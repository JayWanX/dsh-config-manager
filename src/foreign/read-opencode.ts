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

/**
 * 逐会话剔除谓词看到的会话视图（**只由本仓库的 `read-<id>.ts` 使用**，绝不接受用户输入）。
 *
 * 三个 fork 的剔除事实所在层不同，因此视图把三层一次给全：`row`（fork 专有列，如 kilocode 的
 * `parent_id` / `time_archived`）、`messages`（mimocode 的后台标记在 `data.agent` 里 —— 与竞品
 * `readOpencodeDb` 抽 `agent` 供 `isMimocodeBackgroundSession` 过滤同一理由）、`parsed`（已归一记录）。
 */
export interface FamilySessionView {
  readonly id: string;
  readonly row: SqliteRow;
  readonly title: string;
  readonly cwd?: string | undefined;
  readonly time?: IrTimeMs | undefined;
  readonly messages: readonly SqliteRow[];
  readonly parsed: ParsedTranscript;
}

/** 家族读器的逐源差异（缺省 = 不过滤，opencode / teleagent 口径） */
export interface FamilyReadOptions {
  /** 返回 true = 该会话不进结果集（逐源差异，见 `FamilySessionView`）；剔除数进 `sessions.dropped` */
  readonly dropSession?: ((session: FamilySessionView) => boolean) | undefined;
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

/** 默认排序键候选（自适应列：取**实际存在**的第一个时间列，再拿 `id` 兜底） */
const ORDER_TIME_KEYS = ['time_created', 'time_updated', 'created_at', 'createdAt', 'time'];

/**
 * 一张表的全部行（表名只允许编译期常量；读不到 → null）。**必须带 ORDER BY**（竞品同口径的
 * `ORDER BY time_created, id`）：SQLite 无 ORDER BY 时行序是实现定义的，一旦漂移，工具 call/result
 * 配对与轮次切分就跟着错。排序键从**实际存在的列**里取（自适应列，见文件头纪律②）；一个都没有时不排序。
 */
function rowsOfTable(
  db: SqliteHandle,
  table: string,
  cols: readonly string[],
  timeKeys: readonly string[] = ORDER_TIME_KEYS,
): SqliteRow[] | null {
  const order: string[] = [];
  const time = timeKeys.find((key) => cols.includes(key));
  if (time !== undefined) order.push(time);
  if (cols.includes('id')) order.push('id');
  const suffix = order.length === 0 ? '' : ' ORDER BY ' + order.map((key) => '"' + key + '"').join(', ');
  return db.all('SELECT * FROM "' + table + '"' + suffix);
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

/** V1 三表（opencode 1.x）与 V2 两表（opencode 2.x）的表名（**编译期常量**，绝不拼调用方输入） */
const SESSION_TABLE_V1 = 'session';
const SESSION_TABLE_V2 = 'session_v2';
const TRANSCRIPT_TABLE_V2 = 'session_message';
const MESSAGE_TABLES = ['message', 'session_message'];
const PART_TABLES = ['part', 'session_part'];

/**
 * 库属于哪一代：`'v2'`（session_v2）/ `'v1'`（session）/ `undefined`（两者都没有）。
 *
 * **v2 必须优先**（竞品 `opencodeSchemaGeneration`）：V1→V2 迁移后旧三表仍留在同一个库里
 * （只是迁移的来源），先取 `session` 会读到**过期**数据 —— 新会话在 v2 表里、老会话在 v1 表里，
 * 两边都读还会让同一会话被导入两次。
 */
export function opencodeSchemaGeneration(tables: readonly string[]): 'v1' | 'v2' | undefined {
  if (tables.includes(SESSION_TABLE_V2)) return 'v2';
  if (tables.includes(SESSION_TABLE_V1)) return 'v1';
  return undefined;
}

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
/** 会话级模型列（opencode 的 `session.model` 是 JSON 字符串 `{id, providerID, variant}`） */
const SESSION_MODEL_KEYS = ['model', 'model_id', 'modelId'];
/** 会话/消息级模型对象里取 id 的候选（opencode 用 `id`，fork 可能写 `modelID`） */
const MODEL_ID_KEYS = ['id', 'modelID', 'model_id', 'modelId'];

/** V2（session_message）的专属列候选 */
const V2_TYPE_KEYS = ['type', 'kind'];
const V2_MESSAGE_ORDER_KEYS = ['seq', 'time_created', 'id'];

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
  /** 会话行原样（逐源剔除谓词要读 fork 专有列，如 kilocode 的 parent_id / time_archived） */
  readonly row: SqliteRow;
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly time?: IrTimeMs | undefined;
  /** 会话级模型（消息级缺席时的兜底；见 sessionModelOf） */
  readonly model?: string | undefined;
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

/** 消息级模型（竞品 convert/opencode.mjs:249-255 的回退链：平铺 modelID 优先，其次 model.modelID / model 字符串） */
function payloadModel(payload: Record<string, unknown>): string | undefined {
  const flat = payload['modelID'] ?? payload['model_id'] ?? payload['modelId'];
  if (typeof flat === 'string' && flat !== '') return flat;
  const model = payload['model'];
  if (isRecord(model)) {
    const nested = pickString(model, MODEL_ID_KEYS);
    if (nested !== undefined) return nested;
  }
  if (typeof model === 'string' && model !== '') return model;
  return undefined;
}

/**
 * 会话级模型（opencode 的 `session.model` 是 JSON 字符串 `{id, providerID, variant}`；
 * fork 可能是对象或纯字符串）。非 JSON 的脏值不猜 —— 回退链继续走消息级（竞品同口径）。
 */
function sessionModelOf(row: SqliteRow): string | undefined {
  for (const key of SESSION_MODEL_KEYS) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    if (isRecord(raw)) {
      const id = pickString(raw, MODEL_ID_KEYS);
      if (id !== undefined) return id;
      continue;
    }
    const text = cellText(row, key);
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (trimmed === '') continue;
    if (trimmed.charAt(0) !== '{') return trimmed;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        const id = pickString(parsed, MODEL_ID_KEYS);
        if (id !== undefined) return id;
      }
    } catch {
      // 非 JSON（个别脏数据）→ 无会话级模型，回退链继续走消息级
    }
  }
  return undefined;
}

