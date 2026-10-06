/**
 * Hermes（NousResearch/hermes-agent）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 与 hermes.ts 的纯翻译层分开：读盘只做「读得到就读、读不到如实报」，绝不猜、绝不截断。
 *
 * 位置真值（契约 §8.2，本机实测）：
 *  - Windows：%LOCALAPPDATA%\Hermes（本机实测；HERMES_HOME 可整体覆盖）
 *  - macOS / Linux：~/.hermes（官方文档 hermes-agent.nousresearch.com/docs/user-guide/configuration）
 *
 * 四条安全边界（与 read-claude-code.ts 同口径；**刻意不 import 它的私有实现** ——
 * 每个读盘层自带边界与错误口径，真正共享的是纯内核 kernel.ts）：
 *  ① 只读 home 下的固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② .env **只 stat 不读**：值连内存都不进（凭据铁律）
 *  ③ memories/*.md **只列名不读内容**（用户决策：只报告不导入）
 *  ④ 分类目录名与技能名只在内存里做映射，绝不参与写盘路径（写盘路径由翻译层按规定生成）
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { dirWalkSkips, listFileNames, resolveLimit, stemOf, type DirWalkStats } from './session-read.ts';
import { openDetail, pickString, pickTime, sqliteGate, sqliteOpen, sqliteSkip } from './read-opencode.ts';
import type { SqliteDeps } from './read-opencode.ts';
import type { SqliteRow } from './sqlite.ts';
import { irBump, irEarlier, irTextBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, flattenText, genericBlocksOf, parseGenericJsonl, recordIdOf } from './session-source.ts';
import type { ParsedTranscript, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type {
  ForeignLimitOverrides,
  ForeignSkip,
  HermesInput,
  HermesSessionInput,
  HermesSkillInput,
} from './types.ts';

export interface HermesHomeOptions {
  /** 用户 home（Windows 一般传 %USERPROFILE%） */
  homeDir: string;
  /** 进程环境（只用于位置覆盖判定：HERMES_HOME / LOCALAPPDATA） */
  env?: Readonly<Record<string, string | undefined>>;
  /** 平台（缺省 = process.platform；测试注入） */
  platform?: string;
}

export interface HermesResolvedHome {
  /** Hermes 数据目录绝对路径 */
  home: string;
  /** 是否由 HERMES_HOME 覆盖（命中即报 source-location-overridden） */
  overridden: boolean;
}

/**
 * Hermes 数据目录：HERMES_HOME > Windows 的 %LOCALAPPDATA%\Hermes > ~/.hermes。
 * 不猜、不回退到「看起来像」的目录：解析出来的路径就是唯一候选。
 */
export function resolveHermesHome(opts: HermesHomeOptions): HermesResolvedHome {
  const env = opts.env ?? {};
  const explicit = env['HERMES_HOME'];
  if (typeof explicit === 'string' && explicit !== '') return { home: explicit, overridden: true };
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    const lad = env['LOCALAPPDATA'];
    const base = typeof lad === 'string' && lad !== '' ? lad : path.join(opts.homeDir, 'AppData', 'Local');
    return { home: path.join(base, 'Hermes'), overridden: false };
  }
  return { home: path.join(opts.homeDir, '.hermes'), overridden: false };
}

export interface HermesReadOptions extends HermesHomeOptions {
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
  /** 会话数上限（默认 500）；超出即报 source-unreadable/max-sessions-reached，绝不静默截断 */
  maxSessions?: number;
  /**
   * 可注入的 SQLite 依赖（**仅测试**：验证宿主缺 \`node:sqlite\` 时的结构化降级路径）。
   * 生产路径（registry 的 build）永远不传它。
   */
  sqliteDeps?: SqliteDeps;
  /** 可选上限覆盖（t36，装配层透传；缺省 = 上面各默认值逐字不变） */
  limits?: ForeignLimitOverrides;
}

