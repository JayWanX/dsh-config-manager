/**
 * Gemini CLI（~\.gemini/history）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（**四份报告交叉核对**，有出入以 read-chat-import.md §3.1 为准）：
 *  - 根：`<home>/.gemini/history`（三平台同形，**无环境变量覆盖**）
 *    · chat-import §3.1 / read-movein.md 附录 A / read-vault.md §10.2 三份**根逐字一致**；
 *    · PLAN-B-draft §0.3 与 captain 的任务表把「形态」写成 JSONL —— **与 chat-import 冲突**。
 *  - 会话文件：`<history>/<slot>/chats/session-*.json`
 *  - **形态 = 单对象 JSON，不是 JSONL**（chat-import §3.1 与 §8.4 两处都明确写「JSON（单文件
 *    一对象，非 JSONL）」）→ **以 chat-import 为准**，本层按单对象解析。若按 JSONL 逐行解析，
 *    一个格式化过的文件会整份解析失败（bad 计数全量），是本任务最容易踩的一处。
 *  - 顶层 `{sessionId, projectHash, startTime, directories, kind, messages[]}`；`directories[0]` = cwd
 *  - messages 项 `{type:user|gemini|info, content, model, toolCalls, thoughts}`；
 *    工具结果**内联在 toolCalls[].result**（与 Claude「结果另起一条消息」不同）
 *
 * 三条归一（都在本层做实，翻译层只做草稿装配）：
 *  ① `type: 'info'` 不是消息 → 逐类计数（绝不静默丢）；
 *  ② `toolCalls[]` 拆成 **assistant(tool_call) + user(tool_result)** 两条归一记录 —— DSH 合成器
 *     硬校验「工具生命周期闭合」（tool/call 与 tool/result 必须落在同一 step 且结果跟在后面），
 *     不拆会让结果无处归位；
 *  ③ `thoughts`（源侧 reasoning）在 IR 里**没有承载块**（IrBlock 只有 text/tool_call/tool_result）
 *     → 逐条计数并如实报 `unsupported-session-record`，绝不当作正文塞进对话。
 *
 * cwd：直接采信 `directories[0]`（记录字段，非推导）→ 不需要 session-cwd-derived；
 * 缺失时下游按 `session-missing-cwd` 跳过（绝不猜）。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 gemini 行）。本机无 ~/.gemini/history，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { irBump, irEarlier, irSafeTime, irStr, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, statOrNull, stemOf, walkFiles } from './session-read.ts';
import { firstUserText, flattenText, genericBlocksOf, titleFromRecord } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const GEMINI_HISTORY_REL = '.gemini/history';

/**
 * 会话文件名（chat-import §3.1：`<slot>/chats/session-*.json`）。
 *
 * 两处与参考逐字对齐（convert 侧 discovery/gemini.mjs:20 是 `/^session-.+\.json$/i`）：
 *  · `.+` 而非 `.*` —— 拒绝 `session-.json`（空 stem 不是合法会话名，会产出空 id 会话）；
 *  · `i` 大小写不敏感 —— 真机上出现过 `Session-*.json` 的坑位（漏读 = 用户以为会话消失）。
 */
export const GEMINI_SESSION_FILE_RE = /^session-.+\.json$/i;

const MAX_SESSION_FILES = 500;

/** 消息时间字段候选（顶层 startTime 之外，单条消息也可能带时间） */
const MESSAGE_TIME_KEYS: readonly string[] = ['timestamp', 'time', 'startTime', 'createdAt', 'created_at', 'ts'];

/** Gemini CLI 的历史根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function geminiHistoryDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.gemini', 'history');
}

/** 一条已解析的 Gemini 会话 */
export interface GeminiSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface GeminiReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** 解析结果：成功给 id + 归一记录；失败给稳定机器码片段（调用方转成 source-unreadable） */
export type GeminiParseOutcome =
  | { readonly ok: true; readonly id: string | undefined; readonly parsed: ParsedTranscript }
  | { readonly ok: false; readonly problem: 'json-error' | 'not-an-object' | 'messages-not-array' };

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

