/**
 * Grok Build（grokbuild）会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 grokbuild 行）。
 *
 * 布局（四份调研交叉核对，**有出入以 chat-import §3.1 为准**）：
 *   <grokHome>/sessions/<encodeURIComponent(cwd)>/<sessionId>/{summary.json, chat_history.jsonl}
 *   <grokHome>/archived_sessions/...   ← **双根**（chat-import discovery.mjs:132；read-vault §10.2 同）
 *   <grokHome> = $GROK_HOME（非空即**替换**）|| <home>/.grok
 *
 * 三条实现纪律：
 *  ① 路径函数**显式收 platform**（joinFor），绝不用运行平台的分隔符 —— Windows 真值必须在
 *     macOS/Linux 的 CI 上也能断言（platform-paths.ts 文件头）；
 *  ② cwd 取值顺序 = summary.json 的明文字段 → **目录名的 encodeURIComponent 逆变换**
 *     （该编码可逆、是布局自证的事实，不是「猜」；两者都没有才落 session-missing-cwd）；
 *  ③ 读不到一律进 readFindings（稳定机器码），**绝不抛、绝不静默**。
 */
import { envValue, isAbsoluteFor, joinFor, normalizePlatform } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { listDirNames, readJsonSafe, readTextSafe, statOrNull } from './session-read.ts';
import { parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome } from './session-source.ts';
import { irEarlier, irSafeTime } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const GROK_HOME_ENV = 'GROK_HOME';
export const GROK_DEFAULT_HOME_DIR = '.grok';
/** 双根：chat-import 的注释点名「归档目录此前未纳入默认根，其下的 rollout 完全扫不到」 */
export const GROK_SESSION_SUBDIRS: readonly string[] = ['sessions', 'archived_sessions'];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_DIRS = 5000;

const CWD_KEYS: readonly string[] = [
  'cwd', 'workdir', 'workingDirectory', 'working_directory', 'workspace', 'workspacePath', 'projectPath', 'directory',
];
const TITLE_KEYS: readonly string[] = ['title', 'summary', 'name', 'task'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'startTime', 'startedAt', 'timestamp', 'time', 'updatedAt'];

export interface GrokResolvedHome { readonly home: string; readonly overridden: boolean }

/** GROK_HOME（非空即替换；**只报键名，绝不读值进产物**）→ 默认 ~/.grok */
export function resolveGrokHome(opts: RootProbeOptions): GrokResolvedHome {
  const platform = normalizePlatform(opts.platform);
  const explicit = envValue(opts.env, GROK_HOME_ENV);
  if (explicit !== undefined) return { home: explicit, overridden: true };
  return { home: joinFor(platform, opts.homeDir, GROK_DEFAULT_HOME_DIR), overridden: false };
}

/** 静态探测位置（**双根**；运行时再在它下面枚举 cwd 目录与会话目录） */
export function grokSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const { home } = resolveGrokHome(opts);
  return GROK_SESSION_SUBDIRS.map((sub) => joinFor(platform, home, sub));
}

/** 一条已归一的会话文件（结构上就是 `ParsedTranscript` + 源侧 id，draftOf 可直接透传） */
export interface GrokSessionFile extends ParsedTranscript { readonly id: string }

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
 * 目录名 → cwd：`encodeURIComponent(cwd)` 的逆变换（可逆，故不是「猜」）。
 * 解不出 / 解出来不是目标平台的绝对路径 → undefined（宁可不给，也不落一条错 cwd 的会话）。
 */
export function grokCwdFromDirName(name: string, platform: ForeignPlatform): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  if (decoded === '' || !isAbsoluteFor(platform, decoded)) return undefined;
  return decoded;
}

async function readGrokSession(
  platform: ForeignPlatform,
  root: string,
  cwdDir: string,
  sessionId: string,
  findings: ForeignSkip[],
): Promise<GrokSessionFile | undefined> {
  const dir = joinFor(platform, root, cwdDir, sessionId);
  // 位置标签只用会话 id：**绝不把机器路径回传**（detect/build 的产物会被 GUI/CLI 展示）
  const label = sessionId;
  const summaryPath = joinFor(platform, dir, 'summary.json');
  const historyPath = joinFor(platform, dir, 'chat_history.jsonl');

  const summaryRead = await readJsonSafe(summaryPath, MAX_FILE_BYTES);
  let summary: Record<string, unknown> | undefined;
  if (summaryRead.ok) {
    if (isRecord(summaryRead.value)) summary = summaryRead.value;
    else findings.push({ code: 'source-unreadable', origin: label, detail: 'summary-not-object' });
  } else if (summaryRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'summary-' + summaryRead.problem });
  }

  const historyStat = await statOrNull(historyPath);
  if (historyStat === null || !historyStat.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'history-missing' });
    return undefined;
  }
  const text = await readTextSafe(historyPath, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: historyStat.size > MAX_FILE_BYTES ? 'history-too-large' : 'history-read-error',
    });
    return undefined;
  }

  const parsed = parseGenericJsonl(text);
  const summaryCwd = summary === undefined ? undefined : firstStringIn(summary, CWD_KEYS);
  const cwd = summaryCwd ?? grokCwdFromDirName(cwdDir, platform);
  const summaryTitle = summary === undefined ? undefined : firstStringIn(summary, TITLE_KEYS);
  const createdAt = irEarlier(summary === undefined ? undefined : firstTimeIn(summary, TIME_KEYS), parsed.createdAt);
  return {
    id: sessionId,
    cwd,
    createdAt,
    title: summaryTitle === undefined ? parsed.title : summaryTitle.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
  };
}

/**
 * 读全部 grokbuild 会话（双根；源码位置一律按**目标平台**拼接）。
 *
 * 上限：单文件 8 MiB、单根最多 MAX_SESSION_DIRS 个会话目录；触顶**如实报码**（source-unreadable
 * 的 detail=max-sessions-reached），绝不静默截断。
 */
export async function readGrokbuild(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<GrokSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const resolved = resolveGrokHome(opts);
  const findings: ForeignSkip[] = [];
  if (resolved.overridden) findings.push({ code: 'source-location-overridden', origin: GROK_HOME_ENV });
  const maxFiles = opts.maxFiles ?? MAX_SESSION_DIRS;
  const files: GrokSessionFile[] = [];
  let dirs = 0;
  let truncated = false;
  for (const root of grokSessionRoots(opts)) {
    for (const cwdDir of await listDirNames(root)) {
      for (const sessionId of await listDirNames(joinFor(platform, root, cwdDir))) {
        if (files.length >= maxFiles) { truncated = true; break; }
        dirs += 1;
        const file = await readGrokSession(platform, root, cwdDir, sessionId, findings);
        if (file !== undefined) files.push(file);
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'grokbuild', detail: 'max-sessions-reached', count: maxFiles });
  }
  return { files, readFindings: findings, extraCounts: { 'grokbuild.sessionDirs': dirs } };
}
