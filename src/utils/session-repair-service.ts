/**
 * 会话修复的**服务层**（宿主侧；应用内写会话字节的**唯一编排点**）。
 *
 * 分层：utils/session-log-repair.ts 是字节级执行器（校验 → 备份 → 原子换入 → 复验），
 * 本模块负责它周围的**决策与账目**：
 *   ① 目标解析：把体检用的 unitId（projectKey/会话目录）解析成会话根内的真实日志文件，
 *      全程只接受落在 <home>/sessions 之内的路径（防穿越 / 符号链接逃逸）；
 *   ② 写入门（**在 DSH 运行时也只能这么保守**）：目录内有 session.lock 不动；
 *      文件最近 SESSION_REPAIR_QUIESCENT_MS 内被写过 → 视为活跃使用，拒绝；
 *      预览时给出「大小 + mtime」指纹，应用时必须一致（TOCTOU：预览后被改过就拒绝）；
 *   ③ 修复台账（<dataDir>/session-repairs.json）：记录每次修复的备份名与修复后指纹，
 *      **回滚只认台账里的 repairId**（客户端永远不能传路径）；
 *   ④ 回滚：先确认目标仍是我们修完时的那一份（指纹一致），再把备份原子换回去。
 *
 * 「绝不猜」：任何一步证明不了就拒绝，绝不「修得更狠」；台账里的绝对路径不回传浏览器
 * （回传的是 sessionId / 日志文件名 / 备份文件名这些标识，不含目录）。
 */
import fs from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import { PROJECT_KEY_RE, isSessionLogName, sessionLogNames } from './session-log.ts';
import {
  parseSessionRepairBackupName,
  repairSessionLogFile,
  rollbackSessionLogFile,
  SESSION_REPAIR_BACKUP_SUFFIX,
  type SessionLogRepairOutcome,
  type SessionRepairAction,
  type SessionRepairFailure,
} from './session-log-repair.ts';

/** 服务层失败原因 = 执行器原因 ∪ 编排原因（机器可读；文案由界面映射）。 */
export type SessionRepairReason =
  | SessionRepairFailure
  /** unitId 不合法 / 解析不到会话目录或日志 */
  | 'unknown-unit'
  /** 目标日志读不到（可能刚被移走） */
  | 'not-found'
  /** 会话目录内有 session.lock：可能正被使用 */
  | 'locked'
  /** 日志在静止期内被写过：可能在活跃使用中 */
  | 'busy'
  /** 预览之后文件被改过（指纹不一致）—— 拒绝按旧计划写入 */
  | 'changed'
  /** 台账里没有这个 repairId */
  | 'repair-not-found'
  /** 这次修复已经回滚过 */
  | 'already-rolled-back';

/** 写入门：日志最近多久被写过就视为「仍在活跃使用」（毫秒）。 */
export const SESSION_REPAIR_QUIESCENT_MS = 30_000;

/** 修复台账文件名（挂在插件数据目录下）。 */
export const SESSION_REPAIR_LEDGER_FILE = 'session-repairs.json';

/** 台账最多保留的修复条数（超出丢最旧；只影响「能不能一键回滚」，备份文件本身不动）。 */
export const SESSION_REPAIR_LEDGER_MAX = 100;

/** 一次修复的台账记录（**绝对路径不进这里**：目录可由 unitId 重新解析）。 */
export interface SessionRepairRecord {
  repairId: string;
  unitId: string;
  sessionId: string;
  projectKey: string;
  /** 被修复的日志文件名（不含目录） */
  logName: string;
  /** 时间戳备份文件名（与日志同目录） */
  backupName: string;
  /** 修复时刻（epoch ms） */
  at: number;
  droppedRows: number;
  bytesBefore: number;
  bytesAfter: number;
  /** 修复后目标的指纹（回滚前必须仍然一致） */
  repairedSize: number;
  repairedMtimeMs: number;
  /** 已回滚时刻（epoch ms；缺省 = 未回滚） */
  rolledBackAt?: number;
  /** 这次修复含**有损**动作（截断）—— 审计用；缺省 = 零损失 */
  lossy?: boolean;
}