function timeOf(rec: Record<string, unknown>): IrTimeMs | undefined {
  for (const key of MESSAGE_TIME_KEYS) {
    const t = irSafeTime(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 内联工具结果文本（chat-import convert/gemini.mjs:105-116）。
 *
 * **必须走专用口径**：真实形态是 `result[].functionResponse.response.output`，而通用
 * `flattenText` 只认 text/content/message —— 交给它必然返回空串（导入后工具结果全空）。
 * 取值顺序：逐条 functionResponse.response.output → `resultDisplay`（参考的兜底，本仓此前完全没有）
 * → 通用文本投影（容忍非官方变体：本仓既有夹具用 `result: '文本'`）。
 */
export function geminiToolResultText(item: Record<string, unknown>, ignored: Record<string, number>): string | undefined {
  const result = item['result'];
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (!isRecord(entry)) continue;
      const functionResponse = entry['functionResponse'];
      const response = isRecord(functionResponse) ? functionResponse['response'] : undefined;
      const output = isRecord(response) ? response['output'] : undefined;
      if (typeof output === 'string') return output;
    }
  }
  if (result !== undefined) {
    const fallback = flattenText(result, ignored, 'toolResult');
    if (fallback !== '') return fallback;
  }
  if (typeof item['resultDisplay'] === 'string') return item['resultDisplay'];
  return undefined;
}

/**
 * `toolCalls[]` → 工具块。
 *
 * 返回值 = **调用块**（写进 assistant 那条记录）；`results` 是出参，收集**内联结果**
 * （写进紧随其后的 user 记录）。
 *
 * id 缺省时铸 `gemini-<turn>-<n>`（chat-import convert/gemini.mjs:72 同款）：合成器对空
 * callId 会**只改写调用侧**为 `call-<消息序>`（session-ir.ts:389），结果侧仍是空串 →
 * tool/result 与 tool/call 配对断裂（会话被判损坏）。铸 id 后两侧同源，配对恒闭合。
 */
export function geminiToolBlocks(
  raw: unknown,
  ignored: Record<string, number>,
  results: IrBlock[],
  turn = 0,
): IrBlock[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    irBump(ignored, 'toolCalls:not-an-array');
    return [];
  }
  const out: IrBlock[] = [];
  let index = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      irBump(ignored, 'toolCall:not-an-object');
      continue;
    }
    index += 1;
    const name = irStr(item['name']) ?? irStr(item['toolName']) ?? '';
    const id = irStr(item['id']) ?? irStr(item['callId']) ?? 'gemini-' + String(turn) + '-' + String(index);
    const input = item['args'] ?? item['arguments'] ?? item['input'] ?? item['parameters'];
    out.push(irToolCallBlock(id, name, input));
    // 「工具结果内联在 toolCalls[].result」是 gemini 与 Claude 的关键差异（chat-import §8.4）
    const hasResult = item['result'] !== undefined || typeof item['resultDisplay'] === 'string';
    if (hasResult) {
      const text = geminiToolResultText(item, ignored) ?? '';
      // 与参考的差异：参考在取不到文本时整条丢弃结果，本仓 IR 没有「自动补空结果」的合成步骤
      // （session-ir.ts 的待办），丢弃会让调用侧悬空 → 补一条空文本结果，保持生命周期闭合。
      const isError = item['isError'] === true || item['is_error'] === true || item['error'] === true
        || item['status'] === 'error';
      results.push(irToolResultBlock(id, text, isError));
    }
  }
  return out;
}

