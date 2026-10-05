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
import { absoluteEnvPath, joinFor, normalizePlatform, xdgDataHome } from './platform-paths.ts';
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
import { irBump } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, genericBlocksOf } from './session-source.ts';
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
export function crushProjectPathsOf(value: unknown): string[] {
  const out = new Set<string>();
  const addString = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.add(v);
  };
  const addRecord = (v: unknown): void => {
    if (!isRecord(v)) return;
    addString(v['path'] ?? v['project_path'] ?? v['directory'] ?? v['dir'] ?? v['root']);
  };
  const addList = (list: readonly unknown[]): void => {
    for (const item of list) {
      if (typeof item === 'string') addString(item);
      else addRecord(item);
    }
  };
  if (Array.isArray(value)) {
    addList(value);
    return [...out];
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
  return [...out];
}

/* ---------------- sessions / messages 的自适应列 ---------------- */

const CRUSH_SESSION_ID_KEYS = ['id', 'session_id', 'sessionId'];
const CRUSH_SESSION_CWD_KEYS = ['cwd', 'working_dir', 'working_directory', 'directory', 'project_path', 'path'];
const CRUSH_SESSION_TITLE_KEYS = ['title', 'name', 'summary'];
const CRUSH_SESSION_TIME_KEYS = ['updated_at', 'updatedAt', 'created_at', 'createdAt', 'time_created'];

const CRUSH_MESSAGE_SESSION_KEYS = ['session_id', 'sessionId', 'session'];
const CRUSH_MESSAGE_ID_KEYS = ['id', 'message_id', 'messageId'];
const CRUSH_MESSAGE_ROLE_KEYS = ['role', 'sender'];
const CRUSH_MESSAGE_TIME_KEYS = ['created_at', 'createdAt', 'updated_at', 'updatedAt', 'time_created'];
const CRUSH_MESSAGE_MODEL_KEYS = ['model', 'model_id', 'modelId'];
const CRUSH_MESSAGE_PART_KEYS = ['parts', 'content', 'data', 'json'];

interface CrushAcc {
  ignored: Record<string, number>;
  bad: number;
}

/**
 * `parts`（TEXT JSON）→ IR 块。
 *
 * 显式只认「字符串 = 文本」，其余交给共享的 `genericBlocksOf`（它已覆盖
 * text / tool_use / tool_call / tool_result / function_call 这些跨来源公共词汇），
 * 不认识的类型**逐类计数**而不是消失。
 */
function crushBlocks(value: unknown, acc: CrushAcc): IrBlock[] {
  if (typeof value === 'string') return value === '' ? [] : [crushTextBlock(value)];
  if (Array.isArray(value)) {
    const out: IrBlock[] = [];
    for (const item of value) out.push(...crushBlocks(item, acc));
    return out;
  }
  if (isRecord(value)) return genericBlocksOf(value, acc.ignored, 'crush');
  return [];
}

function crushTextBlock(text: string): IrBlock {
  return { type: 'text', text };
}

function crushRecords(rows: readonly SqliteRow[], acc: CrushAcc): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const row of rows) {
    const roleRaw = (pickString(row, CRUSH_MESSAGE_ROLE_KEYS) ?? '').toLowerCase();
    const role = roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : undefined;
    const blocks = crushBlocks(row['parts'] ?? row['content'] ?? row['data'] ?? row['json'], acc);
    if (role === undefined) {
      irBump(acc.ignored, roleRaw === '' ? 'message-no-role' : 'role:' + roleRaw);
      continue;
    }
    const id = pickString(row, CRUSH_MESSAGE_ID_KEYS);
    const time = pickTime(row, CRUSH_MESSAGE_TIME_KEYS);
    const model = pickString(row, CRUSH_MESSAGE_MODEL_KEYS);
    const pushed = splitToolResults(role, blocks, { id, time, model });
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
  for (const row of messageRows) {
    const key = pickString(row, CRUSH_MESSAGE_SESSION_KEYS);
    if (key === undefined) continue;
    const list = bySession.get(key);
    if (list === undefined) bySession.set(key, [row]);
    else list.push(row);
  }

  const files: SqliteSessionFile[] = [];
  const skipped: ForeignSkip[] = [];
  let noId = 0;
  for (const row of sessionRows) {
    const id = pickString(row, CRUSH_SESSION_ID_KEYS);
    if (id === undefined) {
      noId++;
      continue;
    }
    const rows = bySession.get(id) ?? [];
    const acc: CrushAcc = { ignored: {}, bad: 0 };
    const records = crushRecords(rows, acc);
    const title = pickString(row, CRUSH_SESSION_TITLE_KEYS) ?? '';
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
    counts: { sessions: files.length, messages: messageRows.length },
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
  const projects: string[] = [];
  const registry = await readJsonSafe(registryPath, REGISTRY_MAX_BYTES);
  if (registry.ok) {
    projects.push(...crushProjectPathsOf(registry.value));
  } else if (registry.problem !== 'missing') {
    skipped.push(sqliteSkip(labelForPath(opts.homeDir, registryPath), 'projects-json:' + registry.problem));
  }
  if (opts.projectDir !== undefined && opts.projectDir !== '') projects.push(opts.projectDir);

  const files: SqliteSessionFile[] = [];
  const seen = new Set<string>();
  let probed = 0;
  for (const project of projects) {
    const dbFile = crushProjectDbPath(platform, project);
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
      const read = readCrushDatabase(db, project, label);
      if (read === null) {
        skipped.push(sqliteSkip(label, 'shape-mismatch'));
        continue;
      }
      files.push(...read.files);
      skipped.push(...read.skipped);
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
      ...prefixCounts('crush', { sessions: files.length }),
    },
  };
}