/**
 * `data.tokens`（opencode：`{input, output, reasoning, cache:{read, write}}`）→ IR usage 的键名
 * （对齐 `irUsageOf`，非安全整数/缺字段归 0）。`cache.write` 在 `IrUsage` 里没有对应字段，不映射。
 */
function usageOf(tokens: unknown): unknown {
  if (!isRecord(tokens)) return undefined;
  const cache = isRecord(tokens['cache']) ? tokens['cache'] : undefined;
  return {
    inputTokens: tokens['input'],
    outputTokens: tokens['output'],
    reasoningTokens: tokens['reasoning'],
    cacheReadTokens: cache === undefined ? undefined : cache['read'],
  };
}

/** 消息级摘要正文（zcode 的 `data.summary.body`；其它来源可能是纯字符串 `data.summary`） */
function summaryBodyOf(payload: Record<string, unknown>): string | undefined {
  const summary = payload['summary'];
  if (typeof summary === 'string') return summary.trim() === '' ? undefined : summary;
  if (!isRecord(summary)) return undefined;
  const body = summary['body'];
  return typeof body === 'string' && body.trim() !== '' ? body : undefined;
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
    // **output 缺失也发空结果**（竞品 convert/opencode.mjs:187-191 同口径）：只发 tool_call 会留下
    // 「有 call 无 result」的断链，合成器永远配不上对；空文本结果让它成对闭合。
    const output = state?.['output'] ?? data['output'];
    const status = (pickString(state ?? {}, ['status']) ?? '').toLowerCase();
    const isError = status === 'error' || status === 'failed' || (state !== undefined && state['error'] !== undefined);
    blocks.push(irToolResultBlock(id, flattenText(output, acc.ignored, 'tool-output'), isError));
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
  if (type === 'file') {
    // 图片/附件部分：本地 IR **没有 image 块**（见 session-ir.ts 的块词表），因此不可能落成宿主附件。
    // **不伪装成正文** —— 用 `[image: <name>]` 文本占位（竞品拿不到内联字节时的同款降级文案）并逐张计数。
    irBump(acc.ignored, 'part:file');
    return [irTextBlock('[image: ' + (pickString(data, ['filename', 'name']) ?? 'unknown') + ']')];
  }
  if (type === 'patch') {
    // 补丁块原文不落地（竞品只留条数摘要），但**不静默丢**：文件数进正文占位
    const files = Array.isArray(data['files']) ? data['files'].length : 0;
    return [irTextBlock('[patch: ' + String(files) + ' files]')];
  }
  if (type === 'subtask') {
    const command = typeof data['command'] === 'string' ? data['command'] : '';
    const description = typeof data['description'] === 'string' ? data['description'] : '';
    return [irTextBlock('[subtask: ' + command + ' — ' + description + ']')];
  }
  if (type === 'step-start' || type === 'step-finish' || type === 'snapshot' || type === 'agent') {
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
  sessionModel: string | undefined,
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
    // 模型回退链（竞品 convert/opencode.mjs:248-266 同口径，只多一条行级 model 列）：
    // 行级 model 列 → data.modelID → data.model.modelID / data.model（字符串）→ 会话级 model
    const model = pickString(row, MESSAGE_MODEL_KEYS)
      ?? (payload === undefined ? undefined : payloadModel(payload))
      ?? sessionModel;
    // provider 回报用量（assistant 消息的 data.tokens）；user 消息/老库缺席 → 不占键
    const usage = payload === undefined ? undefined : usageOf(payload['tokens']);
    // 消息级压缩摘要（zcode 的 data.summary.body）：源侧压缩标记，正文由**会话级摘要**承载 ——
    // 本地 IR 没有压缩通道（session-ir.ts 的「补头/注入/压缩属于待办能力」），正文进不了对话；
    // 但**绝不静默**：逐条计数（message:summary）让缺口在 unsupported-session-record 里可见。
    if (payload !== undefined && summaryBodyOf(payload) !== undefined) irBump(acc.ignored, 'message:summary');
    const blocks: IrBlock[] = [];
    if (messageId !== undefined) {
      for (const part of partsByMessage.get(messageId) ?? []) blocks.push(...partBlocks(part, acc));
    }
    if (blocks.length === 0 && payload !== undefined) {
      const content = payload['content'] ?? payload['text'];
      if (content !== undefined) blocks.push(...genericBlocksOf(content, acc.ignored, 'message'));
    }
    const pushed = splitToolResults(role as 'user' | 'assistant', blocks, { id: messageId, time, model, usage });
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
  meta: {
    readonly id?: string | undefined;
    readonly time?: IrTimeMs | undefined;
    readonly model?: string | undefined;
    /** provider 回报用量（assistant 侧；user 侧合成器不看，透传无害） */
    readonly usage?: unknown;
  },
): TranscriptRecord[] {
  const rest = blocks.filter((b) => b.type !== 'tool_result');
  const results = blocks.filter((b) => b.type === 'tool_result');
  const out: TranscriptRecord[] = [];
  if (rest.length > 0) out.push({ role, blocks: rest, time: meta.time, id: meta.id, model: meta.model, usage: meta.usage });
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
 *
 * **世代在这里先分派**（见 opencodeSchemaGeneration）：V2 库走 session_v2 + session_message，
 * V1 库走三表；两条路径产出的形状完全一致，差异只在读取层。
 */
export function readOpencodeFamilyDatabase(db: SqliteHandle, options?: FamilyReadOptions): SqliteReadPart | null {
  const tables = db.tables();
  if (tables === null) return null;
  const generation = opencodeSchemaGeneration(tables);
  if (generation === undefined) return null;
  const sessionTable = generation === 'v2' ? SESSION_TABLE_V2 : SESSION_TABLE_V1;
  // **PRAGMA table_info 自适应列**：列清单先读出来做结构自证（缺 id 列的 "session" 表不是本家族的库）
  const sessionCols = db.columns(sessionTable);
  if (sessionCols === null) return null;
  if (!SESSION_ID_KEYS.some((key) => sessionCols.includes(key))) return null;
  const sessionRows = rowsOfTable(db, sessionTable, sessionCols);
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
      row,
      cwd: pickString(row, SESSION_CWD_KEYS),
      title: pickString(row, SESSION_TITLE_KEYS) ?? '',
      time: pickTime(row, SESSION_TIME_KEYS),
      model: sessionModelOf(row),
    });
  }
  if (noId > 0) counts['sessions.without-id'] = noId;
  return generation === 'v2'
    ? readV2Part(db, tables, sessions, counts, options)
    : readV1Part(db, tables, sessions, counts, options);
}