/** 单对象 JSON → 归一记录（**不是** JSONL：整份文件是一个对象） */
export function parseGeminiSession(text: string): GeminiParseOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json-error' };
  }
  if (!isRecord(doc)) return { ok: false, problem: 'not-an-object' };
  const messages = doc['messages'];
  if (!Array.isArray(messages)) return { ok: false, problem: 'messages-not-array' };

  const ignored: Record<string, number> = {};
  const records: TranscriptRecord[] = [];
  let raw = 0;
  let bad = 0;
  // 已开启的用户回合数（1 基；仅用于缺 id 工具的兜底 id `gemini-<turn>-<n>`，与参考同口径）
  let turn = 0;
  let createdAt: IrTimeMs | undefined = irSafeTime(doc['startTime']);

  for (const item of messages) {
    if (!isRecord(item)) {
      raw += 1;
      bad += 1;
      continue;
    }
    raw += 1;
    const type = irStr(item['type']) ?? '';
    const lower = type.toLowerCase();
    const role: 'user' | 'assistant' | undefined =
      lower === 'user' ? 'user'
        : lower === 'gemini' || lower === 'model' || lower === 'assistant' ? 'assistant'
          : undefined;
    if (role === undefined) {
      // 'info' 等非消息记录：逐类计数（绝不静默丢）
      irBump(ignored, lower === '' ? 'unknown' : lower);
      continue;
    }
    const time = timeOf(item);
    createdAt = irEarlier(createdAt, time);
    const model = irStr(item['model']);
    const id = irStr(item['id']);
    const blocks = genericBlocksOf(item['content'], ignored, 'block');
    if (role === 'assistant') {
      const results: IrBlock[] = [];
      const calls = geminiToolBlocks(item['toolCalls'], ignored, results, turn);
      if (item['thoughts'] !== undefined) irBump(ignored, 'thoughts');
      if (blocks.length === 0 && calls.length === 0) {
        irBump(ignored, 'gemini-empty');
        continue;
      }
      const callRecord: TranscriptRecord = { role, blocks: [...blocks, ...calls], time, id };
      records.push(model === undefined ? callRecord : { ...callRecord, model });
      if (results.length > 0) records.push({ role: 'user', blocks: results, time });
      continue;
    }
    if (blocks.length === 0) {
      irBump(ignored, 'user-empty');
      continue;
    }
    const userRecord: TranscriptRecord = { role, blocks, time, id };
    records.push(model === undefined ? userRecord : { ...userRecord, model });
    turn += 1;
  }

  let title = titleFromRecord(doc, ['title', 'summary']);
  if (title === '') title = firstUserText(records);

  const directories = doc['directories'];
  const cwd = Array.isArray(directories) ? firstStringOf(directories) : undefined;

  return { ok: true, id: irStr(doc['sessionId']), parsed: { records, cwd, createdAt, title, raw, bad, ignored } };
}

function firstStringOf(values: readonly unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

export async function readGeminiSessions(opts: GeminiReadOptions): Promise<SessionReadOutcome<GeminiSessionFile>> {
  const historyDir = geminiHistoryDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: GeminiSessionFile[] = [];

  if (!(await isDirectory(historyDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // <history>/<slot>/chats/session-*.json = 根下 3 层。walkFiles 只回数组、不报是否触顶 →
  // 多要一条：拿到 maxFiles+1 条即**证明**触顶（audit-foreign F4，绝不静默截断）。
  const walkedAll = await walkFiles(historyDir, {
    match: (name) => GEMINI_SESSION_FILE_RE.test(name),
    maxDepth: 3,
    maxFiles: maxFiles + 1,
  });
  const truncated = walkedAll.length > maxFiles;
  const walked = truncated ? walkedAll.slice(0, maxFiles) : walkedAll;
  for (const entry of walked) {
    const label = GEMINI_HISTORY_REL + '/' + entry.rel;
    const text = await readTextGuarded(entry.abs, label, maxBytes, findings);
    if (text === null) continue;
    const outcome = parseGeminiSession(text);
    if (!outcome.ok) {
      findings.push({ code: 'source-unreadable', origin: label, detail: outcome.problem });
      continue;
    }
    files.push({ id: outcome.id ?? stemOf(entry.name), parsed: outcome.parsed });
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'gemini', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
