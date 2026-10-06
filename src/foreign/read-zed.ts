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
 * 含 `{id, summary, updated_at, data_type, data, parent_id, folder_paths, folder_paths_order, created_at}`；
 * `data` 是 BLOB，`data_type` 写入端**恒 zstd**（标准帧），`json` 只读兼容。
 *
 * 三种方言都要认（参考 lib/convert/zed.mjs）：
 *  - **v0.3.0（当前）**：消息是 serde 外部标签 `{User:{content:[{Text}|{Mention}|{Image}]}}` /
 *    `{Agent:{content:[{Text}|{Thinking}|{ToolUse}], tool_results:{<tool_use_id>:…}}}` /
 *    `{Compaction:{Summary}}`（裸字符串 "Resume" 是 UI 续聊标记）—— 旧代码只匹配小写别名、
 *    只取 content/message/segments/text/parts，整个线程都记 `message:unmapped`；
 *  - **legacy**：`{role, segments, tool_uses, tool_results, is_visible}`；
 *  - 工具结果按 `tool_use_id` 配对，v0.3.0 挂同一条 Agent 消息的对象里、legacy 是消息上的数组。
 *
 * zstd 走 `node:zlib` 的 `zstdDecompressSync`（Node ≥22.15 / ≥23.8；本仓库 engines ^22.19）。
 * 该函数在运行时**能力探测**：缺它时该库整体降级为「一条 zstd-unavailable 的 source-unreadable」
 * （逐条计数），绝不因为解不开就把线索引成空会话。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。`parent_id` 非空 = 子代理线程
 * （上游 UI/ThreadStore 都过滤）→ 本层同样跳过。
 */
import zlib from 'node:zlib';

import { joinFor, normalizePlatform, xdgDataHome } from './platform-paths.ts';
import { isFile, labelForPath } from './session-read.ts';
import {
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
import { firstUserText } from './session-source.ts';
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
const ZED_FOLDER_ORDER_KEYS = ['folder_paths_order', 'folderPathsOrder'];
const ZED_PARENT_KEYS = ['parent_id', 'parentId'];

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

/* ---------------- folder_paths 编码（`\n` 连接 + `,` 连接的 order 索引） ---------------- */

/**
 * `folder_paths` 用 `\n` 连接路径、`folder_paths_order` 用 `,` 连接索引 —— 旧代码把它当
 * JSON 数组解析（jsonCell），真实库上 cwd 永远拿不到。索引缺失/长度不符时退化为字典序。
 */
export function zedFolderPaths(folderPaths: unknown, order: unknown): string[] {
  const paths = typeof folderPaths === 'string' && folderPaths !== ''
    ? folderPaths.split(String.fromCharCode(10)).filter((p) => p !== '')
    : [];
  if (paths.length <= 1) return paths;
  const orderText = typeof order === 'string' && order !== '' ? order : '';
  if (orderText === '') return paths;
  const indexes = orderText.split(',').map((n) => Number.parseInt(n, 10));
  if (indexes.length !== paths.length || indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= paths.length)) {
    return paths;
  }
  return indexes.map((i) => paths[i] as string);
}

/* ---------------- 内容块方言映射 ---------------- */

/** `raw_input` / `input.value` 是原始 JSON 文本：能解析就解析，不能就原样 */
function toolInputOfText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

/** v0.3.0 工具结果 content（`[{"Text":…}|{"Image":…}]`）→ 文本；图片只计数 */
function v3ResultText(result: Record<string, unknown>, acc: ZedAcc): string {
  const parts: string[] = [];
  const nodes = Array.isArray(result['content']) ? result['content'] : [];
  for (const item of nodes) {
    if (isRecord(item) && typeof item['Text'] === 'string' && item['Text'] !== '') parts.push(item['Text']);
    else if (isRecord(item) && item['Image'] !== undefined) irBump(acc.ignored, 'block:image');
  }
  if (parts.length === 0 && typeof result['output'] === 'string' && result['output'] !== '') {
    parts.push(result['output']);
  }
  return parts.join(String.fromCharCode(10));
}

/** legacy 工具结果 content（形状不固定，容错取 text）→ 文本 */
function legacyResultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result['content'])) {
    for (const item of result['content']) {
      if (typeof item === 'string' && item !== '') parts.push(item);
      else if (isRecord(item) && typeof item['text'] === 'string' && item['text'] !== '') parts.push(item['text']);
    }
  }
  const output = result['output'];
  if (typeof output === 'string' && output !== '') parts.push(output);
  else if (isRecord(output) && typeof output['text'] === 'string' && output['text'] !== '') parts.push(output['text']);
  return parts.join(String.fromCharCode(10));
}