/**
 * 会话 → 归一文件（V1 / V2 两条路径共用）：记录解析由调用方给，逐源剔除谓词在这里统一收口
 * （见 FamilySessionView）。剔除**绝不静默**（计数进 `sessions.dropped`，与 `sessions.without-id` 同口径）。
 */
function familyFiles(
  sessions: readonly FamilySession[],
  counts: Record<string, number>,
  options: FamilyReadOptions | undefined,
  recordsOfSession: (session: FamilySession) => { records: TranscriptRecord[]; ignored: Record<string, number>; bad: number },
  rowsOfSession: (session: FamilySession) => readonly SqliteRow[],
): SqliteSessionFile[] {
  const files: SqliteSessionFile[] = [];
  let dropped = 0;
  for (const session of sessions) {
    const raw = rowsOfSession(session);
    const parsed0 = recordsOfSession(session);
    const parsed: ParsedTranscript = {
      records: parsed0.records,
      cwd: session.cwd,
      createdAt: irEarlier(session.time, earliestTime(parsed0.records)),
      title: session.title !== '' ? session.title : firstUserText(parsed0.records),
      raw: raw.length,
      bad: parsed0.bad,
      ignored: parsed0.ignored,
    };
    const view: FamilySessionView = {
      id: session.id,
      row: session.row,
      title: session.title,
      cwd: session.cwd,
      time: session.time,
      messages: raw,
      parsed,
    };
    if (options?.dropSession !== undefined && options.dropSession(view)) {
      dropped++;
      continue;
    }
    files.push({ id: session.id, parsed });
  }
  counts['sessions'] = files.length;
  if (dropped > 0) counts['sessions.dropped'] = dropped;
  return files;
}

