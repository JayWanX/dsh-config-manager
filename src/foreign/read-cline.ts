/**
 * Cline 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 cline 行）。
 *
 * 布局（chat-import discovery.mjs:47-78,148-154,2094；read-vault §10.1 cline 两行；read-sessions-manager 第 21 行）：
 *   现代：<dataDir>/sessions/<sessionId>/{<id>.json, <id>.messages.json, <id>.compaction.json}
 *         <dataDir> = $CLINE_SESSION_DATA_DIR（直接用）| $CLINE_DATA_DIR + '/sessions'
 *                     | ($CLINE_DIR | <home>/.cline) + '/data/sessions'
 *   遗留：<legacyRoot>/tasks/<taskId>/{api_conversation_history.json, ui_messages.json}
 *         <legacyRoot>/state/taskHistory.json = **tasks/ 兄弟目录**的任务索引（cwd/标题/时间的权威来源）
 *         <legacyRoot> = $CLINE_LEGACY_GLOBAL_STORAGE_DIR | $CLINE_VSCODE_GLOBAL_STORAGE_DIR（命中即**只此一根**）
 *                       | {Code, Code - Insiders, VSCodium} × VS Code User 根 + '/globalStorage/saoudrizwan.claude-dev'
 *   现代元数据索引：<dataDir>/db/sessions.db（**只存元数据**；消息仍在 <id>.messages.json）
 *
 * 平台纪律：三分支逐字对齐 chat-import 的 clineLegacyStorageDirs（win32 = %APPDATA%、
 * darwin = ~/Library/Application Support、linux = $XDG_CONFIG_HOME|~/.config），**全部经 joinFor**。
 *
 * 归一纪律：消息映射是**容错**的（role / say|ask / text|content 三形态并存），不认识的记录类型
 * **逐类计数**（进 `ignored` → 下游 unsupported-session-record），绝不静默丢；cwd 只认**权威来源**
 * （现代：db/sessions.db 或 manifest 的 cwd/workspace_root；遗留：state/taskHistory.json 的
 * cwdOnTaskInitialization）—— 绝不从消息正文深搜（否则会把工具入参里的 `path` 当会话 cwd）。
 */
import { dirname } from 'node:path';

import { envValue, isAbsoluteFor, joinFor, normalizePlatform, vscodeUserDataDir } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { isFile, listDirNames, listFileNames, readJsonSafe, statOrNull } from './session-read.ts';
import { firstUserText, genericBlocksOf } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irEarlier, irBump, irSafeTime } from './session-ir.ts';
import { pickString, pickTime, prefixCounts } from './read-opencode.ts';
import { openSqliteReadOnlyEx } from './sqlite.ts';
import type { SqliteHandle } from './sqlite.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const CLINE_EXTENSION_DIR = 'saoudrizwan.claude-dev';
export const CLINE_DEFAULT_DIR = '.cline';
/** 遗留 VS Code globalStorage 的三个编辑器名（chat-import discovery.mjs:61-78 逐字） */
export const CLINE_LEGACY_EDITORS: readonly string[] = ['Code', 'Code - Insiders', 'VSCodium'];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 5000;

/** cwd 的**显式权威字段**：manifest 的 cwd/workspace_root、legacy 索引的 cwdOnTaskInitialization */
const CWD_KEYS: readonly string[] = ['cwd', 'workspace_root', 'workspaceRoot', 'cwdOnTaskInitialization'];
const TITLE_KEYS: readonly string[] = ['task', 'title', 'summary', 'name'];
/** 时间候选：补 started_at / updated_at（参考 DB 与 manifest 的 started_at） */
const TIME_KEYS: readonly string[] = [
  'createdAt', 'created_at', 'started_at', 'startedAt', 'timestamp', 'ts', 'startTime', 'time', 'updated_at', 'updatedAt',
];