export interface HermesReadResult {
  /** 是否找到 Hermes 数据目录（未安装是正常状态，不是错误） */
  found: boolean;
  /** 解析出的数据目录（诊断用） */
  home: string;
  locationOverridden: boolean;
  input: HermesInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

/** 一个库/一个目录的会话读盘结果（0 会话也是正常结果） */
export interface HermesSessionPart {
  readonly files: readonly HermesSessionInput[];
  readonly skipped: readonly ForeignSkip[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILLS = 500;
/** SOUL.md 是纯文本身份文件，单独给上限（正常只有几百字节） */
const SOUL_MAX_FILE = 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readTextSafe(p: string, max: number): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > max) return null;
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 递归收集一个目录下的普通文件（不跟随符号链接；条目数与单文件字节都有上限） */
async function walkFiles(
  root: string,
  start: string,
  maxFiles: number,
  maxBytes: number,
  stats?: DirWalkStats,
): Promise<{ relativePath: string; data: Uint8Array }[]> {
  const out: { relativePath: string; data: Uint8Array }[] = [];
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // t36：条数触顶不再静默 —— 置标志，由调用方推 max-skill-files-reached。
      if (out.length >= maxFiles) { if (stats !== undefined) stats.truncatedFiles = true; break; }
      const full = path.join(cur, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await statOrNull(full);
      if (st === null) continue;
      if (st.size > maxBytes) {
        if (stats !== undefined) stats.tooLargeCount = (stats.tooLargeCount ?? 0) + 1;
        continue;
      }
      try {
        const data = await fs.readFile(full);
        out.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), data });
      } catch {
        // 单个文件读不到就不带：该技能的成员数会随之少一个，用户在计数上看得见
      }
    }
  }
  return out;
}

async function hasSkillMd(dir: string): Promise<boolean> {
  const st = await statOrNull(path.join(dir, 'SKILL.md'));
  return st !== null && st.isFile();
}

/**
 * skills/ 的两层形态（本机实测：24 个分类，其中 5 个分类目录自己带 SKILL.md、19 个分类下挂技能目录）。
 *
 * 判定（不猜）：
 *  - 分类目录自己带 SKILL.md → 该分类就是一个技能（子目录是它的资产，不再单独当技能）；
 *  - 否则遍历它的子目录：带 SKILL.md 的才是一个技能（技能名取**叶子目录名** = 压平分类），
 *    不带 SKILL.md 的子目录是资产，既不产出也不报错。
 *  - 以 . 开头的目录/文件不是技能（.hub / .curator_backups / .bundled_manifest / .usage.json …）。
 */
