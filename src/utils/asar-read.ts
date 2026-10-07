/**
 * 最小只读 asar 读取器（宿主/CLI 专用，node 侧）—— 解析 Chromium pickle 包头 + JSON 目录表，
 * 按**显式包名 / 相对前缀**把需要的条目取出到缓存目录，供 \`session-verify.ts\` 在纯 node 下
 * import DSH 安装里 app.asar 内的官方 catalog（缺口⑤：打包安装下 asar 是容器不是目录，
 * 纯 node 既 existsSync 不到、也 import 不了里面的文件）。
 *
 * 为什么需要它：asar 是**容器不是目录**，纯 node 既 existsSync 不到、也 import 不了里面的文件。
 * DSH 桌面版把整个 dsh 运行时打进 \`<resources>/app.asar\`，而官方 codec
 * （\`@deepseek-ai/dsh-session-format-catalog\`）只在容器里，于是「真 codec 复验门」在 CLI 下
 * 恒退化到 profile 树里的旧代际 catalog。本模块把**恰好需要的那几个包**取出到系统临时目录再 import。
 *
 * ── 只读纪律（硬约束，不得放宽）────────────────────────────────────────────
 *  · 源 asar 一律 \`open(asarPath, 'r')\`，**绝不写入 DSH 安装树**（连临时文件都不落在安装目录）；
 *  · **不把整个 asar 读进内存**：只读 8 字节包长 + 头 pickle（目录表）+ 需要的那几个条目
 *    （真机实测：app.asar 121,348,951 B / 头 3,392,056 B / catalog 依赖闭包 37 包 ≈ 8.4 MB）；
 *  · 拒绝 \`..\`、绝对路径、反斜杠等越界条目，拒绝非普通条目（目录 / 符号链接 \`link\`）；
 *  · 目标目录**原子发布**：同级唯一临时目录 → 写满 → rename（命中已有缓存则复用，不重复解包）。
 *
 * ── asar 容器格式（对真机 app.asar 实测确定，不抄文档）─────────────────────
 *  \`[0..3]  = payloadSize（恒为 4）\`
 *  \`[4..7]  = headerBytes（头 pickle 整段字节数）\`
 *  \`[8..8+headerBytes) = 头 pickle：[payloadSize'][jsonLength][JSON 目录表][0~3 字节对齐填充]\`
 *  条目数据 \`offset\` 相对「8 + headerBytes」（真机首个条目 offset = "0"）。
 *  成员 \`files\` = 目录；\`size\`/\`offset\`/\`unpacked\`/\`link\` = 文件；\`offset\` 是字符串。
 *
 * ── 安装位置锚点（**绝不猜**）──────────────────────────────────────────────
 *  · \`process.resourcesPath\`（Electron 宿主；接线见 session-verify.ts 的 runtimeAnchorCandidates）；
 *  · 显式环境变量 \`DSH_CM_DSH_INSTALL\` = **DSH 安装根**（就是含 \`resources/app.asar\` 的那一层，
 *    例如 \`D:\Apps\DSH\`）→ 候选 \`<root>/resources/app.asar/...\`。**只在用户显式给出时使用**。
 *  · **「离线 CLI 自动发现安装位置」在本仓未实现**（不依赖任何文档登记即可核实：全仓只有
 *    `process.resourcesPath` 与 `DSH_CM_DSH_INSTALL` 两个来源）。本模块与调用方都不做启发式搜索
 *    （不扫盘、不猜默认安装路径）—— 两者都拿不到时，调用方如实判 unavailable。
 *
 * ── 运行上下文（真机实测；这决定「直接 import」与「抽取」两条路各自的前提）────
 *  · **Electron 宿主**（`DeepSeek Harness.exe`，Electron 44 / node 24.18.1）：Node 的 fs 被 asar **虚拟化** ——
 *    `statSync(app.asar)` 报 `isDirectory`（size 0）、`readdirSync` 能列出容器内容、读容器内路径直接成功，
 *    但**用 fs 打开容器本身读原始字节会 ENOENT**。所以宿主里不需要本模块：session-verify 的
 *    `existsSync(容器内入口) + import` 那条路在宿主里本来就成立（本模块只在直接路径不存在时才被调用）。
 *  · **纯 node**（系统 node，本机 `D:\Apps\nodejs\node.exe` v24.13.0，无 electron）：容器是一个**普通文件**
 *    （基线 size = 121,348,951 B / mtimeMs = 1790678066000），`readdir` 与读容器内路径都失败，只能像本模块
 *    这样**自己解析 pickle 头 + 数据区**。
 *  两处实测（同一条路径、同一时刻）：宿主 `fs.openSync(asar, 'r')` → ENOENT；系统 node 头 8 字节 =
 *    `0400000038c23300`（u32@4 = 3,392,056 = 头 pickle 字节数）。
 *  ⇒ 本模块**绝不依赖任何「把 asar 当目录」的虚拟语义**：只 `open('r')` + 显式 offset 读；
 *    在宿主里调用它只会得到一个诚实的失败码（`not-found`/`io-error`），不会静默给出错内容。
 *
 * 零 DSH 依赖（仅 node:fs / node:path / node:crypto / node:os），CLI 离线引擎可复用。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isENOENT } from './guards.ts';

/* ------------------------------------------------------------------ 常量 */