export interface ClineRoots {
  readonly modern: string;
  /** 权威元数据索引：`<dataDir>/db/sessions.db`（modern 的兄弟目录；不存消息） */
  readonly db: string | undefined;
  readonly legacy: readonly string[];
  readonly clineDir: string;
  readonly modernFrom: 'CLINE_SESSION_DATA_DIR' | 'CLINE_DATA_DIR' | 'CLINE_DIR' | 'default';
  readonly legacyFrom: 'CLINE_LEGACY_GLOBAL_STORAGE_DIR' | 'CLINE_VSCODE_GLOBAL_STORAGE_DIR' | 'default';
}

/**
 * 三级 dataDir 解析（CLINE_SESSION_DATA_DIR > CLINE_DATA_DIR > CLINE_DIR > 默认 ~/.cline）
 * + legacy VS Code globalStorage 根（两个 override 命中即**只返回那一个**，与竞品逐字同义）。
 */
export function resolveClineRoots(opts: RootProbeOptions): ClineRoots {
  const platform = normalizePlatform(opts.platform);
  const sessionDataDir = envValue(opts.env, 'CLINE_SESSION_DATA_DIR');
  const dataDir = envValue(opts.env, 'CLINE_DATA_DIR');
  const dirEnv = envValue(opts.env, 'CLINE_DIR');
  const clineDir = dirEnv ?? joinFor(platform, opts.homeDir, CLINE_DEFAULT_DIR);
  let modern: string;
  let db: string;
  let modernFrom: ClineRoots['modernFrom'];
  if (sessionDataDir !== undefined) {
    modern = sessionDataDir;
    // sessionsDir 显式给出时，dataDir = 它的上一级（参考 clineDeriveArgs：<数据目录>/db/sessions.db）
    db = joinFor(platform, dirname(sessionDataDir), 'db', 'sessions.db');
    modernFrom = 'CLINE_SESSION_DATA_DIR';
  } else if (dataDir !== undefined) {
    modern = joinFor(platform, dataDir, 'sessions');
    db = joinFor(platform, dataDir, 'db', 'sessions.db');
    modernFrom = 'CLINE_DATA_DIR';
  } else {
    modern = joinFor(platform, clineDir, 'data', 'sessions');
    db = joinFor(platform, clineDir, 'data', 'db', 'sessions.db');
    modernFrom = dirEnv === undefined ? 'default' : 'CLINE_DIR';
  }
  const legacyEnv = envValue(opts.env, 'CLINE_LEGACY_GLOBAL_STORAGE_DIR');
  const vscodeEnv = envValue(opts.env, 'CLINE_VSCODE_GLOBAL_STORAGE_DIR');
  let legacy: string[];
  let legacyFrom: ClineRoots['legacyFrom'];
  if (legacyEnv !== undefined) {
    legacy = [legacyEnv];
    legacyFrom = 'CLINE_LEGACY_GLOBAL_STORAGE_DIR';
  } else if (vscodeEnv !== undefined) {
    legacy = [vscodeEnv];
    legacyFrom = 'CLINE_VSCODE_GLOBAL_STORAGE_DIR';
  } else {
    legacy = CLINE_LEGACY_EDITORS.map((editor) =>
      joinFor(platform, vscodeUserDataDir(platform, opts.homeDir, opts.env, editor), 'globalStorage', CLINE_EXTENSION_DIR));
    legacyFrom = 'default';
  }
  return { modern, db, legacy, clineDir, modernFrom, legacyFrom };
}

/** 静态探测位置 = 现代根 + legacy 根（顺序即优先级；probePaths 与读盘层共用本函数） */
export function clineProbePaths(opts: RootProbeOptions): string[] {
  const roots = resolveClineRoots(opts);
  return [roots.modern, ...roots.legacy];
}

