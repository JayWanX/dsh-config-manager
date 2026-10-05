/**
 * Zed 用户数据目录的**读盘层** + 真值表路径。
 *
 * 真值表（read-vault §10.1 zed 行 + chat-import convert/zed.mjs:63-84；read-movein 附录 A、
 * read-sessions-manager ⑧.4 第 24 行交叉核对一致）：
 *  - win32  `%LOCALAPPDATA%/Zed/threads/threads.db`（**目录名大写 Zed**，且用 LOCALAPPDATA）
 *  - darwin `~/Library/Application Support/Zed/threads/threads.db`
 *  - linux  `$XDG_DATA_HOME/zed/threads/threads.db`（缺省 `~/.local/share/zed/threads/threads.db`）
 *  - `--user-data-dir` 会**整体改写 data_dir**，那种安装本层探测不到 → 只能由用户显式给路径
 *    （真值表同款说明；本层不假装能找到它，也不为此报码 —— 那是「不知道」，不是「读不到」）
 *
 * 表面（竞品 sources/zed.mjs:50-58 的签名判定）：**只有一张 `threads` 表**，
 * 含 `{id, summary, updated_at, data_type, data, folder_paths, created_at}`；
 * `data` 是 BLOB，`data_type` 写入端**恒 `zstd`**（标准帧），`json` 只读兼容。
 *
 * zstd 走 `node:zlib` 的 `zstdDecompressSync`（Node ≥22.15 / ≥23.8；本仓库 engines ^22.19）。
 * 该函数在运行时**能力探测**：缺它时该库整体降级为「一条 zstd-unavailable 的 source-unreadable」
 * （逐条计数），绝不因为解不开就把线索引成空会话。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。**真机形态未知的具体一点**：
 * `data` 反序列化后的 JSON 结构只按「顶层 messages 数组 + 每项能给出 role 与 content」两个
 * 最小假设实现，其余走 `genericBlocksOf` 兜底并逐类计数 —— 见 `zedMessagesOf`。
 */
import zlib from 'node:zlib';

