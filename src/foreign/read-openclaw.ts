/**
 * OpenClaw（~\.openclaw/agents）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 openclaw 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致）：
 *  - 根：`<home>/.openclaw/agents`（三平台同形，**无环境变量覆盖**）
 *  - 会话：根下任意深度的 `sessions` 目录里的 `*.jsonl`（**递归**；对齐 convert/openclaw.mjs 与
 *    discovery/jsonl.mjs:238,242 的 walkFiles + 路径正则判据）
 *  - 伴生索引：会话文件**同目录**的 `sessions.json`（displayName）
 *
 * 记录形态（本层单独解析，**不走通用 JSONL 解析**）：一行一个事件对象，两种事件 ——
 *  - `{type:"session", id, cwd, timestamp}`：会话元数据（id / cwd / 创建时间）；
 *  - `{type:"message", message:{role, content}, timestamp}`：对话消息，role ∈ user /
 *    assistant / toolResult；content 为 string 或块数组（text/thinking/tool_use/tool_result）。
 *  工具结果按 `tool_use_id` 挂回**声明该调用的 assistant 记录之后**（共享合成器把
 *  tool/result 收进当前打开的 step）；gateway 注入的 `\n[message_id: …]` 尾缀在提取文本时剥掉。
 *  会话 id 优先取 session 事件的 id，其次才是文件主干（convert/openclaw.mjs:144,150）。
 *
 * 索引文件的用途**只有一个**：给会话取显示名（标题）。两处纪律：
 *  ① 只有**名字**进产物（displayName），索引里的任何其它字段一律不读 → 凭据/值无从进包；
 *  ② 索引形态未取证 → 同时接受「对象映射」与「数组」两种形态，**认不出来就忽略**
 *     （标题退回记录字段 / 首条用户文本，绝不因索引不认识而丢会话）。
 *
 * cwd：只采信 session 事件里的 cwd（报告没有为目录名/文件名给出任何可逆编码语义 → 不猜）；
 * 没有 cwd 的会话由下游 `transcodeSessionDraft` 按 `session-missing-cwd` 跳过并报码。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 openclaw 行）。本机无 ~/.openclaw，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../utils/guards.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import {
  DEFAULT_MAX_FILE_BYTES,
  isDirectory,
  parseJsonlText,
  statOrNull,
  stemOf,
  walkFiles,
} from './session-read.ts';
import { firstUserText, GENERIC_TRANSCRIPT_SHAPE } from './session-source.ts';
import {
  irBump,
  irEarlier,
  irSafeTime,
  irStr,
  irTextBlock,
  irToolCallBlock,
  irToolResultBlock,
} from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import type {
  ParsedTranscript,
  RootProbeOptions,
  SessionReadOutcome,
  TranscriptRecord,
  TranscriptShape,
} from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const OPENCLAW_AGENTS_REL = '.openclaw/agents';

/** 会话文件（JSONL 是唯一形态；索引是 .json，按后缀天然区分） */
export const OPENCLAW_SESSION_FILE_RE = /\.jsonl$/;

/** 伴生索引文件名（与真值表 truth-table.ts 的 dynamic 描述同源） */
export const OPENCLAW_INDEX_NAME = 'sessions.json';

/**
 * 走盘命中判据：路径里同时出现 `agents` 与 `sessions` 段（逐字对齐
 * discovery/jsonl.mjs:242 的 `/\bagents\b.*\bsessions\b/i`）。
 */
export const OPENCLAW_SESSION_PATH_RE = /\bagents\b.*\bsessions\b/i;

const MAX_SESSION_FILES = 500;

