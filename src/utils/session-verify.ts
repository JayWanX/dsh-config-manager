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
 * ── 官方引证（@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js，行号按已装包 142847 B / 3528 行）──
 * 现役读盘路径 = parseHeaderRecord：
 *   L970 function parseHeaderRecord(record) { … }
 *   L971   首帧形状：非空 + 唯一换行符就是最后一个字节（本模块 extractFrames 逐字复刻）
 *   L974   JSON.parse 首行 → L978 必须是 JSON 对象
 *   L979   refuseForeignFormatVersion(parsed)   // L964-968：version !== SESSION_FORMAT_VERSION 直接拒绝
 *   L981   isHeaderLine(parsed)
 *   L984-987 restore = sessionFormatCatalog.createRestore(parsed, { recovery: "strict", validation: "transformed" })
 * 两点必须写清：
 *   ① 该 createRestore **只在 header.version === SESSION_FORMAT_VERSION(本机 4) 时可达** ——
 *      L979 的 refuseForeignFormatVersion 会先把「非本代」的 header 挡掉。所以我们判定 v4 日志用的
 *      { strict, transformed } 正是官方现役读盘口径。
 *   ② 对 **pre-v4** 日志，本门走的是**迁移链**（v0→v1→…→v4 后恢复），它**不等价于 DSH 读盘路径**：
 *      官方的 resolveCurrentLog（L2850-2861）对 sourceVersion === SESSION_FORMAT_VERSION 返回现役日志、
 *      对 < 本代**返回 undefined**（= 这份日志没有「现役代际」）、对 > 本代抛错；而官方的历史读取路径
 *      （L2222-2224）用的是 { recovery: "recoverable", validation: "current" }，与现役口径**不同**。
 *      所以结果里另有 equivalentToReadPath：仅当 header.version === catalog.currentVersion === 已装
 *      SESSION_FORMAT_VERSION 才为 true（「DSH 现在就能直接读」）；pre-v4 迁移链成功时 verified:true
 *      但 equivalentToReadPath:false（「迁移链能还原，但这不是 DSH 的现役读盘」）。
 *
 * ── catalog 解析顺序与资格审查（缺一即 unavailable，绝不猜）─────────────────
 *  ① **裸模块动态 import**（第一顺位）：await import('@deepseek-ai/dsh-session-format-catalog') ——
 *     已装插件自己依赖树里的那一份（开发树 / 档案 node_modules / app.asar 内均按 Node 解析规则命中）；
 *     再用 createRequire(import.meta.url).resolve('<pkg>/package.json') 反推它的 node_modules 根，供代际闸门用。
 *  ② **运行时锚点的 asar 路径**：<process.resourcesPath>/app.asar/dsh/node_modules（含 .unpacked 与解包 app 两种形态）
 *     —— 这是 profileContext.installAnchor 在服务层（拿不到 profileContext 的地方）的进程内等价物。
 *  ③ **<home>/profiles/node_modules/@deepseek-ai/dsh-session-format-catalog**（以及 <home>/profiles/<profile>/… ）
 *     —— 与 src/index.ts 的 dshPackageJsonCandidates 第 ②③ 条同源，每处再试 hoisted 与 pnpm 嵌套两种布局
 *     （deriveRoots 与 utils/session-format.ts 的 resolveSessionFormatVersion 逐字同款）。
 *  代际闸门：候选 catalog 必须暴露 currentVersion，且必须等于**同一 anchor**解析出的已装 DSH
 *     SESSION_FORMAT_VERSION（utils/session-format.ts 的 readSessionFormatVersionAt）——读不到任一侧就换下一个候选；
 *     全部候选都不匹配 → unavailable，detail 里写清每个候选的失败原因（generation-mismatch 等）。
 *  API 闸门：包内没有 createSessionFormatCatalogWithChildren（只有静态 sessionFormatCatalog）时，
 *     **仅当** header.version === catalog.currentVersion 才可用（本代日志不过 v3→v4 边界、不需要 child 事实）；
 *     否则 unavailable(detail='children-required')。例：磁盘上那份 0.1.5-rc.2（currentVersion=3）对 v4 日志必须
 *     unavailable，而不是被当成「日志有错」。
 *  detail 只写**机器可读码 + 候选标签**（bare-module / runtime-anchor / profiles-tree / anchor），
 *     **绝不写绝对路径**（结果会经路由回传浏览器）。
 *  已知缺口（交由文档任务登记）：**asar 抽取不作为产品路径** —— 打包安装下 app.asar 对普通 node 不可读，
 *     本模块不做任何「自己解 asar」的事；R1 的 .tmp/m1/vendor 只用于验证，不参与本模块任何代码路径。
 *
 * ── recovery / validation（对着已安装包实测确定，不抄文档）────────────────────
 *  · recovery: 'strict' 写死。日志是**我们刚改写过的字节**，必须逐行严格成立；用 'recoverable' 会接受
 *    「丢掉一行 + 丢掉其后未提交后缀」的残缺前缀（dsh-session-format/README.md 第 48 行明说），
 *    那等于把「DSH 只能读到一半」判成通过。官方现役路径（L984-987）也是 strict。
 *  · validation: 'transformed' 为**判定门**（与官方现役路径逐字一致）：catalog/lib/index.js L355/L357 显示
 *    非 'current' 时取 options.restoreTransformedCurrent，而 L61-63 里 restoreTransformedCurrent 就是
 *    restoreReleasedV4Artifact(...)；L56-59 的 restoreCurrent 才额外跑 validateInstalledCurrentSessionArtifact
 *    （已安装 build 的语义校验）。用 'current' 当判定门会把「已安装 build 的语义校验」当硬失败，
 *    对「官方读盘路径能读」的日志造成**假回滚**，所以它只作结果里的 strong / strongDetail 增强字段。
 *    （旁证：dsh-session-format-v3-to-v4/README.md L280-281 表格把 validation:'transformed' 记为
 *      「迁移后跑代际自有 V4 恢复、跳过已安装 Session 的通用校验」。）
 *
 * ── children（v3→v4 迁移的显式子会话事实）──────────────────────────────────
 * 优先 createSessionFormatCatalogWithChildren(children)：静态 sessionFormatCatalog 的 v3→v4 边在 createStage()
 * 时无条件抛「V3 catalog migration requires explicit historical child facts, including an empty array for a
 * parent without children」（catalog 实测；旁证 dsh-session-format-v3-to-v4/README.md 第 51 行）。
 * 该行同时明确：**空数组 = 显式声明「这份父会话没有子会话」**，是合法绑定 —— 所以默认 []。
 * 若 codec 仍抛 children 相关错误 → 判 unavailable（detail='children-required'）：我们缺的是**事实**，
 * 而不是日志有问题；服务层据此**不回滚、不宣称已验证**（诚实优于伪造）。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSessionFormatVersionAt } from './session-format.ts';