/** V1 库（session / message / part 三表）→ 归一文件；表结构不符一律 null（统一判负层次） */
function readV1Part(
  db: SqliteHandle,
  tables: readonly string[],
  sessions: readonly FamilySession[],
  counts: Record<string, number>,
  options: FamilyReadOptions | undefined,
): SqliteReadPart | null {
  const messagesBySession = new Map<string, SqliteRow[]>();
  let messageRows = 0;
  const messageTable = firstOf(tables, MESSAGE_TABLES);
  if (messageTable !== undefined) {
    const messageCols = db.columns(messageTable);
    if (messageCols === null) return null;
    if (!MESSAGE_SESSION_KEYS.some((key) => messageCols.includes(key))) return null;
    const rows = rowsOfTable(db, messageTable, messageCols);
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
  // 计数口径 = **part 行数**（此前记的是去重后的消息键数，与键名 parts 名不副实）
  let partRows = 0;
  const partTable = firstOf(tables, PART_TABLES);
  if (partTable !== undefined) {
    const partCols = db.columns(partTable);
    if (partCols === null) return null;
    if (!PART_MESSAGE_KEYS.some((key) => partCols.includes(key))) return null;
    const rows = rowsOfTable(db, partTable, partCols);
    if (rows === null) return null;
    for (const row of rows) {
      const key = pickString(row, PART_MESSAGE_KEYS);
      if (key === undefined) continue;
      partRows++;
      const list = partsByMessage.get(key);
      if (list === undefined) partsByMessage.set(key, [row]);
      else list.push(row);
    }
  }

  const files = familyFiles(
    sessions,
    counts,
    options,
    (session) => recordsOf(messagesBySession.get(session.id) ?? [], partsByMessage, session.model),
    (session) => messagesBySession.get(session.id) ?? [],
  );
  counts['messages'] = messageRows;
  counts['parts'] = partRows;
  if (messageTable === undefined) counts['messages.table-missing'] = 1;
  return { files, skipped: [], counts };
}

/**
 * V2 库（session_v2 + session_message）→ 归一文件。V2 没有 part 表：**一条 session_message 行
 * 就是一个内容单元**，靠行上的 `type` 列分派。缺 `session_message` 表时不假装没有会话：
 * 会话元数据照读、逐条落 session-empty（与 zcode「message 表可能缺失」同口径）。
 */
function readV2Part(
  db: SqliteHandle,
  tables: readonly string[],
  sessions: readonly FamilySession[],
  counts: Record<string, number>,
  options: FamilyReadOptions | undefined,
): SqliteReadPart | null {
  const bySession = new Map<string, SqliteRow[]>();
  let messageRows = 0;
  const hasTranscript = tables.includes(TRANSCRIPT_TABLE_V2);
  if (hasTranscript) {
    const cols = db.columns(TRANSCRIPT_TABLE_V2);
    if (cols === null) return null;
    if (!MESSAGE_SESSION_KEYS.some((key) => cols.includes(key))) return null;
    // 转录按 **seq** 升序重建（竞品 ORDER BY seq；行序漂移会让消息顺序错乱）
    const rows = rowsOfTable(db, TRANSCRIPT_TABLE_V2, cols, V2_MESSAGE_ORDER_KEYS);
    if (rows === null) return null;
    for (const row of rows) {
      const key = pickString(row, MESSAGE_SESSION_KEYS);
      if (key === undefined) continue;
      messageRows++;
      const list = bySession.get(key);
      if (list === undefined) bySession.set(key, [row]);
      else list.push(row);
    }
  }

  const files = familyFiles(
    sessions,
    counts,
    options,
    (session) => v2RecordsOf(bySession.get(session.id) ?? [], session.model),
    (session) => bySession.get(session.id) ?? [],
  );
  counts['messages'] = messageRows;
  // V2 没有 part 行；「一条转录行 = 一个内容单元」，不再用去重后的消息键数冒充 part 数
  if (!hasTranscript) counts['messages.table-missing'] = 1;
  return { files, skipped: [], counts };
}

/**
 * V2 转录行 → 归一记录（**按行上的 `type` 列分派**，竞品 readOpencodeV2 同口径）。不能沿用 V1 的
 * 「按 data.role 判角色」：V2 的 `data` 里没有 role（role 在行的 `type` 列上）→ 旧实现整会话 session-empty。
 */
function v2RecordsOf(
  rows: readonly SqliteRow[],
  sessionModel: string | undefined,
): { records: TranscriptRecord[]; ignored: Record<string, number>; bad: number } {
  const acc: Accumulator = { ignored: {}, bad: 0 };
  const records: TranscriptRecord[] = [];
  const push = (role: 'user' | 'assistant', blocks: readonly IrBlock[], meta: { id?: string | undefined; time?: IrTimeMs | undefined; model?: string | undefined; usage?: unknown }): void => {
    const pushed = splitToolResults(role, blocks, meta);
    for (const rec of pushed) records.push(rec);
    if (pushed.length === 0) irBump(acc.ignored, 'message-empty');
  };
  for (const row of rows) {
    const cell = jsonCell(row, MESSAGE_DATA_KEYS);
    let data: Record<string, unknown> | undefined;
    if (cell.ok) {
      if (isRecord(cell.value)) data = cell.value;
    } else if (cell.problem === 'unparsable') {
      acc.bad++;
    }
    const type = (pickString(row, V2_TYPE_KEYS) ?? '').toLowerCase();
    const id = pickString(row, MESSAGE_ID_KEYS);
    const time = pickTime(row, MESSAGE_TIME_KEYS);
    if (type === 'user') {
      push('user', v2UserBlocks(data, acc), { id, time });
      continue;
    }
    if (type === 'assistant') {
      const model = v2MessageModel(data) ?? sessionModel;
      const usage = data === undefined ? undefined : usageOf(data['tokens']);
      push('assistant', v2AssistantBlocks(data, acc), { id, time, model, usage });
      continue;
    }
    if (type === 'compaction') {
      const body = v2CompactionBody(data);
      const status = data === undefined ? '' : (pickString(data, ['status']) ?? '').toLowerCase();
      if (status !== 'completed') {
        // running / failed：不是「模型可见的压缩边界」→ 正文按普通内容保留（竞品同口径，绝不静默丢）
        if (body !== '') push('user', [irTextBlock(body)], { id, time });
        else irBump(acc.ignored, 'message:compaction-' + (status === '' ? 'unknown' : status));
      } else {
        // completed 是模型可见的边界：正文由 DSH 原生压缩检查点承载 —— 本地 IR 没有该通道
        //（session-ir.ts：「补头/注入/压缩属于待办能力」），正文进不了对话；绝不静默：逐条计数。
        irBump(acc.ignored, 'message:compaction');
      }
      continue;
    }
    if (type === 'synthetic' || type === 'system' || type === 'skill') {
      // 注入文本（工具改名通知 / 合成续跑提示 / 技能正文）：当用户文本保留
      const text = data === undefined ? undefined : data['text'];
      if (typeof text === 'string' && text.trim() !== '') push('user', [irTextBlock(text)], { id, time });
      else irBump(acc.ignored, 'message:' + type);
      continue;
    }
    if (type === 'shell') {
      const text = v2ShellText(data);
      if (text !== '') push('user', [irTextBlock(text)], { id, time });
      else irBump(acc.ignored, 'message:shell');
      continue;
    }
    // idle / agent-switched / model-switched / location-switched（无正文的结构性标记）与未知类型：
    // 不进对话，但逐类计数（绝不静默）
    irBump(acc.ignored, 'message:' + (type === '' ? 'no-type' : type));
  }
  return { records, ignored: acc.ignored, bad: acc.bad };
}

/** V2 user 消息 → 块（text + 附件；本地 IR 无 image 块，附件一律走文本占位并计数） */
function v2UserBlocks(data: Record<string, unknown> | undefined, acc: Accumulator): IrBlock[] {
  if (data === undefined) return [];
  const blocks: IrBlock[] = [];
  const text = data['text'];
  if (typeof text === 'string' && text.trim() !== '') blocks.push(irTextBlock(text));
  const files = data['files'];
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!isRecord(file)) continue;
      // 有内联字节也落不成附件（本地 IR 没有 image 块）→ 与竞品「拿不到字节」同款占位文案
      irBump(acc.ignored, 'message:attachment');
      const name = pickString(file, ['name', 'filename', 'mime']) ?? 'unknown';
      blocks.push(irTextBlock('[attachment: ' + name + ']'));
    }
  }
  return blocks;
}

