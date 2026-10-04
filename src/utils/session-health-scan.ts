/**
 * 会话体检的**宿主侧只读采集器**（T3）：把 <home>/sessions 扫成「每条会话一行事实」，
 * 交给 `core/session-health.ts` 做分类。**本模块绝不写任何字节**。
 *
 * 分层纪律：会话容器的字节结构属 DSH 存储细节 —— core 不得 import 本模块（AGENTS.md），
 * 所以这里的产物是**已经读出来的事实**（数值 / 字符串 / 结构结论），不是字节。
 *
 * 两档体检（设计稿 §9.3 的结论：零依赖结构体检为默认，深度解码为可选增强）：
 *  ① 结构档（恒做）：帧扫描（撕裂尾帧 / 非法帧）+ 首帧 header；
 *  ② 行档（**限额内**才做，默认 200 条）：解压各帧 → 逐行 JSON —— 只做**能从字节证明**的判定
 *     （不可解析行 / 字节相同的重复已提交行 / seq 空洞 / **能证明撞上真实续写**的合成 closer 块）。
 *     注意「合成 closer」的形状判据只是**必要条件**：真机实测（2026-10-04）只看形状会把每一次正常的
 *     「回合结束 → 下一个回合开始」都误报成崩溃残留（同一台机器 86 条健康会话被误报为 nextRequestFails），
 *     所以还必须证明「收尾块之后、下一个 turn/start 之前，同一个 turn 还在继续」。
 *
 * 「绝不猜」：任何读不出的东西一律记成事实缺省（`unreadable` / 计数字段），既不当作「没问题」，
 * 也不编造具体原因。需要 DSH codec 才能判定的类（缺 message id / 悬空 tool-call / settlement
 * 非法）本轮**不产出** —— 没有真凭实据就不下结论（详见本文件末尾的说明）。
 */
import fs from 'node:fs/promises';
import { join } from 'node:path';

import { isSessionLogName, readLogHeaderFromBytes, PROJECT_KEY_RE } from './session-log.ts';
import { decodeZstdFrame, scanZstdFrames } from './zstd-frame.ts';
import type { SessionHealthInput, SessionHealthSummary, SessionHealthRow } from '../core/session-health.ts';
import { analyzeSessionHealth } from '../core/session-health.ts';
import { sessionIdKey } from '../core/session-select.ts';
import { findSyntheticCloserRun, parseSessionRowFacts, type SessionRowFacts } from './session-row-facts.ts';

export { PROJECT_KEY_RE };

/** 单份日志参与体检的字节上限：超过则不读（如实计 unreadable，绝不半读后下结论）。 */
const MAX_LOG_BYTES = 256 * 1024 * 1024;
/** 行档默认限额（条）：超过的会话只做结构档（设计稿 §10.4 的深度解码限额）。 */
export const DEFAULT_DEEP_LIMIT = 200;
/** 会话单元扫描上限（防止异常大的会话库把一次体检拖成分钟级）；超出的如实计入 untested。 */
export const DEFAULT_MAX_UNITS = 2000;

export interface SessionHealthScanOptions {
  /** DSH home（会话根 = <home>/sessions） */
  homeDir: string;
  /** 本机 DSH 支持的会话格式版本（读不到 = undefined → 不做「超前」判定） */
  targetFormatVersion?: number;
  /** 本机工作区记录的 cwd 目录键（`projectKeyOf(path)`） */
  workspaceKeys?: ReadonlySet<string>;
  /** 本机全部已知会话 id 的归一化键（父对话存在性判定） */
  knownSessionIds?: ReadonlySet<string>;
  /** 出现在多个 projectKey 的会话 id（归一化键） */
  duplicateSessionIds?: ReadonlySet<string>;
  /** 行档条数上限（0 = 只做结构档；缺省 DEFAULT_DEEP_LIMIT）——覆盖的是**最新**的那些会话，见下 */
  deepLimit?: number;
  /** 单元数上限（缺省 DEFAULT_MAX_UNITS） */
  maxUnits?: number;
}