import { decodeZstdFrame, scanZstdFrames, zstdAvailable } from './zstd-frame.ts';

/** 复验结论里的失败原因（机器可读；文案由调用方输出层决定）。 */
export type SessionVerifyReason =
  /** 能力不可用：没有 zstd / 找不到可信 catalog / import 失败 / 代际对不上 / 缺子会话事实 */
  | 'unavailable'
  /** 首帧不是「恰好一行 header」（官方 assertZstdHeaderFrame / parseHeaderRecord），或容器结构性不合法（撕裂/魔数/保留位） */
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
  /** 该 catalog 的现役代际（官方 createSessionFormatCatalog 装配时给；判定 equivalentToReadPath 要用）。 */
  currentVersion?: unknown;
}

export interface SessionVerifyOptions {
  /** 显式 @deepseek-ai/dsh/package.json 候选（顺序即真伪顺序；给了就只试它，标签 anchor）。 */
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

/**
 * 复验结论。
 *
 * equivalentToReadPath 的语义（**不许曲解**）：true 当且仅当
 * header.version === catalog.currentVersion === 已装 DSH SESSION_FORMAT_VERSION ——
 * 即「DSH 的现役读盘路径此刻就能直接读它」。pre-v4 日志经迁移链还原成功时 verified:true 但
 * equivalentToReadPath:false（官方 resolveCurrentLog 对 < 本代返回 undefined）。未验证时恒 false
 * （含义是「没有任何可声称的现役等价」，不是「已证明不等价」）。
 * verified:true 时 strong/strongDetail 也只是额外信息，不参与判定。
 */
export type SessionVerifyResult =
  | { verified: true; events: number; strong: boolean; strongDetail?: string; equivalentToReadPath: boolean }
  | { verified: false; reason: SessionVerifyReason; detail?: string; equivalentToReadPath: false };

/* ------------------------------------------------- 候选与布局（与 session-format.ts 同款） */

const DSH_PKG_REL = join('@deepseek-ai', 'dsh');
const CATALOG_PKG = '@deepseek-ai/dsh-session-format-catalog';
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
 *     —— profileContext.installAnchor 在服务层（拿不到 profileContext 的地方）的进程内等价物；
 *     app.asar.unpacked 与解包安装的 app 两种形态一并列出（存在即用，不存在即跳过，绝不猜）。
 *  ② 与 src/index.ts 的 dshPackageJsonCandidates 第 ②③ 条逐字同款：<home>/profiles/<profile>/、
 *     <home>/profiles/、<home>/profiles/web/。
 *
 * 顺序就是真伪顺序：真机实测「profile hoisted 树」是 web 档案装出来的旧副本（本机 0.1.5-rc.2），
 * 桌面端实际跑的是 app.asar 里的 0.2.0-rc.2 —— 所以锚点必须排在前面。
 */
export function defaultDshPackageJsonCandidates(homeDir?: string, profile?: string): string[] {
  return [...runtimeAnchorCandidates(), ...profileCandidates(homeDir, profile)];
}

/** 运行时锚点候选（Electron resources 下的 asar / 解包 app）；非 Electron 进程为空。 */
function runtimeAnchorCandidates(): string[] {
  const out: string[] = [];
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resources !== 'string' || resources === '') return out;
  const bases = [join('app.asar', 'dsh', 'node_modules'), join('app.asar.unpacked', 'dsh', 'node_modules'), join('app', 'dsh', 'node_modules')];
  for (const base of bases) out.push(join(resources, base, DSH_PKG_REL, 'package.json'));
  return out;
}

