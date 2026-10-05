/**
 * OpenClaw（~\.openclaw/agents）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 openclaw 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致）：
 *  - 根：`<home>/.openclaw/agents`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<agents>/<agent>/sessions/*.jsonl`（JSONL）
 *  - 伴生索引：同目录的 `sessions.json`（displayName；convert/openclaw.mjs:3-19）
 *
 * 索引文件的用途**只有一个**：给会话取显示名（标题）。两处纪律：
 *  ① 只有**名字**进产物（displayName），索引里的任何其它字段一律不读 → 凭据/值无从进包；
 *  ② 索引形态未取证 → 同时接受「对象映射」与「数组」两种形态，**认不出来就忽略**
 *     （标题退回记录字段 / 首条用户文本，绝不因索引不认识而丢会话）。
 *
 * cwd：只采信记录字段（报告没有为目录名/文件名给出任何可逆编码语义 → 不猜）；
 * 没有 cwd 的会话由下游 `transcodeSessionDraft` 按 `session-missing-cwd` 跳过并报码。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 openclaw 行）。本机无 ~/.openclaw，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const OPENCLAW_AGENTS_REL = '.openclaw/agents';

/** 会话文件（JSONL 是唯一形态；索引是 .json，按后缀天然区分） */
export const OPENCLAW_SESSION_FILE_RE = /\.jsonl$/;

/** 伴生索引文件名（与真值表 truth-table.ts 的 dynamic 描述同源） */
export const OPENCLAW_INDEX_NAME = 'sessions.json';

const MAX_SESSION_FILES = 500;

/** OpenClaw 的 agents 根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function openclawAgentsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.openclaw', 'agents');
}

/** 记录形态：通用 JSONL 同族 + 保守的 cwd 同义键；titleKeys 去掉 name（常是工具名） */
export const OPENCLAW_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 OpenClaw 会话（`title` 有值时已回填进 `parsed`） */
export interface OpenclawSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface OpenclawReadOptions extends RootProbeOptions {
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

/** 从索引项里只取**名字**（displayName / name / title 三个同义键；其余字段一概不读） */
function displayNameOf(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw !== '') return raw;
  if (!isRecord(raw)) return undefined;
  for (const key of ['displayName', 'name', 'title']) {
    const v = raw[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * 读 `sessions.json` 索引：**只取 id → displayName 的名字映射**。
 *
 * 两种形态都认（对象映射 / 数组）；认不出来就返回空映射（绝不因此丢会话）。
 * id 的候选键：`id` / `sessionId` / `session_id`。
 */
export function sessionNamesFromIndex(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      for (const key of ['id', 'sessionId', 'session_id']) {
        const id = item[key];
        if (typeof id !== 'string' || id === '') continue;
        const name = displayNameOf(item);
        if (name !== undefined) out.set(id, name);
        break;
      }
    }
    return out;
  }
  if (!isRecord(value)) return out;
  for (const [id, raw] of Object.entries(value)) {
    const name = displayNameOf(raw);
    if (name !== undefined) out.set(id, name);
  }
  return out;
}

export async function readOpenclawSessions(
  opts: OpenclawReadOptions,
): Promise<SessionReadOutcome<OpenclawSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const agentsDir = openclawAgentsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: OpenclawSessionFile[] = [];

  if (!(await isDirectory(agentsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）。
  let truncated = false;
  for (const agent of await listDirNames(agentsDir)) {
    const sessionsDir = joinFor(platform, agentsDir, agent, 'sessions');
    if (!(await isDirectory(sessionsDir))) continue;
    const indexLabel = OPENCLAW_AGENTS_REL + '/' + agent + '/sessions/' + OPENCLAW_INDEX_NAME;
    const names = await readIndexNames(joinFor(platform, sessionsDir, OPENCLAW_INDEX_NAME), indexLabel, maxBytes, findings);
    for (const name of await listFileNames(sessionsDir, (n) => OPENCLAW_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = OPENCLAW_AGENTS_REL + '/' + agent + '/sessions/' + name;
      const text = await readTextGuarded(joinFor(platform, sessionsDir, name), label, maxBytes, findings);
      if (text === null) continue;
      const id = stemOf(name);
      const base = parseGenericJsonl(text, OPENCLAW_SHAPE);
      // 索引里的 displayName 是**源产品自己给会话起的名字** → 有就采信；认不出来退回记录派生标题
      // （绝不因为索引缺少这一条而丢会话）
      const displayName = names.get(id);
      const withTitle = displayName === undefined ? base : { ...base, title: displayName.slice(0, 200) };
      files.push({ id, parsed: withTitle });
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'openclaw', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}

/** 索引读不到 / 0 字节 / 畸形 = 没有显示名（**不影响会话本身**，只影响标题） */
async function readIndexNames(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<Map<string, string>> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return new Map<string, string>();
  if (st.size > maxBytes) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return new Map<string, string>();
  }
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return new Map<string, string>();
  }
  if (text.trim() === '') {
    findings.push({ code: 'source-empty-file', origin: label });
    return new Map<string, string>();
  }
  try {
    return sessionNamesFromIndex(JSON.parse(text));
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'json-error' });
    return new Map<string, string>();
  }
}
