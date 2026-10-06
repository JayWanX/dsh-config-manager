/**
 * Kimi（~\.kimi + ~/.kimi-code）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 kimi 行 + §8.4；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告都写明**双根**且根逐字一致）：
 *  - 旧 Kimi CLI：<home>/.kimi/sessions/<md5(workdir)>/<session-id>/wire.jsonl
 *    （同目录还有 context.jsonl 与 state.json）；workdir 映射表 <home>/.kimi/kimi.json
 *    （work_dirs[{path, kaos, last_session_id}]；**目录名 = md5(path)**；kaos 非本地时前缀 <kaos>_）
 *  - 新 Kimi Code：<home>/.kimi-code/sessions/<workspace-id>/<session-id>/agents/main/wire.jsonl
 *    + 同级 state.json；缺 state.json 回退 <home>/.kimi-code/workspaces.json
 *    （条目形态：字符串，或 {root}；对照 import-variants.mjs 的 kimiCodeWorkDirById）
 *  - **无环境变量覆盖**（两条根硬编码，chat-import §3.3 的 env 总表里没有 kimi）
 *
 * **两代 wire 的行形态完全不同**（chat-import §8.4 点名，是本来源最大的坑）：
 *  - 旧 Kimi CLI：每行 {timestamp, message:{type, payload}}，事件名 PascalCase
 *    （TurnBegin / SteerInput / StepBegin / TextPart / ThinkPart / ToolCall / ToolResult /
 *    CompactionBegin / CompactionEnd / SubagentEvent），载荷全在 message.payload；
 *  - 新 Kimi Code：每行直接 {type, time, …}（turn.prompt 的提问在 input；
 *    context.append_loop_event 的正文/思考在 event.part.text|think；工具结果在
 *    event.result.output + event.result.is_error）。
 *  本层按「行里有 message.type」自动识别两代，**不看顶层 type 一个键**。
 *
 * 角色与提问（**不猜**）：turn.prompt 恒为用户输入、旧代次 TurnBegin/SteerInput 的
 * payload.user_input 是提问、TextPart/ThinkPart 恒为 agent 内容；其余判不出角色的
 * 文本事件按类型计数（绝不默认成某一方）。context.append_message 与 turn.prompt
 * 可能携带**同一段文本** → 只在这两种事件相邻且文本相同时去重（detail=duplicate-text）。
 *
 * 工具结果按 tool_call_id/toolCallId 挂回声明它的 assistant 记录，**未配对 / 重复**的
 * 孤儿结果逐条计数（dropped-tool-result），绝不静默丢。
 *
 * cwd 的三档来源（都要求「有据」）：状态文件字段（权威，cwd 或 workDir）→ 旧代次
 * kimi.json 的 md5 反查 → 新代次 workspaces.json 反查（条目 path / root）。
 * 标题：state.json 的 custom_title（或 isCustomTitle+title）> 首条 user 文本。
 * 三档 cwd 都不成立就**不产出会话**（下游按 session-missing-cwd 跳过），绝不猜路径。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 kimi 行）。本机无 ~/.kimi 与 ~/.kimi-code，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import {
  irBump,
  irEarlier,
  irSafeTime,
  irStr,
  irTextBlock,
  irToolCallBlock,
  irToolResultBlock,
  parseJsonlObjects,
} from './session-ir.ts';
import type { IrBlock, IrParseStats, IrTimeMs } from './session-ir.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, isFile, listDirNames, statOrNull } from './session-read.ts';
import { firstUserText, flattenText, genericBlocksOf } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const KIMI_SESSIONS_REL = '.kimi/sessions';
export const KIMI_CODE_SESSIONS_REL = '.kimi-code/sessions';

/** 伴生文件名（真值表 truth-table.ts 的 kimi 行里逐字列出） */
export const KIMI_WORK_DIRS_NAME = 'kimi.json';
export const KIMI_CODE_WORKSPACES_NAME = 'workspaces.json';
export const KIMI_WIRE_NAME = 'wire.jsonl';
export const KIMI_STATE_NAME = 'state.json';