/** 目标解析结果。 */
export interface SessionRepairTarget {
  unitId: string;
  projectKey: string;
  sessionId: string;
  unitDir: string;
  logName: string;
  file: string;
}

/** 预览 / 应用的结果（ok=false 时 reason 为机器可读原因）。 */
export interface SessionRepairPlanResult {
  ok: boolean;
  reason?: SessionRepairReason;
  unitId: string;
  sessionId?: string;
  logName?: string;
  /** 将丢弃（或已丢弃）的重复行数 */
  droppedRows?: number;
  bytesBefore?: number;
  bytesAfter?: number;
  /** 应用时必须回传的指纹（预览时给出） */
  expect?: { size: number; mtimeMs: number };
  /** 写入门判定用到的最近写入时间（busy 时给出，界面据此说明「多久前被写过」） */
  mtimeMs?: number;
  /** 本次修复的 id 与备份名（应用成功才有） */
  repairId?: string;
  backupName?: string;
  /** 修复发生了但台账没记上（回滚入口不可用；备份文件仍在） */
  ledgerRecorded?: boolean;
  /** 计划里的动作清单（预览也回传：界面据此逐条说明「将要做什么」） */
  actions?: SessionRepairAction[];
  /** 计划含有损动作（截断）：应用时必须显式 allowLossy */
  lossy?: boolean;
  /** 保留的行数 */
  keptRows?: number;
}

/** 回滚结果。 */
export interface SessionRepairRollbackResult {
  ok: boolean;
  reason?: SessionRepairReason;
  repairId: string;
  unitId?: string;
  sessionId?: string;
}

/* --------------------------------------------------------------- 目标解析 */

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * unitId（projectKey/会话目录）→ 会话根内的真实日志文件。
 *
 * 与体检同一口径：同一会话目录有多份 generation 时，取**字典序最后一份**（体检「以最新一份为准」）。
 * 路径安全：段数与形状先校验，再用 realpath + relative 确认目录确实落在会话根之内。
 */
export async function resolveSessionUnit(sessionsDir: string, unitId: string): Promise<SessionRepairTarget | undefined> {
  const parts = unitId.split('/');
  if (parts.length !== 2) return undefined;
  const projectKey = parts[0];
  const sessionId = parts[1];
  if (projectKey === undefined || sessionId === undefined) return undefined;
  if (!PROJECT_KEY_RE.test(projectKey)) return undefined;
  if (sessionId === '' || sessionId === '.' || sessionId === '..') return undefined;
  if (sessionId.includes('\\') || sessionId.includes('/')) return undefined;
  const unitDir = join(sessionsDir, projectKey, sessionId);
  let names: string[];
  try {
    const st = await fs.stat(unitDir);
    if (!st.isDirectory()) return undefined;
    names = await fs.readdir(unitDir);
  } catch {
    return undefined;
  }
  const logs = sessionLogNames(names);
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const logName = logs[i];
    if (logName === undefined) continue;
    const file = join(unitDir, logName);
    if (!(await exists(file))) continue;
    const realRoot = await fs.realpath(sessionsDir).catch(() => undefined);
    const realUnit = await fs.realpath(unitDir).catch(() => undefined);
    if (realRoot === undefined || realUnit === undefined) return undefined;
    const rel = relative(realRoot, realUnit);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return { unitId: projectKey + '/' + sessionId, projectKey, sessionId, unitDir, logName, file };
  }
  return undefined;
}

/* ----------------------------------------------------------------- 写入门 */

type WriteGate =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; reason: 'locked' | 'busy' | 'not-found'; size?: number; mtimeMs?: number };

/**
 * 写入门（应用内写会话字节的**唯一允许时机**）。
 *
 * 为什么不是「先关 DSH」：本插件就跑在 DSH 里，那条闸门等于永远拒绝。可证明的保守判据是
 * 「这条会话**看起来没有活跃写者**」：目录无 session.lock + 文件不在静止期内 + 预览/应用指纹一致。
 * 真正的写入仍由执行器保证（校验不过就拒绝、备份、原子换入、写后复验）。
 */