/** v0.3.0 的 ToolUse → tool_call 块（input 是 `{type,value}`，raw_input 是原始 JSON 文本） */
function v3ToolCall(toolUse: unknown): IrBlock | null {
  if (!isRecord(toolUse)) return null;
  const id = pickString(toolUse, ['id']) ?? '';
  const name = pickString(toolUse, ['name']) ?? '';
  if (id === '' || name === '') return null;
  const rawInput = toolUse['raw_input'];
  if (typeof rawInput === 'string' && rawInput !== '') return irToolCallBlock(id, name, toolInputOfText(rawInput));
  const wrapped = toolUse['input'];
  if (isRecord(wrapped)) {
    const value = wrapped['type'] === 'text' && typeof wrapped['value'] === 'string'
      ? toolInputOfText(wrapped['value'])
      : (wrapped['value'] ?? {});
    return irToolCallBlock(id, name, value);
  }
  return irToolCallBlock(id, name, {});
}

/** legacy 的 ToolUse.input 是对象或字符串 */
function legacyToolCall(toolUse: unknown): IrBlock | null {
  if (!isRecord(toolUse)) return null;
  const id = pickString(toolUse, ['id']) ?? '';
  const name = pickString(toolUse, ['name']) ?? '';
  if (id === '' || name === '') return null;
  const input = toolUse['input'];
  return irToolCallBlock(id, name, typeof input === 'string' ? toolInputOfText(input) : (input ?? {}));
}

/** v0.3.0 消息单元（serde 外部标签：{User:…} / {Agent:…} / {Compaction:…} / 裸字符串 "Resume"） */
function zedV3Records(messages: readonly unknown[], acc: ZedAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const msg of messages) {
    if (typeof msg === 'string') continue; // unit 变体 "Resume"：UI 续聊标记
    if (!isRecord(msg)) {
      acc.bad++;
      continue;
    }
    if (isRecord(msg['User'])) {
      const blocks: IrBlock[] = [];
      const content = msg['User']['content'];
      for (const block of Array.isArray(content) ? content : []) {
        if (isRecord(block) && typeof block['Text'] === 'string' && block['Text'] !== '') {
          blocks.push(irTextBlock(block['Text']));
        } else if (isRecord(block) && block['Image'] !== undefined) {
          irBump(acc.ignored, 'block:image');
        } else if (isRecord(block) && block['Mention'] !== undefined) {
          irBump(acc.ignored, 'block:mention');
        } else {
          irBump(acc.ignored, 'block:unmapped');
        }
      }
      if (blocks.length > 0) out.push({ role: 'user', blocks });
      continue;
    }
    if (isRecord(msg['Agent'])) {
      const agent = msg['Agent'];
      const blocks: IrBlock[] = [];
      const content = agent['content'];
      for (const block of Array.isArray(content) ? content : []) {
        if (isRecord(block) && typeof block['Text'] === 'string' && block['Text'] !== '') {
          blocks.push(irTextBlock(block['Text']));
        } else if (isRecord(block) && isRecord(block['Thinking'])
          && typeof block['Thinking']['text'] === 'string' && block['Thinking']['text'] !== '') {
          // IR 只有 text/tool_call/tool_result（reasoning 需共享层改动才能保留）→ 逐类计数
          irBump(acc.ignored, 'block:thinking');
        } else if (isRecord(block) && block['ToolUse'] !== undefined) {
          const call = v3ToolCall(block['ToolUse']);
          if (call === null) irBump(acc.ignored, 'block:tool-use-invalid');
          else blocks.push(call);
        } else {
          irBump(acc.ignored, 'block:unmapped');
        }
      }
      // 同一 Agent 消息上的 tool_results 对象（键 = tool_use_id）；合成器只把 tool_result 归入
      // **已打开的 step** → 拆到用户侧记录后再挂回（splitToolResults）
      const results = agent['tool_results'];
      if (isRecord(results)) {
        for (const [toolUseId, result] of Object.entries(results)) {
          if (!isRecord(result)) {
            irBump(acc.ignored, 'block:unmapped');
            continue;
          }
          blocks.push(irToolResultBlock(toolUseId, v3ResultText(result, acc), result['is_error'] === true));
        }
      }
      if (blocks.length > 0) out.push(...splitToolResults('assistant', blocks, {}));
      continue;
    }
    if (isRecord(msg['Compaction'])) {
      // 压缩落点：本地合成器没有原生压缩检查点（需共享层改动）→ 显式计数
      irBump(acc.ignored, 'message:compaction');
      continue;
    }
    irBump(acc.ignored, 'message:unmapped');
  }
  return out;
}

