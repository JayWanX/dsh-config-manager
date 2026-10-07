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
 *  ② **运行时锚点的 asar 容器**：<process.resourcesPath>/app.asar/dsh/node_modules（含 .unpacked 与解包 app 两种形态）
 *     —— 这是 profileContext.installAnchor 在服务层（拿不到 profileContext 的地方）的进程内等价物。
 *     纯 node 下这条候选**落在 asar 容器里**，直接 existsSync/import 都不可能命中 ⇒ 交给
 *     `utils/asar-read.ts` 的最小只读读取器：把 catalog **及其依赖闭包**（真机 37 包 / 940 文件 / 8.4 MB）
 *     取出到缓存目录（缺省 `<os.tmpdir()>/dsh-cm-asar-codec`，可用 `asarCacheDir` 注入）再 import；
 *     命中缓存不重复解包，源 asar 全程只读（细节与拒绝条件见该模块文件头）。这种解析在内部/结果里
 *     标 `via: "asar-extract"`（`detail` 写成 `runtime-anchor+asar-extract`，仍**不含绝对路径**）。
 *  ③ **显式安装根锚点**：环境变量 `DSH_CM_DSH_INSTALL` = DSH 安装根（含 `resources/app.asar` 的那一层）
 *     → `<root>/resources/app.asar/dsh/node_modules/…`（标签 `env-anchor`，排在运行时锚点之前）。
 *     **只在用户显式给出时使用**；「离线 CLI 自动发现安装位置」仍是已登记缺口，本模块**不做任何启发式搜索**。
 *  ④ **<home>/profiles/node_modules/@deepseek-ai/dsh-session-format-catalog**（以及 <home>/profiles/<profile>/… ）
 *     —— 与 src/index.ts 的 dshPackageJsonCandidates 第 ②③ 条同源，每处再试 hoisted 与 pnpm 嵌套两种布局
 *     （deriveRoots 与 utils/session-format.ts 的 resolveSessionFormatVersion 逐字同款）。
 *  代际闸门：候选 catalog 必须暴露 currentVersion，且必须等于**权威「已装版本」**——
 *     install-anchor（profileContext.installAnchor，最高优先）→ runtime-anchor（<resources>/app.asar|app 下的
 *     dsh/node_modules）→ profiles-tree（<home>/profiles/**），取第一个读得出来的 @deepseek-ai/dsh-session 常量
 *     （utils/session-format.ts 的 readSessionFormatVersionAt；顺序与 src/index.ts 的 dshPackageJsonCandidates 同源）。
 *     调用方显式给了 dshPackageJsonCandidates 时，它**就是**权威清单（标签 anchor）。
 *     读不到任一侧 → 换下一个候选；全部不匹配 → unavailable，detail 写清试过的来源与失败原因
 *     （generation-mismatch / no-installed-version(<来源>) 等）。
 *  API 闸门：包内没有 createSessionFormatCatalogWithChildren（只有静态 sessionFormatCatalog）时，
 *     **仅当** header.version === catalog.currentVersion 才可用（本代日志不过 v3→v4 边界、不需要 child 事实）；
 *     否则 unavailable(detail='children-required')。例：磁盘上那份 0.1.5-rc.2（currentVersion=3）对 v4 日志必须
 *     unavailable，而不是被当成「日志有错」。
 *  detail 只写**机器可读码 + 候选标签**（bare-module / runtime-anchor / profiles-tree / anchor / install-anchor），
 *     **绝不写绝对路径**（结果会经路由回传浏览器）。
 *  缓存纪律（V2-F1 修复点）：进程内缓存只存**与日志无关**的候选事实（catalog / currentVersion / viaChildren /
 *     当时的权威版本），**绝不缓存「某个 headerVersion 下判定通过」这个结论** —— 依赖日志 header 的 API 闸门
 *     与 equivalentToReadPath **每次调用都按本日志的 headerVersion 重算**；权威版本变了缓存条目即作废。
 *     旧实现按根命中就直接返回（还丢掉 currentVersion），后果有二：同一份 v4 日志同进程第二次复验的
 *     equivalentToReadPath 由 true 翻 false（CLI 文案在「现役读盘可读 / 迁移链可还原」间翻转）；以及
 *     本机 0.1.5-rc.2 静态 catalog 被复用到 v4 单元 → createRestore 抛
 *     "stored Session uses newer format v4; this build writes v3" → 判 **decode-failed ⇒ 误回滚 + 不写台账**，
 *     而新进程同输入是 unavailable（不回滚 + 写台账）。两条确定性回归测试钉住这两个后果。
 *  V2-F2（已修）：旧实现用**被判定候选自己那棵树**的 SESSION_FORMAT_VERSION 当「已装版本」（自证），于是
 *     磁盘上 0.1.5-rc.2 那棵树（currentVersion 3）把 v3 日志标成「现役读盘可读」，而真实运行的 DSH 是
 *     asar 里的 0.2.0（v4）—— 结论对运行环境不诚实。现在「已装版本」一律走上面的权威解析顺序
 *     （installAnchor 同源），候选自己那棵树只作为**被判定对象**；权威侧读不到 → unavailable（不猜）。
 *  缺口⑤（本模块的接线，2026-10）：**asar 抽取现在是产品路径** —— runtime-anchor 候选落在 app.asar 容器里
 *     且直接 import 失败时，用 `utils/asar-read.ts` 的只读读取器把 catalog 及其依赖闭包取出到缓存目录再 import
 *     （见上 ②）。于是纯 node 的 CLI/离线救急台也能拿到**正在跑的 DSH** 那份真 codec，不再必然退化到
 *     profiles-tree 的旧代际静态 catalog；结果里的 `via: "asar-extract"` 让调用方与台账能看见这条路径。
 *     仍然**不放宽**任何判据：asar 缺失 / 不可读 / 解不出 / 代际对不上 → 一律如实 unavailable
 *     （绝不伪造 verified，也绝不因此把日志判成 decode-failed）。
 *  剩余缺口（登记在 docs/spec/known-gaps.md G-24）：「离线 CLI 自动发现安装位置」—— 本模块只认
 *     `process.resourcesPath`（Electron 宿主）与显式 `DSH_CM_DSH_INSTALL`，**不扫盘、不猜默认安装路径**。
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

import { extractAsarPackages, extractedEntryPath, readAsarTextEntry } from './asar-read.ts';
import { parseSessionFormatVersion, readPackageVersionAt, readSessionFormatVersionAt, sessionFormatRoots } from './session-format.ts';
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
  /**
   * 显式 @deepseek-ai/dsh/package.json 候选（顺序即真伪顺序；给了就**只**试它，标签 anchor）。
   * 给了它 = 调用方声明「这就是本机权威候选清单」⇒「已装版本」也从它解析（不回落 profile 树）。
   */
  dshPackageJsonCandidates?: readonly string[];
  /**
   * 拉起本宿主的运行时锚（= src/index.ts 的 `profileContext.installAnchor`，优先级最高）。
   * 宿主侧拿到 profileContext 时必须传它：「已装版本」的权威解析第一顺位（V2-F2）。
   */
  installAnchor?: string;
  /** 显式直接子会话事实；缺省 = []（显式声明没有子会话）。 */
  children?: readonly unknown[];
  /** 注入 catalog（测试用）。传 null = 直接判 unavailable（不探测）。 */
  catalog?: SessionVerifyCatalog | null;
  /** asar 解包缓存根（可选注入）；缺省 `<os.tmpdir()>/dsh-cm-asar-codec`。 */
  asarCacheDir?: string;
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
  | { verified: true; events: number; strong: boolean; strongDetail?: string; equivalentToReadPath: boolean; via?: 'asar-extract' }
  | { verified: false; reason: SessionVerifyReason; detail?: string; equivalentToReadPath: false };