async function gateForWrite(target: SessionRepairTarget, nowMs: number): Promise<WriteGate> {
  if (await exists(join(target.unitDir, 'session.lock'))) return { ok: false, reason: 'locked' };
  let st;
  try {
    st = await fs.stat(target.file);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-found' };
  if (nowMs - st.mtimeMs < SESSION_REPAIR_QUIESCENT_MS) {
    return { ok: false, reason: 'busy', size: st.size, mtimeMs: st.mtimeMs };
  }
  return { ok: true, size: st.size, mtimeMs: st.mtimeMs };
}

/* ------------------------------------------------------------------ 台账 */

export function sessionRepairLedgerPath(dataDir: string): string {
  return join(dataDir, SESSION_REPAIR_LEDGER_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRepairRecord(value: unknown): SessionRepairRecord | undefined {
  if (!isRecord(value)) return undefined;
  const repairId = value['repairId'];
  const unitId = value['unitId'];
  const sessionId = value['sessionId'];
  const projectKey = value['projectKey'];
  const logName = value['logName'];
  const backupName = value['backupName'];
  const at = value['at'];
  if (typeof repairId !== 'string' || repairId === '') return undefined;
  if (typeof unitId !== 'string' || typeof sessionId !== 'string' || typeof projectKey !== 'string') return undefined;
  if (typeof logName !== 'string' || !isSessionLogName(logName)) return undefined;
  if (typeof backupName !== 'string' || parseSessionRepairBackupName(backupName) === undefined) return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const num = (key: string): number => {
    const raw = value[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };
  const record: SessionRepairRecord = {
    repairId,
    unitId,
    sessionId,
    projectKey,
    logName,
    backupName,
    at,
    droppedRows: num('droppedRows'),
    bytesBefore: num('bytesBefore'),
    bytesAfter: num('bytesAfter'),
    repairedSize: num('repairedSize'),
    repairedMtimeMs: num('repairedMtimeMs'),
  };
  if (value['lossy'] === true) record.lossy = true;
  const rolledBackAt = value['rolledBackAt'];
  if (typeof rolledBackAt === 'number' && Number.isFinite(rolledBackAt)) record.rolledBackAt = rolledBackAt;
  return record;
}

/**
 * 读台账（只读；**绝不抛错**）。
 *
 * 读不出来 / 形状不对 → repairs=[] 且带 error 原因：调用方据此**不谎报**「没有可回滚的修复」，
 * 而是在应用期降级为「本次修复没记上账（备份仍在，可手工还原）」。
 */
export async function readSessionRepairLedger(dataDir: string): Promise<{ repairs: SessionRepairRecord[]; error?: string; exists: boolean }> {
  const path = sessionRepairLedgerPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { repairs: [], exists: false };
    return { repairs: [], error: 'unreadable', exists: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed['repairs'])) return { repairs: [], error: 'malformed', exists: true };
    const repairs: SessionRepairRecord[] = [];
    for (const item of parsed['repairs']) {
      const record = toRepairRecord(item);
      if (record !== undefined) repairs.push(record);
    }
    return { repairs, exists: true };
  } catch {
    return { repairs: [], error: 'malformed', exists: true };
  }
}

/** 写台账（原子：临时文件 + rename）。返回是否成功；失败绝不抛出。 */
export async function writeSessionRepairLedger(dataDir: string, repairs: readonly SessionRepairRecord[]): Promise<boolean> {
  const path = sessionRepairLedgerPath(dataDir);
  const temp = join(dataDir, '.session-repairs-' + Math.random().toString(16).slice(2, 10) + '.tmp');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ version: 1, repairs }, null, 2), 'utf8');
    await fs.rename(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** 台账里的修复记录（界面展示用；台账文件损坏时带 error，界面据此如实提示）。 */
export async function listSessionRepairs(dataDir: string): Promise<{ repairs: SessionRepairRecord[]; error?: string }> {
  const ledger = await readSessionRepairLedger(dataDir);
  const out: { repairs: SessionRepairRecord[]; error?: string } = { repairs: ledger.repairs };
  if (ledger.error !== undefined) out.error = ledger.error;
  return out;
}

async function recordRepair(dataDir: string, record: SessionRepairRecord): Promise<boolean> {
  const ledger = await readSessionRepairLedger(dataDir);
  if (ledger.error !== undefined && ledger.exists) {
    // 台账损坏：先把坏文件改名留档（绝不静默丢弃证据），再写新账
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.rename(sessionRepairLedgerPath(dataDir), sessionRepairLedgerPath(dataDir) + '.corrupt-' + stamp).catch(() => {});
  }
  const base = ledger.error !== undefined ? [] : ledger.repairs;
  return await writeSessionRepairLedger(dataDir, [record, ...base].slice(0, SESSION_REPAIR_LEDGER_MAX));
}

/* -------------------------------------------------------- 预览 / 应用 */

export interface SessionRepairCallOptions {
  homeDir: string;
  unitId: string;
  /** 注入当前时间（测试固定静止期判定） */
  now?: () => Date;
}

/** 预览（**只读**）：解析目标 → 过写入门 → 跑一次 apply=false 的执行器。 */
export async function previewSessionRepair(options: SessionRepairCallOptions): Promise<SessionRepairPlanResult> {
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const sessionsDir = join(options.homeDir, 'sessions');
  const target = await resolveSessionUnit(sessionsDir, options.unitId);
  if (target === undefined) return { ok: false, reason: 'unknown-unit', unitId: options.unitId };
  const base = { unitId: target.unitId, sessionId: target.sessionId, logName: target.logName };
  const gate = await gateForWrite(target, nowMs);
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      ...base,
      ...(gate.mtimeMs !== undefined ? { mtimeMs: gate.mtimeMs } : {}),
    };
  }
  // 预览是**只读**的：用 allowLossy 算出「完整的计划」给用户看（截断多少行也摆出来），
  // 真正落盘时再要求显式放行（applySessionRepair 的 allowLossy 缺省 false）。
  const outcome = await repairSessionLogFile(target.file, { apply: false, allowLossy: true });
  if (!outcome.ok) return { ok: false, reason: outcome.reason ?? 'verification-refused', ...base };
  return {
    ok: true,
    ...base,
    droppedRows: outcome.droppedRows ?? 0,
    ...(outcome.keptRows !== undefined ? { keptRows: outcome.keptRows } : {}),
    ...(outcome.actions !== undefined ? { actions: outcome.actions } : {}),
    lossy: outcome.lossy === true,
    ...(outcome.bytesBefore !== undefined ? { bytesBefore: outcome.bytesBefore } : {}),
    ...(outcome.bytesAfter !== undefined ? { bytesAfter: outcome.bytesAfter } : {}),
    expect: { size: gate.size, mtimeMs: gate.mtimeMs },
  };
}

