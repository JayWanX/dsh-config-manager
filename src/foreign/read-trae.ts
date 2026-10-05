/**
 * Trae 会话读盘层 —— 档 B「VS Code 多发行版」来源（真值表见 truth-table.ts 的 trae 行）。
 *
 * 数据根（read-vault §10.1 trae 行 + chat-import discovery.mjs:80-93,140 + read-sessions-manager 第 27 行，
 * **三份逐字一致**）：VS Code User 根 × 4 个发行版名 × 三分支
 *   win32  = %APPDATA%/<name>/User
 *   darwin = <home>/Library/Application Support/<name>/User
 *   linux  = $XDG_CONFIG_HOME|<home>/.config>/<name>/User
 *   name ∈ {Trae, Trae CN, TRAE SOLO CN, TRAE SOLO}
 * 全部经 `vscodeUserDataDir(platform, …)`（内部走 roamingAppDataDir + joinFor），**绝不硬编码分隔符**。
 *
 * 存储形态：三份调研一致确认是 **SQLite `state.vscdb`**（<User>/globalStorage/state.vscdb 与
 * <User>/workspaceStorage/<hash>/state.vscdb，表 ItemTable）。⇒ **本批按 SQLite 读**（复用 sqlite.ts
 * 的只读读器；captain 表格里的「文件」标注与 chat-import §3.1 冲突，**以 chat-import 为准**并已记入汇报）。
 *
 * 诚实边界（必须说明，不得美化）：
 *  · `ItemTable` 的键确证的只有 `memento/icube-ai-agent-storage` 一条（chat-import §3.1）；
 *    另有「4 个回退键」但**四份报告都没给出键名** —— 本实现用保守的键名模式（含 icube；或含
 *    trae 且含 chat/agent/session/storage）作为候选，并把「有候选键但解析不出会话」如实报成
 *    `sessions-not-migrated`，绝不假装成功。
 *  · 会话容器的字段级 schema **未取证**：本层用**结构自证**的窄口径（必须有「消息数组 + 至少一条
 *    带 role/type 的消息」）识别会话，容器必须自带字符串 id（否则铸稳定兜底 id）；cwd 只认明文
 *    绝对路径字段，找不到就交给下游落 session-missing-cwd（**绝不猜 cwd**）。
 */
import { isAbsoluteFor, joinFor, normalizePlatform, vscodeUserDataDir } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { isFile, listDirNames, statOrNull } from './session-read.ts';
import { genericBlocksOf } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irBump, irSafeTime, isSafeIrId } from './session-ir.ts';
import { cellBytes, cellText, openSqliteIfShape, sqliteCapability } from './sqlite.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

/** 四个发行版名（顺序 = chat-import traeUserDataDirs 的判定顺序） */
export const TRAE_PRODUCTS: readonly string[] = ['Trae', 'Trae CN', 'TRAE SOLO CN', 'TRAE SOLO'];
export const TRAE_VSCDB_NAME = 'state.vscdb';
export const TRAE_STORAGE_SUBDIRS: readonly string[] = ['globalStorage', 'workspaceStorage'];

const MAX_SESSIONS = 5000;
const MAX_NODES = 50000;
const MAX_DEPTH = 8;

const MESSAGE_ARRAY_KEYS: readonly string[] = [
  'messages', 'conversation', 'history', 'chat', 'turns', 'dialogue', 'items', 'records',
];
const ID_KEYS: readonly string[] = [
  'id', 'sessionId', 'session_id', 'chatId', 'chat_id', 'conversationId', 'conversation_id', 'uuid', 'key',
];
const CWD_KEYS: readonly string[] = [
  'cwd', 'workspace', 'workspacePath', 'workspace_path', 'projectPath', 'workingDirectory', 'directory',
  'folder', 'rootPath', 'path',
];
const TITLE_KEYS: readonly string[] = ['title', 'name', 'summary', 'topic'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'createTime', 'create_time', 'timestamp', 'startTime', 'time'];

/** 静态探测位置 = 4 个 User 目录（state.vscdb 在读取期动态枚举，探测期只 stat 目录） */
export function traeUserDataDirs(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  return TRAE_PRODUCTS.map((product) => vscodeUserDataDir(platform, opts.homeDir, opts.env, product));
}

export function traeProbePaths(opts: RootProbeOptions): string[] {
  return traeUserDataDirs(opts);
}

/** 一条已归一的会话（从 ParsedTranscript 派生 + 源侧 id） */
export interface TraeSessionFile extends ParsedTranscript { readonly id: string }

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * 聊天存储键的**候选**判定（保守）。
 * 已确证的键：`memento/icube-ai-agent-storage`；未确证的回退键用模式兜住，
 * **不把它们当成「一定正确」** —— 解析不出内容就走 sessions-not-migrated。
 */
