/**
 * 崩溃检测 / 归因（灾备线按产品定位收敛后只保留检测与归因）。
 *
 * 背景：宿主启动时先读 `<dir>/boot-state.json`（本模块的 BootState），据此判断
 * 「上次启动是否走到过确认成功」：
 *   - 首次启动（无 boot-state）→ 不判崩溃；
 *   - `prev.ok !== true` → 上次没走到确认成功（进程被杀 / 启动即崩 / dispose 前未标记）→
 *     判崩溃，并按日志尾部签名归因（session 日志损坏 / bundle 声明缺失 / 插件树注册冲突）；
 *   - `prev.ok === true` → 上次正常。
 *  崩溃时给出「建议动作」枚举（advice）与「最近确认正常时刻」（lastGoodAt）；具体怎么恢复
 *  由用户在事故恢复页选择（进入救援模式 / 从备份恢复），本模块不自建恢复通道。
 *
 * 生命周期（宿主接线，本模块只提供纯函数与 IO 原语）：
 *   读 prev = readBootState(dir) → alert = computeBootAlert(prev, readCrashLogTail(...))
 *   → writeBootState(dir, beginBoot(pid, prev)) → 30 秒后 / dispose 时
 *   writeBootState(dir, markBootOk(state))。
 *
 * 与竞品 `boot-state.json` 机制的对应关系：同一份持久化字段、同一套日志签名、同样的
 * 「未确认成功即视为崩溃」判定；差别只在本模块**不产出任何用户可见文案**——全部返回
 * 枚举码（crashReason / advice），由宿主按应用语言映射到 `messages.ts`（建议键名形如
 * `crash.advice.restoreLastGood` / `crash.advice.repairSession` / `crash.advice.checkBundles`
 * / `crash.advice.checkPatchTree`，`advice === 'none'` 时无提示）。
 *
 * 纪律：
 *  - 只读读取绝不抛：缺失 / 损坏 / 结构非法一律返回 null；
 *  - 写入 best-effort：失败不抛（boot-state 只是诊断数据，绝不能反过来阻断启动）；
 *  - 写入经 Phase 1 `atomicWriteFile`（目标文件任意时刻要么旧完整、要么新完整）；
 *  - 本模块不执行恢复动作、不改 DSH 配置、不解析快照目录（避免与 restore.ts 循环依赖）；
 *  - 零 DSH 运行时依赖（仅 node 内置 + `../utils`），CLI 离线引擎可复用。
 *
 * 语义决策（两处刻意的「清理」行为，宿主若需展示历史崩溃原因请自行留存 alert）：
 *  - `computeBootAlert`：`crashed === false` 时 `crashReason` 恒为 null —— 健康启动不做崩溃
 *    归因（否则会把正常日志尾部误判成崩溃原因），`lastGoodAt` 另行原样带出；
 *  - `markBootOk`：确认成功时清空 `crashReason`，避免陈旧原因跨成功启动延续、
 *    在「成功 → 崩溃」序列里误传染下一次崩溃的归因。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { parseJsonSafe } from '../utils/json.ts';

// ---------- 常量 ----------

/** boot-state 文件名（位于 <dir> 之下）。 */
const BOOT_STATE_FILE = 'boot-state.json';

/** boot-state 所在目录名（相对插件数据目录 dataDir）。与任何快照库无关。 */
export const BOOT_STATE_DIR_NAME = 'boot-state';

/** 历史位置：boot-state 曾寄存在灾备快照库目录里（老用户升级时的搬迁来源）。 */
export const LEGACY_BOOT_STATE_DIR_NAME = 'config-snapshots';

/** 日志尾部默认读取字节数（256 KiB）。 */
const DEFAULT_LOG_TAIL_BYTES = 262144;

/** 候选日志所在子目录（<homeDir>/logs/*.log）。 */
const LOGS_DIR_NAME = 'logs';

/** 主日志文件名（<homeDir>/dsh.log）。 */
const MAIN_LOG_FILE = 'dsh.log';

