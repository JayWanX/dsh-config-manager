/**
 * 真 codec 复验门（宿主/CLI 专用，node 侧）—— 把一份会话日志**字节**交给本机已装 DSH 的官方
 * @deepseek-ai/dsh-session-format-catalog 走一遍官方读路径，回答的是
 * 「**本机 DSH 真能加载它吗**」，而不是「它自身结构自洽吗」（后者见 session-log-repair.ts 的 sessionLogSelfCheck）。
 *
 * 分层纪律（与 utils/session-log.ts / utils/session-format.ts / utils/session-log-repair.ts 同款）：
 *   · **只允许宿主侧 import**：src/client/** 与 src/core/** 禁止 import 本模块
 *     —— 它经 utils/zstd-frame.ts 间接依赖 node:zlib，core 必须与 DSH 存储格式 + node 内建模块解耦。
 *   · 本模块只读字节（绝不动文件系统），失败一律**返回结论**，绝不 throw 到调用方。
 *
 * ── 判定口径：recovery / validation（对着已安装包实测确定，不抄文档）────────────
 * 实测对象 = 已装包 <anchor>/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js
 * （行号按该文件；本机已装 0.2.0-rc.2 为 5717 B）。
 *
 * ① recovery: 'strict'（写死）：日志是**我们刚改写过的字节**，必须逐行严格成立。
 *    用 'recoverable' 会接受「丢掉一行 + 丢掉其后未提交后缀」的残缺前缀
 *    （dsh-session-format/README.md 第 48 行：The recoverable decoder returns the accepted logical prefix.
 *    A codec may drop one malformed or sequence-gapped row and its uncommitted suffix），
 *    那等于把「DSH 只能读到一半」判成通过。
 * ② validation: 'transformed' —— **判定口径**。源码证据（catalog/lib/index.js）：
 *    · L355 / L357：createRestore 只有 validation === 'current' 时取 options.restoreCurrent，
 *      其余（含 'transformed'）一律取 options.restoreTransformedCurrent；
 *    · L56-68：restoreCurrent = restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
 *      **再加** validateInstalledCurrentSessionArtifact(...)；而 restoreTransformedCurrent
 *      **就是** restoreReleasedV4Artifact(...) 本身 —— 即**官方 stored-log 读盘路径**（代际自有的 V4 恢复）。
 *    · 旁证：dsh-session-format-v3-to-v4/README.md 第 280-281 行表格把 validation:'transformed'
 *      记为「迁移后跑代际自有 V4 恢复、跳过已安装 Session 的通用校验」。用 'current' 当判定门会把
 *      「已安装 build 的语义校验」当硬失败，对「官方读盘路径能读」的日志造成**假回滚**。
 * ③ validation: 'current' 只作**可选增强**（结果里的 strong / strongDetail）：
 *    它跑完整安装侧校验，能指出「能读但语义不完全干净」；**绝不参与判定**，也绝不影响回滚与否。
 *
 * ── children（v3→v4 迁移的显式子会话事实）──────────────────────────────────
 * 优先 createSessionFormatCatalogWithChildren(children)：静态 sessionFormatCatalog 的 v3→v4 边在
 * createStage() 时无条件抛「V3 catalog migration requires explicit historical child facts,
 * including an empty array for a parent without children」（catalog 实测；旁证
 * dsh-session-format-v3-to-v4/README.md 第 51 行）。该行同时明确：**空数组 = 显式声明「这份父会话没有子会话」**，
 * 是合法绑定 —— 所以默认 []。调用方可用 opts.children 注入真实直接子会话事实。
 * 若 codec 仍抛 children 相关错误 → 判 unavailable（detail='children-required'）：我们缺的是**事实**，
 * 而不是日志有问题；服务层据此**不回滚、不宣称已验证**（诚实优于伪造）。
 *
 * ── 两道解析闸门（缺一即 unavailable，绝不猜）─────────────────────────────
 * ① **代际闸门**：候选 catalog 必须暴露 currentVersion，且它必须等于**同一 anchor**解析出的已装 DSH
 *    SESSION_FORMAT_VERSION（复用 utils/session-format.ts 的 readSessionFormatVersionAt —— 同一套
 *    install anchor 口径）。读不到版本、或对不上 → unavailable：拿别的 build 的 codec 去判生死会造假结论。
 * ② **API 闸门**：包内没有 children 版装配函数时，只能用静态 sessionFormatCatalog ——
 *    此时**仅当**日志 header.version === catalog.currentVersion 才可用（本代日志不过 v3→v4 边界，不需要 child 事实）；
 *    否则 → unavailable(detail='children-required')。例：磁盘上那份 0.1.5-rc.2（currentVersion=3）
 *    对 v4 日志必须判 unavailable，而不是被当成「日志有错」。
 *
 * ── 定位已装 catalog ─────────────────────────────────────────────────────
 * 复用 utils/session-format.ts 的 install anchor 解析口径（**不新造一套、绝不按 semver 猜**）：
 * 候选是 @deepseek-ai/dsh/package.json 的绝对路径（宿主可传 dshPackageJsonCandidates(home, profile, installAnchor)），
 * 每处再试 hoisted 与 pnpm 嵌套两种布局（与 resolveSessionFormatVersion 逐字同款）。
 * 解析不到 / import 失败 / 包内无 createRestore → unavailable。
 * 注意 detail **只放机器可读码，不放绝对路径**（结果会经路由回传浏览器）。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSessionFormatVersionAt } from './session-format.ts';
import { decodeZstdFrame, scanZstdFrames, zstdAvailable } from './zstd-frame.ts';

/** 复验结论里的失败原因（机器可读；文案由调用方输出层决定）。 */
export type SessionVerifyReason =
  /** 能力不可用：没有 zstd / 找不到已装 catalog / import 失败 / 代际对不上 / 缺子会话事实 */
  | 'unavailable'
  /** 首帧不是「恰好一行 header」（官方 assertZstdHeaderFrame），或容器结构性不合法（撕裂/魔数/保留位） */
  | 'invalid-header'
  /** createRestore 或某一行 decodeRow 失败（含官方迁移拒绝） */
  | 'decode-failed'
  /** 全部行都喂完之后 finish() 失败 */
  | 'finish-failed';

