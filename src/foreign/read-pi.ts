/**
 * Pi（~\.pi/agent/sessions）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 pi 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致，无出入）：
 *  - 根：`<home>/.pi/agent/sessions`（三平台同形，**无环境变量覆盖**）
 *  - 布局：`<sessions>/--<cwd>--/<timestamp>_<uuid>.jsonl`
 *  - 形态：**首行 = 会话头**，其余行 `id/parentId` 成树（convert/pi.mjs:14-27）
 *
 * 两条归一（都在本层做实）：
 *  ① 首行按**会话头**处理（不是消息）。若首行解析不出来，仍按源记录记一条 `bad` 并继续解析
 *     其余行（绝不整份丢掉 —— 只解析不了首行时用户仍应拿得到对话）；
 *  ② `id/parentId` 的树**按文件顺序线性化**（源是 append-only 的 JSONL，顺序即发生顺序）。
 *     分支/回溯语义未经取证 → 本层不重排，只照源顺序转。
 *
 * cwd 的两档来源（绝不猜）：记录头里的 cwd 字段（权威）→ 目录名反解。反解要过
 * **存在性检查**（isDirectory）才落盘，并如实报 `session-cwd-derived`；反解不出真实目录时
 * 不产出会话（下游按 `session-missing-cwd` 跳过）。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 pi 行）。本机无 ~/.pi，夹具 + 单测端到端跑
 * 同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { isAbsoluteFor, joinFor, normalizePlatform, sepFor } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { irSafeTime, irStr } from './session-ir.ts';
import type { IrTimeMs } from './session-ir.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const PI_SESSIONS_REL = '.pi/agent/sessions';

/** 会话文件（JSONL 是唯一形态） */
export const PI_SESSION_FILE_RE = /\.jsonl$/;

/** 会话目录名的包装：`--<cwd>--` */
export const PI_DIR_PREFIX = '--';

const MAX_SESSION_FILES = 500;

/** 会话头里的 cwd 候选键（与记录层用同一族键） */
const HEADER_CWD_KEYS: readonly string[] = ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory'];
const HEADER_TIME_KEYS: readonly string[] = ['timestamp', 'time', 'createdAt', 'created_at', 'startTime'];

/** Pi 的会话根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function piSessionsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.pi', 'agent', 'sessions');
}

/** 记录形态：通用 JSONL 同族 + 保守的 cwd 同义键；titleKeys 去掉 name（常是工具名） */
export const PI_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: [...HEADER_CWD_KEYS, 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 Pi 会话 */
export interface PiSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface PiReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** 读一个文件（大小闸门在前，绝不截断）；空文件 / 超限 / 读失败都变成稳定机器码 */
async function readTextGuarded(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return null;
  if (st.size > maxBytes) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return null;
  }
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return null;
  }
  if (text.trim() === '') {
    findings.push({ code: 'source-empty-file', origin: label });
    return null;
  }
  return text;
}

/**
 * `--<cwd>--` 目录名 → 绝对路径**候选**（按目标平台排序；唯一判据是**存在性**）。
 *
 * 编码是有损的（路径里的 `-` 与分隔符同形），所以本函数只产出候选、**不做判断** ——
 * 由调用方逐个 `isDirectory` 验真。两种编码形态都收：
 *  - `C:-Users-u-proj`（posix 形态的 `/`→`-`）；
 *  - `C--Users-u-proj`（分隔符与冒号一起 → `-`）。
 */