/** 本机 profile 树候选（与 src/index.ts 的 dshPackageJsonCandidates ②③ 同源）。 */
function profileCandidates(homeDir?: string, profile?: string): string[] {
  const home = homeDir !== undefined && homeDir !== '' ? homeDir : process.env['DSH_HOME'];
  if (home === undefined || home === '') return [];
  const out: string[] = [];
  if (profile !== undefined && profile !== '') out.push(join(home, 'profiles', profile, 'node_modules', DSH_PKG_REL, 'package.json'));
  out.push(
    join(home, 'profiles', 'node_modules', DSH_PKG_REL, 'package.json'),
    join(home, 'profiles', 'web', 'node_modules', DSH_PKG_REL, 'package.json'),
  );
  return out;
}

/* ------------------------------------------------------------------- 进程内缓存 */

/** 已 import 的 catalog 模块（键 = 文件 URL；失败也缓存，避免反复探测）。 */
const moduleCache = new Map<string, unknown>();
/** 已装配的 children 版 catalog（键 = 根路径；只缓存「显式声明无子会话」的默认装配）。 */
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

/** 裸模块动态 import（第一顺位候选）；失败返回 undefined。 */
async function importBareCatalog(): Promise<unknown> {
  const key = '\u0000bare\u0000' + CATALOG_PKG;
  if (moduleCache.has(key)) return moduleCache.get(key);
  let mod: unknown;
  try {
    mod = await import(CATALOG_PKG);
  } catch {
    mod = undefined;
  }
  moduleCache.set(key, mod);
  return mod;
}

/** 裸模块自己的 node_modules 根（供代际闸门读同树的 dsh-session 常量）；反推不到 → undefined（不猜）。 */
function bareCatalogRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(CATALOG_PKG + '/package.json');
    return join(dirname(pkgJson), '..', '..');
  } catch {
    return undefined;
  }
}

function isSessionVerifyCatalog(value: unknown): value is SessionVerifyCatalog {
  return typeof value === 'object' && value !== null && typeof (value as { createRestore?: unknown }).createRestore === 'function';
}

/** 一个候选的判定结果：要么给出可用 catalog（含两侧代际），要么给出失败码。 */
type CandidateVerdict =
  | { ok: true; catalog: SessionVerifyCatalog; currentVersion: number; installedVersion: number }
  | { ok: false; code: string };