/** legacy 方言（role + segments/tool_uses/tool_results/is_visible） */
function zedLegacyRecords(messages: readonly unknown[], acc: ZedAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const msg of messages) {
    if (!isRecord(msg)) {
      acc.bad++;
      continue;
    }
    if (msg['is_visible'] === false) {
      irBump(acc.ignored, 'message:invisible');
      continue;
    }
    const role = (pickString(msg, ['role']) ?? '').toLowerCase();
    if (role === 'system') {
      irBump(acc.ignored, 'role:system');
      continue;
    }
    const blocks: IrBlock[] = [];
    const segments = msg['segments'];
    for (const seg of Array.isArray(segments) ? segments : []) {
      if (isRecord(seg) && seg['type'] === 'text' && typeof seg['text'] === 'string' && seg['text'] !== '') {
        blocks.push(irTextBlock(seg['text']));
      } else if (isRecord(seg) && (seg['type'] === 'thinking' || seg['type'] === 'RedactedThinking')) {
        irBump(acc.ignored, 'block:' + String(seg['type']));
      } else if (isRecord(seg)) {
        irBump(acc.ignored, 'block:unmapped');
      }
    }
    if (role === 'assistant') {
      for (const toolUse of Array.isArray(msg['tool_uses']) ? msg['tool_uses'] : []) {
        const call = legacyToolCall(toolUse);
        if (call === null) irBump(acc.ignored, 'block:tool-use-invalid');
        else blocks.push(call);
      }
    }
    if (Array.isArray(msg['tool_results'])) {
      for (const result of msg['tool_results']) {
        if (!isRecord(result)) continue;
        const id = pickString(result, ['tool_use_id', 'toolUseId']) ?? '';
        if (id === '') {
          irBump(acc.ignored, 'block:tool-result-invalid');
          continue;
        }
        blocks.push(irToolResultBlock(id, legacyResultText(result), result['is_error'] === true));
      }
    }
    if (role === 'user' || role === 'assistant') {
      if (blocks.length === 0) continue;
      const pushed = splitToolResults(role, blocks, {});
      // 用户消息同时带正文与结果：结果记录排在正文之前（同 read-goose.ts 的理由）
      if (role === 'user' && pushed.length > 1) pushed.reverse();
      out.push(...pushed);
    } else if (role !== '') {
      irBump(acc.ignored, 'role:' + role);
    }
  }
  return out;
}

/** 线程 JSON → 归一记录（v0.3.0 外部标签方言优先；其余走 legacy） */
function zedMessagesOf(thread: unknown, acc: ZedAcc): TranscriptRecord[] {
  if (!isRecord(thread)) {
    acc.bad++;
    return [];
  }
  const raw = thread['messages'];
  if (!Array.isArray(raw)) {
    acc.bad++;
    return [];
  }
  const version = typeof thread['version'] === 'string' ? thread['version'] : '';
  return version === '0.3.0' ? zedV3Records(raw, acc) : zedLegacyRecords(raw, acc);
}

/** cwd：行级 folder_paths（`\n` 分隔 + order 索引）的首项 → 线程 JSON 里的 cwd 字段（缺 → undefined） */
function zedCwdOf(row: SqliteRow, thread: unknown): string | undefined {
  const paths = zedFolderPaths(
    pickString(row, ZED_FOLDER_KEYS),
    pickString(row, ZED_FOLDER_ORDER_KEYS),
  );
  if (paths.length > 0) return paths[0];
  if (isRecord(thread)) {
    return pickString(thread, ['cwd', 'working_dir', 'working_directory', 'directory', 'root', 'project_path']);
  }
  return undefined;
}

/**
 * 打开着的库 → 每个 thread 一个归一文件；**返回 null ⇔ 读不到 / 不是 zed 库**。
 *
 * 签名判定：必须存在 `threads` 表，且它有 `id` 与 `data` 列（竞品同款「靠结构自证」）。
 * `parent_id` 非空的行是子代理线程（上游 UI/ThreadStore 都过滤）→ 跳过并计数。
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
  let subagent = 0;
  const hasParent = ZED_PARENT_KEYS.some((key) => cols.includes(key));
  for (const row of rows) {
    const id = pickString(row, ZED_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    if (hasParent && pickString(row, ZED_PARENT_KEYS) !== undefined) {
      subagent++;
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
    const rowTitle = pickString(row, ZED_TITLE_KEYS) ?? '';
    const blobTitle = isRecord(decoded.value) ? (pickString(decoded.value, ZED_TITLE_KEYS) ?? '') : '';
    const title = rowTitle !== '' ? rowTitle : blobTitle;
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
    counts: { threads: files.length, 'threads.unreadable': unreadable, 'threads.subagent': subagent },
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
