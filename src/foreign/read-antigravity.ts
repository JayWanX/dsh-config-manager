/**
 * Google Antigravity（~/.gemini）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（契约 §8.2）：
 *  - ~/.gemini/config/mcp_config.json（**全局** MCP）：**实测取证**（存在；本机 **0 字节**）
 *  - ~/.gemini/antigravity/mcp_config.json（IDE 侧同形位置）：**实测取证**（存在；0 字节）
 *  - ~/.gemini/antigravity/mcp_oauth_tokens.json：**凭据文件** → 只 stat、绝不读
 *  - ~/.gemini/antigravity-cli/**：本机实测存在（settings.json / conversations/ / knowledge/ /
 *    brain/ …），但契约**未冻结**其中哪些属于配置导入范围 → **本层不读、不报**，
 *    绝不因此产出 sessions/workspaces 分区
 *
 * 两个入口（**不移进 kernel** —— 其它来源的读盘层各自持有自己的边界，共享的是纯内核）：
 *  - resolveGeminiHome({ homeDir })：~/.gemini 的路径解析（三平台同形，无环境变量覆盖）
 *  - readAntigravity({ geminiDir })：直接对着一个已解析的 .gemini 目录读盘
 * 调参用 .gemini 目录而不是 homeDir：**位置解析与读盘解耦**，测试可以对着临时目录建
 * `<任意目录>/config/mcp_config.json`（绕开「点开头目录在测试环境里不好造」的问题），
 * 而且调用方（t22 的宿主装配）本来就要自己决定 homeDir。
 *
 * 本层只做「读得到就读、读不到如实报」，绝不猜、绝不截断；0 字节文件**绝不抛**：
 *  ① 只读固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② 0 字节 → source-empty-file（Antigravity 本机就是这种情形），随后**不解析、不产出任何分区**
 *  ③ JSON 解析失败 → source-unreadable(detail=json-error)
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { readTextSafe, resolveLimit } from './session-read.ts';
import { irBump, irEarlier, irSafeTime, irTextBlock, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText, recordIdOf } from './session-source.ts';
import type { ParsedTranscript, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignLimitOverrides, ForeignSkip } from './types.ts';
import type { AntigravityInput, AntigravitySessionInput } from './antigravity.ts';

/** Antigravity 的 gemini 目录名（真值表用一个值固定下来，调用方不该各写一份字符串） */
export const ANTIGRAVITY_GEMINI_DIR_NAME = '.gemini';

/**
 * ~/.gemini 的路径解析（三平台同形，无环境变量覆盖：契约 §8.2 没有给 Antigravity 列覆盖变量）。
 */
export function resolveGeminiHome(opts: { homeDir: string }): { dir: string } {
  return { dir: path.join(opts.homeDir, ANTIGRAVITY_GEMINI_DIR_NAME) };
}

export interface AntigravityReadOptions {
  /** 已解析的 .gemini 目录绝对路径（宿主用 resolveGeminiHome(...).dir） */
  geminiDir: string;
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 会话数上限（默认 500）；超出即报 source-unreadable/max-sessions-reached，绝不静默截断 */
  maxSessions?: number;
  /** 可选上限覆盖（t36，装配层透传；缺省 = 上面各默认值逐字不变） */
  limits?: ForeignLimitOverrides;
}

export interface AntigravityReadResult {
  /** 是否找到 Antigravity 的痕迹（.gemini 目录存在）；未安装是正常状态，不是错误 */
  found: boolean;
  /** 命中的相对路径（诊断用；**只允许路径，绝不含任何值**） */
  paths: string[];
  input: AntigravityInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

interface JsonRead { ok: boolean; value?: unknown; empty: boolean; present: boolean }

async function readJsonSafe(p: string, max: number): Promise<JsonRead> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return { ok: false, empty: false, present: false };
  if (st.size === 0) return { ok: false, empty: true, present: true };
  if (st.size > max) return { ok: false, empty: false, present: true };
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return { ok: false, empty: false, present: true };
  }
  try {
    return { ok: true, value: JSON.parse(text), empty: false, present: true };
  } catch {
    return { ok: false, empty: false, present: true };
  }
}

/* ---------------- 会话：brain/<convId>/.system_generated/logs/{transcript.jsonl,overview.txt} ---------------- */

/** 三根并列（真值表同款：IDE / 旧 CLI / 个别发行） */
export const ANTIGRAVITY_ROOTS: readonly string[] = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

