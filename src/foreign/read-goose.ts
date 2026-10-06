/**
 * Goose 用户目录的**读盘层** + 真值表路径。
 *
 * 真值表（read-vault §10.1 goose 行 + chat-import convert/goose.mjs:58-75/sources/goose.mjs:92-123；
 * read-movein 附录 A 的 goose 行、read-sessions-manager ⑧.4 第 22 行交叉核对一致）：
 *  - win32  `%APPDATA%/Block/goose/data/sessions/sessions.db`
 *  - darwin `~/Library/Application Support/Block/goose/sessions/sessions.db`（**无 /data 段**）
 *  - linux  `~/.local/share/goose/sessions/sessions.db`（**无 Block 段**）
 *  - `$GOOSE_PATH_ROOT`（**仅绝对路径生效**）= 替换基座 → `<root>/data/sessions/sessions.db`
 *  - **旧 `sessions/*.jsonl` 刻意不读**（竞品注释：与库内容重复，读了会重复导入）
 *
 * 表形态（竞品 sources/goose.mjs:103-105 的签名判定）：
 *  `sessions{id, session_type, working_dir...}` + `messages{session_id, content_json}`。
 *  `sessions.db` 是 **cline 与 goose 共用文件名** → 本层按**结构自证**（必须有 `sessions.id`
 *  与 `working_dir`；cline 用 `session_id` 且无 working_dir），不靠文件名。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端跑同一形态）。
 */