async function readSkills(
  skillsDir: string,
  maxFiles: number,
  maxBytes: number,
  maxSkills: number,
  stats?: DirWalkStats & { truncated?: boolean },
): Promise<HermesSkillInput[]> {
  let categories: Dirent[];
  try {
    categories = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: HermesSkillInput[] = [];
  // 技能数触顶绝不静默（audit-foreign F4）：置标志，由调用方推一条 source-unreadable。
  for (const c of categories) {
    if (out.length >= maxSkills) { if (stats !== undefined) stats.truncated = true; break; }
    if (!c.isDirectory() || c.isSymbolicLink()) continue;
    if (c.name.startsWith('.')) continue;
    const catDir = path.join(skillsDir, c.name);
    if (await hasSkillMd(catDir)) {
      const files = await walkFiles(catDir, catDir, maxFiles, maxBytes, stats);
      if (files.length > 0) out.push({ name: c.name, files });
      continue;
    }
    let subs: Dirent[];
    try {
      subs = await fs.readdir(catDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (out.length >= maxSkills) { if (stats !== undefined) stats.truncated = true; break; }
      if (!s.isDirectory() || s.isSymbolicLink()) continue;
      if (s.name.startsWith('.')) continue;
      const skillDir = path.join(catDir, s.name);
      if (!(await hasSkillMd(skillDir))) continue;
      const files = await walkFiles(skillDir, skillDir, maxFiles, maxBytes, stats);
      if (files.length === 0) continue;
      out.push({ name: s.name, files, category: c.name });
    }
  }
  return out;
}

/** memories/ 下的记忆文件名（**只列名**；.lock 之类的伴随文件不算） */
async function memoryFileNames(memoriesDir: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(memoriesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    if (!d.isFile() || d.isSymbolicLink()) continue;
    if (!d.name.endsWith('.md')) continue;
    out.push(d.name);
  }
  return out.sort();
}

/* ---------------- 会话：state.db（SQLite，主路径）+ sessions/*.jsonl（回退） ---------------- */

/** Hermes 的会话库文件名（真值：<home>/state.db） */
export const HERMES_STATE_DB = 'state.db';

/** 单库最多读多少个会话（超出即报 max-sessions-reached，绝不静默截断） */
const DEFAULT_MAX_SESSIONS = 500;

/* 表名只允许**本文件的编译期常量**（绝不拼调用方给的字符串，见 read-opencode.ts 纪律 ②） */
const HERMES_SESSION_TABLES: readonly string[] = ['sessions'];
const HERMES_MESSAGE_TABLES: readonly string[] = ['messages'];

/* 列名候选：真机实测（hermes-agent）在前，cc-switch 之类的变体在后（列**必须存在**才取得到） */
const H_SESSION_ID_KEYS: readonly string[] = ['id'];
const H_SESSION_CWD_KEYS: readonly string[] = ['cwd', 'directory', 'workdir', 'working_directory', 'project_path'];
const H_SESSION_TITLE_KEYS: readonly string[] = ['title', 'display_name', 'name'];
const H_SESSION_TIME_KEYS: readonly string[] = ['started_at', 'created_at', 'createdAt', 'updated_at'];
const H_MESSAGE_SESSION_KEYS: readonly string[] = ['session_id', 'sessionId'];
const H_MESSAGE_ROLE_KEYS: readonly string[] = ['role', 'sender'];
const H_MESSAGE_CONTENT_KEYS: readonly string[] = ['content', 'api_content'];
const H_MESSAGE_TOOLCALL_KEYS: readonly string[] = ['tool_calls', 'tool_call'];
const H_MESSAGE_TOOLID_KEYS: readonly string[] = ['tool_call_id', 'toolCallId'];
const H_MESSAGE_ID_KEYS: readonly string[] = ['id'];
const H_MESSAGE_TIME_KEYS: readonly string[] = ['timestamp', 'created_at', 'createdAt', 'time'];
const H_MESSAGE_MODEL_KEYS: readonly string[] = ['model', 'model_id'];

/** 标识符自证（只允许来自 PRAGMA 的普通列名；拼进 SQL 前必须过这道门） */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string | undefined {
  return SQL_IDENT_RE.test(name) ? '"' + name + '"' : undefined;
}

function pickColumn(cols: readonly string[], keys: readonly string[]): string | undefined {
  for (const k of keys) if (cols.includes(k)) return k;
  return undefined;
}

/** 取第一个「有值」的原始单元格（与 pickString 不同：数字/BLOB 也能拿到，供 JSON 列使用） */
function firstCell(row: SqliteRow, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * content 单元格 → 文本块。
 *
 * Claude 风格的块数组在 Hermes 的 TEXT 列里以 **JSON 文本**存储（参考实现同款判定）→ 解析回数组
 * 走通用块映射；字面以 '[' 开头的普通文本解析失败时**按原样保留**，绝不吞正文。
 */
function hermesContentBlocks(raw: unknown, ignored: Record<string, number>): IrBlock[] {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return genericBlocksOf(parsed, ignored, 'content');
      } catch {
        // 字面 '[' 开头的普通文本：按文本保留
      }
    }
    return [irTextBlock(raw)];
  }
  if (Array.isArray(raw) || isRecord(raw)) return genericBlocksOf(raw, ignored, 'content');
  return [];
}

/**
 * tool_calls 列（JSON 文本）→ 工具调用块。
 *
 * 归一成通用块形态后再交给 `genericBlocksOf` —— name/arguments 的多种命名（function.name /
 * function.arguments / tool_name / input / args）只在这一处解释，口径与其它来源不可能分叉。
 */
function hermesToolCallBlocks(raw: unknown, ignored: Record<string, number>): IrBlock[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      irBump(ignored, 'tool-calls-unparsable');
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: IrBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item['function']) ? item['function'] : undefined;
    const name = item['name'] !== undefined ? item['name'] : (fn === undefined ? undefined : fn['name']);
    const id = item['id'] !== undefined ? item['id'] : item['tool_call_id'];
    const input = item['input'] !== undefined
      ? item['input']
      : (item['arguments'] !== undefined
        ? item['arguments']
        : (fn === undefined ? item['args'] : (fn['arguments'] !== undefined ? fn['arguments'] : fn['input'])));
    out.push(...genericBlocksOf([{ type: 'tool_call', id, name, input }], ignored, 'tool_call'));
  }
  return out;
}

