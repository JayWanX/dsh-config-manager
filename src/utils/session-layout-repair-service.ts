/**
 * 面板侧「布局归位 / 重复 id 隔离」写入口（宿主服务，E1）。
 *
 * 为什么需要：`location-mismatch` / `duplicate-id` 是**最严重**的一档（DSH 会直接拒绝启动：
 * `corrupt session log` / `duplicate JSONL session id`），而在此之前只有离线 CLI
 * `dcm sessions repair --fix` 与离线救急台能做 —— 面板只能检出、没有修复入口。
 *
 * ── 复用纪律（不得重写，这是本模块的全部价值）────────────────────────────────
 *  · 规划器 = `core/session-repair.ts` 的 `planSessionRepair`（动作种类 / 摘要 / `applies` / `reason` 逐条照用）；
 *  · 写入原语 = `utils/session-log.ts` 的 `rewriteSessionLogDir` / `readLogFileCwd` / `PROJECT_KEY_RE`
 *    / `sessionLogNames`（宿主适配器与 CLI 的唯一实现）；
 *  · 语义与 CLI `runSessionsRepair`（src/cli/sessions-repair.ts）逐条一致：quarantine 目标
 *    `<home>/sessions/.cm-repair-quarantine-<stamp>/<fromProjectKey>/<sessionId>`、`keep` 语义、
 *    「改写失败就不搬目录」、失败逐条计数并**回滚**（改写回原值 + 搬回原位）；
 *  · **本模块禁止 import src/cli/**（CLI 是离线通道，宿主侧不复用它的 IO 与文案）。
 *
 * ── 安全模型（与 CLI 的差异必须写清，不许让用户以为两者相同）──────────────────
 *  CLI 要求「**DSH 已停止**」；面板**不可能**满足（面板就跑在 DSH 里）。因此面板入口采用与
 * 「应用内字节级修复」（`utils/session-repair-service.ts`）**同一套门模型**：
 *  ① 路由层过 SAFE MODE + mutation lock（与导入/恢复互斥）；
 *  ② **逐目标**前置：unit 目录内无 `session.lock`、日志不在 30s 静止期内（同一常量
 *     `SESSION_REPAIR_QUIESCENT_MS`，与字节级门同口径）；
 *  ③ 每次移动/改写后**必须** `reindexSessionHeader` 成功（否则运行中的 DSH 看到陈旧/错位状态，
 *     历史事故就是 `corrupt session log` / 同 id 出现在两个 projectKey）；
 *  ④ 刷新失败 / 搬不动 / 目标已存在 → **该条回滚**并如实汇报（绝不静默成功）。
 *  依据：导入链（`SessionsAdapter.finalizeApply`）本来就在 DSH 运行时做同类「改写首帧 + 归位 + 刷新」操作。
 *
 * ── 面板侧额外护栏（合法输入下仍与 CLI 逐字等价）────────────────────────────
 *  · 重复 id 的 `keep` 必须由调用方**显式给出**，且必须指向该 id 的**已扫描副本**之一；
 *    否则该 id 一律拒绝执行（CLI 里 `--keep` 指错路径会把**所有**副本都隔离 —— 面板不能继承这个脚坑）；
 *  · 被 `keep` 点名保留的那一份本轮**不动**（core 的语义：只报 `keep`，与 CLI 同）；
 *  · 入口不支持路径映射（CLI 的 `--map` 仍可用）⇒ `rewrite` 恒缺席，响应不含任何绝对路径；
 *    `quarantineDir` / `movedUnitId` 都是**相对**身份（相对 `<home>/sessions`）。
 */
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { planSessionRepair, sessionRepairNeedsAttention } from '../core/session-repair.ts';
import type {
  RepairSessionInput,
  SessionRepairAction,
  SessionRepairActionKind,
  SessionRepairPlan,
  SessionRepairReason,
  SessionRepairSummary,
} from '../core/session-repair.ts';
import type { PathMappingRule } from '../core/path-mapping.ts';
import { PROJECT_KEY_RE, readLogFileCwd, rewriteSessionLogDir, sessionLogNames } from './session-log.ts';
import { SESSION_REPAIR_QUIESCENT_MS } from './session-repair-service.ts';

/* ------------------------------------------------------------------ 类型 */