import { absoluteEnvPath, joinFor, normalizePlatform, roamingAppDataDir, xdgDataHome } from './platform-paths.ts';
import { isFile, labelForPath } from './session-read.ts';
import {
  jsonCell,
  openDetail,
  pickString,
  pickTime,
  prefixCounts,
  sqliteGate,
  sqliteOpen,
  sqliteSkip,
  splitToolResults,
} from './read-opencode.ts';
import type { SqliteDeps, SqliteReadPart, SqliteSessionFile } from './read-opencode.ts';
import type { SqliteHandle, SqliteRow } from './sqlite.ts';
import { irBump, irTextBlock, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, flattenText } from './session-source.ts';
import type { SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export interface GoosePathInput {
  readonly homeDir: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Goose 的**数据目录**（库在它的 `sessions/sessions.db` 下）；env 覆盖是「绝对路径才生效」的替换 */
export function gooseDataDir(opts: GoosePathInput): string {
  const platform = normalizePlatform(opts.platform);
  const root = absoluteEnvPath(opts.env, 'GOOSE_PATH_ROOT', platform);
  if (root !== undefined) return joinFor(platform, root, 'data');
  if (platform === 'win32') {
    return joinFor(platform, roamingAppDataDir(platform, opts.homeDir, opts.env), 'Block', 'goose', 'data');
  }
  if (platform === 'darwin') {
    return joinFor(platform, roamingAppDataDir(platform, opts.homeDir, opts.env), 'Block', 'goose');
  }
  return joinFor(platform, xdgDataHome(platform, opts.homeDir, opts.env), 'goose');
}

/** Goose 的库：`<dataDir>/sessions/sessions.db` */
export function gooseDbPath(opts: GoosePathInput): string {
  return joinFor(normalizePlatform(opts.platform), gooseDataDir(opts), 'sessions', 'sessions.db');
}

/* ---------------- 表/列候选（自适应列；缺列只丢该字段） ---------------- */

const GOOSE_SESSION_ID_KEYS = ['id', 'session_id', 'sessionId'];
const GOOSE_SESSION_CWD_KEYS = ['working_dir', 'working_directory', 'cwd', 'directory', 'project_dir'];
const GOOSE_SESSION_TITLE_KEYS = ['name', 'title', 'description', 'summary'];
const GOOSE_SESSION_TIME_KEYS = ['created_at', 'createdAt', 'time_created', 'updated_at', 'updatedAt'];

const GOOSE_SESSION_TYPE_KEYS = ['session_type', 'sessionType'];
const GOOSE_SESSION_PARENT_KEYS = ['parent_session_id', 'parentSessionId', 'parentSession'];
const GOOSE_MESSAGE_SESSION_KEYS = ['session_id', 'sessionId', 'session'];
const GOOSE_MESSAGE_ID_KEYS = ['id', 'message_id', 'messageId'];
const GOOSE_MESSAGE_ROLE_KEYS = ['role', 'sender'];
const GOOSE_MESSAGE_TIME_KEYS = ['created_timestamp', 'created_at', 'createdAt', 'timestamp', 'time_created'];
const GOOSE_CONTENT_KEYS = ['content_json', 'content', 'data', 'json'];

interface GooseAcc {
  ignored: Record<string, number>;
  bad: number;
}

/**
 * Goose 的内容块 → IR 块（**逐个显式映射**，其余逐类计数）。
 *
 * 竞品取证（read-chat-import §8.4）点名 `content_json` 有 8 种块词汇、工具靠
 * `toolRequest.id ↔ toolResponse.id` 配对 —— 这里保留 id 原样（不伪造），配对交给合成器。
 *
 * 信封键名：真实库（serde 默认字段命名）是 **snake_case** `tool_call` / `tool_result`，
 * 旧代码只认 camelCase `toolCall` / `toolResult` → 工具名/参数/结果全落空；这里两种都接受，
 * snake_case 优先（参考 lib/convert/goose.mjs mapGooseBlock）。
 */
function firstRecordValue(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const v = record[key];
    if (isRecord(v)) return v;
  }
  return undefined;
}

function gooseBlock(item: unknown, acc: GooseAcc): IrBlock[] {
  if (typeof item === 'string') return item === '' ? [] : [irTextBlock(item)];
  if (!isRecord(item)) {
    acc.bad++;
    return [];
  }
  const type = (pickString(item, ['type']) ?? '').toLowerCase();
  if (type === 'text') {
    const text = typeof item['text'] === 'string' ? item['text'] : flattenText(item['content']);
    return text === '' ? [] : [irTextBlock(text)];
  }
  if (type === 'toolrequest' || type === 'tool_request') {
    const call = firstRecordValue(item, ['tool_call', 'toolCall']);
    const value = call !== undefined && isRecord(call['value']) ? call['value'] : undefined;
    const id = pickString(item, ['id']) ?? '';
    const name = value === undefined ? '' : (pickString(value, ['name']) ?? '');
    const input = value?.['arguments'] ?? value?.['input'];
    return [irToolCallBlock(id, name, input)];
  }
  if (type === 'toolresponse' || type === 'tool_response') {
    const result = firstRecordValue(item, ['tool_result', 'toolResult']);
    const value = result !== undefined && isRecord(result['value']) ? result['value'] : undefined;
    const id = pickString(item, ['id']) ?? '';
    // 出错时没有 value：结果正文回落到信封的 error 字符串（参考 toolResponseResult）
    const errorText = result !== undefined && typeof result['error'] === 'string' ? result['error'] : undefined;
    const body = value?.['content'] ?? value?.['output'] ?? value?.['text'] ?? errorText ?? value;
    const text = flattenText(body, acc.ignored, 'tool-output');
    const isError = result?.['status'] === 'error'
      || value?.['isError'] === true || value?.['is_error'] === true || item['isError'] === true;
    return [irToolResultBlock(id, text, isError)];
  }
  if (type === 'thinking' || type === 'redactedthinking' || type === 'reasoning') {
    irBump(acc.ignored, 'block:' + type);
    return [];
  }
  if (type === 'image' || type === 'audio') {
    irBump(acc.ignored, 'block:' + type);
    return [];
  }
  if (type === '') return [];
  irBump(acc.ignored, 'block:' + type);
  return [];
}

function gooseBlocks(value: unknown, acc: GooseAcc): IrBlock[] {
  if (typeof value === 'string') return value === '' ? [] : [irTextBlock(value)];
  if (Array.isArray(value)) {
    const out: IrBlock[] = [];
    for (const item of value) out.push(...gooseBlock(item, acc));
    return out;
  }
  if (isRecord(value)) return gooseBlock(value, acc);
  return [];
}

/** `messages.metadata_json.userVisible === false` = agent-only 消息，不进对话（与上游 message_count 口径一致） */
function gooseMessageHidden(row: SqliteRow): boolean {
  const raw = pickString(row, ['metadata_json', 'metadataJson']);
  if (raw === undefined) return false;
  try {
    const meta: unknown = JSON.parse(raw);
    return isRecord(meta) && meta['userVisible'] === false;
  } catch {
    // 畸形 metadata_json 只丢元数据（按 userVisible 默认 true 处理），不影响消息本体
    return false;
  }
}

function gooseRecords(rows: readonly SqliteRow[], acc: GooseAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const row of rows) {
    if (gooseMessageHidden(row)) {
      irBump(acc.ignored, 'message:not-user-visible');
      continue;
    }
    const roleRaw = (pickString(row, GOOSE_MESSAGE_ROLE_KEYS) ?? '').toLowerCase();
    const role = roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : undefined;
    const cell = jsonCell(row, GOOSE_CONTENT_KEYS);
    let blocks: IrBlock[] = [];
    if (cell.ok) blocks = gooseBlocks(cell.value, acc);
    else if (cell.problem === 'unparsable') acc.bad++;
    if (role === undefined) {
      irBump(acc.ignored, roleRaw === '' ? 'message-no-role' : 'role:' + roleRaw);
      continue;
    }
    const id = pickString(row, GOOSE_MESSAGE_ID_KEYS);
    const time = pickTime(row, GOOSE_MESSAGE_TIME_KEYS);
    const pushed = splitToolResults(role, blocks, { id, time });
    // 用户消息同时带正文与 toolResponse 时，splitToolResults 先产出正文记录 → 合成器会把
    // 正文当新一轮开始（关闭当前 step），随后的结果记录就成了无 step 可归的孤儿被丢弃。
    // 结果记录排到正文之前即可挂回上一条 assistant 的 step（参考 convert/goose.mjs：载体正文
    // 不进新轮）。只调换用户侧的两条记录顺序，其它来源的调用不动。
    if (role === 'user' && pushed.length > 1) pushed.reverse();
    for (const rec of pushed) out.push(rec);
    if (pushed.length === 0) irBump(acc.ignored, 'message-empty');
  }
  return out;
}