const AGY_LOGS_REL = '.system_generated/logs';
const AGY_TRANSCRIPT = 'transcript.jsonl';
const AGY_OVERVIEW = 'overview.txt';
const AGY_ANNOTATIONS = 'annotations';
const AGY_MESSAGES_REL = '.system_generated/messages';

/** 会话目录名 = conversationId（UUID）；brain/ 下还有 tempmediaStorage 之类的非会话目录 */
const AGY_SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_SESSIONS = 500;
/** annotations/*.pbtxt 只是标题行，给一个很小的上限就够 */
const ANNOTATION_MAX_BYTES = 256 * 1024;

/** 任务控制类调用自身不产出输出（真正的工作由它派生出去，另行回报） */
const TASK_CONTROL_TOOLS = new Set<string>(['manage_task', 'schedule']);

/** 结果缺失时的显式占位（区分「确实没有输出」与「转录里没带回来」） */
const NO_OUTPUT_BACKGROUND = '(no output captured — background task, result not in transcript)';
const NO_OUTPUT_TASK_CONTROL = '(task control call — no direct output)';

/** Antigravity 把 shell 风格参数存成**带引号的字符串**（"55"、/"a b"/）→ 还原为字面值 */
function unquote(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return value;
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = unquote(value);
  return out;
}

/** <USER_REQUEST> 内的正文即真实提问；<ADDITIONAL_METADATA> 是脚手架元信息，剥掉 */
export function unwrapUserRequest(text: unknown): string {
  let s = typeof text === 'string' ? text : '';
  const m = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (m !== null && m[1] !== undefined) s = m[1];
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  s = s.replace(/<\/?USER_REQUEST>/gi, '');
  return s.trim();
}

/** 转录在字段被截断时以 "\\n... (truncated)" 收尾 → 去掉标记、保留可得正文 */
function stripTruncation(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\n*\.\.\.\s*\(truncated\)\s*$/i, '');
}

/** annotations/*.pbtxt 是 protobuf 文本格式（title:"…"），标题是唯一需要的字段 */
export function parseAnnotationTitle(raw: string): string {
  const m = raw.match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m === null || m[1] === undefined) return '';
  try {
    return String(JSON.parse('"' + m[1] + '"')).trim();
  } catch {
    return m[1].trim();
  }
}

/** 跨平台绝对路径判据（源可能来自另一个平台，绝不用 node:path.isAbsolute 按当前平台判） */
function isAbsoluteCwd(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return p.startsWith('\\\\');
}

/* ---------------- 转录解析（纯函数；与参考实现的记录语义逐条对齐） ---------------- */

interface AgyCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  resultText: string | null;
  resultTime: IrTimeMs | undefined;
  control: boolean;
  stepIndex: number | undefined;
}

interface AgyStep {
  time: IrTimeMs | undefined;
  text: string;
  thinking: string;
  calls: AgyCall[];
}

interface AgyTurn {
  prompt: string;
  time: IrTimeMs | undefined;
  steps: AgyStep[];
}

export interface AntigravityParseOptions {
  /** annotations/<id>.pbtxt 解析出的标题（空串 = 没有） */
  title?: string | undefined;
  /** stepIndex → 伴生 messages/*.json 的回执正文（异步任务的真实输出） */
  taskMessages?: ReadonlyMap<number, string> | undefined;
}

/**
 * transcript.jsonl → 归一记录。
 *
 * 记录语义（参考实现 lib/convert/antigravity.mjs 逐条对齐）：
 *  - USER_INPUT：content 包在 <USER_REQUEST> 里 → 剥壳后是用户轮；
 *  - PLANNER_RESPONSE：content 是正文、thinking 是思考摘要、tool_calls 是调用；
 *  - GENERIC + status=DONE：**工具结果**，按「最早尚无结果的未决调用」正序配对；
 *  - ERROR_MESSAGE：保留为 assistant 正文（失败不许被抹掉）；
 *  - SYSTEM_MESSAGE / CHECKPOINT：框架噪声 → 跳过并逐类计数；
 *  - 未配上结果的调用（fire-and-forget / 任务控制）标显式占位，**绝不虚构空结果**。
 */