/**
 * 工具结果的正文候选键（**真机 shapes 的统计结论**，2026-10-06 对 5863 条 tool 行取样）：
 * `output`（命令输出，最多）/ `content`（读文件）/ `error` / `diff` / `summary` / `question` /
 * `matches` / `message` / `files` / `note` / `hint`。按可信度排序，命中即取。
 */
const TOOL_TEXT_KEYS: readonly string[] = [
  'output', 'diff', 'content', 'text', 'result', 'error', 'summary',
  'question', 'user_response', 'matches', 'message', 'note', 'hint',
];

/**
 * 认不出来的结构化结果 → **可读的标量摘要**（不是 JSON dump）：
 * 字符串/数字/布尔写成 `key: value`，数组/对象只写 `key: [n items]`（绝不把整棵结构塞进正文）。
 */
function toolScalarDigest(rec: Record<string, unknown>, ignored: Record<string, number>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value !== '') lines.push(key + ': ' + value);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(key + ': ' + String(value));
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(key + ': [' + String(value.length) + ' items]');
      continue;
    }
    if (isRecord(value)) lines.push(key + ': {…}');
  }
  if (lines.length === 0) {
    irBump(ignored, 'tool-result-empty');
    return '';
  }
  return lines.join(String.fromCharCode(10)).slice(0, 4000);
}

/**
 * tool 行的结果文本。
 *
 * 真机的 tool 行是**异构 JSON 信封**（`{"output":…}` / `{"content":…}` / `{"error":…}` /
 * `{"diff":…}` / `{"total_count":…}` …），只认 output/content 会让绝大多数结果变成空串。
 * 三级降级：① JSON 字面量 → ② 候选键 → ③ 标量摘要；**绝不 JSON.stringify 整棵结构**。
 */
function hermesToolResultText(cell: unknown, ignored: Record<string, number>): string {
  let value: unknown = cell;
  if (typeof cell === 'string') {
    const trimmed = cell.trim();
    if (trimmed === '') return '';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        // 字面以 { / [ 开头的普通文本：按原样保留
        return cell;
      }
    } else {
      return cell;
    }
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return flattenText(value, ignored, 'tool-result');
  if (isRecord(value)) {
    for (const k of TOOL_TEXT_KEYS) {
      const v = value[k];
      if (typeof v === 'string' && v !== '') return v;
      if (Array.isArray(v)) {
        const text = flattenText(v, ignored, 'tool-result');
        if (text !== '') return text;
      }
    }
    return toolScalarDigest(value, ignored);
  }
  return '';
}

/** 角色归一：命中即按该分支处理；返回 undefined 表示未知角色（调用方计数，绝不静默丢） */
function hermesRoleOf(row: SqliteRow): 'assistant' | 'user' | 'tool' | undefined {
  const role = (pickString(row, H_MESSAGE_ROLE_KEYS) ?? '').toLowerCase();
  if (role === 'assistant' || role === 'ai' || role === 'model') return 'assistant';
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'tool' || role === 'tool_result' || role === 'function') return 'tool';
  return undefined;
}