/** V2 assistant 消息的 content[] → 块（text / reasoning 计数 / tool 成对） */
function v2AssistantBlocks(data: Record<string, unknown> | undefined, acc: Accumulator): IrBlock[] {
  if (data === undefined) return [];
  const blocks: IrBlock[] = [];
  const content = data['content'];
  if (!Array.isArray(content)) {
    if (content !== undefined) irBump(acc.ignored, 'message:content-unmapped');
    return blocks;
  }
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = (pickString(item, ['type']) ?? '').toLowerCase();
    if (type === 'text') {
      if (typeof item['text'] === 'string') blocks.push(irTextBlock(item['text']));
      continue;
    }
    if (type === 'reasoning') {
      // 同 V1：本地 IR 没有 reasoning 块，不伪装成正文，逐类计数
      irBump(acc.ignored, 'part:reasoning');
      continue;
    }
    if (type === 'tool') {
      blocks.push(...v2ToolBlocks(item, acc));
      continue;
    }
    irBump(acc.ignored, 'part:' + (type === '' ? 'unmapped' : type));
  }
  return blocks;
}

/**
 * V2 tool 内容项 → tool_call + tool_result（**恒成对**）。input 在 streaming 状态下是未完成的
 * JSON 字符串：能解析就解析，不能就放进 `partial`（竞品同口径）。输出取 `state.content` 的文本、
 * 空时回退 `state.error.message`；都空也发空结果（保住 call/result 配对）。
 */