/** 一条已归一的会话文件（`ParsedTranscript` + 源侧 id + 存储代次） */
export interface ClineSessionFile extends ParsedTranscript {
  readonly id: string;
  readonly flavor: 'modern' | 'legacy';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * cwd 只认**显式权威字段**（manifest 的 cwd/workspace_root、legacy 索引的 cwdOnTaskInitialization +
 * 目标平台绝对路径校验）。旧实现对整条记录做 5 层递归深搜（cwd/path/directory/workspace 泛键）
 * → 会把工具入参里的 `path` 当会话 cwd；这里只读顶层权威字段，绝不深搜。
 */
export function clineCwdOf(value: unknown, platform: ForeignPlatform): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of CWD_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && isAbsoluteFor(platform, candidate)) return candidate;
  }
  return undefined;
}

/** 标题：manifest 的 metadata.title 优先，其次顶层 title / legacy 索引的 task */
function clineTitleOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const meta = isRecord(value['metadata']) ? value['metadata'] : undefined;
  for (const source of [meta, value]) {
    if (source === undefined) continue;
    for (const key of TITLE_KEYS) {
      const v = source[key];
      if (typeof v === 'string' && v !== '') return v.slice(0, 200);
    }
  }
  return undefined;
}

/** 记录时间（只在**顶层**取；秒/毫秒/RFC3339 自适应） */
function clineTimeOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of TIME_KEYS) {
    const t = irSafeTime(value[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** 角色归一（role 形态 + Cline 的 say|ask 形态 + 通用 type 形态；不认识的一律计数） */
function roleOfItem(item: Record<string, unknown>, ignored: Record<string, number>): 'user' | 'assistant' | undefined {
  const role = str(item['role']);
  if (role !== undefined) {
    const lower = role.toLowerCase();
    if (lower === 'user' || lower === 'human' || lower === 'user_message') return 'user';
    if (lower === 'assistant' || lower === 'ai' || lower === 'model' || lower === 'bot') return 'assistant';
    irBump(ignored, 'cline:role-' + lower);
    return undefined;
  }
  const type = str(item['type']);
  if (type === undefined) {
    irBump(ignored, 'cline:no-role');
    return undefined;
  }
  const lower = type.toLowerCase();
  if (lower === 'say' || lower === 'ask') {
    const sub = (str(item['say']) ?? str(item['ask']) ?? '').toLowerCase();
    // say=user_feedback 是用户输入；**ask 是用户提问**（参考：ui_messages 的 ask.text 属用户侧，
    // 旧实现把 ask 归成 assistant）。ui_messages 本身已不再当转写，这里只保留形态正确性。
    if (lower === 'say' && sub === 'user_feedback') return 'user';
    if (lower === 'ask') {
      if (sub === '' || sub === 'text' || sub === 'followup') return 'user';
      irBump(ignored, 'cline:' + sub);
      return undefined;
    }
    if (sub !== '' && sub !== 'text') {
      // 非文本的 say（api_req_started / checkpoint_created / command / completion_result …）
      irBump(ignored, 'cline:' + sub);
      return undefined;
    }
    return 'assistant';
  }
  if (lower === 'user' || lower === 'human') return 'user';
  if (lower === 'assistant' || lower === 'ai' || lower === 'model') return 'assistant';
  irBump(ignored, 'cline:type-' + lower);
  return undefined;
}

interface MessageListResult {
  readonly records: TranscriptRecord[];
  readonly raw: number;
  readonly bad: number;
}

/**
 * 消息容器 → 归一记录。覆盖三种容器形态：
 *  ① 数组（ui_messages.json / api_conversation_history.json / messages 数组）；
 *  ② 对象里挂 messages|conversation|history|turns|chatHistory 数组；
 *  ③ 单个消息对象（工具把一条记录存成一个文件）。
 */
function recordsFromMessages(value: unknown, ignored: Record<string, number>): MessageListResult {
  let items: unknown[] | undefined;
  if (Array.isArray(value)) items = value;
  else if (isRecord(value)) {
    for (const key of ['messages', 'conversation', 'history', 'turns', 'chatHistory', 'chat_history']) {
      const candidate = value[key];
      if (Array.isArray(candidate)) { items = candidate; break; }
    }
    if (items === undefined) items = [value];
  }
  if (items === undefined) return { records: [], raw: 0, bad: 0 };
  const records: TranscriptRecord[] = [];
  let raw = 0;
  let bad = 0;
  for (const item of items) {
    raw += 1;
    if (!isRecord(item)) { bad += 1; continue; }
    const role = roleOfItem(item, ignored);
    if (role === undefined) continue;
    const content = item['content'] ?? item['text'] ?? item['message'] ?? item['parts'];
    const blocks = genericBlocksOf(content, ignored, 'cline-block');
    if (blocks.length === 0) { irBump(ignored, 'cline:no-content'); continue; }
    const time = irSafeTime(item['ts']) ?? irSafeTime(item['timestamp']) ?? irSafeTime(item['createdAt']);
    records.push({
      role,
      blocks,
      ...(time !== undefined ? { time } : {}),
      ...(str(item['id']) !== undefined ? { id: str(item['id']) as string } : {}),
    });
  }
  return { records, raw, bad };
}

function finish(
  id: string,
  flavor: 'modern' | 'legacy',
  messages: MessageListResult,
  ignored: Record<string, number>,
  cwd: string | undefined,
  title: string | undefined,
  createdAt: number | undefined,
): ClineSessionFile {
  const fallbackTitle = title === undefined || title === '' ? firstUserText(messages.records) : title;
  return {
    id,
    flavor,
    cwd,
    createdAt,
    title: fallbackTitle,
    records: messages.records,
    raw: messages.raw,
    bad: messages.bad,
    ignored,
  };
}

/** 一条 DB 索引（`<dataDir>/db/sessions.db` 的 sessions 表）：cwd/标题/创建时间/子代理判定 */
interface ClineDbEntry {
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly createdAt?: number | undefined;
  readonly isSubagent: boolean;
}

/**
 * 打开着的 cline 索引库 → session_id → 元数据。
 *
 * `<dataDir>/db/sessions.db` **只存元数据索引、不存消息**（消息在 <id>.messages.json），
 * 但它是 cwd/标题/started_at 的**权威来源**；缺表/缺列/读不出来 → 空索引（回退 manifest）。
 */
export function readClineDbIndex(db: SqliteHandle): Map<string, ClineDbEntry> {
  const out = new Map<string, ClineDbEntry>();
  const tables = db.tables();
  if (tables === null || !tables.includes('sessions')) return out;
  const cols = db.columns('sessions');
  if (cols === null || !cols.includes('session_id')) return out;
  const rows = db.all('SELECT * FROM "sessions"');
  if (rows === null) return out;
  for (const row of rows) {
    const id = pickString(row, ['session_id', 'sessionId', 'id']);
    if (id === undefined) continue;
    // 子代理 / 团队会话：消息写在主会话目录内，不单独成会话
    const isSubagent = (cols.includes('is_subagent') && row['is_subagent'] === 1)
      || pickString(row, ['agent_id', 'agentId', 'parent_session_id', 'parentSessionId']) !== undefined;
    const metaRaw = pickString(row, ['metadata_json', 'metadataJson']);
    let title = '';
    if (metaRaw !== undefined) {
      try {
        const meta: unknown = JSON.parse(metaRaw);
        if (isRecord(meta) && typeof meta['title'] === 'string') title = meta['title'];
      } catch {
        // 畸形 metadata_json 只丢标题，不影响其余列
      }
    }
    const cwd = pickString(row, ['cwd', 'workspace_root', 'workspaceRoot']);
    const createdAt = pickTime(row, ['started_at', 'startedAt']);
    out.set(id, {
      ...(cwd !== undefined ? { cwd } : {}),
      title,
      ...(createdAt !== undefined ? { createdAt } : {}),
      isSubagent,
    });
  }
  return out;
}

async function readClineModern(
  platform: ForeignPlatform,
  root: string,
  dirName: string,
  findings: ForeignSkip[],
  dbIndex: ReadonlyMap<string, ClineDbEntry>,
  counts: Record<string, number>,
): Promise<ClineSessionFile | undefined> {
  const dir = joinFor(platform, root, dirName);
  const names = await listFileNames(dir);
  // 规范转写恒为 <sessionId>/<sessionId>.messages.json；目录里的其它 <agentId>.messages.json
  // 是子代理/团队消息（靠文件内 agent 字段区分），不是主线会话
  const canonical = dirName + '.messages.json';
  const messagesName = names.find((n) => n === canonical);
  const subagentFiles = names.filter((n) => n !== canonical && n.endsWith('.messages.json'));
  if (subagentFiles.length > 0) irBump(counts, 'subagent-files', subagentFiles.length);
  if (messagesName === undefined) {
    if (subagentFiles.length > 0) {
      findings.push({ code: 'source-unreadable', origin: dirName, detail: 'subagent-messages-only' });
    }
    return undefined;
  }
  const sessionId = dirName;
  if (dbIndex.get(sessionId)?.isSubagent === true) {
    irBump(counts, 'subagent-sessions');
    return undefined;
  }
  const containerRead = await readJsonSafe(joinFor(platform, dir, messagesName), MAX_FILE_BYTES);
  if (!containerRead.ok) {
    findings.push({ code: 'source-unreadable', origin: sessionId, detail: 'messages-' + containerRead.problem });
    return undefined;
  }
  // 契约里的 agent 字段：'lead' 才是主线；subagent / teammate 不单独成会话
  if (isRecord(containerRead.value)) {
    const agent = containerRead.value['agent'];
    if (typeof agent === 'string' && agent !== '' && agent !== 'lead') {
      irBump(counts, 'subagent-sessions');
      return undefined;
    }
  }
  const metaRead = await readJsonSafe(joinFor(platform, dir, dirName + '.json'), MAX_FILE_BYTES);
  if (!metaRead.ok && metaRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: sessionId, detail: 'meta-' + metaRead.problem });
  }
  const ignored: Record<string, number> = {};
  if (names.some((n) => n.endsWith('.compaction.json'))) irBump(ignored, 'compaction');
  const messages = recordsFromMessages(containerRead.value, ignored);
  // 元数据权威序：DB 索引 > manifest；cwd 只认这两处（绝不从消息正文深搜）
  const dbEntry = dbIndex.get(sessionId);
  const manifest = metaRead.ok ? metaRead.value : undefined;
  const title = dbEntry !== undefined && dbEntry.title !== '' ? dbEntry.title : clineTitleOf(manifest);
  return finish(
    sessionId,
    'modern',
    messages,
    ignored,
    dbEntry?.cwd ?? clineCwdOf(manifest, platform),
    title,
    irEarlier(dbEntry?.createdAt, clineTimeOf(manifest)),
  );
}

/**
 * legacy 任务索引：**`<legacyRoot>/state/taskHistory.json`**（tasks/ 的兄弟目录），
 * 是一个任务条目数组（旧代码错读成 `tasks/<id>/state/taskHistory.json` → cwd/标题/时间永远取不到）。
 */
async function readClineLegacyIndex(
  platform: ForeignPlatform,
  legacyRoot: string,
): Promise<Map<string, Record<string, unknown>>> {
  const index = new Map<string, Record<string, unknown>>();
  const read = await readJsonSafe(joinFor(platform, legacyRoot, 'state', 'taskHistory.json'), MAX_FILE_BYTES);
  if (!read.ok || !Array.isArray(read.value)) return index;
  for (const item of read.value) {
    if (!isRecord(item)) continue;
    const id = item['id'];
    if (typeof id === 'string' && id !== '') index.set(id, item);
  }
  return index;
}

/** ui_messages.json 只做**标题兜底**：它是显示用消息（say/ask），不是权威转写 */
function clineUiTitle(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (str(item['say']) !== 'user_feedback') continue;
    const text = str(item['text']);
    if (text !== undefined) return text.slice(0, 200);
  }
  return undefined;
}