export const SESSION_VERIFY_REASONS: readonly SessionVerifyReason[] = ['unavailable', 'invalid-header', 'decode-failed', 'finish-failed'];

/** 解析台账里的旧字段用（台账记录来自 JSON 反序列化，形状不可信）。 */
export function isSessionVerifyReason(value: unknown): value is SessionVerifyReason {
  return typeof value === 'string' && (SESSION_VERIFY_REASONS as readonly string[]).includes(value);
}

/** 官方 restore 句柄（只用得到这两个方法）。 */
export interface SessionVerifyRestore {
  decodeRow(row: unknown): void;
  finish(): unknown;
}

/** 官方 catalog 的最小接口（判定口径固定为 strict + transformed / current）。 */
export interface SessionVerifyCatalog {
  createRestore(header: unknown, options: { recovery: 'strict'; validation: 'transformed' | 'current' }): SessionVerifyRestore;
}

export interface SessionVerifyOptions {
  /** @deepseek-ai/dsh/package.json 候选（顺序即真伪顺序；缺省 = 运行时锚点 + 本机 profile 树）。 */
  dshPackageJsonCandidates?: readonly string[];
  /** 显式直接子会话事实；缺省 = []（显式声明没有子会话）。 */
  children?: readonly unknown[];
  /** 注入 catalog（测试用）。传 null = 直接判 unavailable（不探测）。 */
  catalog?: SessionVerifyCatalog | null;
  /** 缺省探测时的 home（给 <home>/profiles/** 候选）；缺省取 DSH_HOME 环境变量。 */
  homeDir?: string;
  /** 与 homeDir 搭配的档案名（有则插在 hoisted 树之前）。 */
  profile?: string;
}

/** 复验结论。verified:true 时 strong/strongDetail 是**额外信息**，不参与判定。 */
export type SessionVerifyResult =
  | { verified: true; events: number; strong: boolean; strongDetail?: string }
  | { verified: false; reason: SessionVerifyReason; detail?: string };

/* ------------------------------------------------- 候选与布局（与 session-format.ts 同款） */

const DSH_PKG_REL = join('@deepseek-ai', 'dsh');
const CATALOG_PKG_REL = join('@deepseek-ai', 'dsh-session-format-catalog');
const CATALOG_ENTRY_REL = join('lib', 'index.js');

/**
 * 候选 @deepseek-ai/dsh/package.json → 待探测的 node_modules 根。
 *
 * 与 utils/session-format.ts 的 resolveSessionFormatVersion **逐字同款**（每处试 hoisted 与 pnpm 嵌套两种布局）：
 * 那里解的是同树 @deepseek-ai/dsh-session 的常量，这里解的是同树 dsh-session-format-catalog。
 */