/** 计划里的一个动作（**不含绝对路径**：身份用 `<fromProjectKey>/<sessionId>`）。 */
export interface SessionLayoutPlanItem {
  unitId: string;
  sessionId: string;
  kind: SessionRepairActionKind;
  fromProjectKey: string;
  toProjectKey?: string;
  /** 需要改写首帧 cwd（面板入口不支持映射 ⇒ 恒缺席；字段与 core 同形，留给以后） */
  rewrite?: { from: string; to: string };
  reason: SessionRepairReason;
  /** 是否真的落盘（false = 只报告：缺 cwd / 加锁 / 未点名 keep 的重复项） */
  applies: boolean;
}

export interface SessionLayoutPlan {
  ok: boolean;
  /** 只读计划：`POST /sessions/layout` 在 apply!==true 时只调这里，**零写入** */
  readOnly: true;
  /** 会话根读不出来（机器码；不含绝对路径） */
  reason?: 'sessions-root-unreadable';
  summary: SessionRepairSummary;
  actions: SessionLayoutPlanItem[];
  /** 与 core `sessionRepairNeedsAttention` 同源；另把「keep 被拒」也算作需要介入 */
  needsAttention: boolean;
  /** 有重复 id 但调用方未点名（或 keep 指向非候选副本）的 sessionId —— 面板据此要求用户选保留哪一份 */
  needsKeep: string[];
}

/** 逐条失败/拒绝的机器可读原因。 */
export type SessionLayoutApplyReason =
  | 'locked'
  | 'busy'
  | 'no-cwd'
  | 'inconsistent-generations'
  | 'missing-keep'
  | 'keep-not-a-candidate'
  | 'target-exists'
  | 'quarantine-exists'
  | 'rewrite-failed'
  | 'missing-target-key'
  | 'move-failed'
  | 'reindex-failed'
  | 'not-found'
  | 'io-error';

export interface SessionLayoutApplyItem {
  unitId: string;
  sessionId: string;
  action: SessionRepairActionKind;
  ok: boolean;
  reason?: SessionLayoutApplyReason;
  /** 隔离去向（**相对 `<home>/sessions`**；不含绝对路径） */
  quarantineDir?: string;
  /** 归位后的新身份 `<toProjectKey>/<sessionId>` */
  movedUnitId?: string;
  /** 失败后是否已成功回滚（回到原状态） */
  rolledBack?: boolean;
  /** 该条需要用户介入（被门拒绝 / 无法判定 / 失败） */
  needsAttention?: boolean;
}

export interface SessionLayoutApplyResult {
  ok: boolean;
  applied: number;
  failed: number;
  skipped: number;
  results: SessionLayoutApplyItem[];
  /** 整体未执行的机器码（没有刷新端口 / 会话根读不出来） */
  reason?: 'reindex-unavailable' | 'sessions-root-unreadable';
}

export interface SessionLayoutPlanOptions {
  homeDir: string;
  /** sessionId → 要保留的副本 unitId（`<projectKey>/<sessionId>`）；缺 = 该 id 的重复项一律拒绝执行 */
  keep?: Record<string, string>;
  /**
   * 可选路径映射（CLI `--map` 语义，逐条交给 core 规划器）。**面板入口暂不暴露** ⇒ 缺省无映射、
   * `rewrite` 恒缺席（响应因此不含任何绝对路径）；留给以后需要「跨机重定基后归位」的调用方。
   */
  mappings?: readonly PathMappingRule[];
}

export interface SessionLayoutApplyOptions extends SessionLayoutPlanOptions {
  /** 只处理这些 unitId（缺省 = 计划里全部可执行项） */
  unitIds?: readonly string[];
  /**
   * 宿主注入的索引刷新（`SessionStoreFacade.reindexSessionHeader`）。
   * **缺省 = 一条也不执行**（如实拒绝：没有刷新能力就不动盘，否则运行中的 DSH 会看到错位状态）。
   */
  reindex?: (sessionId: string) => Promise<boolean>;
  /** 注入当前时间（静止期判定；测试固定用） */
  now?: () => Date;
  /** 测试注入隔离目录时间戳；缺省 = ISO 时间戳（与 CLI 同形：`:`/`.` 换成 `-`） */
  stamp?: string;
  /**
   * 改写原语（缺省 = `utils/session-log.ts` 的 `rewriteSessionLogDir`）。
   * 只为**故障注入测试**存在（「改写失败 → 不搬目录 / 回滚」这条路径否则无法覆盖）。
   */
  rewriteDir?: (dir: string, newCwd: string) => Promise<{ ok: boolean; reason?: string }>;
}