/**
 * 单个候选（模块 + 它的 node_modules 根）的资格审查。
 *
 * 闸门顺序固定：createRestore 存在 → **代际闸门**（catalog.currentVersion === 同 anchor 的已装 SESSION_FORMAT_VERSION）
 * → **API 闸门**（只有静态 catalog 时须 header.version === currentVersion）。
 */
function judgeCandidate(mod: unknown, root: string, children: readonly unknown[], headerVersion: unknown): CandidateVerdict {
  // 注意：官方 catalog 包**不导出模块级 createRestore**（导出的只有 createSessionFormatCatalogWithChildren /
  // sessionFormatCatalog / historicalSessionFormatCatalog 等），createRestore 是**装配出的 catalog 对象**上的方法
  // —— 所以这里只判「装配结果是不是一个带 createRestore 的 catalog」，别按模块级导出判（那会把真包判死）。
  const record = mod as Record<string, unknown>;
  const installedVersion = readSessionFormatVersionAt(root);
  if (installedVersion === undefined) return { ok: false, code: 'no-installed-version' };
  const assemble = record['createSessionFormatCatalogWithChildren'];
  let catalog: unknown;
  const viaChildren = typeof assemble === 'function';
  if (viaChildren) {
    try {
      catalog = (assemble as (facts: readonly unknown[]) => unknown)(children);
    } catch {
      return { ok: false, code: 'assemble-failed' };
    }
  } else {
    catalog = record['sessionFormatCatalog'];
  }
  if (!isSessionVerifyCatalog(catalog)) return { ok: false, code: 'no-createRestore' };
  const currentVersion = catalog.currentVersion;
  if (typeof currentVersion !== 'number' || currentVersion !== installedVersion) return { ok: false, code: 'generation-mismatch' };
  // API 闸门：静态 catalog 无法在 v3→v4 边界绑定 child 事实，只有「本来就等于本代」才是可信读盘
  if (!viaChildren && headerVersion !== currentVersion) return { ok: false, code: 'children-required' };
  return { ok: true, catalog, currentVersion, installedVersion };
}

/** 解析 catalog 的结果；detail 只放候选标签 + 失败码（**不放路径** —— 它会回传浏览器）。 */
interface CatalogResolution {
  catalog?: SessionVerifyCatalog;
  currentVersion?: number;
  installedVersion?: number;
  detail: string;
}