import { joinFor, normalizePlatform, xdgDataHome } from './platform-paths.ts';
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
import { irBump } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, genericBlocksOf } from './session-source.ts';
import type { SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export interface ZedPathInput {
  readonly homeDir: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Zed 的 data_dir（`XDG_DATA_HOME` 只对 linux 生效、且仅绝对路径） */
export function zedDataDir(opts: ZedPathInput): string {
  const platform = normalizePlatform(opts.platform);
  const product = platform === 'linux' ? 'zed' : 'Zed';
  return joinFor(platform, xdgDataHome(platform, opts.homeDir, opts.env), product);
}

/** Zed 的库：`<data_dir>/threads/threads.db` */
export function zedThreadsDbPath(opts: ZedPathInput): string {
  return joinFor(normalizePlatform(opts.platform), zedDataDir(opts), 'threads', 'threads.db');
}

/* ---------------- zstd 能力探测（node:zlib 的内建；缺它只降级本库） ---------------- */

type ZstdDecompress = (buffer: Uint8Array) => Uint8Array;

/**
 * `zstdDecompressSync` 走**窄化取值**而不是直接引用属性：`@types/node` 的小版本差异不会
 * 让本文件编译失败，运行期缺它也只是「这一个库降级」。
 */
function zstdDecompressSync(): ZstdDecompress | undefined {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : undefined;
}

/* ---------------- threads 表的解析 ---------------- */

const ZED_ID_KEYS = ['id', 'thread_id', 'threadId'];
const ZED_TITLE_KEYS = ['summary', 'title', 'name'];
const ZED_TIME_KEYS = ['updated_at', 'updatedAt', 'created_at', 'createdAt'];
const ZED_DATA_TYPE_KEYS = ['data_type', 'dataType', 'type'];
const ZED_FOLDER_KEYS = ['folder_paths', 'folderPaths'];
const ZED_THREAD_MESSAGE_KEYS = ['messages', 'conversation', 'events', 'items', 'turns', 'entries'];

interface ZedAcc {
  ignored: Record<string, number>;
  bad: number;
}

type ThreadDecode =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: 'absent' | 'zstd-unavailable' | 'zstd-not-blob' | 'decompress-error' | 'json-error' };

/** `data` BLOB → 线程 JSON（`data_type=json` 时直接解 utf8；其余恒 zstd） */
function decodeThread(row: SqliteRow): ThreadDecode {
  const data = row['data'] ?? row['thread_data'] ?? row['blob'];
  if (data === undefined || data === null) return { ok: false, problem: 'absent' };
  const dataType = (pickString(row, ZED_DATA_TYPE_KEYS) ?? '').toLowerCase();
  let text: string;
  if (typeof data === 'string') {
    if (dataType === 'zstd') return { ok: false, problem: 'zstd-not-blob' };
    text = data;
  } else if (data instanceof Uint8Array) {
    if (dataType === 'json' || dataType === '') {
      text = new TextDecoder().decode(data);
    } else {
      const fn = zstdDecompressSync();
      if (fn === undefined) return { ok: false, problem: 'zstd-unavailable' };
      try {
        text = new TextDecoder().decode(fn(data));
      } catch {
        return { ok: false, problem: 'decompress-error' };
      }
    }
  } else {
    return { ok: false, problem: 'absent' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, problem: 'json-error' };
  }
}

/** serde 枚举形态的两个键（`{User:{...}}` / `{Assistant:{...}}`）也认；认不出来就逐类计数 */
const ZED_ROLE_ALIASES: readonly (readonly [string, 'user' | 'assistant'])[] = [
  ['user', 'user'], ['human', 'user'], ['prompt', 'user'], ['user_message', 'user'],
  ['assistant', 'assistant'], ['ai', 'assistant'], ['model', 'assistant'], ['assistant_message', 'assistant'],
];

function zedRecordOf(item: unknown, acc: ZedAcc): TranscriptRecord[] | null {
  if (!isRecord(item)) {
    acc.bad++;
    return null;
  }
  let payload: Record<string, unknown> = item;
  let role: 'user' | 'assistant' | undefined;
  for (const [alias, mapped] of ZED_ROLE_ALIASES) {
    if (item[alias] !== undefined) {
      role = mapped;
      const inner = item[alias];
      if (isRecord(inner)) payload = inner;
      break;
    }
  }
  if (role === undefined) {
    const raw = (pickString(item, ['role', 'sender', 'kind', 'type']) ?? '').toLowerCase();
    for (const [alias, mapped] of ZED_ROLE_ALIASES) {
      if (raw === alias) {
        role = mapped;
        break;
      }
    }
    if (role === undefined) {
      irBump(acc.ignored, raw === '' ? 'message:unmapped' : 'message:' + raw);
      return null;
    }
  }
  const content = payload['content'] ?? payload['message'] ?? payload['segments'] ?? payload['text'] ?? payload['parts'];
  const blocks: IrBlock[] = content === undefined ? [] : genericBlocksOf(content, acc.ignored, 'zed');
  const id = pickString(payload, ['id', 'message_id', 'messageId']) ?? pickString(item, ['id', 'message_id']);
  const time = pickTime(payload, ['timestamp', 'created_at', 'createdAt', 'time'])
    ?? pickTime(item, ['timestamp', 'created_at', 'createdAt', 'updated_at']);
  const pushed = splitToolResults(role, blocks, { id, time });
  return pushed.length === 0 ? null : pushed;
}

function zedMessagesOf(thread: unknown, acc: ZedAcc): TranscriptRecord[] {
  if (!isRecord(thread)) {
    acc.bad++;
    return [];
  }
  let list: unknown[] | undefined;
  for (const key of ZED_THREAD_MESSAGE_KEYS) {
    const v = thread[key];
    if (Array.isArray(v)) {
      list = v;
      break;
    }
  }
  if (list === undefined) {
    acc.bad++;
    return [];
  }
  const out: TranscriptRecord[] = [];
  for (const item of list) {
    const rec = zedRecordOf(item, acc);
    if (rec !== null) out.push(...rec);
  }
  return out;
}

/** cwd：`folder_paths` 的第一个绝对路径 → 线程 JSON 里的 cwd 字段（缺 → undefined，绝不猜） */
function zedCwdOf(row: SqliteRow, thread: unknown): string | undefined {
  const folders = jsonCell(row, ZED_FOLDER_KEYS);
  if (folders.ok && Array.isArray(folders.value)) {
    for (const p of folders.value) {
      if (typeof p === 'string' && p !== '') return p;
    }
  }
  if (isRecord(thread)) {
    return pickString(thread, ['cwd', 'working_dir', 'working_directory', 'directory', 'root', 'project_path']);
  }
  return undefined;
}

/**
 * 打开着的库 → 每个 thread 一个归一文件；**返回 null ⇔ 读不到 / 不是 zed 库**。
 *
 * 签名判定：必须存在 `threads` 表，且它有 `id` 与 `data` 列（竞品同款「靠结构自证」）。
 */
export function readZedDatabase(db: SqliteHandle, label: string): SqliteReadPart | null {
  const tables = db.tables();
  if (tables === null) return null;
  if (!tables.includes('threads')) return null;
  const cols = db.columns('threads');
  if (cols === null) return null;
  if (!cols.includes('id') || !cols.includes('data')) return null;
  const rows = db.all('SELECT * FROM "threads"');
  if (rows === null) return null;

  const files: SqliteSessionFile[] = [];
  const skipped: ForeignSkip[] = [];
  let noId = 0;
  let unreadable = 0;
  let zstdMissing = 0;
  for (const row of rows) {
    const id = pickString(row, ZED_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    const decoded = decodeThread(row);
    if (!decoded.ok) {
      unreadable++;
      if (decoded.problem === 'zstd-unavailable') zstdMissing++;
      continue;
    }
    const acc: ZedAcc = { ignored: {}, bad: 0 };
    const records = zedMessagesOf(decoded.value, acc);
    const title = pickString(row, ZED_TITLE_KEYS) ?? '';
    const createdAt: IrTimeMs | undefined = pickTime(row, ZED_TIME_KEYS);
    files.push({
      id,
      parsed: {
        records,
        cwd: zedCwdOf(row, decoded.value),
        createdAt,
        title: title !== '' ? title : firstUserText(records),
        raw: records.length,
        bad: acc.bad,
        ignored: acc.ignored,
      },
    });
  }
  if (noId > 0) skipped.push({ ...sqliteSkip(label, 'thread-without-id'), count: noId });
  if (zstdMissing > 0) skipped.push({ ...sqliteSkip(label, 'zstd-unavailable'), count: zstdMissing });
  const other = unreadable - zstdMissing;
  if (other > 0) skipped.push({ ...sqliteSkip(label, 'thread-unreadable'), count: other });
  return {
    files,
    skipped,
    counts: { threads: files.length, 'threads.unreadable': unreadable },
  };
}

export interface ZedReadOptions extends ZedPathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readZed(opts: ZedReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const dbFile = zedThreadsDbPath(opts);
  const label = labelForPath(opts.homeDir, dbFile);
  if (!(await isFile(dbFile))) return { files: [], readFindings: [], extraCounts: {} };
  const gate = await sqliteGate(label, opts.sqliteDeps);
  if (gate !== undefined) return { files: [], readFindings: [gate], extraCounts: {} };
  const opened = await sqliteOpen(dbFile, opts.sqliteDeps);
  if (opened.db === null) return { files: [], readFindings: [sqliteSkip(label, openDetail(opened.problem))], extraCounts: {} };
  const db = opened.db;
  try {
    const read = readZedDatabase(db, label);
    if (read === null) return { files: [], readFindings: [sqliteSkip(label, 'shape-mismatch')], extraCounts: {} };
    return {
      files: read.files,
      readFindings: read.skipped,
      extraCounts: { 'zed.sessions': read.files.length, ...prefixCounts('zed', read.counts) },
    };
  } finally {
    db.close();
  }
}
