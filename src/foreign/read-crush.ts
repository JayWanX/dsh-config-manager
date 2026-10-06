/**
 * Crush 的**读盘层** + 真值表路径（**每项目一个库**，SQLite 批里最重的一个）。
 *
 * 真值表（read-vault §10.1 crush 行 + chat-import convert/crush.mjs:54-76/sources/crush.mjs:43-76；
 * read-movein 附录 A、read-sessions-manager ⑧.4 第 25 行交叉核对一致）：
 *  - 用户级目录`crushUserDataDir`里**只放 `projects.json` 注册表**，不是库：
 *      win32 = `%LOCALAPPDATA%/crush`（=`<xdgdata>`）；其余平台 = `$XDG_DATA_HOME/crush`
 *      → `~/.local/share/crush`；`$CRUSH_GLOBAL_DATA`（**仅绝对路径生效**）= 替换用户级目录。
 *  - **真正的库在项目里**：`<项目>/.crush/crush.db`，每项目一个。
 *  - 库位置另受 `crush.json` 的 `options.data_directory` 与 `--data-dir/-D` 影响 —— 这两条
 *    **本层探测不到**（真值表同款说明），只能靠显式 `projectDir`；不做任何猜测。
 *
 * **响亮报码（任务硬要求）**：注册表里（或用户显式指定）的项目在 `<项目>/.crush/crush.db`
 * 上没有可读的库时，必须留下一条 `source-unreadable`：
 *  `crush-db-missing`（文件不存在）/ `open-failed` / `shape-mismatch`，
 *  **绝不静默跳过**（静默跳过会让用户看到「一条会话都没有」而不知道是哪几个项目没读到）。
 *  只有「注册表本身不存在」= 未安装，才不报码。
 *
 * 表形态（竞品 sources/crush.mjs:54-66 的签名）：`sessions` + `messages`（`parts` TEXT JSON）；
 * `files`/`read_files`（不读）。签名判定 = 这两张表 + `sessions` 有 id 列 + `messages` 有 parts 列。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 */