export function parseAntigravityTranscript(raw: string, opts: AntigravityParseOptions = {}): ParsedTranscript {
  const ignored: Record<string, number> = {};
  const taskMessages = opts.taskMessages ?? new Map<number, string>();
  const turns: AgyTurn[] = [];
  let cur: AgyTurn | null = null;
  let pending: AgyCall[] = [];
  let rawCount = 0;
  let bad = 0;
  let createdAt: IrTimeMs | undefined;
  const cwdCounts = new Map<string, number>();

  const flushPending = (): void => {
    for (const call of pending) {
      if (call.resultText === null) {
        call.resultText = call.control ? NO_OUTPUT_TASK_CONTROL : NO_OUTPUT_BACKGROUND;
      }
    }
    pending = [];
  };
  /** 一次 planner 步可发多个调用，结果按到达顺序逐条配对 → 取**最早**的未决调用 */
  const takePending = (resultStep: number | undefined): AgyCall | null => {
    for (const call of pending) {
      if (call.resultText !== null) continue;
      if (resultStep === undefined || call.stepIndex === undefined || call.stepIndex < resultStep) return call;
    }
    return null;
  };

  for (const line of raw.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isRecord(rec)) {
      bad += 1;
      continue;
    }
    rawCount += 1;
    const type = typeof rec['type'] === 'string' ? rec['type'] : '';
    const stepIndexRaw = rec['step_index'];
    const stepIndex = typeof stepIndexRaw === 'number' && Number.isFinite(stepIndexRaw) ? stepIndexRaw : undefined;
    const time = irSafeTime(rec['created_at']);
    createdAt = irEarlier(createdAt, time);

    if (type === 'USER_INPUT') {
      flushPending();
      const prompt = unwrapUserRequest(stripTruncation(rec['content']));
      if (prompt === '') {
        irBump(ignored, 'user-input-empty');
        continue;
      }
      cur = { prompt, time, steps: [] };
      turns.push(cur);
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      flushPending();
      if (cur === null) {
        // 无用户轮的孤立回复（会话被截断等）→ 丢弃并计数，避免产出无 prompt 的 step
        irBump(ignored, 'planner-response-without-turn');
        continue;
      }
      const text = stripTruncation(rec['content']).trim();
      const thinking = typeof rec['thinking'] === 'string' ? rec['thinking'].trim() : '';
      const calls: AgyCall[] = [];
      const rawCalls = rec['tool_calls'];
      if (Array.isArray(rawCalls)) {
        for (let i = 0; i < rawCalls.length; i++) {
          const tc: unknown = rawCalls[i];
          if (!isRecord(tc)) continue;
          const name = typeof tc['name'] === 'string' && tc['name'] !== '' ? tc['name'] : 'unknown';
          const args = normalizeArgs(tc['args']);
          const cwd = args['Cwd'];
          if (isAbsoluteCwd(cwd)) cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
          const stepPart = stepIndex === undefined ? String(turns.length) : String(stepIndex);
          calls.push({
            id: 'agy-' + stepPart + '-' + String(i),
            name,
            input: args,
            resultText: null,
            resultTime: undefined,
            control: TASK_CONTROL_TOOLS.has(name),
            stepIndex,
          });
        }
      }
      if (text !== '' || thinking !== '' || calls.length > 0) cur.steps.push({ time, text, thinking, calls });
      for (const call of calls) pending.push(call);
      continue;
    }

    if (type === 'GENERIC') {
      // status=RUNNING：后台任务刚启动（不是结果）→ 不消费未决调用
      if (rec['status'] !== 'DONE') {
        irBump(ignored, 'generic:' + String(rec['status'] ?? 'unknown'));
        continue;
      }
      const text = stripTruncation(rec['content']).trim();
      if (text === '') {
        irBump(ignored, 'generic-empty');
        continue;
      }
      const entry = takePending(stepIndex);
      if (entry === null) {
        irBump(ignored, 'orphan-tool-result');
        continue;
      }
      const viaMessage = stepIndex === undefined ? undefined : taskMessages.get(stepIndex);
      entry.resultText = viaMessage !== undefined && viaMessage !== '' ? viaMessage : text;
      entry.resultTime = time;
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      const text = stripTruncation(rec['content']).trim();
      if (text === '' || cur === null) {
        irBump(ignored, 'error-message-empty');
        continue;
      }
      cur.steps.push({ time, text: '[error] ' + text, thinking: '', calls: [] });
      continue;
    }

    irBump(ignored, type === '' ? 'unknown-record' : type);
  }
  flushPending();

  /* 拍平成归一记录：用户轮 → （助手步 + 该步工具结果）——结果必须紧跟其调用，DSH 工具闭合才成立 */
  const records: TranscriptRecord[] = [];
  let index = 0;
  for (const turn of turns) {
    records.push({ role: 'user', blocks: [irTextBlock(turn.prompt)], time: turn.time, id: recordIdOf(undefined, index) });
    index += 1;
    for (const step of turn.steps) {
      const blocks: IrBlock[] = [];
      if (step.text !== '') blocks.push(irTextBlock(step.text));
      // DSH 的 IR 没有 reasoning 块（见 read-opencode.ts 同款口径）→ 不伪装成正文，逐类计数
      if (step.thinking !== '') irBump(ignored, 'reasoning-block');
      for (const call of step.calls) blocks.push(irToolCallBlock(call.id, call.name, call.input));
      if (blocks.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      records.push({ role: 'assistant', blocks, time: step.time, id: recordIdOf(undefined, index) });
      index += 1;
      const results = step.calls.filter((c) => c.resultText !== null);
      if (results.length > 0) {
        const first = results[0];
        records.push({
          role: 'user',
          blocks: results.map((c) => irToolResultBlock(c.id, c.resultText ?? '', false)),
          time: (first === undefined ? undefined : first.resultTime) ?? step.time,
          id: recordIdOf(undefined, index),
        });
        index += 1;
      }
    }
  }

  /* cwd = tool_calls 的 Cwd 众数（参考实现同款；跨平台绝对路径判据） */
  let bestCwd: string | undefined;
  let bestCount = 0;
  for (const [cwd, count] of cwdCounts) {
    if (count > bestCount) {
      bestCwd = cwd;
      bestCount = count;
    }
  }
  const givenTitle = opts.title === undefined ? '' : opts.title;
  const title = givenTitle !== '' ? givenTitle : firstUserText(records);
  return { records, cwd: bestCwd, createdAt, title, raw: rawCount, bad, ignored };
}