export interface SessionHealthScanResult {
  rows: SessionHealthRow[];
  summary: SessionHealthSummary;
  /** 因单元数上限**未体检**的会话数（>0 时界面必须写明「另有 N 条未检查」） */
  untested: number;
  /** 目录/文件读取失败次数（如实计数，绝不静默） */
  unreadableEntries: number;
  /** 会话根绝对路径（界面/诊断用） */
  sessionsDir: string;
  /** 会话根是否存在（false = 这台机器没有会话数据，不是错误） */
  sessionsDirExists: boolean;
}

/** 一行已提交事件的事实（字段判据见 session-row-facts；本模块只再带上原始字节）。 */
interface RowFacts extends SessionRowFacts {
  /** 原始行字节（重复行判定用：字节相同才算「重复」） */
  raw: string;
}

/** 解析一行 JSON —— 委托 `session-row-facts` 的**唯一实现**（体检与修复计划必须同判据）。 */
function parseRow(line: string): SessionRowFacts | null {
  return parseSessionRowFacts(line);
}

/** 行档结论（全部是「从字节可证明」的事实）。 */
interface RowScanResult {
  unparsable: number;
  /** 字节相同且 seq 相同的重复已提交行数（重放族：零损失可丢弃） */
  duplicateRows: number;
  /** 真实 seq 空洞（空洞数量，不是缺失事件数） */
  seqGaps: number;
  /** 合成 closer 块（后面还有真实续写） */
  syntheticCloser: boolean;
}

/** 行档：解压各帧 → 逐行判定（只做能从字节证明的判定）。 */
function scanRows(frames: readonly { start: number; end: number }[], bytes: Uint8Array): RowScanResult {
  const rows: RowFacts[] = [];
  let unparsable = 0;
  for (const frame of frames) {
    let text: string;
    try {
      text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      unparsable += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const facts = parseRow(line);
      if (facts === null) {
        unparsable += 1;
        continue;
      }
      const entry: RowFacts = { raw: line };
      if (facts.type !== undefined) entry.type = facts.type;
      if (facts.seq !== undefined) entry.seq = facts.seq;
      if (facts.turn !== undefined) entry.turn = facts.turn;
      rows.push(entry);
    }
  }
  // ① 字节相同且 seq 相同 → 重放族（同一 seq 被重写，重复的那份可零损失丢弃）
  let duplicateRows = 0;
  // ② seq 空洞（只在同一份日志内部判定；跨 generation 不连续是正常形态，不算空洞）
  let seqGaps = 0;
  let previous: RowFacts | undefined;
  let seenSeq = new Set<number>();
  for (const row of rows) {
    if (previous !== undefined && row.seq !== undefined && previous.seq === row.seq && row.raw === previous.raw) {
      duplicateRows += 1;
    }
    if (row.seq !== undefined) {
      if (previous?.seq !== undefined && row.seq !== previous.seq) {
        if (row.seq > previous.seq + 1) seqGaps += 1;
        // 回退的 seq（重放的另一形态）不计空洞：它已被重复行/重放族覆盖
      }
      seenSeq.add(row.seq);
    }
    previous = row;
  }
  // ③ 合成 closer 块：整块都是收尾类型且含 turn/end，且**后面还有行**（真实续写）
  const syntheticCloser = detectSyntheticCloser(rows);
  return { unparsable, duplicateRows, seqGaps, syntheticCloser };
}

/** 合成 closer 块探测 —— 委托 `session-row-facts.findSyntheticCloserRun` 的唯一实现（判据见其文件头）。 */
function detectSyntheticCloser(rows: readonly RowFacts[]): boolean {
  return findSyntheticCloserRun(rows) !== undefined;
}

/** 结构档 + 首帧 header 读取（单份日志）。 */
interface LogScan {
  header?: { id?: string; cwd?: string; origin?: string; parentSessionId?: string; version?: number };
  structural: SessionHealthInput['structural'];
  rows?: RowScanResult;
  sizeBytes?: number;
}