import { absoluteEnvPath, isAbsoluteFor, joinFor, normalizePlatform, xdgDataHome } from './platform-paths.ts';
import { isFile, labelForPath, readJsonSafe } from './session-read.ts';
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
import { irBump, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, flattenText, genericBlocksOf } from './session-source.ts';
import type { SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export interface CrushPathInput {
  readonly homeDir: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** 反斜杠字符（本模块刻意不写转义字面量，跨层写入时不易被解释掉） */
const BS = String.fromCharCode(92);

/** 用户级目录（**只放注册表**）：`$CRUSH_GLOBAL_DATA`（绝对）> `<xdgdata>/crush` */
export function crushUserDataDir(opts: CrushPathInput): string {
  const platform = normalizePlatform(opts.platform);
  const explicit = absoluteEnvPath(opts.env, 'CRUSH_GLOBAL_DATA', platform);
  if (explicit !== undefined) return explicit;
  return joinFor(platform, xdgDataHome(platform, opts.homeDir, opts.env), 'crush');
}

/** 用户级注册表：`<crushUserDataDir>/projects.json` */
export function crushRegistryPath(opts: CrushPathInput): string {
  return joinFor(normalizePlatform(opts.platform), crushUserDataDir(opts), 'projects.json');
}

/** 项目库：`<项目>/.crush/crush.db`（去掉项目路径尾部的分隔符，避免出现 `//` 段） */
export function crushProjectDbPath(platform: string, projectDir: string): string {
  const p = normalizePlatform(platform);
  let dir = projectDir;
  while (dir.length > 1 && (dir.endsWith('/') || dir.endsWith(BS))) dir = dir.slice(0, -1);
  return joinFor(p, dir, '.crush', 'crush.db');
}

/** 一个字符串看起来像路径（用于「键 = 项目路径」的注册表形态，避免把 version 之类的键当路径） */
function looksLikePath(v: string): boolean {
  if (v === '') return false;
  if (v.indexOf('/') >= 0 || v.indexOf(BS) >= 0) return true;
  return v.length > 2 && v.charAt(1) === ':';
}

/**
 * 注册表 → 项目路径清单（容错四种形态，去重）：
 *  ① `["/p/a", "/p/b"]`（字符串数组）
 *  ② `[{path|project_path|directory|dir|root: "/p/a"}, ...]`（对象数组）
 *  ③ `{projects: [...]}` / `{projects: {"<路径>": {...}}}`
 *  ④ 顶层就是「路径 → 元数据」的映射
 * 认不出来的形态返回空数组（**不猜**；上层只会在「0 个项目」上如实计数）。
 */
/** 一条注册表项目：路径 + 可选 data_dir（**自定义数据目录**，库在 <data_dir>/crush.db） */
export interface CrushProjectEntry {
  readonly path: string;
  readonly dataDir?: string | undefined;
}

/** 同 crushProjectPathsOf 的四种容错形态，但额外带回 data_dir（缺省 = 库在 <项目>/.crush/crush.db） */
export function crushProjectEntriesOf(value: unknown): CrushProjectEntry[] {
  const out = new Map<string, CrushProjectEntry>();
  const add = (path: unknown, dataDir: unknown): void => {
    if (typeof path !== 'string' || path === '') return;
    const dir = typeof dataDir === 'string' && dataDir !== '' ? dataDir : undefined;
    const existing = out.get(path);
    // data_dir 比「没有」更具体：有值条目覆盖无值条目
    if (existing === undefined || (existing.dataDir === undefined && dir !== undefined)) {
      out.set(path, dir === undefined ? { path } : { path, dataDir: dir });
    }
  };
  const addString = (v: unknown): void => add(v, undefined);
  const addRecord = (v: unknown): void => {
    if (!isRecord(v)) return;
    add(v['path'] ?? v['project_path'] ?? v['directory'] ?? v['dir'] ?? v['root'], v['data_dir'] ?? v['dataDir']);
  };
  const addList = (list: readonly unknown[]): void => {
    for (const item of list) {
      if (typeof item === 'string') addString(item);
      else addRecord(item);
    }
  };
  if (Array.isArray(value)) {
    addList(value);
    return [...out.values()];
  }
  if (!isRecord(value)) return [];
  const projects = value['projects'];
  if (Array.isArray(projects)) {
    addList(projects);
  } else if (isRecord(projects)) {
    for (const [key, item] of Object.entries(projects)) {
      addRecord(item);
      if (looksLikePath(key)) addString(key);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      addRecord(item);
      if (looksLikePath(key)) addString(key);
    }
  }
  return [...out.values()];
}

/** 项目路径清单（`crushProjectEntriesOf` 的兼容投影；公开签名保持不变） */
export function crushProjectPathsOf(value: unknown): string[] {
  return crushProjectEntriesOf(value).map((entry) => entry.path);
}

/* ---------------- sessions / messages 的自适应列 ---------------- */

const CRUSH_SESSION_ID_KEYS = ['id', 'session_id', 'sessionId'];
const CRUSH_SESSION_CWD_KEYS = ['cwd', 'working_dir', 'working_directory', 'directory', 'project_path', 'path'];
const CRUSH_SESSION_TITLE_KEYS = ['title', 'name', 'summary'];
/** 会话 createdAt：参考取 created_at（旧代码 updated_at 在前，会把「最近活动」当创建时间） */
const CRUSH_SESSION_TIME_KEYS = ['created_at', 'createdAt', 'time_created', 'updated_at', 'updatedAt'];
const CRUSH_SESSION_PARENT_KEYS = ['parent_session_id', 'parentSessionId'];
const CRUSH_SESSION_UPDATED_KEYS = ['updated_at', 'updatedAt', 'time_updated', 'created_at', 'createdAt'];

const CRUSH_MESSAGE_SESSION_KEYS = ['session_id', 'sessionId', 'session'];
const CRUSH_MESSAGE_ID_KEYS = ['id', 'message_id', 'messageId'];
const CRUSH_MESSAGE_ROLE_KEYS = ['role', 'sender'];
const CRUSH_MESSAGE_TIME_KEYS = ['created_at', 'createdAt', 'time_created', 'updated_at', 'updatedAt'];
/** assistant 的 step 时间取 finished_at（回复完成时刻），缺省回退 created_at */
const CRUSH_MESSAGE_FINISHED_KEYS = ['finished_at', 'finishedAt'];
const CRUSH_MESSAGE_MODEL_KEYS = ['model', 'model_id', 'modelId'];
const CRUSH_MESSAGE_PART_KEYS = ['parts', 'content', 'data', 'json'];

interface CrushAcc {
  ignored: Record<string, number>;
  bad: number;
}

function crushTextBlock(text: string): IrBlock {
  return { type: 'text', text };
}

/** tool_call.data.input 是**原始 JSON 字符串**（不是对象）→ 解析成对象，否则合成期会被再包一层引号 */
function crushToolInput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

/** tool_result.data.content → 纯文本（字符串 / 块数组 / output；取不到返回空串，不虚构） */
function crushResultText(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return '';
  const content = data['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return flattenText(content, undefined, 'crush-result');
  if (typeof data['output'] === 'string') return data['output'];
  return '';
}

/**
 * 一个 part（`{type, data}` 判别式包装）→ IR 块。
 *
 * 真实库的 parts 是 `[{"type":…,"data":{…}}]`（判别式见 convert/crush.mjs）：旧代码把
 * 整个 JSON 串当纯文本 → 正文变成原始 JSON、工具轨迹全丢。这里按判别式映射；
 * 没有 `data` 包装的通用块仍走共享 `genericBlocksOf` 兜底，认不出的类型逐类计数。
 */
function crushPart(value: unknown, acc: CrushAcc): IrBlock[] {
  if (!isRecord(value)) return [];
  const type = typeof value['type'] === 'string' ? value['type'] : '';
  const data = isRecord(value['data']) ? value['data'] : undefined;
  if (data === undefined) {
    // 无包装：通用词汇（text / tool_use / tool_call / tool_result / …）兜底
    return genericBlocksOf(value, acc.ignored, 'crush');
  }
  if (type === 'text') {
    const text = typeof data['text'] === 'string' ? data['text'] : '';
    return text === '' ? [] : [crushTextBlock(text)];
  }
  if (type === 'reasoning') {
    // IR 只有 text/tool_call/tool_result（reasoning 需共享层改动才能保留）→ 逐类计数
    irBump(acc.ignored, 'block:reasoning');
    return [];
  }
  if (type === 'tool_call') {
    const id = pickString(data, ['id']) ?? '';
    const name = pickString(data, ['name']) ?? '';
    return [irToolCallBlock(id, name, crushToolInput(data['input']))];
  }
  if (type === 'tool_result') {
    const id = pickString(data, ['tool_call_id', 'toolCallId', 'id']) ?? '';
    const isError = data['is_error'] === true || data['isError'] === true;
    return [irToolResultBlock(id, crushResultText(data), isError)];
  }
  if (type === 'finish') return []; // 结构块（非 assistant 消息自动补），不进对话也不计数
  if (type === 'image_url' || type === 'shell_command' || type === 'binary') {
    irBump(acc.ignored, 'block:' + type);
    return [];
  }
  irBump(acc.ignored, 'block:' + (type === '' ? 'unmapped' : type));
  return [];
}

/** parts 单元格（TEXT JSON）→ IR 块；字符串里是 JSON 数组就解析，纯文本仍当文本 */
function crushPartsOf(row: SqliteRow, acc: CrushAcc): IrBlock[] {
  const raw = row['parts'] ?? row['content'] ?? row['data'] ?? row['json'];
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        acc.bad++;
        return [];
      }
      return crushPartList(parsed, acc);
    }
    return [crushTextBlock(raw)];
  }
  return crushPartList(raw, acc);
}

