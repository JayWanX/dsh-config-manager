/**
 * 会话**安全修复**的字节级执行器（T6 起步，T8/T9 起应用内也会调用它）。
 *
 * 调用方两处：① 应用内 utils/session-repair-service.ts（DSH 跑着时也允许，但必须先过服务层的写入门）；
 *             ② 离线 CLI（sessions repair --apply；DSH 已经起不来时的唯一通道）。
 *
 * 能修的三类（**都要求能从字节证明**；证明不了就拒绝，绝不「修得更狠」）：
 *   ① drop-duplicate-rows   —— 字节相同 + seq 相同的重放重复行（**零损失**）。
 *   ② drop-synthetic-closer —— 可证明撞上真实续写的合成收尾块（**零损失**：丢的是崩溃恢复补写的收尾，
 *                              真实续写原样保留）。丢完必须仍能通过「seq 单调连续」检查，否则拒绝发布。
 *   ③ truncate-tail         —— 首个异常（不可解析行 / seq 空洞 / seq 回退）之后整段截断（**有损**：
 *                              截断点之后的事件确实丢了）。必须调用方显式 allowLossy 才做，且同样先备份。
 *
 * 安全序列（三类共用，照抄设计稿 §10.3 的生态共识）：
 *  ① 写前按计划重跑校验（不过即拒绝）→ ② 时间戳备份（绝不覆盖已有备份）→
 *  ③ 临时文件 + rename **原子换入**（Windows 上必须先关读句柄）→ ④ 写后**复验**（不过则用备份还原）。
 * 回滚见 rollbackSessionLogFile（只认本模块产生的备份名 + 同目录同日志名）。
 */
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { isSessionLogName } from './session-log.ts';
import { findSyntheticCloserRun, parseSessionRowFacts, type SessionRowFacts } from './session-row-facts.ts';
import { decodeZstdFrame, encodeZstdFrame, scanZstdFrames, zstdAvailable } from './zstd-frame.ts';

/** 修复失败原因（机器可读；文案由调用方输出层决定）。 */
export type SessionRepairFailure =
  /** 运行时缺 zstd 能力 */
  | 'unavailable'
  /** 读不到文件 / 不是普通文件 */
  | 'unreadable'
  /** 容器不是合法 zstd 多帧流（保留位 / 保留块类型 / 魔数 / 解不开的帧） */
  | 'corrupt-container'
  /** 末尾有撕裂帧（DSH 自愈，无需修复） */
  | 'torn-tail'
  /** 首帧 header 不是单行 JSON 对象（应用内不重建 header —— 那是发明数据） */
  | 'invalid-header'
  /** 没有发现任何可零损失修复的问题 */
  | 'nothing-to-fix'
  /** 只有有损修复可用（截断），但调用方没有显式放行 */
  | 'lossy-required'
  /** 写前校验不过（**拒绝修复**） */
  | 'verification-refused'
  /** 临时文件写入 / 备份 / rename 失败 */
  | 'write-failed'
  /** 写后复验不过（临时文件已删除，原文件未动） */
  | 'postcheck-failed'
  /** 回滚：备份名/位置不合规，或备份内容自身校验不过（**拒绝**，零写入） */
  | 'backup-invalid';

/** 计划里的一步修复动作（界面/CLI 据此逐条说明「将要做什么」）。 */
export type SessionRepairActionCode = 'drop-duplicate-rows' | 'drop-synthetic-closer' | 'truncate-tail';

export interface SessionRepairAction {
  code: SessionRepairActionCode;
  /** 人类可读的事实（中文技术描述；不含路径） */
  detail: string;
  /** 有损（会真的丢掉无法恢复的事件）—— 应用期必须显式放行 */
  lossy: boolean;
  /** 这一步影响的行数 */
  rows: number;
}