/* ---------------- 目录读盘 ---------------- */

async function isFileMaybe(p: string): Promise<boolean> {
  const st = await statOrNull(p);
  return st !== null && st.isFile();
}

async function readAnnotationTitle(root: string, id: string): Promise<string> {
  const text = await readTextSafe(path.join(root, AGY_ANNOTATIONS, id + '.pbtxt'), ANNOTATION_MAX_BYTES);
  return text === null ? '' : parseAnnotationTitle(text);
}

/**
 * 异步任务回执（.system_generated/messages/*.json）→ stepIndex → 正文。
 *
 * 转录行在这些回执上只留标题行，正文在伴生目录里 —— 只接受源侧显式给了
 * `sourceMetadata.tool.stepIndex` 的记录（缺字段的（如系统通知）不当回执）。
 */
async function readTaskMessages(messagesDir: string, maxBytes: number): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(messagesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (!d.isFile() || d.isSymbolicLink() || !d.name.endsWith('.json')) continue;
    const text = await readTextSafe(path.join(messagesDir, d.name), maxBytes);
    if (text === null) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    const meta = isRecord(rec['sourceMetadata']) ? rec['sourceMetadata'] : undefined;
    const tool = meta === undefined ? undefined : meta['tool'];
    if (!isRecord(tool)) continue;
    const stepIndex = tool['stepIndex'];
    if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex)) continue;
    const content = typeof rec['content'] === 'string' ? rec['content'] : '';
    if (content === '' || out.has(stepIndex)) continue;
    out.set(stepIndex, content);
  }
  return out;
}

interface AgyRootRead {
  readonly files: AntigravitySessionInput[];
  readonly skipped: ForeignSkip[];
  readonly truncated: boolean;
}