/** 一个会话的 messages 行 → 归一记录（**保持库里的时间序**；每类未迁移记录逐类计数） */
function hermesTranscriptOf(
  rows: readonly SqliteRow[],
  meta: { cwd: string | undefined; title: string; createdAt: IrTimeMs | undefined; raw: number },
): ParsedTranscript {
  const records: TranscriptRecord[] = [];
  const ignored: Record<string, number> = {};
  let earliest = meta.createdAt;
  let index = 0;
  for (const row of rows) {
    const time = pickTime(row, H_MESSAGE_TIME_KEYS);
    earliest = irEarlier(earliest, time);
    const messageId = recordIdOf(pickString(row, H_MESSAGE_ID_KEYS), index);
    index += 1;
    const content = firstCell(row, H_MESSAGE_CONTENT_KEYS);
    const role = hermesRoleOf(row);
    if (role === 'assistant') {
      const blocks: IrBlock[] = [];
      for (const b of hermesContentBlocks(content, ignored)) if (b.type !== 'tool_call') blocks.push(b);
      blocks.push(...hermesToolCallBlocks(firstCell(row, H_MESSAGE_TOOLCALL_KEYS), ignored));
      if (blocks.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      records.push({
        role: 'assistant',
        blocks,
        time,
        id: messageId,
        model: pickString(row, H_MESSAGE_MODEL_KEYS),
      });
      continue;
    }
    if (role === 'user') {
      const blocks = hermesContentBlocks(content, ignored).filter((b) => b.type !== 'tool_call');
      if (blocks.length === 0) {
        irBump(ignored, 'user-empty');
        continue;
      }
      records.push({ role: 'user', blocks, time, id: messageId });
      continue;
    }
    if (role === 'tool') {
      const callId = pickString(row, H_MESSAGE_TOOLID_KEYS) ?? '';
      records.push({
        role: 'user',
        blocks: [irToolResultBlock(callId, hermesToolResultText(content, ignored), false)],
        time,
        id: messageId,
      });
      continue;
    }
    const rawRole = (pickString(row, H_MESSAGE_ROLE_KEYS) ?? '').toLowerCase();
    irBump(ignored, rawRole === '' ? 'unknown-role' : rawRole);
  }
  const title = meta.title !== '' ? meta.title : firstUserText(records);
  return { records, cwd: meta.cwd, createdAt: earliest, title, raw: meta.raw, bad: 0, ignored };
}

/**
 * state.db → 会话（只读打开 + PRAGMA 自适应列）。
 *
 * 打不开 / 不是 Hermes 的库 / 表结构不符 / 查询失败 → 0 文件 + 一条 source-unreadable，
 * 由 `readHermes` 决定是否回退 sessions/*.jsonl。**绝不抛、绝不往用户目录写文件**。
 */
export async function readHermesSessionsFromDb(opts: {
  readonly dbFile: string;
  readonly maxSessions: number;
  readonly sqliteDeps?: SqliteDeps | undefined;
}): Promise<HermesSessionPart> {
  const label = HERMES_STATE_DB;
  const gate = await sqliteGate(label, opts.sqliteDeps);
  if (gate !== undefined) return { files: [], skipped: [gate] };
  const opened = await sqliteOpen(opts.dbFile, opts.sqliteDeps);
  if (opened.db === null) return { files: [], skipped: [sqliteSkip(label, openDetail(opened.problem))] };
  const db = opened.db;
  try {
    const tables = db.tables();
    if (tables === null) return { files: [], skipped: [sqliteSkip(label, 'shape-mismatch')] };
    const sessionTable = HERMES_SESSION_TABLES.find((t) => tables.includes(t));
    if (sessionTable === undefined) return { files: [], skipped: [sqliteSkip(label, 'shape-mismatch')] };
    const sCols = db.columns(sessionTable) ?? [];
    if (pickColumn(sCols, H_SESSION_ID_KEYS) === undefined) {
      return { files: [], skipped: [sqliteSkip(label, 'shape-mismatch')] };
    }
    const sessionRows = db.all('SELECT * FROM "' + sessionTable + '"');
    if (sessionRows === null) return { files: [], skipped: [sqliteSkip(label, 'query-failed')] };

    const messageTable = HERMES_MESSAGE_TABLES.find((t) => tables.includes(t));
    const mCols = messageTable === undefined ? [] : (db.columns(messageTable) ?? []);
    const mSessionCol = pickColumn(mCols, H_MESSAGE_SESSION_KEYS);
    const roleCol = pickColumn(mCols, H_MESSAGE_ROLE_KEYS);
    const timeCol = pickColumn(mCols, H_MESSAGE_TIME_KEYS);
    const idCol = pickColumn(mCols, H_MESSAGE_ID_KEYS);
    const orderParts: string[] = [];
    const timeIdent = timeCol === undefined ? undefined : quoteIdent(timeCol);
    const idIdent = idCol === undefined ? undefined : quoteIdent(idCol);
    if (timeIdent !== undefined) orderParts.push(timeIdent);
    if (idIdent !== undefined) orderParts.push(idIdent);
    const orderBy = orderParts.length > 0 ? ' ORDER BY ' + orderParts.join(', ') : '';
    const messageSql = messageTable !== undefined && mSessionCol !== undefined && roleCol !== undefined
      ? 'SELECT * FROM "' + messageTable + '" WHERE "' + mSessionCol + '" = ?' + orderBy
      : undefined;

    const files: HermesSessionInput[] = [];
    const skipped: ForeignSkip[] = [];
    let truncated = false;
    let noId = 0;
    /* 会话顺序按 started_at 降序（最近在前）；时间列缺失时保持库的自然顺序 */
    const ordered = [...sessionRows].sort((a, b) => (pickTime(b, H_SESSION_TIME_KEYS) ?? 0) - (pickTime(a, H_SESSION_TIME_KEYS) ?? 0));
    for (const row of ordered) {
      if (files.length >= opts.maxSessions) { truncated = true; break; }
      const id = pickString(row, H_SESSION_ID_KEYS);
      if (id === undefined) { noId += 1; continue; }
      const messages = messageSql === undefined ? [] : (db.all(messageSql, id) ?? []);
      files.push({
        id,
        parsed: hermesTranscriptOf(messages, {
          cwd: pickString(row, H_SESSION_CWD_KEYS),
          title: pickString(row, H_SESSION_TITLE_KEYS) ?? '',
          createdAt: pickTime(row, H_SESSION_TIME_KEYS),
          raw: messages.length,
        }),
      });
    }
    if (truncated) {
      skipped.push({ code: 'source-unreadable', origin: label, detail: 'max-sessions-reached', count: opts.maxSessions });
    }
    if (noId > 0) skipped.push({ code: 'source-unreadable', origin: label, detail: 'session-without-id', count: noId });
    if (messageSql === undefined && sessionRows.length > 0) {
      skipped.push({ code: 'source-unreadable', origin: label, detail: 'messages-table-unusable' });
    }
    return { files, skipped };
  } catch {
    return { files: [], skipped: [sqliteSkip(label, 'query-failed')] };
  } finally {
    db.close();
  }
}

/**
 * 回退路径：`sessions/*.jsonl`（旧版/异构 Hermes 布局）。
 *
 * **只认 .jsonl**：真机 sessions/ 里全是 request_dump_*.json（请求转储，不是会话），
 * 把它们当会话读会产出成百上千条垃圾对话 —— 宁可少读，不可错读。
 */
export async function readHermesSessionJsonl(
  sessionsDir: string,
  maxSessions: number,
  maxBytes: number,
): Promise<HermesSessionPart> {
  const skipped: ForeignSkip[] = [];
  const names = (await listFileNames(sessionsDir, (n) => n.endsWith('.jsonl'))).sort();
  const files: HermesSessionInput[] = [];
  let truncated = false;
  for (const name of names) {
    if (files.length >= maxSessions) { truncated = true; break; }
    const text = await readTextSafe(path.join(sessionsDir, name), maxBytes);
    if (text === null) {
      skipped.push({ code: 'source-unreadable', origin: 'sessions/' + name, detail: 'read-error' });
      continue;
    }
    const parsed = parseGenericJsonl(text);
    files.push({ id: stemOf(name), parsed });
  }
  if (truncated) {
    skipped.push({ code: 'source-unreadable', origin: 'sessions', detail: 'max-sessions-reached', count: maxSessions });
  }
  return { files, skipped };
}

export async function readHermes(opts: HermesReadOptions): Promise<HermesReadResult> {
  const resolved = resolveHermesHome(opts);
  const home = resolved.home;
  const maxFileBytes = resolveLimit(opts.limits?.maxFileBytes, opts.maxFileBytes, DEFAULT_MAX_FILE);
  const maxSkillFiles = resolveLimit(opts.limits?.maxSkillFiles, opts.maxSkillFiles, DEFAULT_MAX_SKILL_FILES);
  const maxSkills = resolveLimit(opts.limits?.maxSkills, opts.maxSkills, DEFAULT_MAX_SKILLS);
  const maxSessions = resolveLimit(opts.limits?.maxSessionFiles, opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const readFindings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: HermesInput = {};

  if (resolved.overridden) {
    // 如实报告位置被覆盖（绝不静默换目录）；不把绝对路径写进 finding（那是机器身份）
    readFindings.push({ code: 'source-location-overridden', origin: 'HERMES_HOME' });
  }

  const dirStat = await statOrNull(home);
  if (dirStat === null || !dirStat.isDirectory()) {
    input.readFindings = readFindings;
    return { found: false, home, locationOverridden: resolved.overridden, input, unreadable };
  }

  /* config.yaml（唯一的结构化配置来源） */
  const configPath = path.join(home, 'config.yaml');
  const cfgStat = await statOrNull(configPath);
  if (cfgStat !== null && cfgStat.isFile()) {
    if (cfgStat.size === 0) {
      readFindings.push({ code: 'source-empty-file', origin: 'config.yaml' });
    } else if (cfgStat.size > maxFileBytes) {
      unreadable.push('config.yaml');
      readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'too-large' });
    } else {
      let text: string | null = null;
      try {
        text = await fs.readFile(configPath, 'utf8');
      } catch {
        unreadable.push('config.yaml');
        readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'read-error' });
      }
      if (text !== null && text !== '') {
        try {
          input.config = yaml.load(text);
        } catch {
          unreadable.push('config.yaml');
          readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'yaml-error' });
        }
      }
    }
  }

  /* SOUL.md = 主身份（导入） */
  const soulPath = path.join(home, 'SOUL.md');
  const soul = await readTextSafe(soulPath, SOUL_MAX_FILE);
  if (soul !== null) input.soul = soul;
  else if ((await statOrNull(soulPath)) !== null) {
    unreadable.push('SOUL.md');
    readFindings.push({ code: 'source-unreadable', origin: 'SOUL.md' });
  }

  /* skills/（两层分类） */
  const skillStats: DirWalkStats & { truncated?: boolean } = {};
  const skills = await readSkills(path.join(home, 'skills'), maxSkillFiles, maxFileBytes, maxSkills, skillStats);
  if (skillStats.truncated === true) {
    readFindings.push({ code: 'source-unreadable', origin: 'skills', detail: 'max-skills-reached', count: maxSkills });
  }
  // t36：技能文件遍历的条数/字节触顶同样必须可见（与 max-skills-reached 同族）
  readFindings.push(...dirWalkSkips(skillStats, 'skills', maxSkillFiles));
  if (skills.length > 0) input.skills = skills;

  /* memories/（只列名） */
  const memoryFiles = await memoryFileNames(path.join(home, 'memories'));
  if (memoryFiles.length > 0) input.memoryFiles = memoryFiles;

  /* .env（只 stat） */
  const envStat = await statOrNull(path.join(home, '.env'));
  if (envStat !== null && envStat.isFile()) input.dotEnvPresent = true;

  /* 对话存储：state.db（SQLite）主路径 + sessions/*.jsonl 回退 —— 读得动就读，读不动如实报 */
  const dbPath = path.join(home, HERMES_STATE_DB);
  const sessionsDir = path.join(home, 'sessions');
  const dbStat = await statOrNull(dbPath);
  const sessStat = await statOrNull(sessionsDir);
  const hasDb = dbStat !== null && dbStat.isFile();
  const hasSessionsDir = sessStat !== null && sessStat.isDirectory();
  if (hasDb) input.sessionStore = { present: true, detail: HERMES_STATE_DB };
  else if (hasSessionsDir) input.sessionStore = { present: true, detail: 'sessions/' };

  const sessionFiles: HermesSessionInput[] = [];
  if (hasDb) {
    const read = await readHermesSessionsFromDb({
      dbFile: dbPath,
      maxSessions,
      ...(opts.sqliteDeps !== undefined ? { sqliteDeps: opts.sqliteDeps } : {}),
    });
    sessionFiles.push(...read.files);
    readFindings.push(...read.skipped);
  }
  /* 库不存在 / 读不出来（0 条 + 有码）/ 或根本没有库 → 回退 JSONL；两处都有则合并去重（按 id 先到先得） */
  if (sessionFiles.length === 0 && hasSessionsDir) {
    const read = await readHermesSessionJsonl(sessionsDir, maxSessions, maxFileBytes);
    sessionFiles.push(...read.files);
    readFindings.push(...read.skipped);
  }
  if (sessionFiles.length > 0) input.sessions = sessionFiles;

  input.readFindings = readFindings;
  return { found: true, home, locationOverridden: resolved.overridden, input, unreadable };
}