/** 单次修复的结果（ok=false 时 reason 为机器可读原因）。 */
export interface SessionLogRepairOutcome {
  ok: boolean;
  reason?: SessionRepairFailure;
  /** 丢弃的行数（含重复行/合成收尾块/被截断的尾部） */
  droppedRows?: number;
  /** 保留的行数 */
  keptRows?: number;
  /** 时间戳备份的绝对路径（**只有真的落盘才有**） */
  backupPath?: string;
  /** 修复前后字节数（供报告） */
  bytesBefore?: number;
  bytesAfter?: number;
  /** 计划里的动作清单（预览时也回传，界面据此说明「将要做什么」） */
  actions?: SessionRepairAction[];
  /** 计划里有有损动作（应用期必须显式 allowLossy） */
  lossy?: boolean;
}

/** 一行已解压的会话事件（facts = null 表示这行不是合法 JSON 对象）。 */
interface InspectedRow {
  raw: string;
  facts: SessionRowFacts | null;
}

/** 只读的**检查**结果（不判断怎么修）。 */
interface SessionLogInspection {
  ok: boolean;
  reason?: SessionRepairFailure;
  headerText?: string;
  rows?: InspectedRow[];
}

/**
 * 检查容器与 headr（只读，绝不写字节）。
 *
 * 读不出的地方一律不猜：容器解不开 / 首帧不是单行 JSON 对象 → 直接拒绝（应用内不重建 header）；
 * **末尾撕裂帧**同样拒绝修复 —— DSH 自己会截断自愈，硬写只会把可自愈的文件改坏。
 */
function inspectSessionLog(bytes: Uint8Array): SessionLogInspection {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable' };
  let frames: { start: number; end: number }[];
  let torn = false;
  try {
    const scan = scanZstdFrames(bytes);
    frames = scan.frames;
    torn = scan.tornStart !== undefined;
  } catch {
    return { ok: false, reason: 'corrupt-container' };
  }
  if (frames.length === 0) return { ok: false, reason: 'corrupt-container' };
  if (torn) return { ok: false, reason: 'torn-tail' };
  const texts: string[] = [];
  for (const frame of frames) {
    try {
      texts.push(decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8'));
    } catch {
      return { ok: false, reason: 'corrupt-container' };
    }
  }
  const headerText = texts[0]!;
  const headerLine = headerText.endsWith('\n') ? headerText.slice(0, -1) : headerText;
  if (headerLine === '' || headerLine.includes('\n')) return { ok: false, reason: 'invalid-header' };
  try {
    const parsed: unknown = JSON.parse(headerLine);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid-header' };
  } catch {
    return { ok: false, reason: 'invalid-header' };
  }
  const rows: InspectedRow[] = [];
  for (let f = 1; f < texts.length; f += 1) {
    for (const line of texts[f]!.split('\n')) {
      if (line.trim() === '') continue;
      rows.push({ raw: line, facts: parseSessionRowFacts(line) });
    }
  }
  return { ok: true, headerText, rows };
}

/**
 * 写前校验：**连续性 + 引用完整性**（设计稿 §10.3 第 1 条）—— 严格档，用作**写后复验**。
 *
 * 能证明的两件事：
 *  - **连续性**：帧结构自洽（无撕裂帧、无非法帧）、首帧是单行 JSON 对象；
 *  - **引用完整性**：逐行 JSON 可解析且 seq **不倒退**（回退的 seq 正是重放族要处理的对象）。
 * 证明不了的一律返回 false（宁可不发布）。
 */
export function sessionLogSelfCheck(bytes: Uint8Array): { ok: boolean; reason?: SessionRepairFailure; rows?: { raw: string; seq?: number }[] } {
  const inspection = inspectSessionLog(bytes);
  if (!inspection.ok || inspection.rows === undefined) return { ok: false, reason: inspection.reason ?? 'corrupt-container' };
  const rows: { raw: string; seq?: number }[] = [];
  for (const row of inspection.rows) {
    if (row.facts === null) return { ok: false, reason: 'corrupt-container' };
    rows.push(row.facts.seq === undefined ? { raw: row.raw } : { raw: row.raw, seq: row.facts.seq });
  }
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!.seq;
    const cur = rows[i]!.seq;
    if (prev !== undefined && cur !== undefined && cur < prev) return { ok: false, reason: 'corrupt-container' };
  }
  return { ok: true, rows };
}