/* ------------------------------------------------- 候选与布局（与 session-format.ts 同款） */

const DSH_PKG_REL = join('@deepseek-ai', 'dsh');
const DSH_SESSION_PKG_REL = join('@deepseek-ai', 'dsh-session');
const CATALOG_PKG = '@deepseek-ai/dsh-session-format-catalog';
const CATALOG_PKG_REL = join('@deepseek-ai', 'dsh-session-format-catalog');
const CATALOG_ENTRY_REL = join('lib', 'index.js');
/** 包内入口的 POSIX 相对路径（asar 内路径一律 POSIX）；解包目录定位用。 */
const CATALOG_ENTRY_IN_NM = CATALOG_PKG_REL.split('\\').join('/') + '/' + CATALOG_ENTRY_REL.split('\\').join('/');
/** 显式安装根锚点（**只在用户显式给出时使用**，见文件头）。 */
const DSH_INSTALL_ENV = 'DSH_CM_DSH_INSTALL';

/**
 * 候选 @deepseek-ai/dsh/package.json → 待探测的 node_modules 根。
 *
 * 与 utils/session-format.ts 的 `sessionFormatRoots` **同一份实现**（单一事实源）：hoisted 同级 →
 * dsh/node_modules 嵌套 → pnpm 隔离 store（issue #74）。这里解的是同树 dsh-session-format-catalog，
 * 那里解的是同树 dsh-session 的格式常量 —— 布局推导只能有一处，否则同一个坑会换个入口复发。
 */