/** 缺省缓存根（系统临时目录下），可用选项覆盖。 */
export const DEFAULT_ASAR_CACHE_DIR_NAME = 'dsh-cm-asar-codec';
/** 缺省解析起点（asar 内哪个目录当作 node_modules 根）。 */
export const DEFAULT_ASAR_RESOLVE_FROM = 'dsh/node_modules';
/** 头 pickle 上限：真机 3.4 MB。超出即视为畸形（防恶意包把内存打爆）。 */
const ASAR_HEADER_LIMIT_BYTES = 64 * 1024 * 1024;
/** 头 pickle 超过它就不进进程内索引缓存（避免大包常驻内存；真机 3.4 MB 远小于它）。 */
const INDEX_CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
/** 包长 pickle 固定 8 字节（4 字节 payloadSize + 4 字节 headerBytes）。 */
const SIZE_PICKLE_BYTES = 8;
/** 缓存目录里的清单文件名（命中判据）。 */
const MANIFEST_NAME = '.dsh-cm-asar.json';
const MANIFEST_VERSION = 1;
const EXTRACT_TMP_PREFIX = '.tmp-';

/* ------------------------------------------------------------------ 错误 */

/** 机器可读失败码（调用方据此写 detail，绝不拼绝对路径）。 */
export type AsarErrorCode =
  /** 容器不存在 / 不是普通文件 */
  | 'not-found'
  /** 头 pickle 结构或 JSON 目录表不合法 */
  | 'malformed-header'
  /** 文件被截断（不足 8 字节 / 头长度越界 / 条目超出文件尾） */
  | 'truncated'
  /** 越界或非普通条目（\`..\` / 绝对路径 / 反斜杠 / 符号链接） */
  | 'unsafe-entry'
  /** 解析不到请求的包（或它的 package.json） */
  | 'unresolved-package'
  /** 读写失败（权限 / 占用 / 磁盘） */
  | 'io-error'
  /** 缓存目录发布失败 */
  | 'cache-failed';

/** 读取失败：调用方**一律当结论**处理（绝不 throw 到用户路径）。 */
export class AsarReadError extends Error {
  readonly code: AsarErrorCode;
  constructor(code: AsarErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'AsarReadError';
    this.code = code;
  }
}

/**
 * 出错时只保留**稳定机器码**：errno 码（ENOENT/EACCES/EPERM…）或错误类名，**绝不回显 message**
 * —— node 的 fs 错误 message 里带**绝对路径**，而 detail 会经 `SessionVerifyResult.detail` 回传调用方/
 * 浏览器（F3：结果与台账的纪律是「不含绝对路径」）。判不出来时给 'unknown'，绝不把原文塞进去。
 */
function errorCode(error: unknown): string {
  if (error instanceof AsarReadError) return error.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  if (error instanceof Error && error.name !== '') return error.name;
  return 'unknown';
}

