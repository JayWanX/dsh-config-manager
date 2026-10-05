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
 */
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
    const call = isRecord(item['toolCall']) ? item['toolCall'] : undefined;
    const value = call !== undefined && isRecord(call['value']) ? call['value'] : undefined;
    const id = pickString(item, ['id']) ?? '';
    const name = value === undefined ? '' : (pickString(value, ['name']) ?? '');
    const input = value?.['arguments'] ?? value?.['input'];
    return [irToolCallBlock(id, name, input)];
  }
  if (type === 'toolresponse' || type === 'tool_response') {
    const result = isRecord(item['toolResult']) ? item['toolResult'] : undefined;
    const value = result !== undefined && isRecord(result['value']) ? result['value'] : undefined;
    const id = pickString(item, ['id']) ?? '';
    const body = value?.['content'] ?? value?.['output'] ?? value?.['text'] ?? value;
    const text = flattenText(body, acc.ignored, 'tool-output');
    const isError = value?.['isError'] === true || value?.['is_error'] === true || item['isError'] === true;
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

function gooseRecords(rows: readonly SqliteRow[], acc: GooseAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const row of rows) {
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
    for (const rec of pushed) out.push(rec);
    if (pushed.length === 0) irBump(acc.ignored, 'message-empty');
  }
  return out;
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
  for (const row of messageRows) {
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
  for (const row of sessionRows) {
    const id = pickString(row, GOOSE_SESSION_ID_KEYS);
    if (id === undefined) {
      noId++;
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