export interface SessionRepairApplyOptions extends SessionRepairCallOptions {
  dataDir: string;
  /** 预览给出的指纹；给了就必须一致（拒绝「拿旧计划写已变的文件」） */
  expect?: { size: number; mtimeMs: number };
  /** 显式放行**有损**动作（截断）；缺省 false = 有损计划一律拒绝（reason='lossy-required'） */
  allowLossy?: boolean;
}

/** 应用（**写**）：重跑全部前置判定 → 执行器完整安全序列 → 记台账。 */
export async function applySessionRepair(options: SessionRepairApplyOptions): Promise<SessionRepairPlanResult> {
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const sessionsDir = join(options.homeDir, 'sessions');
  const target = await resolveSessionUnit(sessionsDir, options.unitId);
  if (target === undefined) return { ok: false, reason: 'unknown-unit', unitId: options.unitId };
  const base = { unitId: target.unitId, sessionId: target.sessionId, logName: target.logName };
  const gate = await gateForWrite(target, nowMs);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason, ...base, ...(gate.mtimeMs !== undefined ? { mtimeMs: gate.mtimeMs } : {}) };
  }
  if (options.expect !== undefined && (options.expect.size !== gate.size || Math.abs(options.expect.mtimeMs - gate.mtimeMs) > 1)) {
    return { ok: false, reason: 'changed', ...base };
  }
  const outcome = await repairSessionLogFile(target.file, {
    apply: true,
    allowLossy: options.allowLossy === true,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason ?? 'verification-refused', ...base };
  const repaired = await fs.stat(target.file).catch(() => undefined);
  const repairId = 'repair-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10);
  const backupName = outcome.backupPath !== undefined ? basename(outcome.backupPath) : undefined;
  const record: SessionRepairRecord = {
    repairId,
    unitId: target.unitId,
    sessionId: target.sessionId,
    projectKey: target.projectKey,
    logName: target.logName,
    backupName: backupName ?? target.logName + SESSION_REPAIR_BACKUP_SUFFIX + 'unknown',
    at: Date.now(),
    droppedRows: outcome.droppedRows ?? 0,
    bytesBefore: outcome.bytesBefore ?? 0,
    bytesAfter: outcome.bytesAfter ?? 0,
    repairedSize: repaired?.size ?? outcome.bytesAfter ?? 0,
    repairedMtimeMs: repaired?.mtimeMs ?? 0,
  };
  if (outcome.lossy === true) record.lossy = true;
  const recorded = backupName !== undefined && parseSessionRepairBackupName(backupName) !== undefined
    ? await recordRepair(options.dataDir, record)
    : false;
  return {
    ok: true,
    ...base,
    droppedRows: outcome.droppedRows ?? 0,
    ...(outcome.keptRows !== undefined ? { keptRows: outcome.keptRows } : {}),
    ...(outcome.actions !== undefined ? { actions: outcome.actions } : {}),
    lossy: outcome.lossy === true,
    ...(outcome.bytesBefore !== undefined ? { bytesBefore: outcome.bytesBefore } : {}),
    ...(outcome.bytesAfter !== undefined ? { bytesAfter: outcome.bytesAfter } : {}),
    repairId,
    ...(backupName !== undefined ? { backupName } : {}),
    ledgerRecorded: recorded,
  };
}