/** OpenClaw 的 agents 根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function openclawAgentsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.openclaw', 'agents');
}

/**
 * 通用 JSONL 形态（**遗留**：t 起 OpenClaw 走专用事件流解析，本常量只为保留既有公开导出名）。
 */
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
 * id 的候选键：对象项优先取 `sessionId`（对齐 convert/openclaw.mjs 的 openclawDisplayNames），
 * 没有才退回对象键；数组项取 `id` / `sessionId` / `session_id`。
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
  for (const [key, raw] of Object.entries(value)) {
    const name = displayNameOf(raw);
    if (name === undefined) continue;
    const entryId = isRecord(raw) ? irStr(raw['sessionId']) ?? irStr(raw['session_id']) ?? irStr(raw['id']) : undefined;
    out.set(entryId ?? key, name);
  }
  return out;
}

/* ---------------- 专用事件流解析（纯函数；不读盘） ---------------- */

/** 剥离 OpenClaw gateway 注入的尾部元数据 `\n[message_id: …]`（对齐 convert/openclaw.mjs） */
export function stripMessageIdSuffix(text: string): string {
  const pos = text.lastIndexOf('\n[message_id:');
  return pos === -1 ? text : text.slice(0, pos).trimEnd();
}

/** 内容 → 纯文本（string 原样 / 块数组逐块 / {text} 对象），逐段剥 message_id 尾缀 */
function openclawTextOf(content: unknown): string {
  if (typeof content === 'string') return stripMessageIdSuffix(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const text = openclawTextOf(block);
      if (text.trim() !== '') parts.push(text);
    }
    return parts.join('\n');
  }
  if (isRecord(content) && typeof content['text'] === 'string') return stripMessageIdSuffix(content['text']);
  return '';
}

/** tool_result 内容 → 纯文本（string / 块数组 / {text} 对象），剥 message_id 尾缀 */
function toolResultTextOf(content: unknown): string {
  if (typeof content === 'string') return stripMessageIdSuffix(content).trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const text = openclawTextOf(block);
      if (text.trim() !== '') parts.push(text);
    }
    return parts.join('\n').trim();
  }
  if (isRecord(content)) return openclawTextOf(content).trim();
  return '';
}

/** 一条待配对的工具结果（`callId` 缺失 = 纯文本结果，回填最近未配对调用） */
interface OpenclawToolResult {
  readonly callId?: string | undefined;
  readonly text: string;
  readonly isError: boolean;
}

/**
 * toolResult 消息 → 结果列表：块数组优先取 `tool_result` 块（按 `tool_use_id` 配对）；
 * 没有 `tool_result` 块（字符串 / 纯文本块 / 对象）整条按文本结果返回。
 */
function extractToolResults(content: unknown): OpenclawToolResult[] {
  if (Array.isArray(content)) {
    const out: OpenclawToolResult[] = [];
    let hasToolResult = false;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      hasToolResult = true;
      out.push({
        callId: irStr(block['tool_use_id']),
        text: toolResultTextOf(block['content']),
        isError: block['is_error'] === true,
      });
    }
    if (hasToolResult) return out;
  }
  const text = toolResultTextOf(content);
  return text === '' ? [] : [{ text, isError: false }];
}

/** assistant 消息的 content → IR 块（text / tool_use；thinking 等 IR 无承载块，逐类计数） */
function openclawAssistantBlocks(content: unknown, ignored: Record<string, number>): IrBlock[] {
  if (typeof content === 'string') {
    const text = stripMessageIdSuffix(content).trim();
    return text === '' ? [] : [irTextBlock(text)];
  }
  if (!Array.isArray(content)) {
    const text = openclawTextOf(content).trim();
    return text === '' ? [] : [irTextBlock(text)];
  }
  const out: IrBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = irStr(block['type']);
    if (type === 'text') {
      if (typeof block['text'] === 'string') out.push(irTextBlock(stripMessageIdSuffix(block['text'])));
      continue;
    }
    if (type === 'thinking') {
      // IR 没有 reasoning 块（见 session-ir.ts 的分层纪律）→ 不伪装成正文，逐类计数
      irBump(ignored, 'block:thinking');
      continue;
    }
    if (type === 'tool_use') {
      const id = irStr(block['id']);
      if (id === undefined) {
        // 无 id 的调用无法与 tool_result 配对（会投影出缺 tool 消息的 assistant）→ 整块丢弃
        irBump(ignored, 'tool-call-no-id');
        continue;
      }
      out.push(irToolCallBlock(id, irStr(block['name']) ?? 'unknown', block['input'] ?? {}));
      continue;
    }
    irBump(ignored, 'block:' + (type ?? 'unmapped'));
  }
  return out;
}