export function nodeModulesRootsFor(dshPackageJsonCandidates: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of dshPackageJsonCandidates) {
    const nodeModulesDir = join(dirname(candidate), '..', '..');
    for (const root of [nodeModulesDir, join(nodeModulesDir, DSH_PKG_REL, 'node_modules')]) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

/**
 * 缺省候选：**运行时锚点优先**（拉起本进程的那份 runtime），其次本机 profile 树。
 *
 *  ① Electron 桌面端：<resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json
 *     —— 这是 profileContext.installAnchor 在服务层（拿不到 profileContext 的地方）的进程内等价物；
 *     app.asar.unpacked 与解包安装的 app 两种形态一并列出（存在即用，不存在即跳过，绝不猜）。
 *  ② 与 src/index.ts 的 dshPackageJsonCandidates 第 ②③ 条逐字同款：<home>/profiles/<profile>/、
 *     <home>/profiles/、<home>/profiles/web/。
 *
 * 顺序就是真伪顺序：真机实测「profile hoisted 树」是 web 档案装出来的旧副本（本机 0.1.5-rc.2），
 * 桌面端实际跑的是 app.asar 里的 0.2.0-rc.2 —— 所以锚点必须排在前面。
 */
export function defaultDshPackageJsonCandidates(homeDir?: string, profile?: string): string[] {
  const out: string[] = [];
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resources === 'string' && resources !== '') {
    const bases = [join('app.asar', 'dsh', 'node_modules'), join('app.asar.unpacked', 'dsh', 'node_modules'), join('app', 'dsh', 'node_modules')];
    for (const base of bases) out.push(join(resources, base, DSH_PKG_REL, 'package.json'));
  }
  const home = homeDir !== undefined && homeDir !== '' ? homeDir : process.env['DSH_HOME'];
  if (home !== undefined && home !== '') {
    if (profile !== undefined && profile !== '') out.push(join(home, 'profiles', profile, 'node_modules', DSH_PKG_REL, 'package.json'));
    out.push(
      join(home, 'profiles', 'node_modules', DSH_PKG_REL, 'package.json'),
      join(home, 'profiles', 'web', 'node_modules', DSH_PKG_REL, 'package.json'),
    );
  }
  return out;
}

/* ------------------------------------------------------------------- 进程内缓存 */

/** 已 import 的 catalog 模块（键 = 文件 URL；失败也缓存，避免反复探测）。 */
const moduleCache = new Map<string, unknown>();
/** 已装配的 children 版 catalog（键 = 文件 URL；只缓存「显式声明无子会话」的默认装配）。 */
const catalogCache = new Map<string, SessionVerifyCatalog>();

/** 清空进程内缓存（测试隔离用）。 */
export function clearSessionVerifyCache(): void {
  moduleCache.clear();
  catalogCache.clear();
}

async function importCatalogModule(file: string): Promise<unknown> {
  if (moduleCache.has(file)) return moduleCache.get(file);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch {
    mod = undefined;
  }
  moduleCache.set(file, mod);
  return mod;
}

function isSessionVerifyCatalog(value: unknown): value is SessionVerifyCatalog {
  return typeof value === 'object' && value !== null && typeof (value as { createRestore?: unknown }).createRestore === 'function';
}

/** 解析 catalog 的结果；detail 只放机器可读码（**不放路径** —— 它会回传浏览器）。 */
interface CatalogResolution {
  catalog?: SessionVerifyCatalog;
  detail: string;
}

