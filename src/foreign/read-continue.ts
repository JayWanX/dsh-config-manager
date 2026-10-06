/**
 * Continue（`$CONTINUE_GLOBAL_DIR` → ~/.continue）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 continue 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根与「env 整体替换」语义逐字一致）：
 *  - 根：`<CONTINUE_GLOBAL_DIR>/sessions`；env 缺省 = `<home>/.continue/sessions`
 *  - **`CONTINUE_GLOBAL_DIR` 是替换语义**（不是 vibe 的追加语义；read-vault §10.3-3 专门点名
 *    这两种语义并存、实施时逐源确认）
 *  - 会话：`<sessions>/<sessionId>.json`（**单对象 JSON**，不是 JSONL）
 *  - 同目录 `sessions.json` 是**索引数组**（本层只从它取显示名，其余字段一概不读）
 *
 * env 只报**键名**：`CONTINUE_GLOBAL_DIR` 由 wiring 的 `probeEnvKeys` 声明 → 命中即报
 * `source-location-overridden`（origin = 键名）。**值绝不进日志/产物**：本层只用它拼目录路径，
 * 且路径只在本进程内使用，回给 GUI/CLI 的位置标签一律是「相对 home」或最后两段。
 *
 * 字段形态（**fixture 级**，不是 measured）：`{sessionId, title, workspaceDirectory,
 * history:[{message:{role, content, toolCalls|toolCallStates}, contextItems}]}`。
 * 三条规矩：① 认不出的 history 项逐类计数（`unsupported-session-record`）；
 * ② contextItems（上下文附件）不是对话 → 只计数，正文绝不进包；
 * ③ cwd 只来自记录字段（`workspaceDirectory` 一族），没有就按 `session-missing-cwd` 跳过。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 continue 行）。本机无 ~/.continue/sessions，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { envValue, joinFor, normalizePlatform } from './platform-paths.ts';
import { irBump, irEarlier, irSafeTime, irStr, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { firstUserText, flattenText, genericBlocksOf, titleFromRecord } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 环境变量覆盖的键名（**只报键名**；值绝不回传） */
export const CONTINUE_ENV_KEY = 'CONTINUE_GLOBAL_DIR';

/** 索引文件名（不是会话） */
export const CONTINUE_INDEX_NAME = 'sessions.json';

/** 会话目录名（env 存在时替换 `<home>/.continue` 这一整段） */
export const CONTINUE_DIR_NAME = '.continue';

/**
 * Continue 新建会话时写入的**默认标题常量** → 视为「没有显式标题」（参考 convert/continue.mjs 的
 * DEFAULT_TITLE）：源侧把它当占位符，直接当标题会在目标机显示一整排「New Session」。
 */
export const CONTINUE_DEFAULT_TITLE = 'New Session';

/** cwd 的候选字段（Continue 的会话文件里语义唯一的那些键；不含 path/file 这类工具字段） */
const CWD_KEYS: readonly string[] = ['workspaceDirectory', 'cwd', 'workspaceDir', 'directory'];

/** 创建时间候选（按序取第一个可解析值） */
const TIME_KEYS: readonly string[] = ['createdAt', 'startTime', 'dateCreated'];

const MAX_SESSION_FILES = 500;

/**
 * Continue 的会话根（**env 替换语义**）。
 *
 * 探测面直接复用本函数 → `CONTINUE_GLOBAL_DIR` 生效时 detect 也看得到真实位置；
 * 而真值表护栏用**空环境**比对时它退化成 `<home>/.continue/sessions`（与 truth-table.ts
 * 的 defaults 逐字相同），两种口径都不冲突。
 */
export function continueSessionsDir(opts: RootProbeOptions): string {
  const platform = normalizePlatform(opts.platform);
  const overridden = envValue(opts.env, CONTINUE_ENV_KEY);
  const base = overridden !== undefined ? overridden : joinFor(platform, opts.homeDir, CONTINUE_DIR_NAME);
  return joinFor(platform, base, 'sessions');
}

/** 一条已解析的 Continue 会话 */
export interface ContinueSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface ContinueReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** 解析结果：成功给 id + 归一记录；失败给稳定机器码片段 */
export type ContinueParseOutcome =
  | { readonly ok: true; readonly id: string | undefined; readonly parsed: ParsedTranscript }
  | { readonly ok: false; readonly problem: 'json-error' | 'not-an-object' | 'history-not-array' };

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

