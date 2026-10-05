/**
 * Cline 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 cline 行）。
 *
 * 布局（chat-import discovery.mjs:47-78,148-154,2094；read-vault §10.1 cline 两行；read-sessions-manager 第 21 行）：
 *   现代：<dataDir>/sessions/<sessionId>/{<id>.json, <id>.messages.json, <id>.compaction.json}
 *         <dataDir> = $CLINE_SESSION_DATA_DIR（直接用）| $CLINE_DATA_DIR + '/sessions'
 *                     | ($CLINE_DIR | <home>/.cline) + '/data/sessions'
 *   遗留：<legacyRoot>/tasks/<taskId>/{api_conversation_history.json, ui_messages.json, state/taskHistory.json}
 *         <legacyRoot> = $CLINE_LEGACY_GLOBAL_STORAGE_DIR | $CLINE_VSCODE_GLOBAL_STORAGE_DIR（命中即**只此一根**）
 *                       | {Code, Code - Insiders, VSCodium} × VS Code User 根 + '/globalStorage/saoudrizwan.claude-dev'
 *
 * 平台纪律：三分支逐字对齐 chat-import 的 clineLegacyStorageDirs（win32 = %APPDATA%、
 * darwin = ~/Library/Application Support、linux = $XDG_CONFIG_HOME|~/.config），**全部经 joinFor**。
 *
 * 归一纪律：消息映射是**容错**的（role / say|ask / text|content 三形态并存），不认识的记录类型
 * **逐类计数**（进 `ignored` → 下游 unsupported-session-record），绝不静默丢；cwd 只认源里的
 * 明文字段（找不到就落 session-missing-cwd，**绝不猜**）。
 */
import { envValue, isAbsoluteFor, joinFor, normalizePlatform, vscodeUserDataDir } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { listDirNames, listFileNames, readJsonSafe, statOrNull } from './session-read.ts';
import { firstUserText, genericBlocksOf } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irEarlier, irBump, irSafeTime } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const CLINE_EXTENSION_DIR = 'saoudrizwan.claude-dev';
export const CLINE_DEFAULT_DIR = '.cline';
/** 遗留 VS Code globalStorage 的三个编辑器名（chat-import discovery.mjs:61-78 逐字） */
export const CLINE_LEGACY_EDITORS: readonly string[] = ['Code', 'Code - Insiders', 'VSCodium'];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 5000;
const CWD_DEPTH = 5;

const CWD_KEYS: readonly string[] = [
  'cwd', 'cwdOnTaskInitialization', 'workspacePath', 'workspace', 'worktree', 'worktreePath',
  'projectPath', 'directory', 'path',
];
const TITLE_KEYS: readonly string[] = ['task', 'title', 'summary', 'name'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'timestamp', 'ts', 'startTime', 'time'];