/**
 * 找出**字节相同 + seq 相同**的重复行（重放族里零损失的那一类）。
 *
 * 只认「完全相同」：seq 重复但内容不同说明是真实的分叉，属于「检测 ≠ 发明」的范畴 —— 只报告。
 */
export function duplicateRowIndexes(rows: readonly { raw: string; seq?: number }[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.seq === undefined) continue;
    const key = String(row.seq) + '\u0000' + row.raw;
    if (seen.has(key)) out.push(i);
    else seen.add(key);
  }
  return out;
}

/**
 * 保留行是否仍是**合法的 seq 序列**（首个数字 seq 必须是 0，之后逐个 +1；无 seq 的打包行跳过）。
 *
 * 为什么必须有这一关：合成收尾块被丢掉后，若真实续写**没有**复用那一段 seq，序列就会留下空洞 ——
 * 那正是 DSH 拒读的形态。证明不了连续性就不发布（否则等于把「能读的坏日志」修成「读不了的日志」）。
 */
function planIsContiguous(facts: readonly (SessionRowFacts | null)[]): boolean {
  let prev: number | undefined;
  for (const fact of facts) {
    if (fact === null) return false;
    const seq = fact.seq;
    if (seq === undefined) continue;
    if (prev === undefined) {
      if (seq !== 0) return false;
    } else if (seq !== prev + 1) {
      return false;
    }
    prev = seq;
  }
  return true;
}

/** 修复计划（**纯函数**，不碰文件系统；预览与应用共用同一份判定）。 */
export interface SessionLogRepairPlan {
  ok: boolean;
  reason?: SessionRepairFailure;
  actions: SessionRepairAction[];
  /** 计划里有有损动作 */
  lossy: boolean;
  /** 保留的行（ok=true 才有） */
  keptLines?: string[];
  headerText?: string;
  droppedRows?: number;
  keptRows?: number;
}

/**
 * 按字节算出一份修复计划（**只读、纯函数**）。
 *
 * 顺序固定（后续步骤只看前一步的结果，避免互相打架）：
 *   ① 去重（字节相同 + seq 相同）→ ② 丢可证明的合成收尾块 → ③ 首个异常处截断（需显式放行）。
 * 任何一步之后都必须能通过「seq 从 0 连续」的检查，否则拒绝。
 */
/** 在给定行序列里找**第一个异常**的下标：不可解析 / 首个数字 seq 不是 0 / seq 空洞 / seq 回退。 */
function firstAnomalyIndex(rows: readonly InspectedRow[], kept: readonly number[]): number {
  let lastSeq: number | undefined;
  for (let k = 0; k < kept.length; k += 1) {
    const facts = rows[kept[k]!]!.facts;
    if (facts === null) return k;
    const seq = facts.seq;
    if (seq === undefined) continue;
    if (lastSeq === undefined) {
      if (seq !== 0) return k;
    } else if (seq !== lastSeq + 1) {
      return k;
    }
    lastSeq = seq;
  }
  return -1;
}

