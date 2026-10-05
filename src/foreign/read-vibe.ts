/**
 * Vibe 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 vibe 行）。
 *
 * 布局（read-vault §10.1 vibe 行 + chat-import sources/vibe.mjs:37-49，**以 chat-import 为准**）：
 *   <vibeHome>/logs/session/session_<ts>_<shortId>/{meta.json, messages.jsonl}
 *   根 = $VIBE_HOME（**追加**，不是替换）|| <home>/.vibe   ← 两根**并存**，只取一根会漏扫
 *
 * 交叉核对记录（与 PLAN-B 草稿的差异）：草稿把 vibe 标成「VS Code User 根」并挂起「SQLite?」——
 * 那是 captain 表格的笔误；chat-import §3.1、read-vault §10.1、read-sessions-manager §表中第 28 行
 * 三份都说「VS Code（`~/.vibe`，**无平台分支**）+ messages.jsonl 目录源」，且 $VIBE_HOME 是追加语义
 * （read-vault §10.3-3 专门点出与 continue 的替换语义不同）。本实现按 chat-import。
 */
import { envValue, joinFor, normalizePlatform } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { listDirNames, readJsonSafe, readTextSafe, statOrNull } from './session-read.ts';
import { parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome } from './session-source.ts';
import { irEarlier, irSafeTime } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const VIBE_HOME_ENV = 'VIBE_HOME';
export const VIBE_DEFAULT_DIR = '.vibe';
export const VIBE_LOG_SEGMENTS: readonly string[] = ['logs', 'session'];
export const VIBE_SESSION_DIR_PREFIX = 'session_';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_DIRS = 5000;

const CWD_KEYS: readonly string[] = [
  'cwd', 'workdir', 'workingDirectory', 'working_directory', 'workspace', 'workspacePath', 'projectPath', 'directory',
];
const TITLE_KEYS: readonly string[] = ['title', 'summary', 'name', 'topic', 'task'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'startTime', 'startedAt', 'timestamp', 'time'];

/** 静态探测位置（**两根并存**：$VIBE_HOME 根 + ~/.vibe 根；去重但不丢任一根） */
export function vibeSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const out: string[] = [];
  const explicit = envValue(opts.env, VIBE_HOME_ENV);
  if (explicit !== undefined) out.push(joinFor(platform, explicit, ...VIBE_LOG_SEGMENTS));
  const fallback = joinFor(platform, opts.homeDir, VIBE_DEFAULT_DIR, ...VIBE_LOG_SEGMENTS);
  if (!out.includes(fallback)) out.push(fallback);
  return out;
}

/** 一条已归一的会话文件（`ParsedTranscript` + 源侧 id，draftOf 直接透传） */
export interface VibeSessionFile extends ParsedTranscript { readonly id: string }

function firstStringIn(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function firstTimeIn(rec: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const t = irSafeTime(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 目录名 `session_<ts>_<shortId>` 里的时间戳（毫秒安全整数才采信）。
 * 这是**布局自证的元数据**（不是从内容猜 cwd），meta.json 缺时间时用它兜底。
 */
export function vibeTimeFromDirName(name: string): number | undefined {
  if (!name.startsWith(VIBE_SESSION_DIR_PREFIX)) return undefined;
  const rest = name.slice(VIBE_SESSION_DIR_PREFIX.length);
  const sep = rest.indexOf('_');
  const head = sep < 0 ? rest : rest.slice(0, sep);
  if (!/^[0-9]{10,16}$/.test(head)) return undefined;
  const ts = Number(head);
  return Number.isSafeInteger(ts) ? ts : undefined;
}

async function readVibeSession(
  platform: ForeignPlatform,
  root: string,
  dirName: string,
  findings: ForeignSkip[],
): Promise<VibeSessionFile | undefined> {
  const dir = joinFor(platform, root, dirName);
  const label = dirName; // 位置标签只用会话目录名（绝不回传机器路径）
  const metaPath = joinFor(platform, dir, 'meta.json');
  const messagesPath = joinFor(platform, dir, 'messages.jsonl');

  const metaRead = await readJsonSafe(metaPath, MAX_FILE_BYTES);
  let meta: Record<string, unknown> | undefined;
  if (metaRead.ok) {
    if (isRecord(metaRead.value)) meta = metaRead.value;
    else findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-not-object' });
  } else if (metaRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-' + metaRead.problem });
  }

  const st = await statOrNull(messagesPath);
  if (st === null || !st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'messages-missing' });
    return undefined;
  }
  const text = await readTextSafe(messagesPath, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: st.size > MAX_FILE_BYTES ? 'messages-too-large' : 'messages-read-error',
    });
    return undefined;
  }
  const parsed = parseGenericJsonl(text);
  const metaCwd = meta === undefined ? undefined : firstStringIn(meta, CWD_KEYS);
  const metaTitle = meta === undefined ? undefined : firstStringIn(meta, TITLE_KEYS);
  const createdAt = irEarlier(
    meta === undefined ? undefined : firstTimeIn(meta, TIME_KEYS),
    parsed.createdAt ?? vibeTimeFromDirName(dirName),
  );
  return {
    id: dirName,
    cwd: metaCwd,
    createdAt,
    title: metaTitle === undefined ? parsed.title : metaTitle.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
  };
}

/** 读全部 vibe 会话（两根；只收 `session_` 前缀的目录，绝不把日志目录本身当会话） */
export async function readVibe(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<VibeSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const findings: ForeignSkip[] = [];
  const maxFiles = opts.maxFiles ?? MAX_SESSION_DIRS;
  const files: VibeSessionFile[] = [];
  const seen = new Set<string>();
  let dirs = 0;
  let truncated = false;
  for (const root of vibeSessionRoots(opts)) {
    for (const dirName of await listDirNames(root)) {
      if (!dirName.startsWith(VIBE_SESSION_DIR_PREFIX)) continue;
      if (files.length >= maxFiles) { truncated = true; break; }
      dirs += 1;
      const file = await readVibeSession(platform, root, dirName, findings);
      if (file === undefined || seen.has(file.id)) continue;
      seen.add(file.id);
      files.push(file);
    }
    if (truncated) break;
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'vibe', detail: 'max-sessions-reached', count: maxFiles });
  }
  return { files, readFindings: findings, extraCounts: { 'vibe.sessionDirs': dirs } };
}