export interface ClineRoots {
  readonly modern: string;
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
  let modernFrom: ClineRoots['modernFrom'];
  if (sessionDataDir !== undefined) {
    modern = sessionDataDir;
    modernFrom = 'CLINE_SESSION_DATA_DIR';
  } else if (dataDir !== undefined) {
    modern = joinFor(platform, dataDir, 'sessions');
    modernFrom = 'CLINE_DATA_DIR';
  } else {
    modern = joinFor(platform, clineDir, 'data', 'sessions');
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
  return { modern, legacy, clineDir, modernFrom, legacyFrom };
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

/** 深度受限的 cwd 搜索（键名白名单 + **目标平台绝对路径**双重过滤：'path' 这种泛键也不会误命中） */
export function clineCwdOf(value: unknown, platform: ForeignPlatform): string | undefined {
  const visit = (node: unknown, depth: number): string | undefined => {
    if (depth > CWD_DEPTH || !isRecord(node)) return undefined;
    for (const key of CWD_KEYS) {
      const candidate = node[key];
      if (typeof candidate === 'string' && isAbsoluteFor(platform, candidate)) return candidate;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          const found = visit(item, depth + 1);
          if (found !== undefined) return found;
        }
        continue;
      }
      const found = visit(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function firstTimeDeep(value: unknown, keys: readonly string[]): number | undefined {
  let found: number | undefined;
  const visit = (node: unknown, depth: number): void => {
    if (depth > CWD_DEPTH || found !== undefined || !isRecord(node)) return;
    for (const key of keys) {
      const t = irSafeTime(node[key]);
      if (t !== undefined) { found = t; return; }
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

function firstTitleDeep(value: unknown): string | undefined {
  let found: string | undefined;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 2 || found !== undefined || !isRecord(node)) return;
    for (const key of TITLE_KEYS) {
      const v = str(node[key]);
      if (v !== undefined) { found = v.slice(0, 200); return; }
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
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
    if (lower === 'say' && sub === 'user_feedback') return 'user';
    if (sub !== '' && sub !== 'text') {
      // 非文本的 say/ask（api_req_started / checkpoint_created / command / completion_result …）
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

async function readClineModern(
  platform: ForeignPlatform,
  root: string,
  dirName: string,
  findings: ForeignSkip[],
): Promise<ClineSessionFile | undefined> {
  const dir = joinFor(platform, root, dirName);
  const names = await listFileNames(dir);
  const messagesName = names.find((n) => n === dirName + '.messages.json')
    ?? names.find((n) => n.endsWith('.messages.json'));
  const stem = messagesName === undefined ? dirName : messagesName.slice(0, messagesName.length - '.messages.json'.length);
  const sessionId = stem !== '' ? stem : dirName;
  const label = sessionId;
  const metaPath = joinFor(platform, dir, stem + '.json');
  const metaRead = await readJsonSafe(metaPath, MAX_FILE_BYTES);
  if (!metaRead.ok && metaRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-' + metaRead.problem });
  }
  const containerRead = await readJsonSafe(
    joinFor(platform, dir, messagesName ?? stem + '.json'),
    MAX_FILE_BYTES,
  );
  if (!containerRead.ok) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'messages-' + containerRead.problem });
    return undefined;
  }
  const ignored: Record<string, number> = {};
  if (names.some((n) => n.endsWith('.compaction.json'))) irBump(ignored, 'compaction');
  const messages = recordsFromMessages(containerRead.value, ignored);
  const metaValue = metaRead.ok ? metaRead.value : undefined;
  return finish(
    sessionId,
    'modern',
    messages,
    ignored,
    clineCwdOf(metaValue, platform) ?? clineCwdOf(containerRead.value, platform),
    firstTitleDeep(metaValue),
    irEarlier(firstTimeDeep(metaValue, TIME_KEYS), firstTimeDeep(containerRead.value, TIME_KEYS)),
  );
}

async function readClineLegacy(
  platform: ForeignPlatform,
  legacyRoot: string,
  taskId: string,
  findings: ForeignSkip[],
): Promise<ClineSessionFile | undefined> {
  const tasksRoot = joinFor(platform, legacyRoot, 'tasks');
  const dir = joinFor(platform, tasksRoot, taskId);
  const names = await listFileNames(dir);
  const historyName = names.find((n) => n === 'api_conversation_history.json');
  const uiName = names.find((n) => n === 'ui_messages.json');
  const containerName = historyName ?? uiName;
  const label = taskId;
  if (containerName === undefined) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'legacy-history-missing' });
    return undefined;
  }
  const containerRead = await readJsonSafe(joinFor(platform, dir, containerName), MAX_FILE_BYTES);
  if (!containerRead.ok) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'legacy-' + containerRead.problem });
    return undefined;
  }
  const stateRead = await readJsonSafe(joinFor(platform, dir, 'state', 'taskHistory.json'), MAX_FILE_BYTES);
  if (!stateRead.ok && stateRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'legacy-state-' + stateRead.problem });
  }
  const ignored: Record<string, number> = {};
  if (historyName !== undefined && uiName !== undefined) irBump(ignored, 'cline:ui-messages-not-read');
  const messages = recordsFromMessages(containerRead.value, ignored);
  const stateValue = stateRead.ok ? stateRead.value : undefined;
  return finish(
    taskId,
    'legacy',
    messages,
    ignored,
    clineCwdOf(stateValue, platform) ?? clineCwdOf(containerRead.value, platform),
    firstTitleDeep(stateValue),
    irEarlier(firstTimeDeep(stateValue, TIME_KEYS), firstTimeDeep(containerRead.value, TIME_KEYS)),
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
  const maxFiles = opts.maxFiles ?? MAX_SESSIONS;
  let truncated = false;
  const push = (file: ClineSessionFile | undefined): void => {
    if (file === undefined || seen.has(file.id)) return;
    seen.add(file.id);
    files.push(file);
  };
  const modernDirs = await listDirNames(roots.modern);
  for (const dirName of modernDirs) {
    if (files.length >= maxFiles) { truncated = true; break; }
    push(await readClineModern(platform, roots.modern, dirName, findings));
  }
  if (!truncated) {
    for (const legacyRoot of roots.legacy) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const tasksRoot = joinFor(platform, legacyRoot, 'tasks');
      const tasksStat = await statOrNull(tasksRoot);
      if (tasksStat === null || !tasksStat.isDirectory()) continue;
      for (const taskId of await listDirNames(tasksRoot)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        push(await readClineLegacy(platform, legacyRoot, taskId, findings));
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
    extraCounts: { 'cline.modernDirs': modernDirs.length, 'cline.legacyRoots': roots.legacy.length },
  };
}