/* --------------------------------------------------------------- 只读扫描 */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 扫描 `<home>/sessions`：projectKey 段 → 会话目录 → 首帧 cwd（与 CLI `scanSessions` 同款判据）。 */
async function scanSessions(sessionsRoot: string): Promise<RepairSessionInput[] | undefined> {
  const out: RepairSessionInput[] = [];
  let projectDirs: import('node:fs').Dirent[];
  try {
    projectDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    // 读不出来（不存在 / 不是目录 / EACCES）→ 调用方按「无法判定」处理，绝不猜
    return undefined;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const projectKey = entry.name;
    if (!PROJECT_KEY_RE.test(projectKey)) continue; // 隔离目录等非 projectKey 形状一律跳过
    const projectDir = join(sessionsRoot, projectKey);
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const dir = join(projectDir, sessionEntry.name);
      let names: string[];
      try {
        names = sessionLogNames(await fs.readdir(dir));
      } catch {
        continue;
      }
      if (names.length === 0) continue;
      const cwds: string[] = [];
      for (const name of names) {
        const cwd = await readLogFileCwd(join(dir, name));
        if (cwd !== undefined && !cwds.includes(cwd)) cwds.push(cwd);
      }
      const locked = await exists(join(dir, 'session.lock'));
      out.push({
        sessionId: sessionEntry.name,
        fromProjectKey: projectKey,
        dir,
        ...(cwds.length > 0 ? { cwd: cwds[0] } : {}),
        consistent: cwds.length <= 1,
        ...(locked ? { locked: true } : {}),
      });
    }
  }
  return out;
}

function zeroSummary(): SessionRepairSummary {
  return { scanned: 0, ok: 0, move: 0, rewriteMove: 0, skip: 0, keep: 0, quarantine: 0, duplicates: 0 };
}

function mergeSummary(into: SessionRepairSummary, from: SessionRepairSummary): void {
  into.scanned += from.scanned;
  into.ok += from.ok;
  into.move += from.move;
  into.rewriteMove += from.rewriteMove;
  into.skip += from.skip;
  into.keep += from.keep;
  into.quarantine += from.quarantine;
  into.duplicates += from.duplicates;
}

/** `<projectKey>/<sessionId>` → 绝对目录；形状不合法 / 越界 → undefined（绝不拼出会话根之外的路径）。 */
function unitIdToDir(sessionsRoot: string, unitId: string): string | undefined {
  const at = unitId.indexOf('/');
  if (at <= 0 || at === unitId.length - 1) return undefined;
  const projectKey = unitId.slice(0, at);
  const sessionId = unitId.slice(at + 1);
  if (!PROJECT_KEY_RE.test(projectKey)) return undefined;
  if (sessionId.includes('/') || sessionId.includes(String.fromCharCode(92))) return undefined;
  if (sessionId === '.' || sessionId === '..') return undefined;
  return join(sessionsRoot, projectKey, sessionId);
}

/** 内部计划：core 动作（带绝对 `dir`）+ 视图所需信息；`dir` **绝不进响应**。 */
interface InternalPlan {
  ok: boolean;
  reason?: 'sessions-root-unreadable';
  summary: SessionRepairSummary;
  actions: SessionRepairAction[];
  duplicateIds: Set<string>;
  keptIds: Set<string>;
  keepRejected: Map<string, SessionLayoutApplyReason>;
}

const EMPTY_INTERNAL: InternalPlan = {
  ok: false,
  reason: 'sessions-root-unreadable',
  summary: zeroSummary(),
  actions: [],
  duplicateIds: new Set(),
  keptIds: new Set(),
  keepRejected: new Map(),
};

/** 解析 keep（sessionId → 要保留的副本）→ 绝对目录；指向非候选副本的一律拒绝。 */
function resolveKeeps(
  sessionsRoot: string,
  scanned: readonly RepairSessionInput[],
  keep: Record<string, string> | undefined,
): Map<string, string> {
  const keepDirs = new Map<string, string>();
  if (keep === undefined) return keepDirs;
  const candidatesById = new Map<string, Set<string>>();
  for (const session of scanned) {
    const set = candidatesById.get(session.sessionId) ?? new Set<string>();
    set.add(session.dir);
    candidatesById.set(session.sessionId, set);
  }
  for (const [sessionId, unitId] of Object.entries(keep)) {
    const dir = unitIdToDir(sessionsRoot, unitId);
    if (dir === undefined) continue;
    const candidates = candidatesById.get(sessionId);
    // keep 指错位置：CLI 会把**所有**副本都隔离；面板侧宁可不动（该 id 在视图里进 needsKeep）
    if (candidates === undefined || !candidates.has(dir)) continue;
    keepDirs.set(sessionId, dir);
  }
  return keepDirs;
}