export function planSessionLogRepair(bytes: Uint8Array, opts: { allowLossy?: boolean } = {}): SessionLogRepairPlan {
  const inspection = inspectSessionLog(bytes);
  if (!inspection.ok || inspection.rows === undefined || inspection.headerText === undefined) {
    return { ok: false, reason: inspection.reason ?? 'corrupt-container', actions: [], lossy: false };
  }
  const rows = inspection.rows;

  // ① 重放重复行（零损失；只丢「同一 seq + 同一字节」的那一份，不可能制造新的异常）
  const dupIndexes = duplicateRowIndexes(rows.map((row) => (row.facts?.seq !== undefined ? { raw: row.raw, seq: row.facts.seq } : { raw: row.raw })));
  const dupDrop = new Set<number>(dupIndexes);
  const keptAfterDup: number[] = [];
  for (let i = 0; i < rows.length; i += 1) if (!dupDrop.has(i)) keptAfterDup.push(i);

  // ② 可证明的合成收尾块（零损失）—— 但**只允许丢完仍然连续**：
  //    若真实续写没有复用那一段 seq，丢掉收尾块会留下空洞（DSH 照样拒读），此时宁可不动它。
  const closerRun = findSyntheticCloserRun(keptAfterDup.map((index) => rows[index]!.facts ?? {}));
  const anomalyBeforeCloser = firstAnomalyIndex(rows, keptAfterDup);
  let closerDrop = new Set<number>();
  let kept = keptAfterDup;
  if (closerRun !== undefined) {
    const tentative = new Set<number>();
    for (let k = closerRun.start; k < closerRun.end; k += 1) tentative.add(keptAfterDup[k]!);
    const keptWithoutCloser = keptAfterDup.filter((index) => !tentative.has(index));
    const anomalyAfter = firstAnomalyIndex(rows, keptWithoutCloser);
    const makesNewAnomaly = anomalyAfter >= 0 && (anomalyBeforeCloser < 0 || anomalyAfter < anomalyBeforeCloser);
    if (!makesNewAnomaly) {
      closerDrop = tentative;
      kept = keptWithoutCloser;
    }
  }

  // ③ 首个异常（不可解析 / seq 空洞 / seq 回退）→ 截断（**有损**，必须显式放行）
  const effectiveCloser = closerDrop.size > 0;
  let anomaly = effectiveCloser ? firstAnomalyIndex(rows, kept) : anomalyBeforeCloser;
  if (closerRun !== undefined && !effectiveCloser && anomalyBeforeCloser < 0) {
    // 收尾块被判定为「丢了会制造空洞」→ 直接拒绝（绝不发布带空洞的日志）
    return { ok: false, reason: 'verification-refused', actions: [], lossy: false };
  }
  let truncateRows = 0;
  if (anomaly === 0) {
    // 异常就在第一行（例如首个 seq 不是 0）：截断之后什么都不剩 —— 没有任何合法内容可发布
    return { ok: false, reason: 'verification-refused', actions: [], lossy: false };
  }
  if (anomaly > 0) {
    if (opts.allowLossy !== true) {
      const previewActions = buildActions(dupIndexes.length, effectiveCloser, closerRun, 0);
      return { ok: false, reason: 'lossy-required', actions: previewActions, lossy: true };
    }
    truncateRows = kept.length - anomaly;
    kept = kept.slice(0, anomaly);
  }
  const actions = buildActions(dupIndexes.length, effectiveCloser, closerRun, truncateRows);
  const lossy = actions.some((action) => action.lossy);
  if (kept.length === 0) return { ok: false, reason: 'verification-refused', actions, lossy };
  if (!planIsContiguous(kept.map((index) => rows[index]!.facts))) {
    return { ok: false, reason: 'verification-refused', actions, lossy };
  }
  if (actions.length === 0) return { ok: false, reason: 'nothing-to-fix', actions: [], lossy: false };
  return {
    ok: true,
    actions,
    lossy,
    keptLines: kept.map((index) => rows[index]!.raw),
    headerText: inspection.headerText,
    keptRows: kept.length,
    droppedRows: rows.length - kept.length,
  };
}

/** 按**实际发生的**动作拼清单（顺序固定：去重 → 收尾块 → 截断）。 */
function buildActions(
  dupRows: number,
  closerDropped: boolean,
  closerRun: { start: number; end: number; turn: number } | undefined,
  truncateRows: number,
): SessionRepairAction[] {
  const actions: SessionRepairAction[] = [];
  if (dupRows > 0) {
    actions.push({
      code: 'drop-duplicate-rows',
      detail: '丢弃 ' + String(dupRows) + ' 行重放重复事件（字节相同 + seq 相同）',
      lossy: false,
      rows: dupRows,
    });
  }
  if (closerDropped && closerRun !== undefined) {
    actions.push({
      code: 'drop-synthetic-closer',
      detail: '丢弃 ' + String(closerRun.end - closerRun.start) + ' 行崩溃恢复补写的收尾块（turn ' + String(closerRun.turn) + ' 之后仍在续写，真实内容保留）',
      lossy: false,
      rows: closerRun.end - closerRun.start,
    });
  }
  if (truncateRows > 0) {
    actions.push({
      code: 'truncate-tail',
      detail: '在首个异常处截断：丢弃其后 ' + String(truncateRows) + ' 行（**有损**，备份可回滚）',
      lossy: true,
      rows: truncateRows,
    });
  }
  return actions;
}