async function scanLogFile(absPath: string, withRows: boolean): Promise<LogScan> {
  let bytes: Buffer;
  let sizeBytes: number;
  try {
    const st = await fs.stat(absPath);
    sizeBytes = st.size;
    if (st.size > MAX_LOG_BYTES) {
      return { structural: { ok: false, headerUnreadable: true, corruptReason: 'too-large' }, sizeBytes };
    }
    bytes = await fs.readFile(absPath);
  } catch {
    return { structural: { ok: false, headerUnreadable: true } };
  }
  let frames: { start: number; end: number }[];
  let tornTail = false;
  try {
    const scan = scanZstdFrames(bytes);
    frames = scan.frames;
    tornTail = scan.tornStart !== undefined;
  } catch (error) {
    return {
      structural: { ok: false, corruptReason: error instanceof Error ? error.message : String(error) },
      sizeBytes,
    };
  }
  const header = readLogHeaderFromBytes(bytes);
  const structural: SessionHealthInput['structural'] = {
    ok: header !== undefined,
    frames: frames.length,
    ...(tornTail ? { tornTail: true } : {}),
    ...(header === undefined ? { headerUnreadable: true } : {}),
  };
  const out: LogScan = { structural, sizeBytes };
  if (header !== undefined) out.header = header;
  if (withRows) out.rows = scanRows(frames, bytes);
  return out;
}

/** 会话目录 → 体检输入（单条；不抛错）。 */
async function scanUnit(
  sessionsDir: string,
  projectKey: string,
  sessionId: string,
  withRows: boolean,
): Promise<{ input: SessionHealthInput; unreadable: number }> {
  const dir = join(sessionsDir, projectKey, sessionId);
  let unreadable = 0;
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => isSessionLogName(n)).sort();
  } catch {
    unreadable += 1;
  }
  // 同一会话可能有多份 generation：体检以**最新的一份**为准（时间读不到则取字典序最后一份），
  // 但目录里全部日志的字节都计入 sizeBytes —— 用户关心的是「这条会话占了多少盘」。
  let totalBytes = 0;
  let picked: LogScan | undefined;
  let pickedName: string | undefined;
  for (const name of names) {
    const scan = await scanLogFile(join(dir, name), false);
    if (scan.sizeBytes !== undefined) totalBytes += scan.sizeBytes;
    if (picked === undefined || name > (pickedName ?? '')) {
      picked = scan;
      pickedName = name;
    }
  }
  // 行档只对「被选中的那份」日志做（其余 generation 不重复解压）
  if (withRows && pickedName !== undefined) {
    const withRowScan = await scanLogFile(join(dir, pickedName), true);
    if (withRowScan.sizeBytes !== undefined) {
      totalBytes = totalBytes - (picked?.sizeBytes ?? 0) + withRowScan.sizeBytes;
    }
    picked = withRowScan;
  }
  const header = picked?.header;
  const structural = picked?.structural ?? { ok: false, headerUnreadable: true };
  const rows = picked?.rows;
  // 行档结论 → 深度校验事实（**只标 verified=true 当真的逐行解析过**）
  const deepIssueCodes: { code: 'unparsable-event' | 'replay-duplicate-rows' | 'seq-gap' | 'synthetic-closer'; detail?: string }[] = [];
  if (rows !== undefined) {
    if (rows.unparsable > 0) deepIssueCodes.push({ code: 'unparsable-event', detail: String(rows.unparsable) + ' line(s)' });
    if (rows.duplicateRows > 0) deepIssueCodes.push({ code: 'replay-duplicate-rows', detail: String(rows.duplicateRows) });
    if (rows.seqGaps > 0) deepIssueCodes.push({ code: 'seq-gap', detail: String(rows.seqGaps) });
    if (rows.syntheticCloser) deepIssueCodes.push({ code: 'synthetic-closer' });
  }
  const input: SessionHealthInput = {
    unitId: projectKey + '/' + sessionId,
    sessionId,
    projectKey,
    logFiles: names.length,
    structural,
    ...(header?.cwd !== undefined ? { headerCwd: header.cwd } : {}),
    ...(header?.origin !== undefined ? { origin: header.origin } : {}),
    ...(header?.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header?.version !== undefined ? { headerVersion: header.version } : {}),
    ...(names.length > 0 ? { sizeBytes: totalBytes } : {}),
    ...(rows !== undefined
      ? { deep: { verified: true, ...(deepIssueCodes.length > 0 ? { issues: deepIssueCodes } : {}) } }
      : { deep: { verified: false, unverifiedReason: 'row-scan-not-run' } }),
  };
  return { input, unreadable };
}

/**
 * 扫描本机会话库（只读；**绝不写任何字节**，绝不抛错）。
 *
 * 任何目录/文件读不出来只计入 unreadableEntries，不中断整次体检 —— 体检本身不能成为
 * 新的故障点。
 */