/** 消息行序：参考按 `(created_timestamp, id)` 升序（库里不保证物理顺序，缺 ORDER BY 会乱序） */
function gooseMessageOrder(rows: readonly SqliteRow[]): SqliteRow[] {
  const idOf = (row: SqliteRow): string | number => {
    const v = row['id'] ?? row['message_id'] ?? row['messageId'];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v;
    return '';
  };
  return [...rows].sort((a, b) => {
    const ta = pickTime(a, GOOSE_MESSAGE_TIME_KEYS);
    const tb = pickTime(b, GOOSE_MESSAGE_TIME_KEYS);
    if (ta !== undefined || tb !== undefined) {
      const d = (ta ?? 0) - (tb ?? 0);
      if (d !== 0) return d;
    }
    const ia = idOf(a);
    const ib = idOf(b);
    if (typeof ia === 'number' && typeof ib === 'number') return ia - ib;
    return String(ia).localeCompare(String(ib));
  });
}

/**
 * 打开着的库 → 每个会话一个归一文件；**返回 null ⇔ 读不到 / 不是 goose 库**。
 *
 * 签名判定：必须有 `sessions` 表、它的 `id` 列与 `working_dir`（或 `working_directory`）。
 * 这条判据正是「`sessions.db` 与 cline 同名」时唯一能自证的东西。
 */