/** 日志文件后缀（大小写不敏感）。 */
const LOG_SUFFIX = '.log';



/** 合法崩溃原因（读盘校验用；与 CrashKind 联合类型保持一一对应）。 */
const CRASH_KINDS: readonly CrashKind[] = ['session-corrupt', 'bundle-check', 'patch-tree', 'unknown'];

// ---------- 类型 ----------

/** 上次启动结果（持久化到 <dir>/boot-state.json）。 */
export interface BootState {
  /** 本次启动开始时刻（ISO 字符串）。 */
  startedAt: string;
  /** 启动进程 pid。 */
  pid: number;
  /** 本次启动是否已判定成功。 */
  ok: boolean;
  /** 判定成功的时刻；未成功为 null。 */
  okAt: string | null;
  /** 最近一次「确认正常」的时刻（成功启动时推进）。 */
  lastGoodAt: string | null;
  /** 崩溃原因归因；无归因为 null。 */
  crashReason: CrashKind | null;
}

/** 崩溃原因分类（日志尾部签名 → 枚举；无匹配为 unknown）。 */
export type CrashKind = 'session-corrupt' | 'bundle-check' | 'patch-tree' | 'unknown';

/** 本次启动的 boot alert（结构化判定结果，无用户文案）。 */
export interface BootAlert {
  /** 是否判定为「上次启动崩溃」。 */
  crashed: boolean;
  /** 最近一次确认正常的时刻（供「恢复最后正常快照」使用）。 */
  lastGoodAt: string | null;
  /** 崩溃原因；未崩溃或无证据为 null。 */
  crashReason: CrashKind | null;
  /** 建议用户采取的动作，枚举而非文案。 */
  advice: CrashAdvice;
}

/** 建议动作（枚举码；文案由宿主 i18n 决定）。 */
export type CrashAdvice =
  | 'none'
  | 'restore-last-good'
  | 'repair-session'
  | 'check-bundles'
  | 'check-patch-tree';

/** 崩溃原因 → 建议动作（crashed=false 时恒为 'none'，不经此表）。 */
const ADVICE_BY_KIND: Record<CrashKind, CrashAdvice> = {
  'session-corrupt': 'repair-session',
  'bundle-check': 'check-bundles',
  'patch-tree': 'check-patch-tree',
  'unknown': 'restore-last-good',
};

// ---------- 日志签名（与竞品 boot-state.json 机制逐字对齐） ----------

/** 会话日志损坏：Zstandard 压缩的 session 日志读不出来（写入被中断）。 */
const SESSION_CORRUPT_RE = /corrupt Zstandard session log/i;

/** bundle 检查失败：profile 未声明 dsh.bundle / bundle 无法解析（插件包元数据被改坏）。 */
const BUNDLE_CHECK_RE = /declares no dsh\.bundle|cannot resolve profile bundle/i;

/** patch 树加载失败：重复注册 / loader 条目重复 / 插件加载失败 / 依赖缺失。 */
const PATCH_TREE_RE = /already registered|duplicate loader entry|failed to load plugin|cannot find (module|package)/i;

// ---------- 崩溃归因 ----------

/** 按日志尾部签名分类崩溃原因；无匹配返回 'unknown'。 */
export function classifyCrashLog(text: string): CrashKind {
  if (SESSION_CORRUPT_RE.test(text)) return 'session-corrupt';
  if (BUNDLE_CHECK_RE.test(text)) return 'bundle-check';
  if (PATCH_TREE_RE.test(text)) return 'patch-tree';
  return 'unknown';
}

/**
 * advice 由 crashReason 决定：session-corrupt→repair-session, bundle-check→check-bundles,
 * patch-tree→check-patch-tree, unknown→restore-last-good（crashReason 为 null 时同样
 * 回退 restore-last-good：崩溃但无归因证据，只有「回到最后正常」这一条稳妥动作）。
 * crashed=false 时 advice='none'。
 */
