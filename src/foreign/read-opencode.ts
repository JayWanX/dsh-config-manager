/**
 * opencode 家族（opencode / mimocode / kilocode / teleagent / zcode）的**共享读盘层**，
 * 同时承载 SQLite 批（8 个来源）共用的最小工具：能力探测门、只读打开、时间与 JSON 单元格取值。
 *
 * 为什么五家共用一份（而不是每源抄一遍）：mimocode / kilocode 是 opencode 的 fork，teleagent 与
 * zcode 是同一个「session / message / part 三表 + JSON TEXT 列」形态（见
 * outputs/competitor-recon-2026-10-05/read-chat-import.md §3.1 与 read-claude-move.md §7.2）。
 * 同一套解析逻辑出现第 3 份副本正是竞品纪律明令停止的事；本仓库把它收敛成一个函数。
 * **本文件是 SQLite 批的共用面**：其余 7 个 `read-<id>.ts` 从这里 import 类型与工具，
 * 但每个来源的真值表路径函数一律留在自己的文件里（那才是逐源需要独立取证的部分）。
 *
 * 三条硬纪律（t1 调研确证 + 本任务实测）：
 *  ① **动态 import + 能力探测**：一律经 `sqlite.ts` 的 `sqliteCapability()` —— 静态 import
 *     `node:sqlite` 会在缺该能力的宿主上把**整个插件**加载失败（表现是「插件没装」而
 *     不是「这一个来源读不到」）。能力缺失是**结构化降级**（0 文件 + 一条 skip），绝不崩。
 *  ② **只读打开 + PRAGMA table_info 自适应列**：`sqlite.ts` 的三态打开计划
 *     （direct / immutable / copy —— **绝不往用户目录写文件**，t9 处置见 sqlite.ts 文件头）
 *     + `db.columns()`；表名只允许来自本文件的编译期候选表，绝不拼调用方给的字符串。
 *  ③ **读不到一律返回 null（统一口径）**：本文件的 `readOpencodeFamilyDatabase` 在
 *     「打不开 / 不是这个来源的库 / 表结构不符 / 查询失败」时返回 **null**；把 null 转成
 *     一条 `source-unreadable` skip 的动作**只有 `readOpencodeFamily` 一处**。
 *     「能打开但一条会话都没有」是**空数组**，与 null 严格区分。
 *     **未安装**（库文件不存在）不报码：未安装是正常状态，报码只用于「存在但读不到」。
 */