function v2ToolBlocks(item: Record<string, unknown>, acc: Accumulator): IrBlock[] {
  const state = isRecord(item['state']) ? item['state'] : undefined;
  const id = pickString(item, ['id', 'callID', 'call_id']) ?? '';
  const name = pickString(item, ['name', 'tool']) ?? '';
  let input = state?.['input'];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    try {
      input = JSON.parse(trimmed);
    } catch {
      input = trimmed === '' ? {} : { partial: input };
    }
  }
  const status = (pickString(state ?? {}, ['status']) ?? '').toLowerCase();
  const isError = status === 'error' || status === 'failed' || (state !== undefined && state['error'] !== undefined);
  let output = '';
  const content = state?.['content'];
  if (Array.isArray(content)) {
    output = content
      .map((entry) => (isRecord(entry) && entry['type'] === 'text' && typeof entry['text'] === 'string'
        ? entry['text']
        : '[file: ' + (isRecord(entry) ? (pickString(entry, ['name', 'uri']) ?? 'unknown') : 'unknown') + ']'))
      .join('\n');
  }
  if (output === '') {
    const error = state?.['error'];
    if (isRecord(error) && typeof error['message'] === 'string') output = error['message'];
  }
  return [irToolCallBlock(id, name, input), irToolResultBlock(id, output, isError)];
}