/* ------------------------------------------------------------------ 类型 */

/** 索引里的一个**普通文件**条目。 */
export interface AsarFileEntry {
  /** asar 内 POSIX 相对路径（相对 asar 根）。 */
  readonly path: string;
  readonly size: number;
  /** 条目数据相对「8 + headerBytes」的字节偏移。 */
  readonly offset: number;
  /** asarUnpack：实体在 \`<asarPath>.unpacked/<path>\`，容器内只有占位。 */
  readonly unpacked: boolean;
}

/** 解析后的 asar 目录表（只含普通文件；目录另存）。 */
export interface AsarIndex {
  readonly asarPath: string;
  readonly fileSize: number;
  readonly mtimeMs: number;
  readonly headerBytes: number;
  readonly files: ReadonlyMap<string, AsarFileEntry>;
  readonly directories: ReadonlySet<string>;
}

/* ------------------------------------------------------------- 路径安全 */

/**
 * asar 内相对路径是否安全：拒绝空段 / \`.\` / \`..\` / 绝对路径 / 反斜杠 / 控制字符与 Windows 保留字符。
 * 越界判定不依赖 \`path.resolve\`（跨平台语义不同），逐段白名单更可证。
 */
export function isSafeAsarPath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (rel.includes('\\')) return false;
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>:"|?*]/.test(part)) return false;
    if (part.endsWith('.') || part.endsWith(' ')) return false;
  }
  return true;
}

/** \`<asarPath>.unpacked/<rel>\`（asarUnpack 实体的真实位置）。 */
export function asarUnpackedPath(asarPath: string, rel: string): string {
  return path.join(asarPath + '.unpacked', ...rel.split('/'));
}

/* --------------------------------------------------------------- 头解析 */

/** 进程内索引缓存（键 = asar 路径；size+mtimeMs 变了即作废）。 */
interface CachedIndex {
  readonly size: number;
  readonly mtimeMs: number;
  readonly index: AsarIndex;
}
const indexCache = new Map<string, CachedIndex>();

/** 清空进程内索引缓存（测试隔离用）。 */
export function clearAsarIndexCache(): void {
  indexCache.clear();
}

/** 解析头 pickle 的 JSON 目录表根（\`files\` 对象）。 */
function parseHeaderPickle(header: Buffer): Record<string, unknown> {
  if (header.length < SIZE_PICKLE_BYTES) throw new AsarReadError('truncated', 'header-pickle-short');
  const payloadSize = header.readUInt32LE(0);
  const jsonLength = header.readUInt32LE(4);
  if (payloadSize > header.length - 4) throw new AsarReadError('truncated', 'header-payload-size');
  if (jsonLength <= 0 || 4 + jsonLength > payloadSize || SIZE_PICKLE_BYTES + jsonLength > header.length) {
    throw new AsarReadError('malformed-header', 'header-json-length');
  }
  const text = header.subarray(SIZE_PICKLE_BYTES, SIZE_PICKLE_BYTES + jsonLength).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AsarReadError('malformed-header', 'header-not-json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AsarReadError('malformed-header', 'header-not-object');
  }
  const files = (parsed as { files?: unknown }).files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new AsarReadError('malformed-header', 'header-no-files');
  }
  return files as Record<string, unknown>;
}

