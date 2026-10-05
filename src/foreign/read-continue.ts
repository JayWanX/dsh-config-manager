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

/**
 * 助手消息上的工具调用（两个世代并存：`toolCalls` 与 `toolCallStates`）。
 * 返回调用块；`results` 是出参（内联 output 的配对结果）。
 */
export function continueToolBlocks(
  msg: Record<string, unknown>,
  ignored: Record<string, number>,
  results: IrBlock[],
): IrBlock[] {
  const out: IrBlock[] = [];
  for (const key of ['toolCalls', 'toolCallStates']) {
    const raw = msg[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      irBump(ignored, key + ':not-an-array');
      continue;
    }
    for (const item of raw) {
      if (!isRecord(item)) {
        irBump(ignored, key + ':not-an-object');
        continue;
      }
      const inner = isRecord(item['toolCall']) ? item['toolCall'] : undefined;
      const fn = inner !== undefined && isRecord(inner['function'])
        ? inner['function']
        : (isRecord(item['function']) ? item['function'] : undefined);
      const id = irStr(item['toolCallId']) ?? irStr(item['id']) ?? irStr(inner?.['id']) ?? '';
      const name = irStr(fn?.['name']) ?? irStr(item['name']) ?? irStr(item['tool']) ?? '';
      const input = jsonishInput(fn?.['arguments'] ?? item['arguments'] ?? item['args'] ?? item['input']);
      out.push(irToolCallBlock(id, name, input));
      if (item['output'] !== undefined) {
        results.push(irToolResultBlock(id, flattenText(item['output'], ignored, 'toolOutput'), false));
      } else if (item['result'] !== undefined) {
        results.push(irToolResultBlock(id, flattenText(item['result'], ignored, 'toolOutput'), false));
      }
    }
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
      records.push({ role: 'user', blocks: [irToolResultBlock(callId, text2, msg['isError'] === true)], time, id });
      continue;
    }
    if (roleRaw !== 'user' && roleRaw !== 'assistant') {
      irBump(ignored, roleRaw === '' ? 'unknown' : 'history:' + roleRaw);
      continue;
    }
    const blocks = genericBlocksOf(msg['content'], ignored, 'block');
    if (roleRaw === 'assistant') {
      const results: IrBlock[] = [];
      const calls = continueToolBlocks(msg, ignored, results);
      if (blocks.length === 0 && calls.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      records.push({ role: 'assistant', blocks: [...blocks, ...calls], time, id });
      if (results.length > 0) records.push({ role: 'user', blocks: results, time });
      continue;
    }
    if (blocks.length === 0) {
      irBump(ignored, 'user-empty');
      continue;
    }
    records.push({ role: 'user', blocks, time, id });
  }

  let title = titleFromRecord(doc, ['title']);
  if (title === '') title = firstUserText(records);

  return {
    ok: true,
    id: irStr(doc['sessionId']) ?? irStr(doc['id']),
    parsed: { records, cwd: firstCwdOf(doc), createdAt, title, raw, bad, ignored },
  };
}

/** 索引（`sessions.json`）→ id 显示名映射；只取名字，认不出来就空映射（绝不因此丢会话） */
export function sessionTitlesFromIndex(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = irStr(item['sessionId']) ?? irStr(item['id']);
    const title = irStr(item['title']);
    if (id !== undefined && title !== undefined) out.set(id, title.slice(0, 200));
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

  const names = await readIndex(joinFor(platform, sessionsDir, CONTINUE_INDEX_NAME), findings, maxBytes);

  // 索引文件本身不是会话 → 按名字排除（不能按后缀排除：它也是 .json）
  const sessionFiles = await listFileNames(
    sessionsDir,
    (name) => name.endsWith('.json') && name !== CONTINUE_INDEX_NAME,
  );
  // 触顶必须**可见**（audit-foreign F4）。
  let truncated = false;
  for (const name of sessionFiles) {
    if (files.length >= maxFiles) { truncated = true; break; }
    const text = await readTextGuarded(joinFor(platform, sessionsDir, name), name, maxBytes, findings);
    if (text === null) continue;
    const outcome = parseContinueSession(text);
    if (!outcome.ok) {
      findings.push({ code: 'source-unreadable', origin: name, detail: outcome.problem });
      continue;
    }
    const id = outcome.id ?? stemOf(name);
    const fromIndex = names.get(id);
    // 索引里的显示名是**源产品自己给会话起的名字**（比首条用户文本更权威）→ 有就用它；
    // 索引认不出来时退回记录派生标题（绝不因为索引不认识而丢会话）
    const parsed = fromIndex === undefined ? outcome.parsed : { ...outcome.parsed, title: fromIndex };
    files.push({ id, parsed });
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'continue', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}

/** 索引读不到 / 0 字节 / 畸形 = 没有显示名（只影响标题，绝不影响会话本身） */
async function readIndex(p: string, findings: ForeignSkip[], maxBytes: number): Promise<Map<string, string>> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return new Map<string, string>();
  let text: string;
  try {
    if (st.size > maxBytes) {
      findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'too-large' });
      return new Map<string, string>();
    }
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'read-error' });
    return new Map<string, string>();
  }
  if (text.trim() === '') {
    findings.push({ code: 'source-empty-file', origin: CONTINUE_INDEX_NAME });
    return new Map<string, string>();
  }
  try {
    return sessionTitlesFromIndex(JSON.parse(text));
  } catch {
    findings.push({ code: 'source-unreadable', origin: CONTINUE_INDEX_NAME, detail: 'json-error' });
    return new Map<string, string>();
  }
}