export async function scanSessionHealth(options: SessionHealthScanOptions): Promise<SessionHealthScanResult> {
  const sessionsDir = join(options.homeDir, 'sessions');
  const deepLimit = options.deepLimit ?? DEFAULT_DEEP_LIMIT;
  const maxUnits = options.maxUnits ?? DEFAULT_MAX_UNITS;
  const result: SessionHealthScanResult = {
    rows: [],
    summary: {
      total: 0,
      bySeverity: { blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0 },
      structurallyChecked: 0,
      deepVerified: 0,
      deepUnverified: 0,
    },
    untested: 0,
    unreadableEntries: 0,
    sessionsDir,
    sessionsDirExists: false,
  };
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    result.sessionsDirExists = true;
  } catch {
    return result;
  }
  const projectKeys = projectDirs.filter((name) => PROJECT_KEY_RE.test(name));
  const inputs: SessionHealthInput[] = [];
  const duplicates = new Set<string>();
  // 第一趟：只数「同一会话 id 出现在几个 projectKey 目录」（重复 id 是启动级故障）
  const idLocations = new Map<string, Set<string>>();
  for (const projectKey of projectKeys) {
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(join(sessionsDir, projectKey), { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      result.unreadableEntries += 1;
      continue;
    }
    for (const sessionId of dirs) {
      const key = sessionIdKey(sessionId);
      const set = idLocations.get(key) ?? new Set<string>();
      set.add(projectKey);
      idLocations.set(key, set);
    }
  }
  for (const [key, set] of idLocations) if (set.size > 1) duplicates.add(key);
  // 第二趟：逐单元扫结构 / （限额内的）行档
  //
  // 顺序**必须**是「最近写入优先」：行档（解压 + 逐行判定）最贵，所以有限额；
  // 而「哪些会话被行档覆盖」决定了 synthetic-closer / 重放重复行 / seq 空洞这些深档结论
  // 能不能出现在界面上。此前按 projectKey 字典序 + sessionId 字典序取前 N 条 ——
  // 结果是**最老的那批**被深查，最近出事（刚崩过 / 刚被强杀）的那批永远看不到，
  // 同一个库每次体检给出不同的深档结论（实测：同一台机器 1024 条会话，深查恒为
  // 字典序最前的 200 条，synthetic-closer 时有时无）。改成按目录 mtime 倒序，
  // 顺序**确定且可解释**：最近写过的会话优先被深查。
  const units: Array<{ projectKey: string; sessionId: string; mtimeMs: number }> = [];
  for (const projectKey of projectKeys) {
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(join(sessionsDir, projectKey), { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      continue;
    }
    for (const sessionId of dirs) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(join(sessionsDir, projectKey, sessionId))).mtimeMs;
      } catch {
        // 读不到 mtime：按最旧处理（不中断体检，也绝不因此把它排除在体检之外）
      }
      units.push({ projectKey, sessionId, mtimeMs });
    }
  }
  units.sort((a, b) => (b.mtimeMs - a.mtimeMs)
    || a.projectKey.localeCompare(b.projectKey)
    || a.sessionId.localeCompare(b.sessionId));
  let deepUsed = 0;
  let scanned = 0;
  for (const unit of units) {
    if (scanned >= maxUnits) {
      result.untested += 1;
      continue;
    }
    scanned += 1;
    const withRows = deepLimit > 0 && deepUsed < deepLimit;
    if (withRows) deepUsed += 1;
    const { input, unreadable } = await scanUnit(sessionsDir, unit.projectKey, unit.sessionId, withRows);
    result.unreadableEntries += unreadable;
    inputs.push(input);
  }
  const analyzed = analyzeSessionHealth(inputs, {
    ...(options.targetFormatVersion !== undefined ? { targetFormatVersion: options.targetFormatVersion } : {}),
    workspaceKeys: options.workspaceKeys ?? new Set<string>(),
    knownSessionIds: options.knownSessionIds ?? new Set<string>(),
    duplicateSessionIds: options.duplicateSessionIds ?? duplicates,
  });
  result.rows = analyzed.rows;
  result.summary = analyzed.summary;
  return result;
}