async function resolveCatalog(options: SessionVerifyOptions, headerVersion: unknown): Promise<CatalogResolution> {
  if (options.catalog === null) return { detail: 'catalog-disabled' };
  if (options.catalog !== undefined) return { catalog: options.catalog, detail: 'injected' };
  const candidates = options.dshPackageJsonCandidates ?? defaultDshPackageJsonCandidates(options.homeDir, options.profile);
  const children = options.children ?? [];
  const notes: string[] = [];
  for (const root of nodeModulesRootsFor(candidates)) {
    const file = join(root, CATALOG_PKG_REL, CATALOG_ENTRY_REL);
    let present = false;
    try {
      present = existsSync(file);
    } catch {
      present = false;
    }
    if (!present) continue;
    const mod = await importCatalogModule(file);
    if (mod === undefined) {
      notes.push('import-failed');
      continue;
    }
    const record = mod as Record<string, unknown>;
    // 代际闸门（前半）：同一 anchor 里已装 DSH 的 SESSION_FORMAT_VERSION —— 读不到就不猜
    const expected = readSessionFormatVersionAt(root);
    if (expected === undefined) {
      notes.push('no-installed-version');
      continue;
    }
    const assemble = record['createSessionFormatCatalogWithChildren'];
    if (typeof assemble === 'function') {
      const cached = catalogCache.get(file);
      if (cached !== undefined && children.length === 0) return { catalog: cached, detail: 'cached' };
      let assembled: unknown;
      try {
        assembled = (assemble as (facts: readonly unknown[]) => unknown)(children);
      } catch {
        notes.push('assemble-failed');
        continue;
      }
      if (!isSessionVerifyCatalog(assembled)) {
        notes.push('no-createRestore');
        continue;
      }
      // 代际闸门（后半）：装配出的 catalog 的 currentVersion 必须等于同一 anchor 的已装版本
      const currentVersion = (assembled as { currentVersion?: unknown }).currentVersion;
      if (typeof currentVersion !== 'number' || currentVersion !== expected) {
        notes.push('generation-mismatch');
        continue;
      }
      if (children.length === 0) catalogCache.set(file, assembled);
      return { catalog: assembled, detail: 'resolved' };
    }
    // API 闸门：只有静态 catalog —— 仅当这份日志本来就等于它的 currentVersion 才是可信读盘
    const staticCatalog = record['sessionFormatCatalog'];
    if (!isSessionVerifyCatalog(staticCatalog)) {
      notes.push('no-createRestore');
      continue;
    }
    const currentVersion = (staticCatalog as { currentVersion?: unknown }).currentVersion;
    if (typeof currentVersion !== 'number' || currentVersion !== expected) {
      notes.push('generation-mismatch');
      continue;
    }
    if (headerVersion !== currentVersion) {
      notes.push('children-required');
      continue;
    }
    return { catalog: staticCatalog, detail: 'static' };
  }
  if (notes.includes('children-required')) return { detail: 'children-required' };
  return { detail: notes.length > 0 ? notes.join('+') : 'no-catalog' };
}

/* ---------------------------------------------------------------- 字节 → header + 行 */

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** children-事实缺失类错误（catalog 实测文本：「V3 catalog migration requires explicit historical child facts…」）。 */
const CHILDREN_ERROR_RE = /(historical child|child facts|child evidence|childfacts|requires explicit)/i;

function isChildrenError(error: unknown): boolean {
  return CHILDREN_ERROR_RE.test(errorText(error));
}

type FrameExtraction =
  | { ok: true; header: unknown; rows: unknown[] }
  | { ok: false; reason: SessionVerifyReason; detail: string };

/**
 * 解帧 → 首帧**恰好一行** header（官方 assertZstdHeaderFrame：非空且唯一的换行符就是最后一个字节）
 * → 其余帧逐行 JSON.parse 成物理行对象。
 *
 * 归类：结构性不合法（帧扫描抛错 / 撕裂尾帧 / 首帧不是单行 header）→ invalid-header；
 * 字节级解压失败或行不是 JSON 对象 → decode-failed。两者都是**确定性**结论（服务层据此自动回滚）。
 */
function extractFrames(bytes: Uint8Array): FrameExtraction {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable', detail: 'no-zstd' };
  let frames: { start: number; end: number }[];
  let torn = false;
  try {
    const scan = scanZstdFrames(bytes);
    frames = scan.frames;
    torn = scan.tornStart !== undefined;
  } catch {
    return { ok: false, reason: 'invalid-header', detail: 'corrupt-container' };
  }
  if (frames.length === 0) return { ok: false, reason: 'invalid-header', detail: 'no-frame' };
  if (torn) return { ok: false, reason: 'invalid-header', detail: 'torn-tail' };
  const first = frames[0];
  if (first === undefined) return { ok: false, reason: 'invalid-header', detail: 'no-frame' };
  let headerText: string;
  try {
    headerText = decodeZstdFrame(bytes.subarray(first.start, first.end)).toString('utf8');
  } catch (error) {
    return { ok: false, reason: 'decode-failed', detail: 'header-frame: ' + errorText(error) };
  }
  if (headerText.length === 0 || headerText.indexOf(String.fromCharCode(10)) !== headerText.length - 1) {
    return { ok: false, reason: 'invalid-header', detail: 'header-frame-not-one-line' };
  }
  let header: unknown;
  try {
    header = JSON.parse(headerText.slice(0, -1));
  } catch {
    return { ok: false, reason: 'invalid-header', detail: 'header-not-json' };
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { ok: false, reason: 'invalid-header', detail: 'header-not-object' };
  }
  const rows: unknown[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame === undefined) continue;
    let text: string;
    try {
      text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      return { ok: false, reason: 'decode-failed', detail: 'row-frame: ' + errorText(error) };
    }
    for (const line of text.split(String.fromCharCode(10))) {
      if (line.trim() === '') continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        return { ok: false, reason: 'decode-failed', detail: 'row-not-json' };
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return { ok: false, reason: 'decode-failed', detail: 'row-not-object' };
      }
      rows.push(row);
    }
  }
  return { ok: true, header, rows };
}

