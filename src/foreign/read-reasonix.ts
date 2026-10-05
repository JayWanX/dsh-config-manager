/**
 * Reasonix 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 reasonix 行）。
 *
 * 布局（chat-import discovery.mjs:99,122-124；read-vault §10.2）：
 *   <home>/.reasonix/sessions/<stem>.jsonl        + 伴生 <stem>.meta.json（workspace/summary）
 *   <appdata>/reasonix/**（**Windows 桌面端第二根**，仅在 win32 平台加入）
 *
 * 纪律：路径函数显式收 platform；`.meta.json` 绝不当作会话正文（只按伴生元数据读）；
 * 单文件 8 MiB 上限、目录树深度上限、根不存在 = 正常（未安装），读不到才报码。
 */
import { joinFor, normalizePlatform, roamingAppDataDir } from './platform-paths.ts';
import { statOrNull, readJsonSafe, readTextSafe, stemOf, walkFiles } from './session-read.ts';
import type { WalkedFile } from './session-read.ts';
import { parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome } from './session-source.ts';
import { irEarlier, irSafeTime } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const REASONIX_DIR = '.reasonix';
export const REASONIX_SESSIONS_SUBDIR = 'sessions';
export const REASONIX_DESKTOP_DIR = 'reasonix';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 6;

const CWD_KEYS: readonly string[] = [
  'workspace', 'cwd', 'workdir', 'workingDirectory', 'working_directory', 'projectPath', 'directory', 'path',
];
const TITLE_KEYS: readonly string[] = ['summary', 'title', 'name', 'topic'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'startTime', 'startedAt', 'timestamp', 'time', 'updatedAt'];

/**
 * 静态探测位置（**多根**）：`<home>/.reasonix/sessions` +（win32）`%APPDATA%/reasonix`。
 *
 * 为什么 win32 的第二根无条件加入（而不是「仅 $APPDATA 存在时」）：真值表把这两条都写进了
 * `defaults.win32`，而 `roamingAppDataDir` 在缺 %APPDATA% 时会回落到 `<home>/AppData/Roaming`
 * —— 条件加入会让 probePaths 与真值表在「空环境」下逐项不等（t6 按合成真值交叉核对时必红）。
 */
export function reasonixSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const roots = [joinFor(platform, opts.homeDir, REASONIX_DIR, REASONIX_SESSIONS_SUBDIR)];
  if (platform === 'win32') {
    roots.push(joinFor(platform, roamingAppDataDir(platform, opts.homeDir, opts.env), REASONIX_DESKTOP_DIR));
  }
  return roots;
}

/** 一条已归一的会话文件（`ParsedTranscript` + 源侧 id，draftOf 直接透传） */
export interface ReasonixSessionFile extends ParsedTranscript { readonly id: string }

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

/** 伴生元数据路径：`<stem>.jsonl` → `<stem>.meta.json` */
export function reasonixMetaPath(jsonlPath: string): string {
  return jsonlPath.slice(0, jsonlPath.length - '.jsonl'.length) + '.meta.json';
}

async function readMeta(path: string, label: string, findings: ForeignSkip[]): Promise<Record<string, unknown> | undefined> {
  const read = await readJsonSafe(path, MAX_FILE_BYTES);
  if (!read.ok) {
    if (read.problem !== 'missing') {
      findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-' + read.problem });
    }
    return undefined;
  }
  if (!isRecord(read.value)) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-not-object' });
    return undefined;
  }
  return read.value;
}

async function readReasonixSession(
  file: WalkedFile,
  findings: ForeignSkip[],
): Promise<ReasonixSessionFile | undefined> {
  const id = stemOf(file.name);
  const label = id;
  const meta = await readMeta(reasonixMetaPath(file.abs), label, findings);
  const st = await statOrNull(file.abs);
  if (st === null || !st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'missing' });
    return undefined;
  }
  const text = await readTextSafe(file.abs, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: st.size > MAX_FILE_BYTES ? 'too-large' : 'read-error',
    });
    return undefined;
  }
  const parsed = parseGenericJsonl(text);
  const metaCwd = meta === undefined ? undefined : firstStringIn(meta, CWD_KEYS);
  const metaTitle = meta === undefined ? undefined : firstStringIn(meta, TITLE_KEYS);
  const createdAt = irEarlier(meta === undefined ? undefined : firstTimeIn(meta, TIME_KEYS), parsed.createdAt);
  return {
    id,
    cwd: metaCwd,
    createdAt,
    title: metaTitle === undefined ? parsed.title : metaTitle.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
  };
}

/** 读全部 reasonix 会话（多根；同 id 先到先得，不覆盖 —— 与全局「同 id 只允许一条」同口径） */
export async function readReasonix(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<ReasonixSessionFile>> {
  const findings: ForeignSkip[] = [];
  const files: ReasonixSessionFile[] = [];
  const seen = new Set<string>();
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  // walkFiles 只回数组、不报是否触顶 → 每个根多要一条：拿到 maxFiles+1 条即**证明**触顶（audit-foreign F4）。
  let truncated = false;
  let walked = 0;
  for (const root of reasonixSessionRoots(opts)) {
    const foundAll = await walkFiles(root, {
      match: (name) => name.endsWith('.jsonl'),
      maxDepth: MAX_DEPTH,
      maxFiles: maxFiles + 1,
    });
    if (foundAll.length > maxFiles) truncated = true;
    const found = foundAll.length > maxFiles ? foundAll.slice(0, maxFiles) : foundAll;
    for (const entry of found) {
      walked += 1;
      if (seen.has(stemOf(entry.name))) continue;
      const file = await readReasonixSession(entry, findings);
      if (file === undefined) continue;
      seen.add(file.id);
      files.push(file);
    }
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) findings.push({ code: 'source-unreadable', origin: 'reasonix', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'reasonix.files': walked } };
}