/** 新代次的 wire 在会话目录下的相对路径（<session>/agents/main/wire.jsonl） */
const KIMI_CODE_WIRE_PARTS: readonly string[] = ['agents', 'main', KIMI_WIRE_NAME];

const MAX_SESSION_FILES = 500;

/** cwd 的候选键（保守：**不含** path/file 这类在工具参数里到处都是的键；workDir 是新代次写法） */
const CWD_KEYS: readonly string[] = [
  'cwd', 'workDir', 'workdir', 'workingDirectory', 'working_directory', 'workspacePath', 'workspaceDir', 'projectPath',
];

/** 旧 Kimi CLI 的 sessions 根 */
export function kimiLegacySessionsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.kimi', 'sessions');
}

/** 旧 Kimi CLI 的 workdir 映射表路径 */
export function kimiWorkDirsPath(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.kimi', KIMI_WORK_DIRS_NAME);
}

/** 新 Kimi Code 的 sessions 根 */
export function kimiCodeSessionsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.kimi-code', 'sessions');
}

/** 新 Kimi Code 的 workspaces 表路径 */
export function kimiCodeWorkspacesPath(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.kimi-code', KIMI_CODE_WORKSPACES_NAME);
}

/** 一条已解析的 Kimi 会话 */
export interface KimiSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface KimiReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** md5 十六进制（旧代次的目录名 = md5(workdir)；这只是**反查用的哈希**，不是凭据） */
export function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
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

/** 静默读 JSON（读不到 / 畸形 = undefined；状态文件是**辅助**信息，不单独产码） */
async function readJsonSoft(p: string, maxBytes: number): Promise<unknown> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size === 0 || st.size > maxBytes) return undefined;
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return undefined;
  }
}


/* ---------------- ① 目录名 → cwd 的两张反查表 ---------------- */

/**
 * kimi.json 的 work_dirs[] → 目录名 → cwd。
 *
 * 目录名 = <kaos>_ + md5(path)（kaos 为**非本地**时才有前缀）。「本地」的判据是
 * kaos 缺失 / 空串 / local（大小写不敏感）；认不出的取值按**非本地**处理 —— 保守方向：
 * 宁可不匹配，也不把远端前缀当成 md5 的一部分去反解。
 */
export function workDirMapOf(kimiJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(kimiJson)) return out;
  const dirs = kimiJson['work_dirs'];
  if (!Array.isArray(dirs)) return out;
  for (const item of dirs) {
    if (!isRecord(item)) continue;
    const path = irStr(item['path']);
    if (path === undefined) continue;
    const kaos = irStr(item['kaos']);
    const prefix = kaos === undefined || kaos.toLowerCase() === 'local' ? '' : kaos + '_';
    out.set(prefix + md5Hex(path), path);
  }
  return out;
}

/**
 * workspaces.json → workspaceId → cwd（对象映射 / 数组两种形态都认；认不出就空表）。
 *
 * 条目形态：字符串，或 {path} / {root}（新代次真实写法是 root；对照
 * import-variants.mjs 的 kimiCodeWorkDirById）。
 */