/* --------------------------------------------------------------------- 官方读路径 */

type RestoreOutcome = { ok: true; events: number } | { ok: false; reason: SessionVerifyReason; detail: string };

/** 官方 finish() 产物里的 events 数组长度；产物形态不符（例如注入替身）时退回已解码行数。 */
function eventCountOf(artifact: unknown, fallback: number): number {
  if (typeof artifact === 'object' && artifact !== null) {
    const events = (artifact as { events?: unknown }).events;
    if (Array.isArray(events)) return events.length;
  }
  return fallback;
}

/**
 * 走一遍官方读路径：createRestore → 逐行 decodeRow（**每行先 structuredClone**）→ finish()。
 *
 * 为什么每行都要 structuredClone：官方 restore 会**原地改写**入参（生态参考 mengjiemy/dsh-session-tools 的
 * session-oracle.mjs 与 YouHui1/dsh-sessions-diagnosis 的 probeMigration 都这么做），而我们每次判定都要用
 * 同一份行再跑一趟 strong 增强校验 —— 不隔离就会让增强校验吃到被上一趟改写过的行。
 */
function runRestore(
  catalog: SessionVerifyCatalog,
  header: unknown,
  rows: readonly unknown[],
  validation: 'transformed' | 'current',
): RestoreOutcome {
  let restore: SessionVerifyRestore;
  try {
    restore = catalog.createRestore(structuredClone(header), { recovery: 'strict', validation });
  } catch (error) {
    if (isChildrenError(error)) return { ok: false, reason: 'unavailable', detail: 'children-required' };
    return { ok: false, reason: 'decode-failed', detail: 'createRestore: ' + errorText(error) };
  }
  try {
    for (const row of rows) restore.decodeRow(structuredClone(row));
  } catch (error) {
    if (isChildrenError(error)) return { ok: false, reason: 'unavailable', detail: 'children-required' };
    return { ok: false, reason: 'decode-failed', detail: 'decodeRow: ' + errorText(error) };
  }
  let artifact: unknown;
  try {
    artifact = restore.finish();
  } catch (error) {
    if (isChildrenError(error)) return { ok: false, reason: 'unavailable', detail: 'children-required' };
    return { ok: false, reason: 'finish-failed', detail: 'finish: ' + errorText(error) };
  }
  return { ok: true, events: eventCountOf(artifact, rows.length) };
}

/* ------------------------------------------------------------------------- 入口 */

/**
 * 复验一份会话日志字节：**本机 DSH 的官方 codec 能不能把它读到底**。
 *
 * 判定口径固定 { recovery: 'strict', validation: 'transformed' }（选择 + 源码证据见文件头）；
 * validation: 'current' 只作为结果里的 strong / strongDetail 增强信息，**绝不影响判定**。
 * 任何能力缺失（没有 zstd / 找不到 catalog / 代际对不上 / 缺子会话事实）→ unavailable：
 * **绝不 throw，绝不宣称通过**。
 */
export async function verifySessionLogBytes(bytes: Uint8Array, options: SessionVerifyOptions = {}): Promise<SessionVerifyResult> {
  const framed = extractFrames(bytes);
  if (!framed.ok) return { verified: false, reason: framed.reason, detail: framed.detail };
  let resolution: CatalogResolution;
  try {
    resolution = await resolveCatalog(options, (framed.header as { version?: unknown }).version);
  } catch {
    // 理论上到不了（resolveCatalog 内部全 try/catch）；兜底仍判 unavailable，绝不 throw 给调用方
    return { verified: false, reason: 'unavailable', detail: 'resolver-failed' };
  }
  if (resolution.catalog === undefined) return { verified: false, reason: 'unavailable', detail: resolution.detail };
  const verdict = runRestore(resolution.catalog, framed.header, framed.rows, 'transformed');
  if (!verdict.ok) return { verified: false, reason: verdict.reason, detail: verdict.detail };
  // 可选增强（不参与判定）：跑完整安装侧校验，用来区分「能读且干净」与「能读但语义不完全干净」
  const strong = runRestore(resolution.catalog, framed.header, framed.rows, 'current');
  if (strong.ok) return { verified: true, events: verdict.events, strong: true };
  return { verified: true, events: verdict.events, strong: false, strongDetail: strong.detail };
}