/**
 * 规划（**只读**，零写入）：扫描 + `planSessionRepair`。
 *
 * 关于 keep 的多条：core 的 `options.keep` 是**单值**（CLI `--keep <dir>` 语义），面板可能同时处理
 * 多个重复 id ⇒ 按 sessionId 分组调用（有 keep 的组单独规划），再合并 actions/summary
 * （计数可加；每个重复组只计一次 duplicates，与单趟等价），最后按扫描顺序稳定排序。
 */
async function planInternal(options: SessionLayoutPlanOptions): Promise<InternalPlan> {
  const sessionsRoot = join(options.homeDir, 'sessions');
  const scanned = await scanSessions(sessionsRoot);
  if (scanned === undefined) return EMPTY_INTERNAL;
  const keepDirs = resolveKeeps(sessionsRoot, scanned, options.keep);
  const order = new Map<string, number>();
  scanned.forEach((session, index) => { if (!order.has(session.dir)) order.set(session.dir, index); });

  const groups = new Map<string, RepairSessionInput[]>();
  for (const session of scanned) {
    const list = groups.get(session.sessionId);
    if (list === undefined) groups.set(session.sessionId, [session]);
    else list.push(session);
  }
  const duplicateIds = new Set<string>();
  for (const [sessionId, list] of groups) { if (list.length > 1) duplicateIds.add(sessionId); }

  const merged: SessionRepairPlan = { actions: [], summary: zeroSummary() };
  const handled = new Set<string>();
  const keptIds = new Set<string>();
  for (const [sessionId, list] of groups) {
    if (!duplicateIds.has(sessionId)) continue;
    const keepDir = keepDirs.get(sessionId);
    if (keepDir === undefined) continue; // 未点名 keep：并入主规划（quarantine 项 applies:false）
    const sub = planSessionRepair(list, { keep: keepDir, ...(options.mappings !== undefined ? { mappings: options.mappings } : {}) });
    mergeSummary(merged.summary, sub.summary);
    merged.actions.push(...sub.actions);
    handled.add(sessionId);
    keptIds.add(sessionId);
  }
  const rest = scanned.filter((session) => !handled.has(session.sessionId));
  const main = planSessionRepair(rest, options.mappings !== undefined ? { mappings: options.mappings } : {});
  mergeSummary(merged.summary, main.summary);
  merged.actions.push(...main.actions);
  merged.actions.sort((a, b) => (order.get(a.dir) ?? 0) - (order.get(b.dir) ?? 0));

  // keep 被拒（指向非候选副本 / 形状非法）且该 id 确实有重复 → 该 id 拒绝执行并说明
  const keepRejected = new Map<string, SessionLayoutApplyReason>();
  if (options.keep !== undefined) {
    for (const sessionId of Object.keys(options.keep)) {
      if (!duplicateIds.has(sessionId) || keptIds.has(sessionId)) continue;
      keepRejected.set(sessionId, 'keep-not-a-candidate');
    }
  }
  return { ok: true, summary: merged.summary, actions: merged.actions, duplicateIds, keptIds, keepRejected };
}

/** 计划视图（剥离绝对路径）：`POST /sessions/layout` 的 `apply!==true` 分支只调它。 */
export async function planSessionLayoutRepair(options: SessionLayoutPlanOptions): Promise<SessionLayoutPlan> {
  const internal = await planInternal(options);
  if (!internal.ok) {
    return { ok: false, readOnly: true, reason: 'sessions-root-unreadable', summary: internal.summary, actions: [], needsAttention: false, needsKeep: [] };
  }
  const actions: SessionLayoutPlanItem[] = internal.actions.map((action) => ({
    unitId: action.fromProjectKey + '/' + action.sessionId,
    sessionId: action.sessionId,
    kind: action.kind,
    fromProjectKey: action.fromProjectKey,
    ...(action.toProjectKey !== undefined ? { toProjectKey: action.toProjectKey } : {}),
    ...(action.rewrite !== undefined ? { rewrite: { from: action.rewrite.from, to: action.rewrite.to } } : {}),
    reason: action.reason,
    applies: action.applies,
  }));
  const needsKeep = [...internal.duplicateIds]
    .filter((sessionId) => !internal.keptIds.has(sessionId))
    .sort();
  const plan: SessionRepairPlan = { actions: internal.actions, summary: internal.summary };
  return {
    ok: true,
    readOnly: true,
    summary: internal.summary,
    actions,
    needsAttention: sessionRepairNeedsAttention(plan) || internal.keepRejected.size > 0,
    needsKeep,
  };
}