/** V2 assistant 消息级模型（竞品：data.model.id；兼容平铺 modelID 与字符串 model） */
function v2MessageModel(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined;
  const flat = data['modelID'];
  if (typeof flat === 'string' && flat !== '') return flat;
  const model = data['model'];
  if (isRecord(model)) {
    const id = pickString(model, ['id', 'modelID', 'model_id', 'modelId']);
    if (id !== undefined) return id;
  }
  if (typeof model === 'string' && model !== '') return model;
  return undefined;
}

/** V2 compaction 行正文 = summary + recent（非 completed 时才进对话；completed 由检查点承载） */
function v2CompactionBody(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return '';
  return [data['summary'], data['recent']]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join('\n\n')
    .trim();
}

/** V2 shell 行 → 可见文本（无样本来源的保守兜底：命令 + 状态 + 输出） */
function v2ShellText(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return '';
  const command = typeof data['command'] === 'string' ? data['command'] : '';
  const output = typeof data['output'] === 'string' ? data['output'] : '';
  const status = typeof data['status'] === 'string' ? data['status'] : '';
  const head = '[shell' + (status === '' ? '' : ':' + status) + '] ' + command;
  return [head, output].filter((s) => s.trim() !== '').join('\n').trim();
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
  options?: FamilyReadOptions,
): Promise<SqliteReadPart> {
  if (!(await isFile(dbFile))) return { files: [], skipped: [], counts: {} };
  const gate = await sqliteGate(label, deps);
  if (gate !== undefined) return { files: [], skipped: [gate], counts: {} };
  const opened = await sqliteOpen(dbFile, deps);
  if (opened.db === null) return { files: [], skipped: [sqliteSkip(label, openDetail(opened.problem))], counts: {} };
  const db = opened.db;
  try {
    const read = readOpencodeFamilyDatabase(db, options);
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