export function piCwdCandidates(dirName: string, platform: ForeignPlatform): string[] {
  const sep = sepFor(platform);
  let inner = dirName.startsWith(PI_DIR_PREFIX) ? dirName.slice(PI_DIR_PREFIX.length) : dirName;
  if (inner.endsWith(PI_DIR_PREFIX)) inner = inner.slice(0, inner.length - PI_DIR_PREFIX.length);
  const out: string[] = [];
  const driveA = /^([A-Za-z]):-?(.*)$/.exec(inner);
  const driveB = /^([A-Za-z])--(.*)$/.exec(inner);
  const formA = driveA === null ? undefined : driveA[1] + ':' + sep + (driveA[2] ?? '').split('-').join(sep);
  const formB = driveB === null ? undefined : driveB[1] + ':' + sep + (driveB[2] ?? '').split('-').join(sep);
  const posixForm = '/' + inner.split('-').join('/');
  const ordered = platform === 'win32'
    ? [formA, formB, inner, posixForm]
    : [inner, posixForm, formA, formB];
  for (const candidate of ordered) {
    if (candidate === undefined || candidate === '') continue;
    if (!isAbsoluteFor(platform, candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** 目录名反解 → 本机真实存在的目录（不存在 = undefined，**绝不猜**） */
export async function derivedCwdOfDirName(dirName: string, platform: ForeignPlatform): Promise<string | undefined> {
  for (const candidate of piCwdCandidates(dirName, platform)) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

/** 会话头（首行）→ 已解析对象；解析不出来 = undefined（记一条 bad，但不影响其余行） */
function parseHeader(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function headerCwd(header: Record<string, unknown> | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const key of HEADER_CWD_KEYS) {
    const v = irStr(header[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function headerTime(header: Record<string, unknown> | undefined): IrTimeMs | undefined {
  if (header === undefined) return undefined;
  for (const key of HEADER_TIME_KEYS) {
    const t = irSafeTime(header[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 会话 id：头的 id > 文件名 `<timestamp>_<uuid>` 的 uuid 段 > 文件名主干。
 * 自证安全性（isSafeIrId）留给下游 `transcodeSessionDraft` —— 不安全就报 session-unsafe-id，
 * **绝不在这里悄悄换一个 id**。
 */
export function piSessionIdOf(header: Record<string, unknown> | undefined, fileStem: string): string {
  const fromHeader = header === undefined ? undefined : irStr(header['id']);
  if (fromHeader !== undefined) return fromHeader;
  const underscore = fileStem.lastIndexOf('_');
  if (underscore > 0 && underscore < fileStem.length - 1) return fileStem.slice(underscore + 1);
  return fileStem;
}

export async function readPiSessions(opts: PiReadOptions): Promise<SessionReadOutcome<PiSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const sessionsDir = piSessionsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: PiSessionFile[] = [];

  if (!(await isDirectory(sessionsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）。
  let truncated = false;
  for (const dirName of await listDirNames(sessionsDir)) {
    if (!dirName.startsWith(PI_DIR_PREFIX)) continue;
    const sessionDir = joinFor(platform, sessionsDir, dirName);
    const derivedCwd = await derivedCwdOfDirName(dirName, platform);
    for (const name of await listFileNames(sessionDir, (n) => PI_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = PI_SESSIONS_REL + '/' + dirName + '/' + name;
      const text = await readTextGuarded(joinFor(platform, sessionDir, name), label, maxBytes, findings);
      if (text === null) continue;
      const nl = text.indexOf(String.fromCharCode(10));
      const headerLine = (nl < 0 ? text : text.slice(0, nl)).trim();
      const body = nl < 0 ? '' : text.slice(nl + 1);
      const header = parseHeader(headerLine);
      const base = parseGenericJsonl(body, PI_SHAPE);
      const stem = stemOf(name);
      const id = piSessionIdOf(header, stem);
      // 首行解析不出来（且确实有一行）：按源记录记一条 bad（绝不静默少一条记录）
      const parsedBase = header === undefined && headerLine !== ''
        ? { ...base, raw: base.raw + 1, bad: base.bad + 1 }
        : base;

      const cwd = headerCwd(header) ?? derivedCwd;
      if (headerCwd(header) === undefined && derivedCwd !== undefined) {
        findings.push({ code: 'session-cwd-derived', origin: id, detail: 'session-dir-name' });
      }
      const createdAt = base.createdAt ?? headerTime(header);
      const title = irStr(header?.['title']) ?? base.title;
      const parsed: ParsedTranscript = { ...parsedBase, cwd, title };
      files.push({ id, parsed: createdAt === undefined ? parsed : { ...parsed, createdAt } });
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'pi', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