/* ------------------------------------------------------------------- 应用 */

function defaultStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 逐目标前置门（与字节级门同一口径）：目录无 session.lock + 日志不在静止期内。 */
async function gateForTarget(dir: string, nowMs: number): Promise<'ok' | 'locked' | 'busy' | 'not-found'> {
  if (await exists(join(dir, 'session.lock'))) return 'locked';
  let names: string[];
  try {
    names = sessionLogNames(await fs.readdir(dir));
  } catch {
    return 'not-found';
  }
  let newest: number | undefined;
  for (const name of names) {
    try {
      const st = await fs.stat(join(dir, name));
      if (!st.isFile()) continue;
      if (newest === undefined || st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      continue;
    }
  }
  if (newest === undefined) return 'not-found';
  if (nowMs - newest < SESSION_REPAIR_QUIESCENT_MS) return 'busy';
  return 'ok';
}

/** 尽力搬回（回滚用）；原位置空出来才算成功。 */
async function moveIfPossible(from: string, to: string): Promise<boolean> {
  try {
    if (!(await exists(from)) || await exists(to)) return false;
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.rename(from, to);
    return (await exists(to)) && !(await exists(from));
  } catch {
    return false;
  }
}

function itemOf(action: SessionRepairAction): SessionLayoutApplyItem {
  return { unitId: action.fromProjectKey + '/' + action.sessionId, sessionId: action.sessionId, action: action.kind, ok: false };
}

async function quarantineOne(
  action: SessionRepairAction,
  sessionsRoot: string,
  stamp: string,
  nowMs: number,
  reindex: (sessionId: string) => Promise<boolean>,
): Promise<SessionLayoutApplyItem> {
  const item = itemOf(action);
  const gate = await gateForTarget(action.dir, nowMs);
  if (gate !== 'ok') return { ...item, reason: gate, needsAttention: true };
  const rel = '.cm-repair-quarantine-' + stamp + '/' + action.fromProjectKey + '/' + action.sessionId;
  const target = join(sessionsRoot, '.cm-repair-quarantine-' + stamp, action.fromProjectKey, action.sessionId);
  try {
    if (await exists(target)) return { ...item, reason: 'quarantine-exists', needsAttention: true };
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.rename(action.dir, target);
    if (!(await exists(target)) || await exists(action.dir)) {
      const back = await moveIfPossible(target, action.dir);
      return { ...item, reason: 'move-failed', rolledBack: back, needsAttention: true };
    }
    const refreshed = await reindex(action.sessionId).catch(() => false);
    if (!refreshed) {
      const back = await moveIfPossible(target, action.dir);
      return { ...item, reason: 'reindex-failed', rolledBack: back, needsAttention: true };
    }
    return { ...item, ok: true, quarantineDir: rel };
  } catch {
    const back = await moveIfPossible(target, action.dir);
    return { ...item, reason: 'io-error', ...(back ? { rolledBack: true } : {}), needsAttention: true };
  }
}

async function moveOne(
  action: SessionRepairAction,
  sessionsRoot: string,
  nowMs: number,
  reindex: (sessionId: string) => Promise<boolean>,
  rewriteDir: (dir: string, newCwd: string) => Promise<{ ok: boolean; reason?: string }>,
): Promise<SessionLayoutApplyItem> {
  const item = itemOf(action);
  const gate = await gateForTarget(action.dir, nowMs);
  if (gate !== 'ok') return { ...item, reason: gate, needsAttention: true };
  let rewritten = false;
  const rollbackRewrite = async (): Promise<boolean> => {
    if (!rewritten || action.rewrite === undefined) return true;
    const back = await rewriteDir(action.dir, action.rewrite.from);
    return back.ok;
  };
  if (action.rewrite !== undefined) {
    const r = await rewriteDir(action.dir, action.rewrite.to);
    if (!r.ok) return { ...item, reason: 'rewrite-failed', needsAttention: true };
    rewritten = true;
  }
  if (action.toProjectKey === undefined) {
    const back = await rollbackRewrite();
    return { ...item, reason: 'missing-target-key', ...(rewritten ? { rolledBack: back } : {}), needsAttention: true };
  }
  const targetDir = join(sessionsRoot, action.toProjectKey, action.sessionId);
  try {
    if (await exists(targetDir)) {
      const back = await rollbackRewrite();
      return { ...item, reason: 'target-exists', ...(rewritten ? { rolledBack: back } : {}), needsAttention: true };
    }
    await fs.mkdir(dirname(targetDir), { recursive: true });
    await fs.rename(action.dir, targetDir);
    if (!(await exists(targetDir)) || await exists(action.dir)) {
      const backMove = await moveIfPossible(targetDir, action.dir);
      const backRewrite = await rollbackRewrite();
      return { ...item, reason: 'move-failed', rolledBack: backMove && backRewrite, needsAttention: true };
    }
    const refreshed = await reindex(action.sessionId).catch(() => false);
    if (!refreshed) {
      const backMove = await moveIfPossible(targetDir, action.dir);
      const backRewrite = await rollbackRewrite();
      return { ...item, reason: 'reindex-failed', rolledBack: backMove && backRewrite, needsAttention: true };
    }
    return { ...item, ok: true, movedUnitId: action.toProjectKey + '/' + action.sessionId };
  } catch {
    const backMove = await moveIfPossible(targetDir, action.dir);
    const backRewrite = await rollbackRewrite();
    return { ...item, reason: 'io-error', rolledBack: backMove && backRewrite, needsAttention: true };
  }
}

/**
 * 应用（逐条执行；失败逐条回滚）。
 *
 * 计数口径（与 CLI 的退出码同源）：`applied` = 真的写成/搬动的条数；`failed` = 被门拒绝 / 被护栏拒绝 /
 * 写失败（含回滚）的条数；`skipped` = 规划器判定「只报告」的条数（缺 cwd / 加锁 / 多 generation 不一致）。
 * `ok = failed === 0`。
 */
export async function applySessionLayoutRepair(options: SessionLayoutApplyOptions): Promise<SessionLayoutApplyResult> {
  if (options.reindex === undefined) {
    // 没有刷新能力就不动盘：宁可如实拒绝，也不让运行中的 DSH 看到错位状态
    return { ok: false, applied: 0, failed: 0, skipped: 0, results: [], reason: 'reindex-unavailable' };
  }
  const reindex = options.reindex;
  const internal = await planInternal(options);
  if (!internal.ok) return { ok: false, applied: 0, failed: 0, skipped: 0, results: [], reason: 'sessions-root-unreadable' };
  const sessionsRoot = join(options.homeDir, 'sessions');
  const wanted = options.unitIds !== undefined ? new Set(options.unitIds) : undefined;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const stamp = options.stamp ?? defaultStamp();
  const results: SessionLayoutApplyItem[] = [];
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  // keep 被拒（指向非候选副本）且该 id 有重复：补一条**显式拒绝**（core 不知道 keep 解析失败），绝不静默
  for (const [sessionId, reason] of internal.keepRejected) {
    const requested = options.keep?.[sessionId];
    results.push({
      unitId: requested !== undefined ? requested : sessionId,
      sessionId,
      action: 'quarantine',
      ok: false,
      reason,
      needsAttention: true,
    });
    failed += 1;
  }

  for (const action of internal.actions) {
    const unitId = action.fromProjectKey + '/' + action.sessionId;
    if (action.kind === 'ok' || action.kind === 'keep') continue;
    if (wanted !== undefined && !wanted.has(unitId)) continue;
    if (action.kind === 'skip') {
      const item = itemOf(action);
      results.push({ ...item, reason: action.reason as SessionLayoutApplyReason, needsAttention: true });
      skipped += 1;
      continue;
    }
    if (action.kind === 'quarantine') {
      if (!action.applies) {
        // 重复 id 未点名 keep（或 keep 指向非候选副本）：**拒绝执行并说明**（CLI 只是跳过它）
        const item = itemOf(action);
        results.push({ ...item, reason: 'missing-keep', needsAttention: true });
        failed += 1;
        continue;
      }
      const done = await quarantineOne(action, sessionsRoot, stamp, nowMs, reindex);
      results.push(done);
      if (done.ok) applied += 1; else failed += 1;
      continue;
    }
    const done = await moveOne(action, sessionsRoot, nowMs, reindex, options.rewriteDir ?? rewriteSessionLogDir);
    results.push(done);
    if (done.ok) applied += 1; else failed += 1;
  }
  return { ok: failed === 0, applied, failed, skipped, results };
}