function crushPartList(value: unknown, acc: CrushAcc): IrBlock[] {
  if (typeof value === 'string') return value === '' ? [] : [crushTextBlock(value)];
  if (Array.isArray(value)) {
    const out: IrBlock[] = [];
    for (const item of value) out.push(...crushPart(item, acc));
    return out;
  }
  if (isRecord(value)) return crushPart(value, acc);
  return [];
}

/** 消息行序：参考按 (created_at, rowid)；这里用 (时间, id) 还原（库里不保证物理顺序） */
function crushMessageOrder(rows: readonly SqliteRow[]): SqliteRow[] {
  const idOf = (row: SqliteRow): string => pickString(row, CRUSH_MESSAGE_ID_KEYS) ?? '';
  return [...rows].sort((a, b) => {
    const d = (pickTime(a, CRUSH_MESSAGE_TIME_KEYS) ?? 0) - (pickTime(b, CRUSH_MESSAGE_TIME_KEYS) ?? 0);
    return d !== 0 ? d : idOf(a).localeCompare(idOf(b));
  });
}

function crushRecords(rows: readonly SqliteRow[], acc: CrushAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const row of rows) {
    // 自动摘要消息（is_summary_message=1）是压缩产物：本地合成器没有原生压缩检查点
    // （需共享层改动）→ 先显式计数并跳过，绝不把它当普通 assistant 正文塞进对话
    const summaryFlag = row['is_summary_message'] ?? row['isSummaryMessage'];
    if (summaryFlag === 1 || summaryFlag === true) {
      irBump(acc.ignored, 'message:summary');
      continue;
    }
    const roleRaw = (pickString(row, CRUSH_MESSAGE_ROLE_KEYS) ?? '').toLowerCase();
    const isTool = roleRaw === 'tool';
    const role = roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : isTool ? 'user' : undefined;
    const blocks = crushPartsOf(row, acc);
    if (role === undefined) {
      irBump(acc.ignored, roleRaw === '' ? 'message-no-role' : 'role:' + roleRaw);
      continue;
    }
    const id = pickString(row, CRUSH_MESSAGE_ID_KEYS);
    const model = pickString(row, CRUSH_MESSAGE_MODEL_KEYS);
    const time = roleRaw === 'assistant'
      ? (pickTime(row, CRUSH_MESSAGE_FINISHED_KEYS) ?? pickTime(row, CRUSH_MESSAGE_TIME_KEYS))
      : pickTime(row, CRUSH_MESSAGE_TIME_KEYS);
    if (isTool) {
      // role='tool' 正是工具结果的载体（结果通常单独一条消息）→ 只取 tool_result 块
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length !== blocks.length) irBump(acc.ignored, 'tool-message:non-result', blocks.length - results.length);
      const pushed = splitToolResults('user', results, { id, time, model });
      for (const rec of pushed) out.push(rec);
      if (pushed.length === 0) irBump(acc.ignored, 'message-empty');
      continue;
    }
    const pushed = splitToolResults(role, blocks, { id, time, model });
    // 用户消息同时带正文与结果时，结果记录必须排在正文之前（同 read-goose.ts 的理由）
    if (role === 'user' && pushed.length > 1) pushed.reverse();
    for (const rec of pushed) out.push(rec);
    if (pushed.length === 0) {
      // parts 是畸形 JSON 时上面已计入 bad；这里只补「空消息」这一类
      irBump(acc.ignored, 'message-empty');
    }
  }
  return out;
}