/** 枚举一个根（antigravity / antigravity-cli / antigravity-ide）的 brain/* 会话 */
async function readAntigravityRoot(
  root: string,
  rootLabel: string,
  opts: { maxFileBytes: number; maxSessions: number },
): Promise<AgyRootRead> {
  const files: AntigravitySessionInput[] = [];
  const skipped: ForeignSkip[] = [];
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(path.join(root, 'brain'), { withFileTypes: true });
  } catch {
    return { files, skipped, truncated: false };
  }
  const names = dirents
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && AGY_SESSION_DIR_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  let truncated = false;
  for (const id of names) {
    if (files.length >= opts.maxSessions) {
      truncated = true;
      break;
    }
    const logsDir = path.join(root, 'brain', id, AGY_LOGS_REL);
    const transcript = path.join(logsDir, AGY_TRANSCRIPT);
    const overview = path.join(logsDir, AGY_OVERVIEW);
    // transcript.jsonl 优先；IDE 侧只留 overview.txt（同一记录形态）→ 两种文件名都支持
    const origin = (await isFileMaybe(transcript)) ? AGY_TRANSCRIPT : (await isFileMaybe(overview)) ? AGY_OVERVIEW : null;
    if (origin === null) {
      skipped.push({ code: 'source-unreadable', origin: rootLabel + '/brain/' + id, detail: 'no-transcript' });
      continue;
    }
    const text = await readTextSafe(path.join(logsDir, origin), opts.maxFileBytes);
    if (text === null) {
      skipped.push({ code: 'source-unreadable', origin: rootLabel + '/brain/' + id + '/' + origin, detail: 'read-error' });
      continue;
    }
    const title = await readAnnotationTitle(root, id);
    const taskMessages = await readTaskMessages(path.join(root, 'brain', id, AGY_MESSAGES_REL), opts.maxFileBytes);
    files.push({ id, parsed: parseAntigravityTranscript(text, { title, taskMessages }) });
  }
  return { files, skipped, truncated };
}

export async function readAntigravity(opts: AntigravityReadOptions): Promise<AntigravityReadResult> {
  const geminiDir = opts.geminiDir;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const findings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const paths: string[] = [];
  const input: AntigravityInput = {};

  const geminiStat = await statOrNull(geminiDir);
  if (geminiStat === null || !geminiStat.isDirectory()) {
    input.readFindings = findings;
    return { found: false, paths, input, unreadable };
  }

  /* 两个 mcp_config.json 位置都探测（全局在前，IDE 侧在后） */
  const mcpTargets: { rel: string; assign: (v: unknown) => void }[] = [
    { rel: 'config/mcp_config.json', assign: (v) => { input.globalMcp = v; } },
    { rel: 'antigravity/mcp_config.json', assign: (v) => { input.ideMcp = v; } },
  ];
  for (const t of mcpTargets) {
    const full = path.join(geminiDir, t.rel);
    const read = await readJsonSafe(full, maxFileBytes);
    if (!read.present) continue;
    paths.push(ANTIGRAVITY_GEMINI_DIR_NAME + '/' + t.rel);
    if (read.empty) {
      // 本机真值就是 0 字节：报码、不解析、绝不产出空 mcp 分区（见 convertAntigravity）
      findings.push({ code: 'source-empty-file', origin: t.rel });
      continue;
    }
    if (read.ok) { t.assign(read.value); continue; }
    unreadable.push(path.join(ANTIGRAVITY_GEMINI_DIR_NAME, t.rel).split(path.sep).join('/'));
    const size = (await statOrNull(full))?.size ?? 0;
    findings.push({
      code: 'source-unreadable',
      origin: t.rel,
      detail: size > maxFileBytes ? 'too-large' : 'json-error',
    });
  }

  /* 凭据文件：只 stat（值绝不读、绝不进内存、绝不进包） */
  const oauthRel = 'antigravity/mcp_oauth_tokens.json';
  if ((await statOrNull(path.join(geminiDir, 'antigravity', 'mcp_oauth_tokens.json'))) !== null) {
    paths.push(ANTIGRAVITY_GEMINI_DIR_NAME + '/' + oauthRel);
    input.oauthTokensPresent = true;
  }

  /* 会话：三根并列各自枚举 brain/<convId>/.system_generated/logs/（真值表同款顺序） */
  const maxSessions = resolveLimit(opts.limits?.maxSessionFiles, opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const sessionFiles: AntigravitySessionInput[] = [];
  let truncated = false;
  for (const rootName of ANTIGRAVITY_ROOTS) {
    if (sessionFiles.length >= maxSessions) {
      truncated = true;
      break;
    }
    const read = await readAntigravityRoot(path.join(geminiDir, rootName), rootName, {
      maxFileBytes,
      maxSessions: maxSessions - sessionFiles.length,
    });
    sessionFiles.push(...read.files);
    findings.push(...read.skipped);
    if (read.truncated) truncated = true;
  }
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'brain', detail: 'max-sessions-reached', count: maxSessions });
  }
  if (sessionFiles.length > 0) input.sessions = sessionFiles;

  input.readFindings = findings;
  return { found: true, paths, input, unreadable };
}