export interface SessionRepairRollbackOptions {
  homeDir: string;
  dataDir: string;
  repairId: string;
}

/** 回滚：**只接受台账里的 repairId**（客户端不能传路径）；目标指纹不一致就拒绝。 */
export async function rollbackSessionRepair(options: SessionRepairRollbackOptions): Promise<SessionRepairRollbackResult> {
  const ledger = await readSessionRepairLedger(options.dataDir);
  if (ledger.error !== undefined) return { ok: false, reason: 'repair-not-found', repairId: options.repairId };
  const record = ledger.repairs.find((item) => item.repairId === options.repairId);
  if (record === undefined) return { ok: false, reason: 'repair-not-found', repairId: options.repairId };
  if (record.rolledBackAt !== undefined) return { ok: false, reason: 'already-rolled-back', repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
  const target = await resolveSessionUnit(join(options.homeDir, 'sessions'), record.unitId);
  if (target === undefined || target.logName !== record.logName) {
    return { ok: false, reason: 'not-found', repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
  }
  const st = await fs.stat(target.file).catch(() => undefined);
  if (st === undefined) return { ok: false, reason: 'not-found', repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
  if (st.size !== record.repairedSize || Math.abs(st.mtimeMs - record.repairedMtimeMs) > 1) {
    return { ok: false, reason: 'changed', repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
  }
  const outcome: SessionLogRepairOutcome = await rollbackSessionLogFile(target.file, join(target.unitDir, record.backupName));
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason ?? 'write-failed', repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
  }
  const next = ledger.repairs.map((item) => (item.repairId === options.repairId ? { ...item, rolledBackAt: Date.now() } : item));
  await writeSessionRepairLedger(options.dataDir, next);
  return { ok: true, repairId: options.repairId, unitId: record.unitId, sessionId: record.sessionId };
}