export function adviceFor(kind: CrashKind | null, crashed: boolean): CrashAdvice {
  if (!crashed) return 'none';
  if (kind === null) return 'restore-last-good';
  // 防御：磁盘上的值理论上已校验，运行时仍可能越界 → 保守回退「恢复最后正常快照」
  return ADVICE_BY_KIND[kind] ?? 'restore-last-good';
}

// ---------- boot-state 读写 ----------

/** 普通对象判定（数组 / null / 原始值均不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** crashReason 是否为合法枚举值。 */
function isCrashKind(value: unknown): value is CrashKind {
  return typeof value === 'string' && CRASH_KINDS.includes(value as CrashKind);
}

/** 可空字符串字段校验（null 合法；缺失/其它类型非法）。 */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * 结构校验：只有完整且类型正确的对象才算 BootState（不做字段值语义校验 —— 时间戳是否
 * 可解析由消费方决定，避免把「格式怪但可用」的旧数据判死）。
 */
function parseBootState(value: unknown): BootState | null {
  if (!isRecord(value)) return null;
  const { startedAt, pid, ok, okAt, lastGoodAt, crashReason } = value;
  if (typeof startedAt !== 'string') return null;
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return null;
  if (typeof ok !== 'boolean') return null;
  if (!isNullableString(okAt)) return null;
  if (!isNullableString(lastGoodAt)) return null;
  if (crashReason !== null && !isCrashKind(crashReason)) return null;
  return { startedAt, pid, ok, okAt, lastGoodAt, crashReason };
}

/** 只读读取 boot-state；缺失/损坏/非法一律返回 null（绝不抛）。 */
export async function readBootState(dir: string): Promise<BootState | null> {
  try {
    const text = await fs.readFile(path.join(dir, BOOT_STATE_FILE), 'utf8');
    return parseBootState(parseJsonSafe(text));
  } catch {
    // 文件缺失 / 非法 JSON / 读权限 → 与「无 boot-state」同义：不判崩溃
    return null;
  }
}

/**
 * 原子写入 boot-state（用 ../utils/atomic-write.ts 的 atomicWriteFile）。失败不抛。
 * 只落盘 BootState 的六个已知字段（避免调用方对象上的额外字段进入持久化文件）。
 */
export async function writeBootState(dir: string, state: BootState): Promise<void> {
  const persisted: BootState = {
    startedAt: state.startedAt,
    pid: state.pid,
    ok: state.ok,
    okAt: state.okAt,
    lastGoodAt: state.lastGoodAt,
    crashReason: state.crashReason,
  };
  try {
    await atomicWriteFile(path.join(dir, BOOT_STATE_FILE), `${JSON.stringify(persisted, null, 2)}\n`);
  } catch {
    // boot-state 只是诊断数据：写入失败绝不影响启动/恢复主流程
  }
}

/**
 * 把旧位置的 boot-state 搬到新目录（一次性、幂等、best-effort）。
 *
 * 背景：boot-state 曾寄生在 <dataDir>/config-snapshots/（灾备快照库目录）。灾备线收敛
 * 下线后 boot-state 搬到独立目录，老用户那份可用状态若直接不读，会表现为「丢失上次是否
 * 正常」的记录（首次判定退化为无记录）。因此启动时补一次搬迁：
 *  新目录已有 → 不动；旧目录有可用状态且新目录没有 → 原样搬过去。
 *
 * 纪律：只读旧、只写新；任何失败都不抛（返回 false），绝不影响启动。
 */
export async function adoptLegacyBootState(legacyDir: string, dir: string): Promise<boolean> {
  if (legacyDir === dir) return false;
  try {
    if ((await readBootState(dir)) !== null) return false;
    const legacy = await readBootState(legacyDir);
    if (legacy === null) return false;
    await writeBootState(dir, legacy);
    return true;
  } catch {
    return false;
  }
}


// ---------- boot alert ----------