/** 按 DSH 的物理布局重建日志：首帧仅 header 行 + 一个事件帧（与既有实现同形）。 */
function encodeSessionLog(headerText: string, lines: readonly string[]): Buffer {
  const frames: Buffer[] = [encodeZstdFrame(Buffer.from(headerText, 'utf8'))];
  if (lines.length > 0) frames.push(encodeZstdFrame(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  return Buffer.concat(frames);
}

/** 修复备份的扩展名（**唯一事实源**：回滚只接受本模块产生的备份名）。 */
export const SESSION_REPAIR_BACKUP_SUFFIX = '.cm-backup-';

const BACKUP_STAMP_RE = /^[0-9A-Za-z._-]+$/;

/**
 * 解析本模块产生的备份名：<会话日志名>.cm-backup-<时间戳>[-序号]。
 *
 * 判据从严（回滚是一条「用旧内容覆盖新内容」的写路径）：日志名必须是合法会话日志名，
 * 时间戳只允许 [0-9A-Za-z._-] —— 任何不合规的名字一律返回 undefined，调用方据此拒绝。
 */
export function parseSessionRepairBackupName(name: string): { logName: string; stamp: string } | undefined {
  const at = name.lastIndexOf(SESSION_REPAIR_BACKUP_SUFFIX);
  if (at <= 0) return undefined;
  const logName = name.slice(0, at);
  const stamp = name.slice(at + SESSION_REPAIR_BACKUP_SUFFIX.length);
  if (stamp === '' || !BACKUP_STAMP_RE.test(stamp)) return undefined;
  if (!isSessionLogName(logName)) return undefined;
  return { logName, stamp };
}

/** 时间戳备份路径（**绝不覆盖**已有备份：存在同名则加序号后缀）。 */
async function backupPathFor(absPath: string, stamp: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : '-' + String(attempt);
    const candidate = absPath + '.cm-backup-' + stamp + suffix;
    try {
      await fs.stat(candidate);
      continue;
    } catch {
      return candidate;
    }
  }
  throw new Error('backup path exhausted');
}

/** 处理部分写入（EINTR / 短写）。 */
async function writeAllBytes(handle: Awaited<ReturnType<typeof fs.open>>, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await handle.write(data, offset, data.length - offset);
    if (written.bytesWritten <= 0) throw new Error('short write');
    offset += written.bytesWritten;
  }
}

/**
 * 修复单份会话日志（按 planSessionLogRepair 的计划）。
 *
 * 安全序列见文件头；**任一环节不过都不发布**（临时文件删除，原文件保持原样）。
 * `now` 可注入（测试固定时间戳）；`allowLossy` 缺省 false —— 有损计划一律拒绝（reason='lossy-required'）。
 */