import { joinFor, normalizePlatform, posixLocalShare } from './platform-paths.ts';
import { isFile } from './session-read.ts';
import {
  cellText,
  openSqliteReadOnlyEx,
  sqliteCapability,
} from './sqlite.ts';
import type { SqliteCapability, SqliteHandle, SqliteOpenProblem, SqliteOpenResult, SqliteRow } from './sqlite.ts';
import { firstUserText, genericBlocksOf, flattenText } from './session-source.ts';
import type { ParsedTranscript, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import {
  irBump,
  irEarlier,
  irSafeTime,
  irTextBlock,
  irToolCallBlock,
  irToolResultBlock,
} from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

/* ---------------- ① SQLite 批共用形状与工具 ---------------- */

/** 一个已读成归一记录的 SQLite 会话（8 个 SQLite 来源共用同一形状） */
export interface SqliteSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

/**
 * 可注入的 SQLite 依赖（默认 = `sqlite.ts` 的真实实现）。
 *
 * 注入面只有两个函数，用途**仅限测试**：验证「宿主没有 `node:sqlite`」时的结构化降级路径
 * （竞品调研 read-claude-move §7.2 的建议：先落地一个可注入的最小适配器 + fake 实现）。
 * 生产路径（wiring 的 read）永远不传它。
 */
export interface SqliteDeps {
  readonly capability?: () => Promise<SqliteCapability>;
  readonly open?: (file: string) => Promise<SqliteHandle | null>;
}

/** 一个来源/一个库的读盘结果（0 文件也是正常结果） */
export interface SqliteReadPart {
  readonly files: readonly SqliteSessionFile[];
  readonly skipped: readonly ForeignSkip[];
  readonly counts: Readonly<Record<string, number>>;
}

/** 读不到的**稳定机器码**：code 固定 source-unreadable，detail 区分原因（绝不进用户可见文案） */
export function sqliteSkip(origin: string, detail: string): ForeignSkip {
  return { code: 'source-unreadable', origin, detail };
}

/**
 * 能力探测门：可用 → undefined；宿主缺 `node:sqlite` → 一条结构化降级 skip。
 *
 * **不抛、不返回 null**：能力缺失是「宿主不支持」这个**已知事实**，必须能被上层看见
 * （与「库读不到」不是同一件事）。
 */
export async function sqliteGate(origin: string, deps?: SqliteDeps): Promise<ForeignSkip | undefined> {
  const probe = await (deps?.capability ?? sqliteCapability)();
  if (probe.available) return undefined;
  return sqliteSkip(origin, 'sqlite-capability:' + (probe.reason ?? 'unavailable'));
}

/**
 * 只读打开（能力已探测）：默认走 `sqlite.ts` 的三态计划
 * （direct / immutable / copy —— **绝不往用户目录写文件**，见 sqlite.ts 文件头），
 * 并把失败原因带出来（`open-failed:<problem>`，如 `copy-too-large`）。
 * 注入的 `deps.open` 只能给句柄（测试用），没有细分原因 → detail 就是 `open-failed`。
 */
export async function sqliteOpen(file: string, deps?: SqliteDeps): Promise<SqliteOpenResult> {
  if (deps?.open !== undefined) return { db: await deps.open(file) };
  return await openSqliteReadOnlyEx(file);
}

/** 打开失败的 detail（稳定机器码；`problem` 缺省说明失败发生在注入的 open 里） */
export function openDetail(problem: SqliteOpenProblem | undefined): string {
  return problem === undefined ? 'open-failed' : 'open-failed:' + problem;
}

/**
 * 从「本平台拼接」的常量表名里取第一个存在的候选（表名绝不来自调用方输入）。
 * 表名一律加双引号（SQLite 标识符引号），避免与关键字相撞。
 */
function firstOf(tables: readonly string[], candidates: readonly string[]): string | undefined {
  return candidates.find((name) => tables.includes(name));
}

/** 一张表的全部行（表名只允许编译期常量；读不到 → null） */
function rowsOfTable(db: SqliteHandle, table: string): SqliteRow[] | null {
  return db.all('SELECT * FROM "' + table + '"');
}

/* ---------------- ② 单元格取值（自适应列的唯一口径） ---------------- */

/** 秒/毫秒自适应的**上界**：小于它的正数时间戳按「秒」解释（毫秒量级的 2026 年是 1.7e12） */
const SECONDS_CEILING = 100_000_000_000;

/**
 * 单元格 → 毫秒安全整数。
 *
 * 与 `session-ir.ts` 的 `irSafeTime` 的差异只有一条：SQLite 来源常见**秒**时间戳
 * （竞品 core 同款「秒/毫秒自适应 + 必须取整」），而 DSH 的时间字段要求安全整数毫秒。
 * 判据是**有界的**：只有正数且小于 `SECONDS_CEILING` 的整数才乘 1000，其余原样；
 * 负值/0 不做任何换算（绝不猜）。
 */
export function msTime(v: unknown): IrTimeMs | undefined {
  if (typeof v !== 'number') return irSafeTime(v);
  if (!Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (!Number.isSafeInteger(n)) return undefined;
  if (n > 0 && n < SECONDS_CEILING) {
    const ms = n * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  return n;
}

/** 取第一个非空字符串列值（列**必须存在**才取得到 —— 缺列只丢该字段，不抛） */
export function pickString(row: SqliteRow, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = cellText(row, key);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** 取第一个可解析时间列值（自适应列 + 秒/毫秒自适应） */
export function pickTime(row: SqliteRow, keys: readonly string[]): IrTimeMs | undefined {
  for (const key of keys) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    const t = msTime(raw);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** JSON 列的取值结果（`absent` 与 `unparsable` 必须能区分：前者不是错误，后者要计数） */
export type JsonCell =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: 'absent' | 'unparsable' };

/** 一行 JSON 列：TEXT/BLOB 里是 JSON 就解析；纯文本原样返回；空/缺 → absent；畸形 → unparsable */
export function jsonCell(row: SqliteRow, keys: readonly string[]): JsonCell {
  for (const key of keys) {
    const v = row[key];
    if (v === undefined || v === null) continue;
    let text: string | undefined;
    if (typeof v === 'string') text = v;
    else if (v instanceof Uint8Array) text = new TextDecoder().decode(v);
    else if (typeof v === 'object') return { ok: true, value: v };
    else continue;
    const trimmed = text.trim();
    if (trimmed === '') return { ok: false, problem: 'absent' };
    const head = trimmed.charAt(0);
    if (head === '{' || head === '[') {
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch {
        return { ok: false, problem: 'unparsable' };
      }
    }
    return { ok: true, value: text };
  }
  return { ok: false, problem: 'absent' };
}

/* ---------------- ③ opencode 家族的表/列候选（真值表见 chat-import §3.1） ---------------- */

const SESSION_TABLES = ['session', 'session_v2'];
const MESSAGE_TABLES = ['message', 'session_message'];
const PART_TABLES = ['part', 'session_part'];

const SESSION_ID_KEYS = ['id', 'session_id', 'sessionId', 'sessionID'];
/** 会话表的 cwd 候选（opencode 用 directory；fork 各自有别） */
const SESSION_CWD_KEYS = ['directory', 'cwd', 'workdir', 'working_directory', 'worktree', 'project_path', 'project_dir', 'path'];
const SESSION_TITLE_KEYS = ['title', 'name', 'summary', 'slug'];
const SESSION_TIME_KEYS = ['time_created', 'created_at', 'createdAt', 'time', 'time_updated', 'updated_at', 'updatedAt'];

const MESSAGE_SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'session'];
const MESSAGE_ID_KEYS = ['id', 'message_id', 'messageId', 'messageID'];
const MESSAGE_DATA_KEYS = ['data', 'json', 'content', 'message', 'payload'];
const MESSAGE_ROLE_KEYS = ['role', 'sender'];
const MESSAGE_TIME_KEYS = ['time_created', 'created_at', 'createdAt', 'time', 'time_updated', 'updated_at', 'updatedAt'];
const MESSAGE_MODEL_KEYS = ['model', 'model_id', 'modelId'];

const PART_MESSAGE_KEYS = ['message_id', 'messageId', 'messageID', 'message', 'parent_id', 'parentID'];
const PART_DATA_KEYS = ['data', 'json', 'content', 'part', 'payload'];

/** 记账累加器（未迁移类型逐类计数 + 解析不出来的条数；两处都绝不静默） */
interface Accumulator {
  ignored: Record<string, number>;
  bad: number;
}

/** 会话行（只在解析期用） */
interface FamilySession {
  readonly id: string;
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly time?: IrTimeMs | undefined;
}

function nestedTime(payload: Record<string, unknown> | undefined): IrTimeMs | undefined {
  if (payload === undefined) return undefined;
  const time = payload['time'];
  if (isRecord(time)) {
    const t = pickTime(time, ['created', 'createdAt', 'start', 'updated', 'completed']);
    if (t !== undefined) return t;
  }
  return pickTime(payload, ['time', 'timestamp', 'createdAt', 'created_at']);
}

/**
 * opencode 家族的 part → IR 块。
 *
 * 块的词汇由本函数**逐个显式映射**（text / tool / tool-result / reasoning），其余一律
 * 按 `genericBlocksOf` 兜底并逐类计数 —— 不认识的 part 类型不会消失，而是出现在
 * `unsupported-session-record` 的 detail 里。
 */
function partDataBlocks(data: Record<string, unknown>, acc: Accumulator): IrBlock[] {
  const type = (pickString(data, ['type']) ?? '').toLowerCase();
  if (type === 'text') {
    const text = typeof data['text'] === 'string' ? data['text'] : flattenText(data['content']);
    return text === '' ? [] : [irTextBlock(text)];
  }
  if (type === 'tool' || type === 'tool-call' || type === 'tool_call') {
    const state = isRecord(data['state']) ? data['state'] : undefined;
    const id = pickString(data, ['callID', 'call_id', 'id']) ?? '';
    const name = pickString(data, ['tool', 'name']) ?? '';
    const input = state?.['input'] ?? data['input'] ?? data['arguments'];
    const blocks: IrBlock[] = [irToolCallBlock(id, name, input)];
    const output = state?.['output'] ?? data['output'];
    if (output !== undefined) {
      const status = (pickString(state ?? {}, ['status']) ?? '').toLowerCase();
      const isError = status === 'error' || status === 'failed' || (state !== undefined && state['error'] !== undefined);
      blocks.push(irToolResultBlock(id, flattenText(output, acc.ignored, 'tool-output'), isError));
    }
    return blocks;
  }
  if (type === 'tool-result' || type === 'tool_result' || type === 'toolresult') {
    const id = pickString(data, ['callID', 'call_id', 'tool_use_id', 'id']) ?? '';
    const text = flattenText(data['content'] ?? data['output'] ?? data['result'] ?? data['text'], acc.ignored, 'tool-output');
    const isError = data['is_error'] === true || data['isError'] === true || data['error'] === true;
    return [irToolResultBlock(id, text, isError)];
  }
  if (type === 'reasoning' || type === 'thinking') {
    // DSH 的 IR 没有 reasoning 块；**不伪装成正文**，逐类计数后交给上层报码
    irBump(acc.ignored, 'part:' + type);
    return [];
  }
  if (type === 'step-start' || type === 'step-finish' || type === 'snapshot' || type === 'patch' || type === 'agent') {
    irBump(acc.ignored, 'part:' + type);
    return [];
  }
  if (type === '') return genericBlocksOf(data, acc.ignored, 'part');
  irBump(acc.ignored, 'part:' + type);
  return [];
}

function partBlocks(row: SqliteRow, acc: Accumulator): IrBlock[] {
  const cell = jsonCell(row, PART_DATA_KEYS);
  if (!cell.ok) {
    if (cell.problem === 'unparsable') acc.bad++;
    return [];
  }
  if (typeof cell.value === 'string') return cell.value === '' ? [] : [irTextBlock(cell.value)];
  if (!isRecord(cell.value)) {
    acc.bad++;
    return [];
  }
  return partDataBlocks(cell.value, acc);
}

/**
 * 一个会话的消息行 → 归一记录。
 *
 * 两条结构性决定（都是 fixture 级取证，见各来源的 evidence 字段）：
 *  ① 工具生命周期在这里**成对闭合**：一个 part 同时带 input/output 时拆成两条记录
 *     （助手侧的 tool_call + 用户侧的 tool_result），因为合成器只把 tool_result 归入
 *     **已打开的 step**；两条塞进同一条助手记录会让结果被静默丢掉。
 *  ② 消息的 `data` JSON 是主形态，缺它时退回行上的 `role`/`content` 列（fork 差异）。
 */
function recordsOf(
  rows: readonly SqliteRow[],
  partsByMessage: ReadonlyMap<string, readonly SqliteRow[]>,
): { records: TranscriptRecord[]; ignored: Record<string, number>; bad: number } {
  const acc: Accumulator = { ignored: {}, bad: 0 };
  const records: TranscriptRecord[] = [];
  for (const row of rows) {
    const cell = jsonCell(row, MESSAGE_DATA_KEYS);
    let payload: Record<string, unknown> | undefined;
    if (cell.ok) {
      if (isRecord(cell.value)) payload = cell.value;
      else if (typeof cell.value === 'string' && cell.value !== '') payload = { content: cell.value };
    } else if (cell.problem === 'unparsable') {
      acc.bad++;
    }
    const roleRaw = (payload === undefined ? undefined : pickString(payload, ['role'])) ?? pickString(row, MESSAGE_ROLE_KEYS) ?? '';
    const role = roleRaw.toLowerCase();
    if (role !== 'user' && role !== 'assistant') {
      irBump(acc.ignored, role === '' ? 'message-no-role' : role);
      continue;
    }
    const messageId = pickString(row, MESSAGE_ID_KEYS);
    const time = pickTime(row, MESSAGE_TIME_KEYS) ?? nestedTime(payload);
    const model = pickString(row, MESSAGE_MODEL_KEYS) ?? (payload === undefined ? undefined : pickString(payload, ['model']));
    const blocks: IrBlock[] = [];
    if (messageId !== undefined) {
      for (const part of partsByMessage.get(messageId) ?? []) blocks.push(...partBlocks(part, acc));
    }
    if (blocks.length === 0 && payload !== undefined) {
      const content = payload['content'] ?? payload['text'];
      if (content !== undefined) blocks.push(...genericBlocksOf(content, acc.ignored, 'message'));
    }
    const pushed = splitToolResults(role as 'user' | 'assistant', blocks, { id: messageId, time, model });
    for (const rec of pushed) records.push(rec);
    if (pushed.length === 0) irBump(acc.ignored, 'message-empty');
  }
  return { records, ignored: acc.ignored, bad: acc.bad };
}

/**
 * 一条源记录 → 1~2 条归一记录（**工具生命周期闭合的唯一实现**，SQLite 批四个读器共用）。
 *
 * 为什么必须拆：合成器只把 `tool_result` 归入**已打开的 step**（助手侧消息），一条记录里
 * 同时放 tool_call 与 tool_result 时结果会被**静默丢弃**（合成器的助手分支只取 tool_call）。
 * 因此 tool_result 一律拆到紧随其后的**用户侧记录**，与真实日志的「同一 step 内闭合」同形。
 */
export function splitToolResults(
  role: 'user' | 'assistant',
  blocks: readonly IrBlock[],
  meta: { readonly id?: string | undefined; readonly time?: IrTimeMs | undefined; readonly model?: string | undefined },
): TranscriptRecord[] {
  const rest = blocks.filter((b) => b.type !== 'tool_result');
  const results = blocks.filter((b) => b.type === 'tool_result');
  const out: TranscriptRecord[] = [];
  if (rest.length > 0) out.push({ role, blocks: rest, time: meta.time, id: meta.id, model: meta.model });
  if (results.length > 0) {
    out.push({ role: 'user', blocks: results, time: meta.time, id: meta.id === undefined ? undefined : meta.id + '-result' });
  }
  return out;
}

function earliestTime(records: readonly TranscriptRecord[]): IrTimeMs | undefined {
  let earliest: IrTimeMs | undefined;
  for (const rec of records) earliest = irEarlier(earliest, rec.time);
  return earliest;
}

/**
 * 打开着的库 → 每个会话一个归一文件。
 *
 * **返回 null ⇔ 读不到**：表读不出来 / 既无 `session` 也无 `session_v2` 表 /
 * 消息表查询失败。返回空数组才是「这就是该库，但里面没有会话」。
 */
export function readOpencodeFamilyDatabase(db: SqliteHandle): SqliteReadPart | null {
  const tables = db.tables();
  if (tables === null) return null;
  const sessionTable = firstOf(tables, SESSION_TABLES);
  if (sessionTable === undefined) return null;
  // **PRAGMA table_info 自适应列**：列清单先读出来做结构自证（缺 id 列的 "session" 表不是本家族的库）
  const sessionCols = db.columns(sessionTable);
  if (sessionCols === null) return null;
  if (!SESSION_ID_KEYS.some((key) => sessionCols.includes(key))) return null;
  const sessionRows = rowsOfTable(db, sessionTable);
  if (sessionRows === null) return null;

  const counts: Record<string, number> = {};
  const sessions: FamilySession[] = [];
  let noId = 0;
  for (const row of sessionRows) {
    const id = pickString(row, SESSION_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    sessions.push({
      id,
      cwd: pickString(row, SESSION_CWD_KEYS),
      title: pickString(row, SESSION_TITLE_KEYS) ?? '',
      time: pickTime(row, SESSION_TIME_KEYS),
    });
  }

  const messagesBySession = new Map<string, SqliteRow[]>();
  let messageRows = 0;
  const messageTable = firstOf(tables, MESSAGE_TABLES);
  if (messageTable !== undefined) {
    const messageCols = db.columns(messageTable);
    if (messageCols === null) return null;
    if (!MESSAGE_SESSION_KEYS.some((key) => messageCols.includes(key))) return null;
    const rows = rowsOfTable(db, messageTable);
    if (rows === null) return null;
    for (const row of rows) {
      const key = pickString(row, MESSAGE_SESSION_KEYS);
      if (key === undefined) continue;
      messageRows++;
      const list = messagesBySession.get(key);
      if (list === undefined) messagesBySession.set(key, [row]);
      else list.push(row);
    }
  }

  const partsByMessage = new Map<string, SqliteRow[]>();
  const partTable = firstOf(tables, PART_TABLES);
  if (partTable !== undefined) {
    const partCols = db.columns(partTable);
    if (partCols === null) return null;
    if (!PART_MESSAGE_KEYS.some((key) => partCols.includes(key))) return null;
    const rows = rowsOfTable(db, partTable);
    if (rows === null) return null;
    for (const row of rows) {
      const key = pickString(row, PART_MESSAGE_KEYS);
      if (key === undefined) continue;
      const list = partsByMessage.get(key);
      if (list === undefined) partsByMessage.set(key, [row]);
      else list.push(row);
    }
  }

  const files: SqliteSessionFile[] = [];
  for (const session of sessions) {
    const rows = messagesBySession.get(session.id) ?? [];
    const parsed = recordsOf(rows, partsByMessage);
    files.push({
      id: session.id,
      parsed: {
        records: parsed.records,
        cwd: session.cwd,
        createdAt: irEarlier(session.time, earliestTime(parsed.records)),
        title: session.title !== '' ? session.title : firstUserText(parsed.records),
        raw: rows.length,
        bad: parsed.bad,
        ignored: parsed.ignored,
      },
    });
  }

  counts['sessions'] = sessions.length;
  counts['messages'] = messageRows;
  counts['parts'] = partsByMessage.size;
  if (noId > 0) counts['sessions.without-id'] = noId;
  if (messageTable === undefined) counts['messages.table-missing'] = 1;
  return { files, skipped: [], counts };
}

/**
 * 家族入口：存在性 → 能力门 → 只读打开 → 解析，四步的错误各有稳定码。
 *
 * **库文件不存在 = 未安装**：不报码（与 detect 的 found:false 一致）；
 * 「存在但打不开 / 不是这个来源的库 / 查询失败」= 一条 `source-unreadable`（响亮）。
 */
export async function readOpencodeFamily(
  dbFile: string,
  label: string,
  deps?: SqliteDeps,
): Promise<SqliteReadPart> {
  if (!(await isFile(dbFile))) return { files: [], skipped: [], counts: {} };
  const gate = await sqliteGate(label, deps);
  if (gate !== undefined) return { files: [], skipped: [gate], counts: {} };
  const opened = await sqliteOpen(dbFile, deps);
  if (opened.db === null) return { files: [], skipped: [sqliteSkip(label, openDetail(opened.problem))], counts: {} };
  const db = opened.db;
  try {
    const read = readOpencodeFamilyDatabase(db);
    if (read === null) return { files: [], skipped: [sqliteSkip(label, 'shape-mismatch')], counts: {} };
    return read;
  } finally {
    db.close();
  }
}

/* ---------------- ④ opencode 本体的真值表路径 ---------------- */

/** 真值表路径函数的入参（与 `session-source.ts` 的 RootProbeOptions 同形，只取用得到的字段） */
export interface SqlitePathInput {
  readonly homeDir: string;
  readonly platform: string;
}

/**
 * 三平台同形的 `<home>/.local/share/<product>/<name>`。
 *
 * 这条规则**Windows 也不走 %APPDATA%**（chat-import discovery.mjs:125-131 的
 * `joinFor('win32', home, '.local','share', ...)`）；read-claude-move 的 %APPDATA% 说法
 * 与 chat-import 冲突，按「有出入以 chat-import 为准」取它（真值表同款结论）。
 */
export function posixShareDbPath(platform: string, homeDir: string, product: string, name: string): string {
  const p = normalizePlatform(platform);
  return joinFor(p, posixLocalShare(p, homeDir), product, name);
}

/** opencode 的库：`<home>/.local/share/opencode/opencode.db` */
export function opencodeDbPath(opts: SqlitePathInput): string {
  return posixShareDbPath(opts.platform, opts.homeDir, 'opencode', 'opencode.db');
}

/** opencode 的读盘入口（wiring 的 `read`） */
export async function readOpencode(
  opts: SqlitePathInput & { readonly sqliteDeps?: SqliteDeps | undefined },
): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(opencodeDbPath(opts), 'opencode.db', opts.sqliteDeps);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'opencode.sessions': read.files.length, ...prefixCounts('opencode', read.counts) },
  };
}

/** 把家族计数键加上来源前缀（避免多来源合并时撞键） */
export function prefixCounts(prefix: string, counts: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) out[prefix + '.' + key] = value;
  return out;
}