export function readGooseDatabase(db: SqliteHandle): SqliteReadPart | null {
  const tables = db.tables();
  if (tables === null) return null;
  if (!tables.includes('sessions')) return null;
  const sessionCols = db.columns('sessions');
  if (sessionCols === null) return null;
  if (!sessionCols.includes('id')) return null;
  if (!sessionCols.includes('working_dir') && !sessionCols.includes('working_directory')) return null;

  const sessionRows = db.all('SELECT * FROM "sessions"');
  if (sessionRows === null) return null;
  const messageRows = tables.includes('messages') ? db.all('SELECT * FROM "messages"') : [];
  if (messageRows === null) return null;

  const bySession = new Map<string, SqliteRow[]>();
  for (const row of gooseMessageOrder(messageRows)) {
    const key = pickString(row, GOOSE_MESSAGE_SESSION_KEYS);
    if (key === undefined) continue;
    const list = bySession.get(key);
    if (list === undefined) bySession.set(key, [row]);
    else list.push(row);
  }

  const files: SqliteSessionFile[] = [];
  const skipped: ForeignSkip[] = [];
  let noId = 0;
  let noCwd = 0;
  let filteredType = 0;
  let filteredParent = 0;
  for (const row of sessionRows) {
    const id = pickString(row, GOOSE_SESSION_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    // 只取顶层会话：子代理 / 隐藏会话与挂在父会话下的行不单独成会话（参考 gooseRows）
    const sessionType = (pickString(row, GOOSE_SESSION_TYPE_KEYS) ?? '').toLowerCase();
    if (sessionType === 'sub_agent' || sessionType === 'hidden') {
      filteredType++;
      continue;
    }
    if (pickString(row, GOOSE_SESSION_PARENT_KEYS) !== undefined) {
      filteredParent++;
      continue;
    }
    const cwd = pickString(row, GOOSE_SESSION_CWD_KEYS);
    if (cwd === undefined) noCwd++;
    const rows = bySession.get(id) ?? [];
    const acc: GooseAcc = { ignored: {}, bad: 0 };
    const records = gooseRecords(rows, acc);
    const title = pickString(row, GOOSE_SESSION_TITLE_KEYS) ?? '';
    const createdAt: IrTimeMs | undefined = pickTime(row, GOOSE_SESSION_TIME_KEYS);
    files.push({
      id,
      parsed: {
        records,
        cwd,
        createdAt,
        title: title !== '' ? title : firstUserText(records),
        raw: rows.length,
        bad: acc.bad,
        ignored: acc.ignored,
      },
    });
  }
  if (noId > 0) skipped.push({ ...sqliteSkip('sessions', 'row-without-id'), count: noId });
  const counts: Record<string, number> = {
    sessions: files.length,
    messages: messageRows.length,
    'sessions.without-cwd': noCwd,
    'sessions.filtered-type': filteredType,
    'sessions.filtered-parent': filteredParent,
  };
  return { files, skipped, counts };
}

export interface GooseReadOptions extends GoosePathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readGoose(opts: GooseReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const dbFile = gooseDbPath(opts);
  const label = labelForPath(opts.homeDir, dbFile);
  if (!(await isFile(dbFile))) return { files: [], readFindings: [], extraCounts: {} };
  const gate = await sqliteGate(label, opts.sqliteDeps);
  if (gate !== undefined) return { files: [], readFindings: [gate], extraCounts: {} };
  const opened = await sqliteOpen(dbFile, opts.sqliteDeps);
  if (opened.db === null) return { files: [], readFindings: [sqliteSkip(label, openDetail(opened.problem))], extraCounts: {} };
  const db = opened.db;
  try {
    const read = readGooseDatabase(db);
    if (read === null) return { files: [], readFindings: [sqliteSkip(label, 'shape-mismatch')], extraCounts: {} };
    return {
      files: read.files,
      readFindings: read.skipped,
      extraCounts: { 'goose.sessions': read.files.length, ...prefixCounts('goose', read.counts) },
    };
  } finally {
    db.close();
  }
}