/** 目录表 → 扁平索引（越界条目直接抛 truncated；非普通条目跳过）。 */
function buildIndex(asarPath: string, fileSize: number, mtimeMs: number, headerBytes: number, root: Record<string, unknown>): AsarIndex {
  const files = new Map<string, AsarFileEntry>();
  const directories = new Set<string>();
  const bodyLimit = fileSize - SIZE_PICKLE_BYTES - headerBytes;
  const stack: { node: Record<string, unknown>; prefix: string }[] = [{ node: root, prefix: '' }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) continue;
    for (const [name, raw] of Object.entries(item.node)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const rel = item.prefix === '' ? name : item.prefix + '/' + name;
      // 越界/非法名字：**不进索引**（读取时即 undefined），绝不落到磁盘上任何位置
      if (!isSafeAsarPath(rel)) continue;
      const record = raw as Record<string, unknown>;
      const children = record['files'];
      if (children !== null && children !== undefined && typeof children === 'object' && !Array.isArray(children)) {
        directories.add(rel);
        stack.push({ node: children as Record<string, unknown>, prefix: rel });
        continue;
      }
      // 符号链接是非普通条目：拒绝（不跟随、不取出）
      if (typeof record['link'] === 'string') continue;
      const size = record['size'];
      const offsetRaw = record['offset'];
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) continue;
      const offset = typeof offsetRaw === 'string' ? Number(offsetRaw) : offsetRaw;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) continue;
      const unpacked = record['unpacked'] === true;
      // unpacked 条目的实体在容器外，容器内 offset 无意义 → 不做范围判定
      if (!unpacked && offset + size > bodyLimit) throw new AsarReadError('truncated', 'entry-out-of-range:' + rel);
      files.set(rel, { path: rel, size, offset, unpacked });
    }
  }
  return { asarPath, fileSize, mtimeMs, headerBytes, files, directories };
}

/**
 * 解析 asar 目录表（只读 8 字节包长 + 头 pickle，**不读数据区**）。
 * 失败一律抛 \`AsarReadError\`（code 机器可读）；size+mtimeMs 未变时命中进程内缓存。
 */