export async function repairSessionLogFile(
  absPath: string,
  opts: { apply: boolean; allowLossy?: boolean; now?: () => Date } = { apply: false },
): Promise<SessionLogRepairOutcome> {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable' };
  let bytes: Buffer;
  let size: number;
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) return { ok: false, reason: 'unreadable' };
    size = st.size;
    bytes = await fs.readFile(absPath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const plan = planSessionLogRepair(bytes, { allowLossy: opts.allowLossy === true });
  if (!plan.ok || plan.keptLines === undefined || plan.headerText === undefined) {
    return {
      ok: false,
      reason: plan.reason ?? 'verification-refused',
      actions: plan.actions,
      lossy: plan.lossy,
      bytesBefore: size,
      bytesAfter: size,
    };
  }
  if (!opts.apply) {
    return {
      ok: true,
      actions: plan.actions,
      lossy: plan.lossy,
      droppedRows: plan.droppedRows,
      keptRows: plan.keptRows,
      bytesBefore: size,
      bytesAfter: size,
    };
  }

  const next = encodeSessionLog(plan.headerText, plan.keptLines);
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const temp = join(dirname(absPath), '.cm-repair-' + randomBytes(6).toString('hex') + '.tmp');
  let written = false;
  try {
    const out = await fs.open(temp, 'wx', 0o600);
    try {
      await writeAllBytes(out, next);
      await out.sync();
    } finally {
      await out.close();
    }
    written = true;
    // ② 时间戳备份（就地保留原件；rename 是覆盖式的，所以必须先有原件副本）
    const backupPath = await backupPathFor(absPath, stamp);
    await fs.copyFile(absPath, backupPath);
    // ③ 原子换入
    await fs.rename(temp, absPath);
    // ④ 写后复验（严格档：输出必须无撕裂帧、逐行可解析、seq 不倒退）
    const verify = sessionLogSelfCheck(await fs.readFile(absPath));
    if (!verify.ok) {
      await fs.copyFile(backupPath, absPath);
      return { ok: false, reason: 'postcheck-failed', backupPath, bytesBefore: size, bytesAfter: next.length };
    }
    return {
      ok: true,
      actions: plan.actions,
      lossy: plan.lossy,
      droppedRows: plan.droppedRows,
      keptRows: plan.keptRows,
      backupPath,
      bytesBefore: size,
      bytesAfter: next.length,
    };
  } catch {
    if (written) await fs.rm(temp, { force: true }).catch(() => {});
    return { ok: false, reason: 'write-failed', bytesBefore: size };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * **回滚**一次修复：把备份内容原子换回目标日志。
 *
 * 与修复同一条安全序列（校验 → 临时文件 → 原子换入 → 写后复验），另加两条前置：
 *  - 备份必须是**同一目录下、同一日志名**的本模块备份（parseSessionRepairBackupName）；
 *  - 备份内容必须先通过 sessionLogSelfCheck —— 备份本身不可信就绝不拿它覆盖任何东西。
 */
export async function rollbackSessionLogFile(absPath: string, backupPath: string): Promise<SessionLogRepairOutcome> {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable' };
  if (dirname(backupPath) !== dirname(absPath)) return { ok: false, reason: 'backup-invalid' };
  const parsed = parseSessionRepairBackupName(basename(backupPath));
  if (parsed === undefined || parsed.logName !== basename(absPath)) return { ok: false, reason: 'backup-invalid' };
  let backupBytes: Buffer;
  try {
    const st = await fs.stat(backupPath);
    if (!st.isFile()) return { ok: false, reason: 'backup-invalid' };
    backupBytes = await fs.readFile(backupPath);
  } catch {
    return { ok: false, reason: 'backup-invalid' };
  }
  if (!sessionLogSelfCheck(backupBytes).ok) return { ok: false, reason: 'backup-invalid' };
  let targetSize = 0;
  try {
    targetSize = (await fs.stat(absPath)).size;
  } catch {
    // 目标不在了也能回滚（备份就是内容来源），bytesBefore 如实记 0
  }
  const temp = join(dirname(absPath), '.cm-rollback-' + randomBytes(6).toString('hex') + '.tmp');
  try {
    const out = await fs.open(temp, 'wx', 0o600);
    try {
      await writeAllBytes(out, backupBytes);
      await out.sync();
    } finally {
      await out.close();
    }
    await fs.rename(temp, absPath);
    const verify = sessionLogSelfCheck(await fs.readFile(absPath));
    if (!verify.ok) return { ok: false, reason: 'postcheck-failed', bytesBefore: targetSize, bytesAfter: backupBytes.length };
    return { ok: true, backupPath, bytesBefore: targetSize, bytesAfter: backupBytes.length };
  } catch {
    return { ok: false, reason: 'write-failed', bytesBefore: targetSize };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** 读一份日志的字节（只读；供 CLI 的 doctor 汇总用）。 */
export async function readSessionLogBytes(absPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absPath);
  } catch {
    return null;
  }
}