/**
 * 计算本次启动的 boot alert。
 * - prev 为 null（首次启动）→ crashed=false，lastGoodAt=null，crashReason=null，advice='none'；
 * - prev.ok !== true → crashed=true（上次没走到「确认成功」）；
 * - crashReason 优先沿用 prev.crashReason（上次已算过），否则若给了 logTail 就用 classifyCrashLog；
 * - crashed=false 时 crashReason 恒为 null（健康启动不做归因，见文件头「语义决策」）。
 */
export function computeBootAlert(prev: BootState | null, logTail: string | null): BootAlert {
  if (prev === null) {
    return { crashed: false, lastGoodAt: null, crashReason: null, advice: 'none' };
  }
  const crashed = prev.ok !== true;
  const lastGoodAt = prev.lastGoodAt ?? null;
  if (!crashed) {
    return { crashed: false, lastGoodAt, crashReason: null, advice: 'none' };
  }
  const hasLog = logTail !== null && logTail.trim() !== '';
  const crashReason = prev.crashReason ?? (hasLog ? classifyCrashLog(logTail) : null);
  return { crashed: true, lastGoodAt, crashReason, advice: adviceFor(crashReason, true) };
}

// ---------- 候选日志与尾部读取 ----------

/** 读单个文件尾部（最多 maxBytes）；不可读/为空返回 null。 */
async function readFileTail(file: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size <= 0) return null;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    return text.length > 0 ? text : null;
  } catch {
    // 不存在 / 无权限 / 是目录 / 读取竞态 → 该候选不可用，由调用方试下一个
    return null;
  } finally {
    if (handle !== null) {
      try { await handle.close(); } catch { /* 关闭失败无需处理 */ }
    }
  }
}

/**
 * 从候选日志文件里读尾部（最多 maxBytes，默认 262144），返回第一个非空日志的文本；
 * 无则 null。单个候选不可读（不存在/无权限/是目录）不抛，直接跳到下一个。
 */
export async function readCrashLogTail(
  candidates: readonly string[],
  maxBytes: number = DEFAULT_LOG_TAIL_BYTES,
): Promise<string | null> {
  const limit = Math.floor(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  for (const candidate of candidates) {
    const text = await readFileTail(candidate, limit);
    if (text !== null) return text;
  }
  return null;
}

/** 路径是否为可读常规文件（跟随 symlink；不存在/是目录 → false）。 */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出候选日志路径：`<homeDir>/logs/*.log`（按文件名字典序，稳定可测）与
 * `<homeDir>/dsh.log`（存在才纳入）。`logs` 目录不存在/不可读时返回空数组
 * —— 与「无候选日志」同义（不抛）。
 */
export async function listCandidateLogs(homeDir: string): Promise<string[]> {
  const out: string[] = [];
  const logsDir = path.join(homeDir, LOGS_DIR_NAME);
  let names: string[];
  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    names = entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(LOG_SUFFIX))
      .map((e) => e.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
  for (const name of names) out.push(path.join(logsDir, name));
  const main = path.join(homeDir, MAIN_LOG_FILE);
  if (await isFile(main)) out.push(main);
  return out;
}


// ---------- 启动生命周期辅助 ----------

/** 启动生命周期辅助：apply 时调用一次，写「正在启动」（ok:false）。 */
export function beginBoot(pid: number, prev: BootState | null, now: () => Date = () => new Date()): BootState {
  return {
    startedAt: now().toISOString(),
    pid,
    ok: false,
    okAt: null,
    // 未确认成功前，「最近正常」与「上次崩溃归因」都从上一次状态延续
    lastGoodAt: prev?.lastGoodAt ?? null,
    crashReason: prev?.crashReason ?? null,
  };
}

/**
 * 30 秒后 / dispose 时调用：标记成功并推进 lastGoodAt（ok:true、okAt=lastGoodAt=now）。
 * 同时清空 crashReason：本次启动已确认正常，陈旧归因不得延续到下一次崩溃判定。
 */
export function markBootOk(state: BootState, now: () => Date = () => new Date()): BootState {
  const iso = now().toISOString();
  return { ...state, ok: true, okAt: iso, lastGoodAt: iso, crashReason: null };
}