export function workspaceMapOf(workspacesJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const pathOf = (raw: unknown): string | undefined => {
    if (typeof raw === 'string' && raw !== '') return raw;
    if (!isRecord(raw)) return undefined;
    // 这里是**工作区注册表条目**（不是会话记录）：path / root 就是它的规范键，可以放心收
    for (const key of ['path', 'root', ...CWD_KEYS]) {
      const v = irStr(raw[key]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  if (Array.isArray(workspacesJson)) {
    for (const item of workspacesJson) {
      if (!isRecord(item)) continue;
      const id = irStr(item['id']) ?? irStr(item['workspaceId']) ?? irStr(item['workspace_id']);
      const path = pathOf(item);
      if (id !== undefined && path !== undefined) out.set(id, path);
    }
    return out;
  }
  if (!isRecord(workspacesJson)) return out;
  for (const [id, raw] of Object.entries(workspacesJson)) {
    const path = pathOf(raw);
    if (path !== undefined) out.set(id, path);
  }
  return out;
}

/** 状态文件里的 cwd（cwd / workDir；**权威**优先于目录名反查） */
export function cwdOfState(stateJson: unknown): string | undefined {
  if (!isRecord(stateJson)) return undefined;
  for (const key of CWD_KEYS) {
    const v = irStr(stateJson[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * 状态文件里的权威标题：custom_title（重命名）> isCustomTitle === true 时的 title。
 * 对照 import-variants.mjs 的 kimiDeriveArgs。
 */
export function titleOfState(stateJson: unknown): string | undefined {
  if (!isRecord(stateJson)) return undefined;
  const custom = irStr(stateJson['custom_title']);
  if (custom !== undefined) return custom.trim();
  if (stateJson['isCustomTitle'] === true) {
    const title = irStr(stateJson['title']);
    if (title !== undefined) return title.trim();
  }
  return undefined;
}

/* ---------------- ② 两代 wire 事件 → 归一记录 ---------------- */

/** 归一化事件类型：小写、去掉 . 与 _（turn.prompt → turnprompt） */
export function normalizeEventType(raw: string): string {
  return raw.toLowerCase().split('.').join('').split('_').join('');
}

/** 秒/毫秒自动判定（两代 wire 的行时间都可能是 Unix 秒；< 1e11 视为秒） */
function kimiTimeOf(value: unknown): IrTimeMs | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round(value < 1e11 ? value * 1000 : value);
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  return irSafeTime(value);
}

/**
 * 用户输入 → 文本：字符串原样；ContentPart 数组取 text 片段**直接相接**（分隔符 ''），
 * 结果去首尾空白。对照 convert/kimi.mjs 的 kimiUserInputText。
 */
export function kimiUserInputText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const p of value) {
      if (typeof p === 'string') { parts.push(p); continue; }
      if (!isRecord(p)) continue;
      if (typeof p['text'] === 'string') { parts.push(p['text']); continue; }
      if (typeof p['content'] === 'string') parts.push(p['content']);
    }
    return parts.join('').trim();
  }
  if (isRecord(value) && typeof value['text'] === 'string') return value['text'].trim();
  return '';
}

/** 工具入参：字符串若是 JSON 就解析（旧代次 function.arguments 是 JSON 字符串） */
function kimiToolInput(raw: unknown): unknown {
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

/** 工具结果文本：output 优先；为空回退 message（对模型的说明文本），避免空结果吞信息 */
function kimiToolResultText(output: unknown, fallback: unknown, ignored: Record<string, number>): string {
  const text = flattenText(output, ignored, 'toolResult');
  return text !== '' ? text : flattenText(fallback, ignored, 'toolResult');
}

const USER_VALUES: readonly string[] = ['user', 'human', 'prompt', 'usermessage', 'turnprompt'];
const ASSISTANT_VALUES: readonly string[] = ['assistant', 'ai', 'model', 'agent', 'bot', 'kimi', 'assistantmessage'];

/** 无内容的结构性事件：**不算未迁移**，也不产记录 */
const STRUCTURAL_TYPES: readonly string[] = [
  'turnbegin', 'steerinput', 'turnstart', 'turnend', 'turnended', 'stepbegin', 'stepstart', 'stepend', 'stepended',
  'contextappend', 'loopbegin', 'loopend', 'appendloopevent',
];

function eventTypeOf(obj: Record<string, unknown>): string {
  return irStr(obj['type']) ?? irStr(obj['event']) ?? irStr(obj['kind']) ?? '';
}

/** 角色字段候选（事件本体与嵌套的 message 载荷都看；新代次的 role 在 message 里面） */
const ROLE_KEYS: readonly string[] = ['role', 'speaker', 'author', 'from', 'sender'];

function explicitRoleOf(obj: Record<string, unknown>): string | undefined {
  for (const key of ROLE_KEYS) {
    const v = irStr(obj[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function roleOfEvent(obj: Record<string, unknown>, normType: string): 'user' | 'assistant' | undefined {
  const nested = isRecord(obj['message']) ? explicitRoleOf(obj['message']) : undefined;
  const explicit = explicitRoleOf(obj) ?? nested;
  if (explicit !== undefined) {
    const lower = explicit.toLowerCase();
    if (USER_VALUES.includes(lower)) return 'user';
    if (ASSISTANT_VALUES.includes(lower)) return 'assistant';
  }
  // 两代词汇的既定语义（chat-import §8.4）：新代次 turn.prompt = 用户输入；
  // 旧代次 PascalCase 的 TextPart = agent 自己的文本流
  if (normType === 'turnprompt') return 'user';
  if (normType === 'textpart') return 'assistant';
  return undefined;
}

/** 文本载荷：text/content/message/delta/input；message.content 下钻一层 */
function textContentOf(obj: Record<string, unknown>): unknown {
  for (const key of ['text', 'content', 'message', 'delta', 'input']) {
    const v = obj[key];
    if (v === undefined) continue;
    if (isRecord(v) && v['content'] !== undefined) return v['content'];
    return v;
  }
  return undefined;
}

/** wire 解析的中间状态（**显式**状态对象，避免把归一逻辑写成闭包里的隐式状态） */
interface WireState {
  readonly records: TranscriptRecord[];
  readonly ignored: Record<string, number>;
  createdAt: IrTimeMs | undefined;
  textBuf: string[];
  textTime: IrTimeMs | undefined;
  textId: string | undefined;
  pendingKind: 'prompt' | 'message' | undefined;
  pendingText: string | undefined;
  /** 已声明的工具调用 id（用于孤儿结果判定） */
  readonly declaredCalls: Set<string>;
  /** callId → 结果块（解析收尾时按 id 挂回 call 所在 assistant 记录） */
  readonly toolResults: Map<string, { block: IrBlock; time: IrTimeMs | undefined }>;
}

function newWireState(): WireState {
  return {
    records: [], ignored: {}, createdAt: undefined, textBuf: [], textTime: undefined, textId: undefined,
    pendingKind: undefined, pendingText: undefined, declaredCalls: new Set(), toolResults: new Map(),
  };
}

/** 收口「相邻 assistant 文本→一条消息」（wire 是分片流，逐事件成消息会切碎一条回复） */
function flushText(st: WireState): void {
  if (st.textBuf.length === 0) return;
  st.records.push({
    role: 'assistant',
    blocks: [irTextBlock(st.textBuf.join(String.fromCharCode(10)))],
    time: st.textTime,
    id: st.textId,
  });
  st.textBuf = [];
  st.textTime = undefined;
  st.textId = undefined;
}

/** 追加 assistant 文本（相邻分片合并；空串不产记录） */
function pushAssistantText(st: WireState, text: string, time: IrTimeMs | undefined, id: string | undefined): void {
  if (text === '') return;
  if (st.textBuf.length === 0) {
    st.textTime = time;
    st.textId = id;
  }
  st.textBuf.push(text);
}

/**
 * 推入一条 user 记录；context.append_message 与 turn.prompt 携带**同一段文本**且
 * 相邻时去重（只这一对，绝不按「任意相邻同文本」去重）。
 */
function pushUserRecord(
  st: WireState,
  blocks: readonly IrBlock[],
  time: IrTimeMs | undefined,
  id: string | undefined,
  kind: 'prompt' | 'message',
): void {
  flushText(st);
  const flat = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(String.fromCharCode(10));
  if (st.pendingText !== undefined && st.pendingKind !== undefined && st.pendingKind !== kind && st.pendingText === flat) {
    irBump(st.ignored, 'duplicate-text');
    st.pendingKind = kind;
    return;
  }
  st.records.push({ role: 'user', blocks, time, id });
  st.pendingKind = kind;
  st.pendingText = flat;
}

/** 推入一条 assistant 工具调用记录（并登记 callId 供结果配对） */
function pushToolCall(
  st: WireState,
  callId: string,
  name: string,
  input: unknown,
  time: IrTimeMs | undefined,
  id: string | undefined,
): void {
  flushText(st);
  st.records.push({ role: 'assistant', blocks: [irToolCallBlock(callId, name, input)], time, id });
  st.declaredCalls.add(callId);
}

/** 登记工具结果：callId 未声明 / 重复 → 孤儿计数（绝不静默） */
function noteToolResult(st: WireState, callId: string, block: IrBlock, time: IrTimeMs | undefined): void {
  if (callId === '' || !st.declaredCalls.has(callId) || st.toolResults.has(callId)) {
    irBump(st.ignored, 'dropped-tool-result');
    return;
  }
  st.toolResults.set(callId, { block, time });
}

/** 通用事件兜底（未在两代专用分支覆盖的文本事件；判不出角色就按类型计数） */
function handleWireEvent(
  st: WireState,
  obj: Record<string, unknown>,
  normType: string,
  outerTime: IrTimeMs | undefined,
): void {
  const time = kimiTimeOf(obj['time']) ?? kimiTimeOf(obj['timestamp']) ?? outerTime;
  st.createdAt = irEarlier(st.createdAt, time);
  const id = irStr(obj['id']) ?? irStr(obj['messageId']) ?? irStr(obj['message_id']);
  const isToolCall = normType.includes('toolcall') || normType.includes('tooluse');
  const isToolResult = normType.includes('toolresult') || normType.includes('tooloutput') || normType.includes('toolresponse');

  if (isToolCall) {
    flushText(st);
    const name = irStr(obj['name']) ?? irStr(obj['toolName']) ?? irStr(obj['tool']) ?? '';
    const callId = irStr(obj['toolCallId']) ?? irStr(obj['callId']) ?? irStr(obj['id']) ?? '';
    const input = obj['args'] ?? obj['arguments'] ?? obj['input'] ?? obj['parameters'];
    st.records.push({ role: 'assistant', blocks: [irToolCallBlock(callId, name, input)], time, id });
    return;
  }
  if (isToolResult) {
    flushText(st);
    const callId = irStr(obj['toolCallId']) ?? irStr(obj['tool_call_id']) ?? irStr(obj['callId']) ?? irStr(obj['id']) ?? '';
    const body = obj['content'] ?? obj['output'] ?? obj['result'];
    const isError = obj['isError'] === true || obj['is_error'] === true || obj['error'] === true;
    st.records.push({ role: 'user', blocks: [irToolResultBlock(callId, flattenText(body, st.ignored, 'toolResult'), isError)], time, id });
    return;
  }

  const content = textContentOf(obj);
  if (content === undefined) {
    irBump(st.ignored, normType === '' ? 'unknown' : normType);
    return;
  }
  const role = roleOfEvent(obj, normType);
  if (role === undefined) {
    // 判不出角色的文本事件：按类型计数（绝不默认成某一方）
    irBump(st.ignored, normType === '' ? 'unknown' : normType);
    return;
  }
  const blocks = genericBlocksOf(content, st.ignored, 'block');
  if (blocks.length === 0) {
    irBump(st.ignored, normType + ':no-content');
    return;
  }
  const flat = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(String.fromCharCode(10));

  if (role === 'user') {
    pushUserRecord(st, blocks, time, id, normType === 'turnprompt' ? 'prompt' : 'message');
    return;
  }
  pushAssistantText(st, flat, time, id);
}

/** 旧 Kimi CLI 事件（PascalCase；载荷在 message.payload） */
function handleOldEvent(
  st: WireState,
  type: string,
  payload: Record<string, unknown>,
  time: IrTimeMs | undefined,
): void {
  const norm = normalizeEventType(type);
  if (type === 'TurnBegin' || type === 'SteerInput') {
    const prompt = kimiUserInputText(payload['user_input']);
    if (prompt === '') { irBump(st.ignored, norm + ':no-input'); return; }
    pushUserRecord(st, [irTextBlock(prompt)], time, undefined, 'prompt');
    return;
  }
  if (type === 'TextPart') {
    if (typeof payload['text'] === 'string') pushAssistantText(st, payload['text'], time, undefined);
    return;
  }
  if (type === 'ThinkPart') {
    // IR 无 reasoning 块（见 session-ir.ts 头注释）→ 不伪装成正文，逐类计数
    if (typeof payload['think'] === 'string' && payload['think'] !== '') irBump(st.ignored, 'reasoning-block');
    return;
  }
  if (type === 'ToolCall') {
    const fn = isRecord(payload['function']) ? payload['function'] : {};
    const callId = irStr(payload['id']) ?? '';
    const name = irStr(fn['name']) ?? '';
    if (callId === '' || name === '') { irBump(st.ignored, 'toolcall:no-id-or-name'); return; }
    pushToolCall(st, callId, name, kimiToolInput(fn['arguments']), time, undefined);
    return;
  }
  if (type === 'ToolResult') {
    const callId = irStr(payload['tool_call_id']) ?? '';
    const rv = isRecord(payload['return_value']) ? payload['return_value'] : {};
    const body = kimiToolResultText(rv['output'], rv['message'], st.ignored);
    noteToolResult(st, callId, irToolResultBlock(callId, body, rv['is_error'] === true), time);
    return;
  }
  if (type === 'ToolCallPart') return; // 流式参数分块：最终 ToolCall 已带完整参数（对照 convert/kimi.mjs）
  if (type === 'CompactionBegin' || type === 'CompactionEnd') {
    // 参考实现映射为 DSH 原生压缩检查点；本地合成器暂无此能力位（shared 层）→ 计数不静默
    irBump(st.ignored, 'compaction');
    return;
  }
  if (type === 'SubagentEvent') {
    irBump(st.ignored, 'subagent-event');
    return;
  }
  if (STRUCTURAL_TYPES.includes(norm)) return;
  handleWireEvent(st, payload, norm, time);
}

/** 新 Kimi Code 事件（点分小写；每行直接是 {type,…}） */
function handleNewEvent(
  st: WireState,
  type: string,
  rec: Record<string, unknown>,
  time: IrTimeMs | undefined,
): void {
  if (type === 'turn.prompt') {
    // 提问在 input（ContentPart 数组）；兼容历史顶层 text/content 写法
    const raw = rec['input'] !== undefined ? rec['input'] : (rec['text'] !== undefined ? rec['text'] : rec['content']);
    const prompt = kimiUserInputText(raw);
    if (prompt === '') { irBump(st.ignored, 'turnprompt:no-input'); return; }
    pushUserRecord(st, [irTextBlock(prompt)], time, irStr(rec['id']), 'prompt');
    return;
  }
  if (type === 'context.append_loop_event') {
    const event = isRecord(rec['event']) ? rec['event'] : (isRecord(rec['payload']) ? rec['payload'] : undefined);
    if (event === undefined) { irBump(st.ignored, 'contextappendloopevent:no-event'); return; }
    const et = eventTypeOf(event);
    const norm = normalizeEventType(et);
    if (norm === 'stepbegin' || norm === 'stepend') return;
    if (norm === 'contentpart') {
      const part = isRecord(event['part']) ? event['part'] : undefined;
      if (part === undefined) { irBump(st.ignored, 'contentpart:no-part'); return; }
      const pt = typeof part['type'] === 'string' ? part['type'] : '';
      if (pt === 'text') {
        if (typeof part['text'] === 'string') pushAssistantText(st, part['text'], time, undefined);
        return;
      }
      if (pt === 'think') {
        if (typeof part['think'] === 'string' && part['think'] !== '') irBump(st.ignored, 'reasoning-block');
        return;
      }
      if (pt === 'image_url' || pt === 'image' || pt === 'video_url' || pt === 'audio_url') {
        irBump(st.ignored, 'image-block');
        return;
      }
      irBump(st.ignored, 'contentpart:' + (pt === '' ? 'unmapped' : pt));
      return;
    }
    if (norm === 'toolcall') {
      const callId = irStr(event['toolCallId']) ?? '';
      const name = irStr(event['name']) ?? '';
      if (callId === '' || name === '') { irBump(st.ignored, 'toolcall:no-id-or-name'); return; }
      pushToolCall(st, callId, name, kimiToolInput(event['args']), time, undefined);
      return;
    }
    if (norm === 'toolresult') {
      const callId = irStr(event['toolCallId']) ?? '';
      const rv = isRecord(event['result']) ? event['result'] : {};
      const body = kimiToolResultText(rv['output'], rv['message'], st.ignored);
      noteToolResult(st, callId, irToolResultBlock(callId, body, rv['is_error'] === true), time);
      return;
    }
    if (STRUCTURAL_TYPES.includes(norm)) return;
    handleWireEvent(st, event, norm, time);
    return;
  }
  if (type === 'context.apply_compaction') {
    // 参考实现把摘要落成压缩检查点；本地合成器暂无此能力位（shared 层）→ 计数不静默
    irBump(st.ignored, 'compaction');
    return;
  }
  if (type === 'turn.ended') return;
  if (STRUCTURAL_TYPES.includes(normalizeEventType(type))) return;
  handleWireEvent(st, rec, normalizeEventType(type), time);
}

/** 把登记的 tool_result 块挂回声明它的 assistant 记录之后（合成器按位置收进同一 step） */
function applyToolResults(st: WireState): TranscriptRecord[] {
  if (st.toolResults.size === 0) return st.records;
  const out: TranscriptRecord[] = [];
  for (const rec of st.records) {
    out.push(rec);
    if (rec.role !== 'assistant') continue;
    const blocks: IrBlock[] = [];
    let time: IrTimeMs | undefined;
    for (const b of rec.blocks) {
      if (b.type !== 'tool_call') continue;
      const result = st.toolResults.get(b.id);
      if (result === undefined) continue;
      blocks.push(result.block);
      if (time === undefined) time = result.time;
      st.toolResults.delete(b.id);
    }
    if (blocks.length > 0) out.push({ role: 'user', blocks, time });
  }
  return out;
}

/**
 * wire.jsonl → 归一记录（**两代词汇共用一处**）。旧代次每行是
 * {timestamp, message:{type,payload}}、新代次每行直接是 {type,…}，按行自动识别。
 */
export function parseKimiWire(text: string): ParsedTranscript {
  const stats: IrParseStats = { records: 0, unparsable: 0, issues: [] };
  const objects = parseJsonlObjects(text, stats);
  const st = newWireState();

  for (const rec of objects) {
    const msg = isRecord(rec['message']) ? rec['message'] : undefined;
    const isOldWire = msg !== undefined && typeof msg['type'] === 'string';
    if (isOldWire) {
      const payload = isRecord(msg['payload']) ? msg['payload'] : {};
      // 旧 wire 的行时间戳在**顶层**（{timestamp, message:{…}}），载荷里没有
      const outerTime = kimiTimeOf(rec['timestamp']);
      st.createdAt = irEarlier(st.createdAt, outerTime);
      handleOldEvent(st, msg['type'] as string, payload, outerTime);
      continue;
    }
    const type = typeof rec['type'] === 'string' ? rec['type'] : '';
    if (type === '') {
      irBump(st.ignored, 'unknown');
      continue;
    }
    const time = kimiTimeOf(rec['time'] ?? rec['created_at'] ?? rec['timestamp']);
    st.createdAt = irEarlier(st.createdAt, time);
    handleNewEvent(st, type, rec, time);
  }

  flushText(st);
  const records = applyToolResults(st);
  return {
    records,
    createdAt: st.createdAt,
    title: firstUserText(records),
    raw: objects.length + stats.unparsable,
    bad: stats.unparsable,
    ignored: st.ignored,
  };
}

/* ---------------- ③ 入口 ---------------- */

export async function readKimiSessions(opts: KimiReadOptions): Promise<SessionReadOutcome<KimiSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: KimiSessionFile[] = [];

  const legacyRoot = kimiLegacySessionsDir(opts);
  const codeRoot = kimiCodeSessionsDir(opts);
  if (!(await isDirectory(legacyRoot)) && !(await isDirectory(codeRoot))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  const workDirs = workDirMapOf(await readJsonSoft(kimiWorkDirsPath(opts), maxBytes));
  const workspaces = workspaceMapOf(await readJsonSoft(kimiCodeWorkspacesPath(opts), maxBytes));

  /** 两个代次共用的一条会话：wire 位置 + 状态文件位置 + cwd/标题的反查结果 */
  const addSession = async (input: {
    id: string;
    label: string;
    wirePath: string;
    statePath: string;
    cwdFromMapping: string | undefined;
  }): Promise<void> => {
    const text = await readTextGuarded(input.wirePath, input.label, maxBytes, findings);
    if (text === null) return;
    const state = await readJsonSoft(input.statePath, maxBytes);
    const cwd = cwdOfState(state) ?? input.cwdFromMapping;
    const title = titleOfState(state);
    const parsed = parseKimiWire(text);
    files.push({
      id: input.id,
      parsed: {
        ...parsed,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
      },
    });
  };

  // 触顶必须**可见**（audit-foreign F4）：两个代次共同一个上限，任一 break 都置标志。
  let truncated = false;
  /* 旧 Kimi CLI：<root>/<md5(workdir)>/<sid>/{wire.jsonl,state.json} */
  if (await isDirectory(legacyRoot)) {
    for (const workDirName of await listDirNames(legacyRoot)) {
      const workDir = joinFor(platform, legacyRoot, workDirName);
      for (const sid of await listDirNames(workDir)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        const sessionDir = joinFor(platform, workDir, sid);
        const wirePath = joinFor(platform, sessionDir, KIMI_WIRE_NAME);
        if (!(await isFile(wirePath))) continue;
        await addSession({
          id: sid,
          label: KIMI_SESSIONS_REL + '/' + workDirName + '/' + sid + '/' + KIMI_WIRE_NAME,
          wirePath,
          statePath: joinFor(platform, sessionDir, KIMI_STATE_NAME),
          cwdFromMapping: workDirs.get(workDirName),
        });
      }
    }
  }

  /* 新 Kimi Code：<root>/<workspaceId>/<sid>/agents/main/wire.jsonl + 同级 state.json */
  if (await isDirectory(codeRoot)) {
    for (const workspaceId of await listDirNames(codeRoot)) {
      const workspaceDir = joinFor(platform, codeRoot, workspaceId);
      for (const sid of await listDirNames(workspaceDir)) {
        if (files.length >= maxFiles) { truncated = true; break; }
        const sessionDir = joinFor(platform, workspaceDir, sid);
        const wirePath = joinFor(platform, sessionDir, ...KIMI_CODE_WIRE_PARTS);
        if (!(await isFile(wirePath))) continue;
        await addSession({
          id: sid,
          label: KIMI_CODE_SESSIONS_REL + '/' + workspaceId + '/' + sid + '/agents/main/' + KIMI_WIRE_NAME,
          wirePath,
          statePath: joinFor(platform, sessionDir, KIMI_STATE_NAME),
          cwdFromMapping: workspaces.get(workspaceId),
        });
      }
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'kimi', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