/**
 * 打开着的项目库 → 该项目下每个会话一个归一文件；**返回 null ⇔ 读不到 / 不是 crush 库**。
 *
 * cwd 取会话行（若该版本有 cwd 列）→ 否则**取项目目录本身**（库就在 `<项目>/.crush/` 下，
 * 这是有证据的归属，不是猜）。
 */
export function readCrushDatabase(db: SqliteHandle, projectDir: string, label: string): SqliteReadPart | null {
  const tables = db.tables();
  if (tables === null) return null;
  if (!tables.includes('sessions') || !tables.includes('messages')) return null;
  const sessionCols = db.columns('sessions');
  const messageCols = db.columns('messages');
  if (sessionCols === null || messageCols === null) return null;
  if (!CRUSH_SESSION_ID_KEYS.some((key) => sessionCols.includes(key))) return null;
  if (!CRUSH_MESSAGE_PART_KEYS.some((key) => messageCols.includes(key))) return null;

  const sessionRows = db.all('SELECT * FROM "sessions"');
  if (sessionRows === null) return null;
  const messageRows = db.all('SELECT * FROM "messages"');
  if (messageRows === null) return null;

  const bySession = new Map<string, SqliteRow[]>();
  for (const row of crushMessageOrder(messageRows)) {
    const key = pickString(row, CRUSH_MESSAGE_SESSION_KEYS);
    if (key === undefined) continue;
    const list = bySession.get(key);
    if (list === undefined) bySession.set(key, [row]);
    else list.push(row);
  }

  const files: SqliteSessionFile[] = [];
  const skipped: ForeignSkip[] = [];
  let noId = 0;
  let filteredParent = 0;
  let filteredSynthetic = 0;
  // 会话行序：参考按 updated_at DESC
  const sessionOrder = [...sessionRows].sort((a, b) =>
    (pickTime(b, CRUSH_SESSION_UPDATED_KEYS) ?? 0) - (pickTime(a, CRUSH_SESSION_UPDATED_KEYS) ?? 0));
  for (const row of sessionOrder) {
    const id = pickString(row, CRUSH_SESSION_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    // 子会话（parent_session_id 非空）与标题生成会话（id 前缀 title- / 标题 "Generate a title"）
    // 不是真实对话，不单独成会话（参考 crushRows / isSyntheticSession）
    if (pickString(row, CRUSH_SESSION_PARENT_KEYS) !== undefined) {
      filteredParent++;
      continue;
    }
    const title = pickString(row, CRUSH_SESSION_TITLE_KEYS) ?? '';
    if (id.startsWith('title-') || title.trim().toLowerCase() === 'generate a title') {
      filteredSynthetic++;
      continue;
    }
    const rows = bySession.get(id) ?? [];
    const acc: CrushAcc = { ignored: {}, bad: 0 };
    const records = crushRecords(rows, acc);
    const createdAt: IrTimeMs | undefined = pickTime(row, CRUSH_SESSION_TIME_KEYS);
    const cwd = pickString(row, CRUSH_SESSION_CWD_KEYS) ?? projectDir;
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
  if (noId > 0) skipped.push({ ...sqliteSkip(label, 'session-without-id'), count: noId });
  return {
    files,
    skipped,
    counts: {
      sessions: files.length,
      messages: messageRows.length,
      'sessions.filtered-parent': filteredParent,
      'sessions.filtered-synthetic': filteredSynthetic,
    },
  };
}

/** 注册表本身的上限（正常只有几 KB；超限如实报码，绝不截断） */
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;

export interface CrushReadOptions extends CrushPathInput {
  /** 显式项目目录（真值表：库在项目里，注册表查不到的项目只能由用户点名） */
  readonly projectDir?: string | undefined;
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/**
 * 读盘入口（wiring 的 `read`）：注册表 → 逐项目探测 `<项目>/.crush/crush.db` → 合并。
 *
 * 三条语义：
 *  ① 注册表不存在且没有显式 projectDir = 未安装 → 0 文件、不报码；
 *  ② 注册表存在但读不出来（0 字节/超限/畸形）→ 一条 `source-unreadable`（否则用户无法区分
 *     「Crush 没装」与「注册表坏了」）；
 *  ③ **每个项目独立报码**：一个项目的库缺失/读不到不影响其它项目（单点失败不牵连）。
 */
export async function readCrush(opts: CrushReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const skipped: ForeignSkip[] = [];
  const registryPath = crushRegistryPath(opts);
  const projects: CrushProjectEntry[] = [];
  const registry = await readJsonSafe(registryPath, REGISTRY_MAX_BYTES);
  if (registry.ok) {
    projects.push(...crushProjectEntriesOf(registry.value));
  } else if (registry.problem !== 'missing') {
    skipped.push(sqliteSkip(labelForPath(opts.homeDir, registryPath), 'projects-json:' + registry.problem));
  }
  if (opts.projectDir !== undefined && opts.projectDir !== '') projects.push({ path: opts.projectDir });

  const files: SqliteSessionFile[] = [];
  const seen = new Set<string>();
  const dbCounts: Record<string, number> = {};
  let probed = 0;
  for (const project of projects) {
    // 注册表条目的 data_dir（**绝对路径才生效**）覆盖默认的 <项目>/.crush/crush.db
    const dataDir = project.dataDir !== undefined && isAbsoluteFor(platform, project.dataDir)
      ? project.dataDir
      : undefined;
    const dbFile = dataDir !== undefined
      ? joinFor(platform, dataDir, 'crush.db')
      : crushProjectDbPath(platform, project.path);
    if (seen.has(dbFile)) continue;
    seen.add(dbFile);
    const label = labelForPath(opts.homeDir, dbFile);
    if (!(await isFile(dbFile))) {
      // **响亮报码**：点名了的项目没有库，绝不静默
      skipped.push(sqliteSkip(label, 'crush-db-missing'));
      continue;
    }
    probed++;
    const gate = await sqliteGate(label, opts.sqliteDeps);
    if (gate !== undefined) {
      skipped.push(gate);
      continue;
    }
    const opened = await sqliteOpen(dbFile, opts.sqliteDeps);
    if (opened.db === null) {
      skipped.push(sqliteSkip(label, openDetail(opened.problem)));
      continue;
    }
    const db = opened.db;
    try {
      const read = readCrushDatabase(db, project.path, label);
      if (read === null) {
        skipped.push(sqliteSkip(label, 'shape-mismatch'));
        continue;
      }
      files.push(...read.files);
      skipped.push(...read.skipped);
      for (const [key, count] of Object.entries(read.counts)) {
        dbCounts[key] = (dbCounts[key] ?? 0) + count;
      }
    } finally {
      db.close();
    }
  }
  return {
    files,
    readFindings: skipped,
    extraCounts: {
      'crush.projects': seen.size,
      'crush.databases': probed,
      'crush.sessions': files.length,
      ...prefixCounts('crush', { ...dbCounts, sessions: files.length }),
    },
  };
}