async function readClineLegacy(
  platform: ForeignPlatform,
  legacyRoot: string,
  taskId: string,
  findings: ForeignSkip[],
  historyIndex: ReadonlyMap<string, Record<string, unknown>>,
): Promise<ClineSessionFile | undefined> {
  const dir = joinFor(platform, joinFor(platform, legacyRoot, 'tasks'), taskId);
  const names = await listFileNames(dir);
  const historyName = names.find((n) => n === 'api_conversation_history.json');
  const uiName = names.find((n) => n === 'ui_messages.json');
  const label = taskId;
  if (historyName === undefined) {
    // 没有 API 历史就没有转写：ui_messages.json（type:"ask" 等显示消息）绝不能当对话正文
    findings.push({ code: 'source-unreadable', origin: label, detail: 'legacy-history-missing' });
    return undefined;
  }
  const containerRead = await readJsonSafe(joinFor(platform, dir, historyName), MAX_FILE_BYTES);
  if (!containerRead.ok) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'legacy-' + containerRead.problem });
    return undefined;
  }
  const ignored: Record<string, number> = {};
  if (uiName !== undefined) irBump(ignored, 'cline:ui-messages-not-read');
  const messages = recordsFromMessages(containerRead.value, ignored);
  // cwd 只认索引的 cwdOnTaskInitialization；标题取索引 task、空则 ui_messages 兜底；时间取索引 ts
  const item = historyIndex.get(taskId);
  let title = clineTitleOf(item);
  if (title === undefined && uiName !== undefined) {
    const uiRead = await readJsonSafe(joinFor(platform, dir, uiName), MAX_FILE_BYTES);
    if (uiRead.ok) title = clineUiTitle(uiRead.value);
  }
  return finish(
    taskId,
    'legacy',
    messages,
    ignored,
    clineCwdOf(item, platform),
    title,
    clineTimeOf(item),
  );
}