export interface OpenclawEventParse {
  /** session 事件里的 id（缺省时由调用方回落到文件主干） */
  readonly sessionId?: string | undefined;
  readonly parsed: ParsedTranscript;
}

/**
 * OpenClaw 事件流（纯函数：原文 → 已归一记录）。
 *
 * 三条纪律：① session 事件只取 id/cwd/timestamp，出现多次只认第一条；② message 事件的
 * role 决定记录角色，toolResult 按 `tool_use_id` 挂回声明该调用的 assistant 记录**之后**
 * （由共享合成器收进同一个 step）；③ 对不上的孤儿结果丢弃并逐类计数，绝不塞进别的回合。
 */
export function parseOpenclawEventStream(text: string): OpenclawEventParse {
  const { objects, bad } = parseJsonlText(text);
  const ignored: Record<string, number> = {};
  const ordered: TranscriptRecord[] = [];
  const callOwner = new Map<string, TranscriptRecord>();
  const callOrder = new Map<string, number>();
  const resultsOf = new Map<TranscriptRecord, { readonly record: TranscriptRecord; readonly order: number }[]>();
  const unresolved: string[] = [];
  const resolved = new Set<string>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: IrTimeMs | undefined;
  let hasUser = false;

  for (const rec of objects) {
    const type = rec['type'];
    if (type === 'session') {
      if (sessionId === undefined) sessionId = irStr(rec['id']);
      if (cwd === undefined) cwd = irStr(rec['cwd']);
      createdAt = irEarlier(createdAt, irSafeTime(rec['timestamp']));
      continue;
    }
    if (type !== 'message') {
      irBump(ignored, typeof type === 'string' && type !== '' ? type : 'unknown');
      continue;
    }
    const msg = rec['message'];
    if (!isRecord(msg)) {
      irBump(ignored, 'message:no-content');
      continue;
    }
    createdAt = irEarlier(createdAt, irSafeTime(rec['timestamp']));
    const time = irSafeTime(rec['timestamp']);
    const id = irStr(rec['id']);
    const role = irStr(msg['role']);

    if (role === 'user') {
      const prompt = openclawTextOf(msg['content']).trim();
      if (prompt === '') {
        irBump(ignored, 'message:no-content');
        continue;
      }
      ordered.push({ role: 'user', blocks: [irTextBlock(prompt)], time, id });
      hasUser = true;
      continue;
    }

    if (role === 'assistant') {
      // 没有开启的轮次（此前没有 user）→ 对齐参考实现：不产出一条无主的 assistant
      if (!hasUser) {
        irBump(ignored, 'message:no-turn');
        continue;
      }
      const blocks = openclawAssistantBlocks(msg['content'], ignored);
      const record: TranscriptRecord = { role: 'assistant', blocks, time, id };
      let order = 0;
      for (const block of blocks) {
        if (block.type !== 'tool_call') continue;
        callOwner.set(block.id, record);
        callOrder.set(block.id, order);
        order += 1;
        unresolved.push(block.id);
      }
      ordered.push(record);
      continue;
    }

    if (role === 'toolResult') {
      if (!hasUser) {
        irBump(ignored, 'tool-result-orphan');
        continue;
      }
      for (const result of extractToolResults(msg['content'])) {
        let callId = result.callId;
        if (callId === undefined) callId = unresolved[unresolved.length - 1];
        if (callId === undefined || !callOwner.has(callId)) {
          irBump(ignored, 'tool-result-orphan');
          continue;
        }
        if (resolved.has(callId)) {
          irBump(ignored, 'tool-result-duplicate');
          continue;
        }
        resolved.add(callId);
        const at = unresolved.indexOf(callId);
        if (at >= 0) unresolved.splice(at, 1);
        const owner = callOwner.get(callId);
        if (owner === undefined) {
          irBump(ignored, 'tool-result-orphan');
          continue;
        }
        const list = resultsOf.get(owner) ?? [];
        list.push({
          record: { role: 'user', blocks: [irToolResultBlock(callId, result.text, result.isError)], time, id },
          order: callOrder.get(callId) ?? Number.MAX_SAFE_INTEGER,
        });
        resultsOf.set(owner, list);
      }
      continue;
    }

    irBump(ignored, 'role:' + (role ?? 'unknown'));
  }

  // 结果挂回声明记录的**之后**（同一 assistant 记录内按调用声明顺序）
  const records: TranscriptRecord[] = [];
  for (const rec of ordered) {
    records.push(rec);
    const results = resultsOf.get(rec);
    if (results === undefined) continue;
    results.sort((a, b) => a.order - b.order);
    for (const r of results) records.push(r.record);
  }

  return {
    sessionId,
    parsed: {
      records,
      cwd,
      createdAt,
      title: firstUserText(records),
      raw: objects.length,
      bad,
      ignored,
    },
  };
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

export async function readOpenclawSessions(
  opts: OpenclawReadOptions,
): Promise<SessionReadOutcome<OpenclawSessionFile>> {
  const agentsDir = openclawAgentsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: OpenclawSessionFile[] = [];

  if (!(await isDirectory(agentsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 递归走盘 + 路径段判据（对齐 discovery/jsonl.mjs:238,242）；触顶必须**可见**（audit-foreign F4）
  const walked = await walkFiles(agentsDir, { match: (n) => OPENCLAW_SESSION_FILE_RE.test(n) });
  const candidates = walked.filter((f) => OPENCLAW_SESSION_PATH_RE.test(f.abs));
  const truncated = candidates.length > maxFiles;
  const chosen = truncated ? candidates.slice(0, maxFiles) : candidates;
  const namesByDir = new Map<string, Map<string, string>>();

  for (const file of chosen) {
    const sep = file.rel.lastIndexOf('/');
    const relDir = sep < 0 ? '' : file.rel.slice(0, sep);
    const label = OPENCLAW_AGENTS_REL + (relDir === '' ? '' : '/' + relDir) + '/' + file.name;
    const text = await readTextGuarded(file.abs, label, maxBytes, findings);
    if (text === null) continue;

    const dir = path.dirname(file.abs);
    let names = namesByDir.get(dir);
    if (names === undefined) {
      const indexLabel = OPENCLAW_AGENTS_REL + (relDir === '' ? '' : '/' + relDir) + '/' + OPENCLAW_INDEX_NAME;
      names = await readIndexNames(path.join(dir, OPENCLAW_INDEX_NAME), indexLabel, maxBytes, findings);
      namesByDir.set(dir, names);
    }

    const stem = stemOf(file.name);
    const { sessionId, parsed } = parseOpenclawEventStream(text);
    // 会话 id 优先取 session 事件的 id（convert/openclaw.mjs:144,150），文件主干只是兜底
    const id = sessionId ?? stem;
    // 索引里的 displayName 是**源产品自己给会话起的名字** → 有就采信；认不出来退回记录派生标题
    // （绝不因为索引缺少这一条而丢会话）
    const displayName = names.get(id) ?? names.get(stem);
    const withTitle = displayName === undefined ? parsed : { ...parsed, title: displayName.slice(0, 200) };
    files.push({ id, parsed: withTitle });
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'openclaw', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