function firstCwdOf(doc: Record<string, unknown>): string | undefined {
  for (const key of CWD_KEYS) {
    const v = irStr(doc[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function createdAtOf(doc: Record<string, unknown>): IrTimeMs | undefined {
  for (const key of TIME_KEYS) {
    const t = irSafeTime(doc[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 工具入参：字符串若是 JSON 就解析（源侧两种形态并存 —— OpenAI 风格的 `function.arguments`
 * 是 JSON **字符串**，别家直接给对象）。口径与本仓 `session-source.ts` 的 toolInputOf 一致
 * （那份是私有的，此处保留一处等价实现；解析不了就原样传，绝不抛）。
 */
function jsonishInput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

/** 一次工具调用的归一（id 允许为空串：源没给就照抄，绝不伪造） */
interface ContinueCallSource {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** 调用项自身内联的 output/result（源侧少见；toolCallStates 走 stateByCallId 那一支） */
  readonly output?: unknown | undefined;
}

/**
 * 工具上下文（**预扫一次**的产物）。
 *
 * 为什么需要预扫：参考实现是「先把所有 tool 结果消息收进 coveredCallIds，再用
 * toolCallStates[].output 只补**没有**独立结果消息的调用」。我们的 IR 是顺序流，
 * 在解析 assistant 时还不知道后面有没有 `role:'tool'` 消息 → 必须先把这层信息扫出来。
 */
export interface ContinueToolContext {
  /** 历史项上的全部 toolCallStates（顺序 = 源顺序） */
  readonly states: readonly Record<string, unknown>[];
  /** callId → 该 state（首个同 id 者胜） */
  readonly stateByCallId: ReadonlyMap<string, Record<string, unknown>>;
  /** 已有独立 `role:'tool'` 结果消息的 callId（这些调用的结果以消息为准） */
  readonly coveredByToolMessage: ReadonlySet<string>;
}

/** toolCallStates 项的配对键（toolCallId 优先，回退 toolCall.id 与 id） */
function stateCallIdOf(state: Record<string, unknown>): string | undefined {
  const inner = isRecord(state['toolCall']) ? state['toolCall'] : undefined;
  return irStr(state['toolCallId']) ?? irStr(inner?.['id']) ?? irStr(state['id']);
}

/** `toolCallStates[].status === 'errored'` → 结果按错误上报（其余状态一律非错误，参考 stateIsError） */
function stateIsError(state: Record<string, unknown>): boolean {
  return state['status'] === 'errored';
}

/**
 * `toolCallStates[].output` → 结果文本。形态：ContextItem[]（正文在 `.content`）/ 字符串 /
 * 对象；取不到返回 null（**绝不虚构**空结果）。
 */
function stateOutputText(state: Record<string, unknown>): string | null {
  const output = state['output'];
  if (output === undefined || output === null) return null;
  const text = flattenText(output);
  return text === '' ? null : text;
}

/** 历史项上的 toolCallStates（参考读 item.toolCallStates；message 上同名字段一并容忍） */
function toolStatesOf(entry: Record<string, unknown>, msg: Record<string, unknown>): Record<string, unknown>[] {
  const sources: unknown[] = entry === msg ? [entry['toolCallStates']] : [entry['toolCallStates'], msg['toolCallStates']];
  const out: Record<string, unknown>[] = [];
  for (const raw of sources) {
    if (!Array.isArray(raw)) continue;
    for (const item of raw) if (isRecord(item)) out.push(item);
  }
  return out;
}

/** 一个工具调用项 → 归一调用（两个世代的项目形态不同：message.toolCalls 与 state.toolCall） */
function callSourceOf(item: Record<string, unknown>): ContinueCallSource {
  const inner = isRecord(item['toolCall']) ? item['toolCall'] : undefined;
  const fn = inner !== undefined && isRecord(inner['function'])
    ? inner['function']
    : (isRecord(item['function']) ? item['function'] : undefined);
  const id = irStr(item['toolCallId']) ?? irStr(item['id']) ?? irStr(inner?.['id']) ?? '';
  const name = irStr(fn?.['name']) ?? irStr(item['name']) ?? irStr(item['tool']) ?? '';
  const input = jsonishInput(fn?.['arguments'] ?? item['arguments'] ?? item['args'] ?? item['input']);
  const output = item['output'] !== undefined ? item['output'] : item['result'];
  return output === undefined ? { id, name, input } : { id, name, input, output };
}

/** 数组 → 归一调用；非数组 / 非对象逐类计数（同 id 去重，参考 toolCallsOf 的 seen） */
function callSourcesOf(raw: unknown, ignored: Record<string, number>, key: string): ContinueCallSource[] {
  if (!Array.isArray(raw)) {
    irBump(ignored, key + ':not-an-array');
    return [];
  }
  const out: ContinueCallSource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      irBump(ignored, key + ':not-an-object');
      continue;
    }
    const call = callSourceOf(item);
    if (call.id !== '' && seen.has(call.id)) continue;
    if (call.id !== '') seen.add(call.id);
    out.push(call);
  }
  return out;
}

/**
 * 助手消息上的工具调用（两个世代并存：`toolCalls` 与 `toolCallStates`）。
 *
 * 与参考 convert/continue.mjs 对齐的两条口径：
 *  ① `message.toolCalls` 是**权威**，**只在它产出 0 条调用时**才回退 `item.toolCallStates`
 *     —— 两者同时存在时是同一数组的镜像，无条件同时遍历会**重复产出**调用与结果；
 *  ② state 的 output 只补「没有独立 `role:'tool'` 结果消息」的调用，错误位取
 *     `status === 'errored'`（而不是消息上自造的 isError）。
 *
 * 返回调用块；`results` 是出参（配对结果，按源顺序）。
 */
export function continueToolBlocks(
  msg: Record<string, unknown>,
  ctx: ContinueToolContext,
  ignored: Record<string, number>,
  results: IrBlock[],
): IrBlock[] {
  const declared = msg['toolCalls'];
  let calls = declared === undefined ? [] : callSourcesOf(declared, ignored, 'toolCalls');
  if (calls.length === 0) calls = callSourcesOf(ctx.states, ignored, 'toolCallStates');

  const out: IrBlock[] = [];
  for (const call of calls) {
    out.push(irToolCallBlock(call.id, call.name, call.input));
    // 空 id（源没给）不能配对；有独立结果消息的调用以消息为准 → 两者都不在这里补结果
    if (call.id === '' || ctx.coveredByToolMessage.has(call.id)) continue;
    if (call.output !== undefined) {
      results.push(irToolResultBlock(call.id, flattenText(call.output, ignored, 'toolOutput'), false));
      continue;
    }
    const state = ctx.stateByCallId.get(call.id);
    if (state === undefined) continue;
    const text = stateOutputText(state);
    if (text !== null) results.push(irToolResultBlock(call.id, text, stateIsError(state)));
  }
  return out;
}

/** 单对象 JSON → 归一记录（Continue 的会话文件是**一个对象**，不是 JSONL） */
export function parseContinueSession(text: string): ContinueParseOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json-error' };
  }
  if (!isRecord(doc)) return { ok: false, problem: 'not-an-object' };
  const history = doc['history'];
  if (!Array.isArray(history)) return { ok: false, problem: 'history-not-array' };

  const ignored: Record<string, number> = {};
  const records: TranscriptRecord[] = [];
  let raw = 0;
  let bad = 0;
  let createdAt = createdAtOf(doc);

  // 预扫：① 哪些 callId 已有独立的 tool 结果消息；② 全部 toolCallStates（顺序 = 源顺序）
  const coveredByToolMessage = new Set<string>();
  const toolStates: Record<string, unknown>[] = [];
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const msg = isRecord(entry['message']) ? entry['message'] : entry;
    if ((irStr(msg['role']) ?? '').toLowerCase() === 'tool') {
      const callId = irStr(msg['toolCallId']) ?? irStr(msg['tool_call_id']);
      if (callId !== undefined) coveredByToolMessage.add(callId);
    }
    toolStates.push(...toolStatesOf(entry, msg));
  }
  const stateByCallId = new Map<string, Record<string, unknown>>();
  for (const state of toolStates) {
    const callId = stateCallIdOf(state);
    if (callId !== undefined && !stateByCallId.has(callId)) stateByCallId.set(callId, state);
  }
  const toolCtx: ContinueToolContext = { states: toolStates, stateByCallId, coveredByToolMessage };

  // 待落到下一个 assistant 步的推理文本（thinking 消息先到；用于与 item.reasoning.text 去重）
  let pendingThinking = '';
  // 换行符常量：本仓避免在普通字符串里出现裸换行拼接
  const LF = String.fromCharCode(10);

  for (const entry of history) {
    raw += 1;
    if (!isRecord(entry)) {
      bad += 1;
      continue;
    }
    if (Array.isArray(entry['contextItems']) && entry['contextItems'].length > 0) {
      // 上下文附件不是对话内容 → 只计数（正文绝不进包）
      irBump(ignored, 'contextItem', entry['contextItems'].length);
    }
    const msg = isRecord(entry['message']) ? entry['message'] : entry;
    const roleRaw = (irStr(msg['role']) ?? '').toLowerCase();
    const time = irSafeTime(msg['timestamp']) ?? irSafeTime(msg['time']);
    createdAt = irEarlier(createdAt, time);
    const id = irStr(msg['id']);
    if (roleRaw === 'system') {
      irBump(ignored, 'system');
      continue;
    }
    if (roleRaw === 'tool') {
      const callId = irStr(msg['toolCallId']) ?? irStr(msg['tool_call_id']) ?? '';
      const text2 = flattenText(msg['content'], ignored, 'toolResult');
      // 错误位以 toolCallStates[].status === 'errored' 为准（参考 stateIsError）；
      // 源侧消息上没有该 state 时，才回落到消息自身的 isError 标记
      const state = callId === '' ? undefined : stateByCallId.get(callId);
      const isError = state === undefined ? msg['isError'] === true : stateIsError(state);
      records.push({ role: 'user', blocks: [irToolResultBlock(callId, text2, isError)], time, id });
      continue;
    }
    if (roleRaw === 'thinking') {
      // 推理在本地 IR **没有承载位**（IR 词表只有 text / tool_call / tool_result）→
      // 只**显式计数**，绝不把推理伪装成正文；被安全策略隐藏的思考（无正文）单独计数
      const thinkingText = flattenText(msg['content']);
      if (thinkingText.trim() === '') {
        irBump(ignored, 'continue:thinking-redacted');
      } else {
        pendingThinking = pendingThinking === '' ? thinkingText : pendingThinking + LF + thinkingText;
        irBump(ignored, 'continue:thinking');
      }
      continue;
    }
    if (roleRaw !== 'user' && roleRaw !== 'assistant') {
      irBump(ignored, roleRaw === '' ? 'unknown' : 'history:' + roleRaw);
      continue;
    }
    const blocks = genericBlocksOf(msg['content'], ignored, 'block');
    if (roleRaw === 'assistant') {
      // item.reasoning.text（UI 流式累积）与 thinking 消息常是同一段文本 → 去重后另计
      const inline = isRecord(entry['reasoning']) ? irStr(entry['reasoning']['text']) : undefined;
      if (inline !== undefined && inline.trim() !== '' && inline !== pendingThinking) {
        irBump(ignored, 'continue:reasoning');
      }
      pendingThinking = '';
      const results: IrBlock[] = [];
      const calls = continueToolBlocks(msg, toolCtx, ignored, results);
      if (blocks.length === 0 && calls.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      records.push({ role: 'assistant', blocks: [...blocks, ...calls], time, id });
      if (results.length > 0) records.push({ role: 'user', blocks: results, time });
      continue;
    }
    // 新用户回合开始：上一段被打断的思考不串轮（参考 openTurn 里清空 pendingReasoning）
    pendingThinking = '';
    if (blocks.length === 0) {
      irBump(ignored, 'user-empty');
      continue;
    }
    records.push({ role: 'user', blocks, time, id });
  }

  // 默认标题常量不是用户起的名字 → 视为「没有显式标题」，交给首问兜底（参考 DEFAULT_TITLE）
  let title = titleFromRecord(doc, ['title']).trim();
  if (title === CONTINUE_DEFAULT_TITLE) title = '';
  if (title === '') title = firstUserText(records);

  return {
    ok: true,
    id: irStr(doc['sessionId']) ?? irStr(doc['id']),
    parsed: { records, cwd: firstCwdOf(doc), createdAt, title, raw, bad, ignored },
  };
}

/** 索引条目（只读这两项；其余字段一概不读 —— 索引可被手工编辑，畸变条目按缺省处理） */
export interface ContinueIndexEntry {
  /** 源产品自己给会话起的显示名（空串 = 没有；默认标题常量已过滤） */
  readonly title: string;
  /** 创建时间（会话文件本身没有时间戳，只有索引带 dateCreated） */
  readonly createdAt?: IrTimeMs | undefined;
}

/**
 * 索引的 `dateCreated` → 毫秒。
 *
 * 它是 `String(Date.now())`（**毫秒数字串**），不是时间戳文本：纯数字串必须先按数值解析，
 * 交给 `Date.parse` 会得到 NaN（于是 createdAt 退化成导入当天）。其余形态回退 `irSafeTime`。
 */
export function indexTimeOf(v: unknown): IrTimeMs | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isSafeInteger(n) ? n : undefined;
    }
  }
  return irSafeTime(v);
}

/** 索引（`sessions.json`）→ id → {显示名, 创建时间}；认不出来就空映射（绝不因此丢会话） */
export function continueIndexOf(value: unknown): Map<string, ContinueIndexEntry> {
  const out = new Map<string, ContinueIndexEntry>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = irStr(item['sessionId']) ?? irStr(item['id']);
    if (id === undefined) continue;
    // 默认标题常量不是用户起的名字 → 当「没有标题」处理（与 record 侧同一判据）
    const raw = irStr(item['title']) ?? '';
    const title = raw.trim() === CONTINUE_DEFAULT_TITLE ? '' : raw.slice(0, 200);
    const createdAt = indexTimeOf(item['dateCreated'] ?? item['createdAt']);
    out.set(id, createdAt === undefined ? { title } : { title, createdAt });
  }
  return out;
}