/** 读全部 Cline 会话（现代根 + 最多三个 legacy 根；同 id 先到先得） */
export async function readCline(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<ClineSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const roots = resolveClineRoots(opts);
  const findings: ForeignSkip[] = [];
  const files: ClineSessionFile[] = [];
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  const maxFiles = opts.maxFiles ?? MAX_SESSIONS;
  let truncated = false;
  const push = (file: ClineSessionFile | undefined): void => {
    if (file === undefined || seen.has(file.id)) return;
    seen.add(file.id);
    files.push(file);
  };

  // 权威元数据索引（可选）：读不到/非 cline 库只是回退 manifest，不改变会话枚举面
  let dbIndex: Map<string, ClineDbEntry> = new Map();
  if (roots.db !== undefined && await isFile(roots.db)) {
    const opened = await openSqliteReadOnlyEx(roots.db);
    if (opened.db !== null) {
      const db = opened.db;
      try {
        dbIndex = readClineDbIndex(db);
      } finally {
        db.close();
      }
    }
  }

  const modernDirs = await listDirNames(roots.modern);
  for (const dirName of modernDirs) {
    if (files.length >= maxFiles) { truncated = true; break; }
    push(await readClineModern(platform, roots.modern, dirName, findings, dbIndex, counts));
  }
  if (!truncated) {
    for (const legacyRoot of roots.legacy) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const tasksRoot = joinFor(platform, legacyRoot, 'tasks');
      const tasksStat = await statOrNull(tasksRoot);
      if (tasksStat === null || !tasksStat.isDirectory()) continue;
      const historyIndex = await readClineLegacyIndex(platform, legacyRoot);
      for (const taskId of await listDirNames(tasksRoot)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        push(await readClineLegacy(platform, legacyRoot, taskId, findings, historyIndex));
      }
    }
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'cline', detail: 'max-sessions-reached', count: maxFiles });
  }
  return {
    files,
    readFindings: findings,
    extraCounts: {
      'cline.modernDirs': modernDirs.length,
      'cline.legacyRoots': roots.legacy.length,
      ...prefixCounts('cline', counts),
    },
  };
}