export async function readAsarIndex(asarPath: string): Promise<AsarIndex> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(asarPath);
  } catch (error) {
    throw new AsarReadError(isENOENT(error) ? 'not-found' : 'io-error', 'stat:' + errorCode(error));
  }
  if (!stat.isFile()) throw new AsarReadError('not-found', 'not-a-file');
  const cached = indexCache.get(asarPath);
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;

  if (stat.size < SIZE_PICKLE_BYTES) throw new AsarReadError('truncated', 'shorter-than-size-pickle');
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(asarPath, 'r');
  } catch (error) {
    throw new AsarReadError(isENOENT(error) ? 'not-found' : 'io-error', 'open:' + errorCode(error));
  }
  try {
    const sizePickle = Buffer.alloc(SIZE_PICKLE_BYTES);
    const headRead = await handle.read(sizePickle, 0, SIZE_PICKLE_BYTES, 0);
    if (headRead.bytesRead !== SIZE_PICKLE_BYTES) throw new AsarReadError('truncated', 'size-pickle-short-read');
    const headerBytes = sizePickle.readUInt32LE(4);
    if (headerBytes < SIZE_PICKLE_BYTES || headerBytes > ASAR_HEADER_LIMIT_BYTES || SIZE_PICKLE_BYTES + headerBytes > stat.size) {
      throw new AsarReadError('truncated', 'header-length-out-of-range');
    }
    const header = Buffer.alloc(headerBytes);
    const headerRead = await handle.read(header, 0, headerBytes, SIZE_PICKLE_BYTES);
    if (headerRead.bytesRead !== headerBytes) throw new AsarReadError('truncated', 'header-short-read');
    const index = buildIndex(asarPath, stat.size, stat.mtimeMs, headerBytes, parseHeaderPickle(header));
    if (headerBytes <= INDEX_CACHE_LIMIT_BYTES) indexCache.set(asarPath, { size: stat.size, mtimeMs: stat.mtimeMs, index });
    return index;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/* --------------------------------------------------------------- 条目读 */

/** 用已解析的索引读一个条目（内部用；不重复解析头）。 */
async function readEntryWithIndex(index: AsarIndex, entry: AsarFileEntry): Promise<Buffer> {
  if (entry.unpacked) {
    try {
      return await fs.readFile(asarUnpackedPath(index.asarPath, entry.path));
    } catch (error) {
      throw new AsarReadError(isENOENT(error) ? 'not-found' : 'io-error', 'unpacked-read:' + errorCode(error));
    }
  }
  const handle = await fs.open(index.asarPath, 'r');
  try {
    const buffer = Buffer.alloc(entry.size);
    if (entry.size === 0) return buffer;
    const absolute = SIZE_PICKLE_BYTES + index.headerBytes + entry.offset;
    const read = await handle.read(buffer, 0, entry.size, absolute);
    if (read.bytesRead !== entry.size) throw new AsarReadError('truncated', 'short-read:' + entry.path);
    return buffer;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 读单个条目字节。条目不存在 / 越界 / 非普通条目 → **undefined**（不抛）；
 * 容器不可读 / 截断 → 抛 \`AsarReadError\`（调用方按结论处理）。
 */
export async function readAsarEntry(asarPath: string, relPath: string): Promise<Uint8Array | undefined> {
  if (!isSafeAsarPath(relPath)) return undefined;
  const index = await readAsarIndex(asarPath);
  const entry = index.files.get(relPath);
  if (entry === undefined) return undefined;
  return readEntryWithIndex(index, entry);
}

/** 读单个文本条目（UTF-8）；条目不存在 → undefined。 */
export async function readAsarTextEntry(asarPath: string, relPath: string): Promise<string | undefined> {
  const bytes = await readAsarEntry(asarPath, relPath);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------- 依赖闭包 */

/** 把一个依赖名解析到 asar 内目录（Node 的 node_modules 上溯规则）。 */
function resolvePackageDir(index: AsarIndex, name: string, fromDir: string): string | undefined {
  const parts = fromDir === '' ? [] : fromDir.split('/');
  for (let i = parts.length; i >= 0; i -= 1) {
    const dir = parts.slice(0, i).join('/');
    const candidate = (dir === '' ? '' : dir + '/') + 'node_modules/' + name;
    if (index.files.has(candidate + '/package.json')) return candidate;
  }
  return undefined;
}

interface ClosureResult {
  readonly dirs: string[];
  readonly roots: { name: string; dir: string }[];
  readonly missingRoots: string[];
  readonly unresolved: string[];
}

/** 从显式包名出发，按 package.json 的 dependencies + peerDependencies(+optional) 求闭包。 */
async function resolveClosure(index: AsarIndex, resolveFrom: string, names: readonly string[]): Promise<ClosureResult> {
  const dirs = new Set<string>();
  const roots: { name: string; dir: string }[] = [];
  const missingRoots: string[] = [];
  const unresolved: string[] = [];
  const queue: string[] = [];
  for (const name of names) {
    const dir = resolvePackageDir(index, name, resolveFrom);
    if (dir === undefined) {
      missingRoots.push(name);
      continue;
    }
    roots.push({ name, dir });
    queue.push(dir);
  }
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined || dirs.has(dir)) continue;
    dirs.add(dir);
    const text = await readAsarTextEntry(index.asarPath, dir + '/package.json').catch(() => undefined);
    if (text === undefined) continue;
    let pkg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      pkg = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const hard = new Set<string>();
    for (const key of ['dependencies', 'peerDependencies']) {
      const section = pkg[key];
      if (section === null || typeof section !== 'object' || Array.isArray(section)) continue;
      for (const dep of Object.keys(section as Record<string, unknown>)) hard.add(dep);
    }
    const optional = new Set<string>();
    const optionalSection = pkg['optionalDependencies'];
    if (optionalSection !== null && typeof optionalSection === 'object' && !Array.isArray(optionalSection)) {
      for (const dep of Object.keys(optionalSection as Record<string, unknown>)) optional.add(dep);
    }
    for (const dep of [...hard, ...optional]) {
      const depDir = resolvePackageDir(index, dep, dir);
      if (depDir === undefined) {
        if (hard.has(dep)) unresolved.push(dep + ' (from ' + dir + ')');
        continue;
      }
      if (!dirs.has(depDir)) queue.push(depDir);
    }
  }
  return { dirs: [...dirs].sort(), roots, missingRoots, unresolved };
}

/* ------------------------------------------------------------------ 缓存 */

interface AsarCacheManifest {
  version: number;
  key: string;
  asarPath: string;
  asarSize: number;
  asarMtimeMs: number;
  resolveFrom: string;
  packages: string[];
  files: number;
  bytes: number;
  createdAt: string;
}

/** 缺省缓存根：\`<os.tmpdir()>/dsh-cm-asar-codec\`。 */
export function defaultAsarCacheDir(): string {
  return path.join(tmpdir(), DEFAULT_ASAR_CACHE_DIR_NAME);
}

/** 缓存键：asar 绝对路径 + size + mtimeMs + 解析起点 + 包集合（排序后）。 */
export function asarCacheKey(index: Pick<AsarIndex, 'asarPath' | 'fileSize' | 'mtimeMs'>, resolveFrom: string, packages: readonly string[]): string {
  const material = JSON.stringify({
    v: MANIFEST_VERSION,
    asar: path.resolve(index.asarPath),
    size: index.fileSize,
    mtimeMs: index.mtimeMs,
    resolveFrom,
    packages: [...packages].sort(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** 读缓存清单；缺失 / 不可解析 / 键不符 → undefined（视为未命中）。 */
async function readCacheManifest(dir: string, key: string): Promise<AsarCacheManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_NAME), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const manifest = parsed as Partial<AsarCacheManifest>;
    if (manifest.version !== MANIFEST_VERSION || manifest.key !== key) return undefined;
    return manifest as AsarCacheManifest;
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------------- 抽取 */

export interface AsarExtractOptions {
  /** 源 asar 容器路径（只读）。 */
  asarPath: string;
  /** 要取出的包名（相对 resolveFrom 解析，含 scope 全名）。 */
  packages: readonly string[];
  /** asar 内作为解析起点的 node_modules 根（POSIX 相对路径）；缺省 \`dsh/node_modules\`。 */
  resolveFrom?: string;
  /** 缓存根目录；缺省 \`<os.tmpdir()>/dsh-cm-asar-codec\`。 */
  cacheDir?: string;
  /** true = 忽略已有缓存、强制重新解包（缓存被外部破坏时用）。 */
  refresh?: boolean;
}

export interface AsarExtractOk {
  ok: true;
  /** 解包后的目录根；条目路径与 asar 内相对路径一一对应。 */
  dir: string;
  cached: boolean;
  packages: { name: string; dir: string }[];
  files: number;
  bytes: number;
  /** 解析不到的传递依赖（不致命：仍交给 import 判定）。 */
  unresolved: string[];
  key: string;
}

export interface AsarExtractFailure {
  ok: false;
  code: AsarErrorCode;
  detail?: string;
}

export type AsarExtractResult = AsarExtractOk | AsarExtractFailure;

function failureOf(error: unknown): AsarExtractFailure {
  if (error instanceof AsarReadError) return { ok: false, code: error.code, detail: error.message };
  // 非 AsarReadError（fs 直传错误等）只留机器码：message 里可能带绝对路径（F3）
  return { ok: false, code: 'io-error', detail: 'io-error:' + errorCode(error) };
}

/** 校验并规整相对前缀（\`dsh/node_modules\`）；非法 → undefined。 */
function normalizePrefix(rel: string): string | undefined {
  // 只允许规整 "开头 ./" 与 "尾部 /"；**绝不**把 "../.." 这类越界前缀"扫干净"成根
  let trimmed = rel.replace(/\\/g, '/');
  while (trimmed.startsWith('./')) trimmed = trimmed.slice(2);
  trimmed = trimmed.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return '';
  if (!isSafeAsarPath(trimmed)) return undefined;
  return trimmed;
}

/** 目标路径必须落在解包根内（双重防线，防止越界条目把内容写到缓存根之外）。 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把显式包名（及其依赖闭包）从 asar 取出到缓存目录。
 *
 * 语义：源 asar 只读；目标目录原子发布（临时目录 + rename）；size+mtimeMs+包集合命中即复用。
 * 失败一律返回结论（\`ok:false\` + 机器可读 code），**绝不 throw**、绝不写 DSH 安装树。
 */
export async function extractAsarPackages(rawOptions: AsarExtractOptions): Promise<AsarExtractResult> {
  const packages = [...rawOptions.packages];
  if (packages.length === 0) return { ok: false, code: 'unresolved-package', detail: 'no-packages' };
  const resolveFrom = normalizePrefix(rawOptions.resolveFrom ?? DEFAULT_ASAR_RESOLVE_FROM);
  if (resolveFrom === undefined) return { ok: false, code: 'unsafe-entry', detail: 'bad-resolve-from' };
  const cacheDir = rawOptions.cacheDir ?? defaultAsarCacheDir();

  let index: AsarIndex;
  try {
    index = await readAsarIndex(rawOptions.asarPath);
  } catch (error) {
    return failureOf(error);
  }
  let closure: ClosureResult;
  try {
    closure = await resolveClosure(index, resolveFrom, packages);
  } catch (error) {
    return failureOf(error);
  }
  if (closure.missingRoots.length > 0) return { ok: false, code: 'unresolved-package', detail: 'missing:' + closure.missingRoots.join(',') };

  const key = asarCacheKey(index, resolveFrom, packages);
  const target = path.join(cacheDir, key);

  const hit = rawOptions.refresh === true ? undefined : await readCacheManifest(target, key);
  if (hit !== undefined) {
    return { ok: true, dir: target, cached: true, packages: closure.roots, files: hit.files, bytes: hit.bytes, unresolved: closure.unresolved, key };
  }

  // 要取出的条目：闭包内每个包目录下的全部普通文件（保持 asar 内相对路径）
  const wanted: AsarFileEntry[] = [];
  for (const dir of closure.dirs) {
    const prefix = dir + '/';
    for (const entry of index.files.values()) {
      if (entry.path.startsWith(prefix)) wanted.push(entry);
    }
  }
  wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tmpDir = path.join(cacheDir, EXTRACT_TMP_PREFIX + key + '-' + process.pid.toString(36) + '-' + createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8));
  let files = 0;
  let bytes = 0;
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    for (const entry of wanted) {
      const dest = path.join(tmpDir, ...entry.path.split('/'));
      if (!isInside(tmpDir, dest)) throw new AsarReadError('unsafe-entry', 'escape:' + entry.path);
      const data = await readEntryWithIndex(index, entry);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      files += 1;
      bytes += data.byteLength;
    }
    const manifest: AsarCacheManifest = {
      version: MANIFEST_VERSION,
      key,
      asarPath: path.resolve(index.asarPath),
      asarSize: index.fileSize,
      asarMtimeMs: index.mtimeMs,
      resolveFrom,
      packages: closure.roots.map((root) => root.name).sort(),
      files,
      bytes,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(tmpDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

    // 原子发布：目标已是**可用**缓存（并发解包/复用）则不删、rename 失败后回落复用；
    // 否则（不存在 / 清单损坏 / 显式 refresh）先清掉再 rename。
    if (rawOptions.refresh === true || (await readCacheManifest(target, key)) === undefined) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
      await fs.rename(tmpDir, target);
    } catch (error) {
      const existing = await readCacheManifest(target, key);
      if (existing === undefined) return { ok: false, code: 'cache-failed', detail: 'rename:' + errorCode(error) };
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      return { ok: true, dir: target, cached: true, packages: closure.roots, files: existing.files, bytes: existing.bytes, unresolved: closure.unresolved, key };
    }
    return { ok: true, dir: target, cached: false, packages: closure.roots, files, bytes, unresolved: closure.unresolved, key };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const existing = await readCacheManifest(target, key);
    if (existing !== undefined) {
      return { ok: true, dir: target, cached: true, packages: closure.roots, files: existing.files, bytes: existing.bytes, unresolved: closure.unresolved, key };
    }
    return failureOf(error);
  }
}

/** 解包目录里的条目路径（\`<dir>/<resolveFrom>/<rel>\`）；调用方判存在后再用。 */
export function extractedEntryPath(dir: string, resolveFrom: string, rel: string): string {
  return path.join(dir, ...(resolveFrom === '' ? rel.split('/') : [...resolveFrom.split('/'), ...rel.split('/')]));
}

/** 缓存根是否已经存在（诊断/测试用；不做写入）。 */
export function asarCacheDirExists(cacheDir: string): boolean {
  return existsSync(cacheDir);
}