export function nodeModulesRootsFor(dshPackageJsonCandidates: readonly string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of dshPackageJsonCandidates) {
    const nodeModulesDir = join(dirname(candidate), '..', '..');
    for (const root of sessionFormatRoots(nodeModulesDir, readPackageVersionAt(candidate))) {
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
  return [...envInstallAnchorCandidates(), ...runtimeAnchorCandidates(), ...profileCandidates(homeDir, profile)];
}

/**
 * 显式安装根锚点：`DSH_CM_DSH_INSTALL` = **DSH 安装根**（就是含 `resources/app.asar` 的那一层，
 * 例如 `D:\Apps\DSH`）。只在用户显式给出时使用 —— **绝不**扫盘或猜默认安装路径。
 */
function envInstallAnchorCandidates(): string[] {
  const root = process.env[DSH_INSTALL_ENV];
  if (typeof root !== 'string' || root === '') return [];
  return anchorCandidatesAt(join(root, 'resources'));
}

/** 运行时锚点候选（Electron resources 下的 asar / 解包 app）；非 Electron 进程为空。 */
function runtimeAnchorCandidates(): string[] {
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resources !== 'string' || resources === '') return [];
  return anchorCandidatesAt(resources);
}

/** 一个 resources 目录下的三种形态（打包 asar / asarUnpack / 解包 app）。 */
function anchorCandidatesAt(resources: string): string[] {
  const bases = [join('app.asar', 'dsh', 'node_modules'), join('app.asar.unpacked', 'dsh', 'node_modules'), join('app', 'dsh', 'node_modules')];
  return bases.map((base) => join(resources, base, DSH_PKG_REL, 'package.json'));
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
/**
 * 已装配的候选**事实**（键 = node_modules 根；只缓存「显式声明无子会话」的默认装配）。
 *
 * V2-F1 修复点：这里**只**存与日志无关的事实（catalog / currentVersion / viaChildren / 当时的权威版本），
 * **绝不**把「某个 headerVersion 下判定通过」这个结论也缓存进去 —— 依赖日志 header 的闸门（API 闸门）
 * 与 equivalentToReadPath 每次调用都按本日志的 headerVersion 重算（见 headerGateFailure / pickCandidate）。
 */
interface CachedCandidate {
  catalog: SessionVerifyCatalog;
  currentVersion: number;
  /** 模块是否导出 children 版装配函数（= 能过 v3→v4 边界） */
  viaChildren: boolean;
  /** 入缓存时的权威「已装版本」；权威版本变了就作废重判 */
  installedVersion: number;
}
const catalogCache = new Map<string, CachedCandidate>();

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

/**
 * 权威候选清单（**带来源标签**，与 src/index.ts 的 dshPackageJsonCandidates 同序）：
 * install-anchor（profileContext.installAnchor）→ runtime-anchor（asar / 解包 app）→ profiles-tree。
 * 调用方显式给了 dshPackageJsonCandidates 时，它**就是**权威清单（标签 anchor）。
 */
function authoritativePlans(options: SessionVerifyOptions): { label: string; candidates: string[] }[] {
  if (options.dshPackageJsonCandidates !== undefined) return [{ label: 'anchor', candidates: [...options.dshPackageJsonCandidates] }];
  const plans: { label: string; candidates: string[] }[] = [];
  if (options.installAnchor !== undefined && options.installAnchor !== '') plans.push({ label: 'install-anchor', candidates: [options.installAnchor] });
  const env = envInstallAnchorCandidates();
  if (env.length > 0) plans.push({ label: 'env-anchor', candidates: env });
  const runtime = runtimeAnchorCandidates();
  if (runtime.length > 0) plans.push({ label: 'runtime-anchor', candidates: runtime });
  const profiles = profileCandidates(options.homeDir, options.profile);
  if (profiles.length > 0) plans.push({ label: 'profiles-tree', candidates: profiles });
  return plans;
}

/**
 * 权威「已装 DSH 格式版本」：按 [installAnchor → 运行时锚点(asar/app) → <home>/profiles/**] 顺序，取第一个
 * 读得出来的 @deepseek-ai/dsh-session 常量（与 utils/session-format.ts 的 resolveSessionFormatVersion 同源同序）。
 * 读不到 → undefined：**不猜**，调用方据此直接判 unavailable。
 *
 * V2-F2 修复点：**绝不拿被判定的那个 catalog 候选自己那棵树当权威**。旧实现用 readSessionFormatVersionAt(候选根)
 * 自证，于是磁盘上 0.1.5-rc.2 那棵树（currentVersion 3）把 v3 日志标成「现役读盘可读」，而真实运行的 DSH 是 v4
 * （asar 里的 0.2.0）—— 同一输入在新/旧进程给出不同代际结论，且对运行环境不诚实。
 */
async function resolveAuthoritativeVersion(options: SessionVerifyOptions): Promise<{ version?: number; tried: string[] }> {
  const tried: string[] = [];
  for (const plan of authoritativePlans(options)) {
    for (const root of nodeModulesRootsFor(plan.candidates)) {
      // 磁盘树优先（解包 app / 档案树），asar 容器内的同树常量走只读读取器（缺口⑤）
      const version = readSessionFormatVersionAt(root) ?? (await readSessionFormatVersionInAsar(root));
      if (version !== undefined) return { version, tried };
    }
    tried.push(plan.label);
  }
  return { tried };
}

/* ------------------------------------------------------------------ asar 容器 */

/**
 * 把「可能位于 asar 容器内的路径」拆成 <容器路径> + <容器内相对前缀>（POSIX）。
 * 只认以 `.asar` 结尾的路径段 —— `app.asar.unpacked` 不匹配（它的实体是普通目录）。
 */
export function splitAsarPath(p: string): { asarPath: string; innerPrefix: string } | undefined {
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const index = segments.findIndex((segment) => /\.asar$/i.test(segment));
  if (index < 0) return undefined;
  const leading = normalized.startsWith('/') ? '/' : '';
  return { asarPath: leading + segments.slice(0, index + 1).join('/'), innerPrefix: segments.slice(index + 1).join('/') };
}

/** 从 asar 里的 node_modules 根读同树 @deepseek-ai/dsh-session 的格式常量；读不到 → undefined（不猜）。 */
async function readSessionFormatVersionInAsar(root: string): Promise<number | undefined> {
  const split = splitAsarPath(root);
  if (split === undefined) return undefined;
  const rel = [...split.innerPrefix.split('/'), ...DSH_SESSION_PKG_REL.split('\\'), 'lib', 'index.js'].filter((part) => part !== '').join('/');
  try {
    const text = await readAsarTextEntry(split.asarPath, rel);
    return text === undefined ? undefined : parseSessionFormatVersion(text);
  } catch {
    return undefined;
  }
}

function existsSafe(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/**
 * runtime-anchor 候选落在 asar 容器里时的产品路径：把 catalog **及其依赖闭包**取出到缓存目录再 import。
 * 缓存被外部破坏（清单在、入口文件没了）时强制重解一次；一切失败都如实返回 undefined（判 unavailable）。
 */
async function extractCatalogFromAsar(split: { asarPath: string; innerPrefix: string }, options: SessionVerifyOptions): Promise<string | undefined> {
  const resolveFrom = split.innerPrefix === '' ? undefined : split.innerPrefix;
  const run = (refresh: boolean) => extractAsarPackages({
    asarPath: split.asarPath,
    packages: [CATALOG_PKG],
    ...(resolveFrom !== undefined ? { resolveFrom } : {}),
    ...(options.asarCacheDir !== undefined ? { cacheDir: options.asarCacheDir } : {}),
    ...(refresh ? { refresh: true } : {}),
  });
  try {
    for (const refresh of [false, true]) {
      const result = await run(refresh);
      if (!result.ok) return undefined;
      const entry = extractedEntryPath(result.dir, split.innerPrefix, CATALOG_ENTRY_IN_NM);
      if (existsSafe(entry)) return entry;
    }
    return undefined;
  } catch {
    // 读取器按纪律不 throw；这里只兜住不可预见的异常，一律如实判「取不出」
    return undefined;
  }
}

/** 装配一个候选模块（**与日志无关**的那一半判定）。 */
function assembleCandidate(
  mod: unknown,
  children: readonly unknown[],
): { ok: true; catalog: SessionVerifyCatalog; currentVersion: number; viaChildren: boolean } | { ok: false; code: string } {
  // 注意：官方 catalog 包**不导出模块级 createRestore**（导出的只有 createSessionFormatCatalogWithChildren /
  // sessionFormatCatalog / historicalSessionFormatCatalog 等），createRestore 是**装配出的 catalog 对象**上的方法
  // —— 所以这里只判「装配结果是不是一个带 createRestore 的 catalog」，别按模块级导出判（那会把真包判死）。
  const record = mod as Record<string, unknown>;
  const assemble = record['createSessionFormatCatalogWithChildren'];
  const viaChildren = typeof assemble === 'function';
  let catalog: unknown;
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
  if (typeof currentVersion !== 'number') return { ok: false, code: 'no-current-version' };
  return { ok: true, catalog, currentVersion, viaChildren };
}

/**
 * **每次调用都必须重跑**的、依赖本日志 header 的闸门（V2-F1 修复点）。
 *
 * 静态 catalog（模块没导出 children 版装配函数）在 v3→v4 边界绑不了 child 事实，只有「这份日志本来就等于它的
 * 现役代际」才是可信读盘，否则 unavailable(children-required)。**缓存命中也不例外** —— 旧实现命中缓存就直接
 * 返回（还丢掉了 currentVersion），于是同一份 v4 日志在同进程第二次调用会由「现役可读」翻成「迁移链可还原」，
 * 甚至把 v4 交给 v3 codec 判 decode-failed ⇒ 误回滚。
 */
function headerGateFailure(facts: { viaChildren: boolean; currentVersion: number }, headerVersion: unknown): string | undefined {
  if (facts.viaChildren) return undefined;
  return headerVersion === facts.currentVersion ? undefined : 'children-required';
}

/** 试一个候选根：缓存只提供「与日志无关的事实」，依赖 header 的闸门每次重跑。 */
function pickCandidate(
  mod: unknown,
  root: string,
  children: readonly unknown[],
  headerVersion: unknown,
  installedVersion: number,
  label: string,
  via?: 'asar-extract',
): { ok: true; resolution: CatalogResolution } | { ok: false; code: string } {
  let facts: CachedCandidate | undefined;
  if (children.length === 0) {
    const cached = catalogCache.get(root);
    // 权威版本变了（换锚点 / 装了别的）→ 缓存作废，重跑与日志无关的那一半
    if (cached !== undefined && cached.installedVersion === installedVersion) facts = cached;
  }
  if (facts === undefined) {
    const verdict = assembleCandidate(mod, children);
    if (!verdict.ok) return { ok: false, code: verdict.code };
    if (verdict.currentVersion !== installedVersion) return { ok: false, code: 'generation-mismatch' };
    facts = { catalog: verdict.catalog, currentVersion: verdict.currentVersion, viaChildren: verdict.viaChildren, installedVersion };
    if (children.length === 0) catalogCache.set(root, facts);
  }
  const gate = headerGateFailure(facts, headerVersion);
  if (gate !== undefined) return { ok: false, code: gate };
  return { ok: true, resolution: { catalog: facts.catalog, currentVersion: facts.currentVersion, installedVersion, detail: label, ...(via !== undefined ? { via } : {}) } };
}

/** 解析 catalog 的结果；detail 只放候选标签 + 失败码（**不放路径** —— 它会回传浏览器）。 */
interface CatalogResolution {
  catalog?: SessionVerifyCatalog;
  currentVersion?: number;
  installedVersion?: number;
  detail: string;
  /** 这条 catalog 是不是从 asar 容器取出后再 import 的（缺口⑤；透出到结果的 via 字段）。 */
  via?: 'asar-extract';
}

async function resolveCatalog(options: SessionVerifyOptions, headerVersion: unknown): Promise<CatalogResolution> {
  if (options.catalog === null) return { detail: 'catalog-disabled' };
  if (options.catalog !== undefined) {
    // 注入 catalog = 调用方声明「这就是判定用的本机 codec」⇒ 它的 currentVersion 即权威版本（不再另找）
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

  // 「已装版本」先**独立**解析（权威解析，与被判定的候选自己那棵树无关）；读不到 → 不猜（detail 带上试过的来源）
  const authority = await resolveAuthoritativeVersion(options);
  if (authority.version === undefined) {
    return { detail: authority.tried.length > 0 ? 'no-installed-version(' + authority.tried.join('+') + ')' : 'no-installed-version' };
  }
  const installedVersion = authority.version;

  // ① 裸模块（第一顺位）：已装插件自己依赖树里的那一份
  const bare = await importBareCatalog();
  if (bare === undefined) {
    note('bare-module', 'import-failed');
  } else {
    const root = bareCatalogRoot();
    if (root === undefined) {
      note('bare-module', 'no-version-anchor');
    } else {
      const picked = pickCandidate(bare, root, children, headerVersion, installedVersion, 'bare-module');
      if (picked.ok) return picked.resolution;
      note('bare-module', picked.code);
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
    const direct = join(plan.root, CATALOG_PKG_REL, CATALOG_ENTRY_REL);
    let entryFile = direct;
    let label = plan.label;
    let via: 'asar-extract' | undefined;
    if (!existsSafe(direct)) {
      // 直接路径不存在：若候选落在 asar 容器里，走只读读取器取出闭包再从缓存目录 import（缺口⑤）
      const split = splitAsarPath(plan.root);
      if (split === undefined) {
        note(plan.label, 'not-found');
        continue;
      }
      const extracted = await extractCatalogFromAsar(split, options);
      if (extracted === undefined) {
        note(plan.label, 'asar-extract-failed');
        continue;
      }
      entryFile = extracted;
      label = plan.label + '+asar-extract';
      via = 'asar-extract';
    }
    const mod = await importCatalogModule(entryFile);
    if (mod === undefined) {
      note(label, 'import-failed');
      continue;
    }
    const picked = pickCandidate(mod, plan.root, children, headerVersion, installedVersion, label, via);
    if (picked.ok) return picked.resolution;
    note(label, picked.code);
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
  const via = resolution.via !== undefined ? { via: resolution.via } : {};
  // 可选增强（不参与判定）：跑完整安装侧校验，用来区分「能读且干净」与「能读但语义不完全干净」
  const strong = runRestore(resolution.catalog, framed.header, framed.rows, 'current');
  if (strong.ok) return { verified: true, events: verdict.events, strong: true, equivalentToReadPath, ...via };
  return { verified: true, events: verdict.events, strong: false, strongDetail: strong.detail, equivalentToReadPath, ...via };
}