async function resolveCatalog(options: SessionVerifyOptions, headerVersion: unknown): Promise<CatalogResolution> {
  if (options.catalog === null) return { detail: 'catalog-disabled' };
  if (options.catalog !== undefined) {
    return {
      catalog: options.catalog,
      ...(typeof options.catalog.currentVersion === 'number' ? { currentVersion: options.catalog.currentVersion } : {}),
      detail: 'injected',
    };
  }
  const children = options.children ?? [];
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (label: string, code: string): void => {
    const entry = label + ':' + code;
    if (noted.has(entry)) return;
    noted.add(entry);
    notes.push(entry);
  };

  // ① 裸模块（第一顺位）：已装插件自己依赖树里的那一份
  const bare = await importBareCatalog();
  if (bare === undefined) {
    note('bare-module', 'import-failed');
  } else {
    const root = bareCatalogRoot();
    if (root === undefined) {
      note('bare-module', 'no-version-anchor');
    } else {
      const verdict = judgeCandidate(bare, root, children, headerVersion);
      if (verdict.ok) return { catalog: verdict.catalog, currentVersion: verdict.currentVersion, installedVersion: verdict.installedVersion, detail: 'bare-module' };
      note('bare-module', verdict.code);
    }
  }

  // ②③ 显式候选（标签 anchor）或运行时锚点（runtime-anchor）+ profile 树（profiles-tree）
  const plans: { label: string; root: string }[] = [];
  const seenRoots = new Set<string>();
  const pushPlan = (label: string, root: string): void => {
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    plans.push({ label, root });
  };
  if (options.dshPackageJsonCandidates !== undefined) {
    for (const root of nodeModulesRootsFor(options.dshPackageJsonCandidates)) pushPlan('anchor', root);
  } else {
    for (const root of nodeModulesRootsFor(runtimeAnchorCandidates())) pushPlan('runtime-anchor', root);
    for (const root of nodeModulesRootsFor(profileCandidates(options.homeDir, options.profile))) pushPlan('profiles-tree', root);
  }
  for (const plan of plans) {
    const file = join(plan.root, CATALOG_PKG_REL, CATALOG_ENTRY_REL);
    let present = false;
    try {
      present = existsSync(file);
    } catch {
      present = false;
    }
    if (!present) {
      note(plan.label, 'not-found');
      continue;
    }
    const cached = catalogCache.get(plan.root);
    if (cached !== undefined && children.length === 0) {
      return { catalog: cached, currentVersion: undefined, detail: plan.label + ':cached' };
    }
    const mod = await importCatalogModule(file);
    if (mod === undefined) {
      note(plan.label, 'import-failed');
      continue;
    }
    const verdict = judgeCandidate(mod, plan.root, children, headerVersion);
    if (!verdict.ok) {
      note(plan.label, verdict.code);
      continue;
    }
    if (children.length === 0) catalogCache.set(plan.root, verdict.catalog);
    return { catalog: verdict.catalog, currentVersion: verdict.currentVersion, installedVersion: verdict.installedVersion, detail: plan.label };
  }

  // 全部候选都不匹配时：只要任一候选卡在「静态 catalog 过不了 v3→v4 边界」，最终结论就是 children-required
  if (notes.some((entry) => entry.endsWith(':children-required'))) return { detail: 'children-required' };
  return { detail: notes.length > 0 ? notes.join('+') : 'no-candidate' };
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
 * 解帧 → 首帧**恰好一行** header（官方 parseHeaderRecord L971 / assertZstdHeaderFrame：非空且唯一的换行符
 * 就是最后一个字节）→ 其余帧逐行 JSON.parse 成物理行对象。
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
 * 判定口径固定 { recovery: 'strict', validation: 'transformed' }（= 官方现役读盘口径，选择 + 源码证据见文件头）；
 * validation: 'current' 只作为结果里的 strong / strongDetail 增强信息，**绝不影响判定**。
 * 任何能力缺失（没有 zstd / 找不到可信 catalog / 代际对不上 / 缺子会话事实）→ unavailable：
 * **绝不 throw，绝不宣称通过**。
 */
export async function verifySessionLogBytes(bytes: Uint8Array, options: SessionVerifyOptions = {}): Promise<SessionVerifyResult> {
  const framed = extractFrames(bytes);
  if (!framed.ok) return { verified: false, reason: framed.reason, detail: framed.detail, equivalentToReadPath: false };
  const headerVersion = (framed.header as { version?: unknown }).version;
  let resolution: CatalogResolution;
  try {
    resolution = await resolveCatalog(options, headerVersion);
  } catch {
    // 理论上到不了（resolveCatalog 内部全 try/catch）；兜底仍判 unavailable，绝不 throw 给调用方
    return { verified: false, reason: 'unavailable', detail: 'resolver-failed', equivalentToReadPath: false };
  }
  if (resolution.catalog === undefined) return { verified: false, reason: 'unavailable', detail: resolution.detail, equivalentToReadPath: false };
  // equivalentToReadPath：仅当 header.version === catalog.currentVersion === 已装 SESSION_FORMAT_VERSION
  // （代际闸门已经保证后两者相等，所以这里等价于 header.version === currentVersion）
  const equivalentToReadPath = typeof headerVersion === 'number'
    && resolution.currentVersion === headerVersion
    && (resolution.installedVersion === undefined || resolution.installedVersion === resolution.currentVersion);
  const verdict = runRestore(resolution.catalog, framed.header, framed.rows, 'transformed');
  if (!verdict.ok) return { verified: false, reason: verdict.reason, detail: verdict.detail, equivalentToReadPath: false };
  // 可选增强（不参与判定）：跑完整安装侧校验，用来区分「能读且干净」与「能读但语义不完全干净」
  const strong = runRestore(resolution.catalog, framed.header, framed.rows, 'current');
  if (strong.ok) return { verified: true, events: verdict.events, strong: true, equivalentToReadPath };
  return { verified: true, events: verdict.events, strong: false, strongDetail: strong.detail, equivalentToReadPath };
}