/** 索引 → id 显示名映射（保留原导出名与语义；`continueIndexOf` 的薄视图） */
export function sessionTitlesFromIndex(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, entry] of continueIndexOf(value)) {
    if (entry.title !== '') out.set(id, entry.title);
  }
  return out;
}

export async function readContinueSessions(
  opts: ContinueReadOptions,
): Promise<SessionReadOutcome<ContinueSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const sessionsDir = continueSessionsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: ContinueSessionFile[] = [];

  if (!(await isDirectory(sessionsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  const index = await readIndex(joinFor(platform, sessionsDir, CONTINUE_INDEX_NAME), findings, maxBytes);

  // 索引文件本身不是会话 → 按名字排除（不能按后缀排除：它也是 .json）
  const sessionFiles = await listFileNames(
    sessionsDir,
    (name) => name.endsWith('.json') && name !== CONTINUE_INDEX_NAME,
  );
  // 触顶必须**可见**（audit-foreign F4）。
  let truncated = false;
  // 结构自拒的条数：目录里的索引 / JetBrains 留下的空对象 / 别的 .json 不是 Continue 会话
  //（参考 discovery/documents.mjs 先做「sessionId + history」结构签名，不合签名直接不看）
  let nonSessions = 0;
  for (const name of sessionFiles) {
    if (files.length >= maxFiles) { truncated = true; break; }
    const text = await readTextGuarded(joinFor(platform, sessionsDir, name), name, maxBytes, findings);
    if (text === null) continue;
    const outcome = parseContinueSession(text);
    if (!outcome.ok) {
      // 畸形 JSON 仍**响亮**（可能是被截断的真实会话）；「能解析但不是会话文档」才静默跳过并计数
      if (outcome.problem === 'json-error') {
        findings.push({ code: 'source-unreadable', origin: name, detail: outcome.problem });
      } else {
        nonSessions += 1;
      }
      continue;
    }
    const id = outcome.id ?? stemOf(name);
    const fromIndex = index.get(id);
    // 索引里的显示名是**源产品自己给会话起的名字**（比首条用户文本更权威）→ 有就用它；
    // 索引认不出来时退回记录派生标题（绝不因为索引不认识而丢会话）。
    // createdAt：记录里有就采信记录（权威），没有才用索引的 dateCreated（会话文件本身没有时间戳）。
    const parsed = fromIndex === undefined
      ? outcome.parsed
      : {
          ...outcome.parsed,
          ...(fromIndex.title === '' ? {} : { title: fromIndex.title }),
          ...(outcome.parsed.createdAt === undefined && fromIndex.createdAt !== undefined
            ? { createdAt: fromIndex.createdAt }
            : {}),
        };
    files.push({ id, parsed });
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'continue', detail: 'max-sessions-reached', count: maxFiles });
  return {
    files,
    readFindings: findings,
    extraCounts: { 'sessions.candidates': files.length, 'continue.nonSessionFiles': nonSessions },
  };
}

/** 索引读不到 / 0 字节 / 畸形 = 没有显示名与时间（只影响标题/时间，绝不影响会话本身） */
async function readIndex(
  p: string,
  findings: ForeignSkip[],
  maxBytes: number,
): Promise<Map<string, ContinueIndexEntry>> {
  const none = new Map<string, ContinueIndexEntry>();
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return none;
  let text: string;
  try {
    if (st.size > maxBytes) {
      findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'too-large' });
      return none;
    }
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'read-error' });
    return none;
  }
  if (text.trim() === '') {
    findings.push({ code: 'source-empty-file', origin: CONTINUE_INDEX_NAME });
    return none;
  }
  try {
    return continueIndexOf(JSON.parse(text));
  } catch {
    findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'json-error' });
    return none;
  }
}