export function isTraeChatStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.includes('icube')) return true;
  return lower.includes('trae')
    && (lower.includes('chat') || lower.includes('agent') || lower.includes('session') || lower.includes('storage'));
}

function isAbsoluteCwd(v: unknown, platform: ForeignPlatform): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return isAbsoluteFor(platform, v) ? v : undefined;
}

function cwdOf(node: Record<string, unknown>, platform: ForeignPlatform): string | undefined {
  for (const key of CWD_KEYS) {
    const found = isAbsoluteCwd(node[key], platform);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstOf(node: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = str(node[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function timeOf(node: Record<string, unknown>): number | undefined {
  for (const key of TIME_KEYS) {
    const t = irSafeTime(node[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** 结构自证：数组里**至少一条**带角色字段的记录，才把它当消息数组（挡住任意字符串数组） */
function messageArrayOf(node: Record<string, unknown>): unknown[] | undefined {
  for (const key of MESSAGE_ARRAY_KEYS) {
    const candidate = node[key];
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    for (const item of candidate) {
      if (!isRecord(item)) continue;
      if (str(item['role']) !== undefined || str(item['type']) !== undefined
        || str(item['sender']) !== undefined || item['author'] !== undefined) return candidate;
    }
  }
  return undefined;
}

function roleOfItem(item: Record<string, unknown>, ignored: Record<string, number>): 'user' | 'assistant' | undefined {
  const author = item['author'];
  const rawRole = str(item['role'])
    ?? (isRecord(author) ? str(author['role']) : undefined)
    ?? str(item['sender'])
    ?? str(item['type']);
  if (rawRole === undefined) {
    irBump(ignored, 'trae:no-role');
    return undefined;
  }
  const lower = rawRole.toLowerCase();
  if (lower === 'user' || lower === 'human' || lower === 'user_message' || lower === 'ask') return 'user';
  if (lower === 'assistant' || lower === 'ai' || lower === 'model' || lower === 'bot' || lower === 'say') return 'assistant';
  irBump(ignored, 'trae:role-' + lower);
  return undefined;
}

interface RawSession {
  readonly id: string;
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly createdAt?: number | undefined;
  readonly records: readonly TranscriptRecord[];
  readonly raw: number;
  readonly ignored: Readonly<Record<string, number>>;
}

function recordsOf(items: readonly unknown[], ignored: Record<string, number>): { records: TranscriptRecord[]; raw: number } {
  const records: TranscriptRecord[] = [];
  let raw = 0;
  for (const item of items) {
    raw += 1;
    if (!isRecord(item)) { irBump(ignored, 'trae:non-object-item'); continue; }
    const role = roleOfItem(item, ignored);
    if (role === undefined) continue;
    const content = item['content'] ?? item['text'] ?? item['message'] ?? item['parts'];
    const blocks = genericBlocksOf(content, ignored, 'trae-block');
    if (blocks.length === 0) { irBump(ignored, 'trae:no-content'); continue; }
    const time = timeOf(item);
    const id = firstOf(item, ['id', 'messageId', 'message_id']);
    records.push({
      role,
      blocks,
      ...(time !== undefined ? { time } : {}),
      ...(id !== undefined ? { id } : {}),
    });
  }
  return { records, raw };
}

/** 键名 → 安全 id 片段（兜底铸 id 用；非白名单字符一律换成 '-'） */
function safeFragment(key: string): string {
  let out = '';
  for (const ch of key) out += /[A-Za-z0-9._-]/.test(ch) ? ch : '-';
  return out.length > 64 ? out.slice(0, 64) : out;
}

/**
 * 从一个 ItemTable 值里**结构自证**地抽出会话容器。
 *
 * 判据（全部满足才认）：① 是对象；② 有消息数组且至少一条带角色字段；③ 有字符串 id（否则铸稳定兜底 id）。
 * 不满足的节点只**继续下钻**（不计数 —— 存储值里绝大多数是 UI 状态）；满足的节点不再下钻（避免重复计数）。
 */
export function traeSessionsOfValue(value: unknown, storageKey: string, platform: ForeignPlatform): RawSession[] {
  const out: RawSession[] = [];
  const seenIds = new Set<string>();
  let nodes = 0;
  const visit = (node: unknown, depth: number, fallbackId: string): void => {
    if (depth > MAX_DEPTH || nodes > MAX_NODES || !isRecord(node)) return;
    nodes += 1;
    const messages = messageArrayOf(node);
    if (messages !== undefined) {
      const ignored: Record<string, number> = {};
      const rawId = firstOf(node, ID_KEYS);
      const id = rawId !== undefined && isSafeIrId(rawId) ? rawId : fallbackId;
      const parsed = recordsOf(messages, ignored);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        out.push({
          id,
          cwd: cwdOf(node, platform),
          title: firstOf(node, TITLE_KEYS)?.slice(0, 200) ?? '',
          createdAt: timeOf(node),
          records: parsed.records,
          raw: parsed.raw,
          ignored,
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        let index = 0;
        for (const item of child) {
          if (isRecord(item)) visit(item, depth + 1, safeFragment(storageKey) + '-' + String(index));
          index += 1;
        }
        continue;
      }
      if (isRecord(child)) visit(child, depth + 1, safeFragment(storageKey) + '-' + safeFragment(key));
    }
  };
  visit(value, 0, safeFragment(storageKey));
  return out;
}

/** 一个 User 根下的 state.vscdb 位置（globalStorage 一个 + workspaceStorage/<hash> 各一个） */
export async function traeVscdbPaths(userDir: string, platform: ForeignPlatform): Promise<string[]> {
  const out: string[] = [];
  for (const sub of TRAE_STORAGE_SUBDIRS) {
    const base = joinFor(platform, userDir, sub);
    const st = await statOrNull(base);
    if (st === null || !st.isDirectory()) continue;
    if (sub === 'globalStorage') {
      const db = joinFor(platform, base, TRAE_VSCDB_NAME);
      if (await isFile(db)) out.push(db);
      continue;
    }
    for (const hashDir of await listDirNames(base)) {
      const db = joinFor(platform, base, hashDir, TRAE_VSCDB_NAME);
      if (await isFile(db)) out.push(db);
    }
  }
  return out;
}

/**
 * 读 Trae 会话。
 *
 * SQLite 能力缺失时**不再尝试**（如实报 source-unreadable 的 detail=sqlite-module-unavailable），
 * 而不是静默返回空 —— 那会与「未安装 Trae」混淆（t5 明文要求两者可区分）。
 */
export async function readTrae(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<TraeSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const findings: ForeignSkip[] = [];
  const files: TraeSessionFile[] = [];
  const seen = new Set<string>();
  const maxFiles = opts.maxFiles ?? MAX_SESSIONS;

  const capability = await sqliteCapability();
  if (!capability.available) {
    return {
      files: [],
      readFindings: [{ code: 'source-unreadable', origin: 'trae', detail: 'sqlite-' + String(capability.reason) }],
      extraCounts: { 'trae.vscdb': 0 },
    };
  }

  const dbs: string[] = [];
  for (const userDir of traeUserDataDirs(opts)) {
    dbs.push(...await traeVscdbPaths(userDir, platform));
  }
  let candidateKeys = 0;
  let truncated = false;
  for (const dbPath of dbs) {
    if (files.length >= maxFiles) { truncated = true; break; }
    const db = await openSqliteIfShape(dbPath, { ItemTable: ['key'] });
    if (db === null) {
      // 打开失败与「库形状不对」都必须可见（detail 用于区分；绝不静默当成空）
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'itemtable-open-or-shape-failed' });
      continue;
    }
    const rows = db.all('SELECT key, value FROM ItemTable');
    if (rows === null) {
      findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'itemtable-read-failed' });
      db.close();
      continue;
    }
    for (const row of rows) {
      const key = cellText(row, 'key');
      if (key === undefined || !isTraeChatStorageKey(key)) continue;
      candidateKeys += 1;
      const bytes = cellBytes(row, 'value');
      if (bytes === undefined) {
        findings.push({ code: 'source-unreadable', origin: key, detail: 'item-value-not-bytes' });
        continue;
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        findings.push({ code: 'source-unreadable', origin: key, detail: 'item-json-error' });
        continue;
      }
      for (const raw of traeSessionsOfValue(parsedValue, key, platform)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        files.push({
          id: raw.id,
          cwd: raw.cwd,
          createdAt: raw.createdAt,
          title: raw.title,
          records: raw.records,
          raw: raw.raw,
          bad: 0,
          ignored: raw.ignored,
        });
      }
    }
    db.close();
    if (truncated) break;
  }
  const extraSkips: ForeignSkip[] = [];
  if (files.length === 0 && candidateKeys === 0 && dbs.length > 0) {
    extraSkips.push({ code: 'sessions-not-migrated', origin: 'trae', detail: 'chat-storage-key-not-found' });
  } else if (files.length === 0 && candidateKeys > 0) {
    extraSkips.push({ code: 'sessions-not-migrated', origin: 'trae', detail: 'no-session-container', count: candidateKeys });
  }
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'trae', detail: 'max-sessions-reached', count: maxFiles });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    files,
    readFindings: findings,
    extraSkips,
    extraCounts: { 'trae.vscdb': dbs.length, 'trae.chatStorageKeys': candidateKeys },
  };
}
