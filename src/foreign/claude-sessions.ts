/**
 * Claude Code 会话（~/.claude/projects/<项目>/<uuid>.jsonl）→ **DSH 会话日志**的转码器（纯函数）。
 *
 * 为什么是转码而不是搬运（两边落盘形态完全不同）：
 *  - Claude Code：纯 JSONL 明文，一行一条记录（type = user / assistant / attachment / queue-operation / system），
 *    cwd 只写在记录字段里；
 *  - DSH：sessions/<projectKey(cwd)>/<id>/session[.vN].jsonl.zstd，是**带校验和的 zstd 帧的拼接**
 *    （首帧 = header 单行 JSON，之后每个 append 批次一帧）；DSH 启动时校验
 *    「日志位置 == projectKey(header.cwd)/id」，不一致直接报 corrupt session log。
 *
 * 三条硬约束：
 *  ① **格式版本必须来自目标机**：DSH 对非本 build 的 header.version 直接拒绝，且列表里**静默跳过**
 *     （用户看到的是「对话消失」，见本仓 G-23）。本模块不猜版本：调用方必须传入
 *     （宿主用 utils/session-format.ts 的 resolveSessionFormatVersion 解析）；本模块只实现 3。
 *  ② **行的形态按 DSH 自己的 codec 对齐，不按本模块的想象**：surfaceOp 标记（user/message、
 *     assistant/message、tool/result 必需）、可选空字段必须省略（request/header 的 tools: [] 会被拒）、
 *     header 的 isSeeded / delegationDepth 必填。这套最小事件集由真实 codec 的
 *     encode → assertV3RowAdmission → createDecoder 三条路径验证过
 *     （复核脚本：outputs/foreign-import-v1/try-dsh-events.mjs）。
 *  ③ **不认识的记录一律计数上报**，绝不静默吞掉。
 *
 * 三段式分层（t4，档 B 前置）：
 *  ① **解析**（本文件）：Claude 记录 → IR（`./session-ir.ts`）；
 *  ② **合成**（`./session-ir.ts` 的 `synthesizeDshRows`）：IR → DSH 行（**所有会话类来源共用**）；
 *  ③ **编码**（本文件）：行 → 字节（zstd 帧拼接 + 校验和）。
 *  本文件**刻意不出现在 file-budget 的 import 白名单里**：它 import 了 `node:fs` 的**类型**用于
 *  构造只读句柄的回调（`ClaudeReadHandle`，追加能力通道），这是**零运行期 I/O** 的类型依赖。
 *  守卫按运行时性质放行（见 file-budget.test.ts 的白名单说明）。
 */
import type { Stats } from 'node:fs';

import { projectKeyOf } from '../core/session-select.ts';
import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import {
  irBump,
  irEarlier,
  irMessage,
  irMessageIdOf,
  irNum,
  irSafeTime,
  irStr,
  irTextBlock,
  irTextOfBlocks,
  irToolCallBlock,
  irToolResultBlock,
  isSafeIrId,
  parseJsonlObjects,
  synthesizeDshRows,
} from './session-ir.ts';
import type {
  DshSessionHeader,
  DshSessionRow,
  IrBlock,
  IrMessage,
  IrParseStats,
  IrSession,
  SynthesisStats,
} from './session-ir.ts';

export type { DshSessionHeader, DshSessionRow } from './session-ir.ts';

/** 本模块已实现行式的 DSH 会话格式版本（其它版本一律拒绝，不猜） */
export const SUPPORTED_DSH_SESSION_FORMAT_VERSIONS: readonly number[] = [3];

/** 单帧的软上限（字节）：把多条事件行合并进一帧，避免「一行一帧」产生上千个帧 */
const FRAME_TARGET_BYTES = 64 * 1024;

/** 该会话的请求头能力声明（从重构前的内联字面量原样搬出，取值一字未改） */
const CLAUDE_PROVIDER = 'claude-code';
const CLAUDE_REASONING_EFFORT = 'medium';
const CLAUDE_MAX_TOKENS = 8192;

export interface ClaudeSessionFile {
  /** 文件名（不含 .jsonl）——同时作为 DSH 侧的会话 id（DSH 要求目录名与 header.id 逐字相同） */
  id: string;
  /** 文件原文 */
  text: string;
}

/**
 * **只读**的文件读取面（additive，2026-10）：**内部**用它支持「大文件只读头尾」的追加通道。
 *
 * 现状：转码器一次吃全文（`ClaudeSessionFile.text`），本接口是**给将来留的扩展位**，不是
 * 现状产物的一部分 —— 因此它**刻意不从本模块再导出**（v1 公开面是 registry/claude-code.ts
 * 到转码器的调用，不是这个内部形状）。真正需要它的是「同一会话被再次导入时只转尾段」那条路
 * （竞品 `tailSessionEvents` 的等价物），属于 t4 之后的档 B 工作。
 */
export interface ClaudeReadHandle {
  readonly id: string;
  /** 只需要文件元信息与大小（宿主侧用 `ctx.fs.stat` 即可满足，避免为了 size 读整份文件） */
  stat(): Promise<Stats>;
  /** 只读前 n 字节（可选实现；未提供时由调用方整读后再截取） */
  readHead?(bytes: number): Promise<string>;
  /** 只读后 n 字节（可选实现） */
  readTail?(bytes: number): Promise<string>;
}

export interface ClaudeSessionInfo {
  records: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  /** 未迁移的记录类型 → 条数（sidechain / attachment / queue-operation / system …） */
  ignored: Record<string, number>;
}

export interface TranscodedSession {
  id: string;
  cwd: string;
  /** 包内相对路径：<projectKey>/<id>/<日志名> */
  relativePath: string;
  data: Uint8Array;
  info: ClaudeSessionInfo;
}

export interface TranscodeOptions {
  /** 目标机 DSH 的 SESSION_FORMAT_VERSION（必填） */
  formatVersion: number;
  /** 时间兜底（记录里没有可解析时间时用） */
  now?: number;
}

export interface TranscodeSkip {
  code:
    | 'session-format-unsupported'
    | 'session-missing-cwd'
    | 'session-unsafe-id'
    | 'session-empty'
    | 'session-unparsable';
  detail?: string;
}

export interface TranscodeResult {
  session?: TranscodedSession;
  skip?: TranscodeSkip;
}

/* ---------------- ① 解析：Claude 记录 → IR ---------------- */

/** Claude 记录里可识别的块（原始形态） */
interface ParsedBlock {
  readonly kind: 'text' | 'call' | 'result' | 'other';
  readonly text: string;
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly isError: boolean;
}

/** `message.usage` 的一个字段（对象外一律 undefined —— 形态不符是「没这回事」，不是「0 用量」） */
function usageField(usage: unknown, key: string): unknown {
  return typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>)[key] : undefined;
}

function blockOf(raw: unknown): ParsedBlock {
  const rec = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (rec === undefined) {
    return { kind: 'other', text: '', id: '', name: '', input: undefined, isError: false };
  }
  const rawType = irStr(rec['type']) ?? '';
  const id = irStr(rec['id']) ?? '';
  const name = irStr(rec['name']);
  const isText = rawType === 'text' || typeof rec['text'] === 'string';
  if (isText) {
    return {
      kind: 'text',
      text: typeof rec['text'] === 'string' ? rec['text'] : '',
      id, name: '', input: undefined, isError: false,
    };
  }
  if (rawType === 'tool_use' && name !== undefined) {
    return { kind: 'call', text: '', id, name, input: rec['input'], isError: false };
  }
  // 工具结果的配对键是 Claude 的 `tool_use_id`（不是块 id）；**空串照抄**（源没给就保持空，
  // 不伪造 —— 伪造会让 tool_result 与 tool/call 的 callId 对不上）
  if (rawType === 'tool_result') {
    const key = irStr(rec['tool_use_id']);
    if (key !== undefined) {
      return { kind: 'result', text: '', id: key, name: '', input: undefined, isError: rec['is_error'] === true };
    }
  }
  return { kind: 'other', text: '', id, name: '', input: undefined, isError: false };
}

/**
 * 内容块抽取：字符串正文 / 数组正文 / 对象正文（含 `text` 字段）。
 *
 * 注意第三条分支（数组里的**对象**且带 text）会被当作文本块 —— 这是重构前的**既有行为**，
 * 逐字节回归钉住了它；改它会改变产物（用户在会话里看到多余/缺失的文本块）。
 */
function blocksOf(message: unknown): ParsedBlock[] {
  const msg = typeof message === 'object' && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
  if (msg === undefined) return [];
  const content = msg['content'];
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content, id: '', name: '', input: undefined, isError: false }];
  }
  // 唯一口径：**每个元素都走同一个块解析器**（重构前对数组元素逐个判 type，与 blockOf 的
  // 「类文本 / tool_use / tool_result」三分支同解；逐字节回归钉住这一等价性）
  if (!Array.isArray(content)) return [];
  const out: ParsedBlock[] = [];
  for (const raw of content) out.push(blockOf(raw));
  return out;
}

/** 块 → IR（工具结果在此拍平成文本；其它块保持文本投影） */
function irBlockOf(block: ParsedBlock): IrBlock {
  if (block.kind === 'call') return irToolCallBlock(block.id, block.name, block.input);
  if (block.kind === 'result') return irToolResultBlock(block.id, block.text, block.isError);
  return irTextBlock(block.text);
}

/** 一条 Claude 记录 → IR 消息；`undefined` = 该记录不产出消息（未迁移的类型） */
function irMessageOf(
  rec: Record<string, unknown>,
  parsed: readonly ParsedBlock[],
  index: number,
): IrMessage | undefined {
  const type = irStr(rec['type']) ?? 'unknown';
  const uuid = rec['uuid'];
  if (type === 'assistant') {
    const msg = typeof rec['message'] === 'object' && rec['message'] !== null
      ? (rec['message'] as Record<string, unknown>)
      : undefined;
    const usage = msg === undefined ? undefined : msg['usage'];
    return irMessage(irMessageIdOf(uuid, index), 'assistant', parsed.map(irBlockOf), {
      source: { model: irStr(msg?.['model']) ?? '' },
      usage: {
        inputTokens: irNum(usageField(usage, 'input_tokens')),
        outputTokens: irNum(usageField(usage, 'output_tokens')),
        cacheReadTokens: irNum(usageField(usage, 'cache_read_input_tokens')),
      },
      time: irSafeTime(rec['timestamp']),
    });
  }
  if (type === 'user') {
    return irMessage(irMessageIdOf(uuid, index), 'user', parsed.map(irBlockOf), {
      time: irSafeTime(rec['timestamp']),
    });
  }
  return undefined;
}

/**
 * Claude 会话原文 → IR（**纯函数，不读盘**）。
 *
 * 反应：坏行不抛、计数上报（`stats.unparsable`）；缺 cwd 时**不产出会话**（由调用方转成 skip 码），
 * 因为 DSH 会按 cwd 的目录键归位，猜一个 cwd 等于把会话放到错误的项目里。
 */
export function parseClaudeSession(
  file: ClaudeSessionFile,
  options: TranscodeOptions,
  stats?: IrParseStats,
): IrSession | undefined {
  const parsed = parseClaudeSessionText(file, options);
  if (stats !== undefined) {
    stats.records = parsed.records.length;
    stats.unparsable = parsed.unparsable;
  }
  return parsed.records.length === 0 ? undefined : parsed.session;
}

function typeOf(rec: Record<string, unknown>): string {
  return irStr(rec['type']) ?? 'unknown';
}

/**
 * 一次解析出的全部记账（供转码入口判定 skip 面与合成所需的源侧提示）。
 *
 * `messages` 的长度与 `records.length` **刻意可以不等**：只有 user/assistant 记录进 IR，
 * 其余类型由合成期按「未迁移记录类型」计数（与重构前逐字一致）。
 */
interface ParsedClaudeSession {
  readonly session: IrSession;
  readonly records: readonly Record<string, unknown>[];
  readonly cwd: string | undefined;
  readonly unparsable: number;
  readonly title: string;
}

/**
 * 解析入口：**只走一遍 JSON.parse**，把「记录 / cwd / 最早时间 / IR 消息 / 标题」一次算齐。
 *
 * 为什么必须只走一遍：文本解析是这里唯一的热点（长会话可达数 MB），重构前也只解析一次；
 * 分成「解析 IR」+「再解析原始记录取标题」两遍会让大文件成本翻倍。
 */
function parseClaudeSessionText(file: ClaudeSessionFile, options: TranscodeOptions): ParsedClaudeSession {
  const stats: IrParseStats = { records: 0, unparsable: 0, issues: [] };
  const records = parseJsonlObjects(file.text, stats);

  let cwd: string | undefined;
  let createdAt: number | undefined;
  for (const r of records) {
    if (cwd === undefined) cwd = irStr(r['cwd']);
    createdAt = irEarlier(createdAt, irSafeTime(r['timestamp']));
  }

  const messages: IrMessage[] = [];
  let messageIndex = 0;
  let firstUserText = '';
  for (const rec of records) {
    const type = typeOf(rec);
    if (type !== 'user' && type !== 'assistant') continue;
    const blocks = blocksOf(rec['message']);
    const message = irMessageOf(rec, blocks, messageIndex);
    if (message === undefined) continue;
    messages.push(message);
    // 消息 id 的兜底序 = 「第几条已知消息」（重构前的序号语义，逐字节回归钉住）
    messageIndex++;
    if (type === 'user' && firstUserText === '') {
      const text = irTextOfBlocks(blocks.map(irBlockOf));
      if (text.trim() !== '') firstUserText = text;
    }
  }

  const now = options.now ?? Date.now();
  return {
    session: {
      id: file.id,
      cwd: cwd ?? '',
      createdAt: createdAt ?? now,
      records: records.length,
      messages,
    },
    records,
    cwd,
    unparsable: stats.unparsable,
    title: titleOf(records, firstUserText),
  };
}

/* ---------------- ② ③ 合成 + 编码 ---------------- */

/** 标题：Claude 的 summary 记录优先，否则首条用户文本前 80 字（折叠空白） */
function titleOf(records: readonly Record<string, unknown>[], firstUserText: string): string {
  for (const r of records) {
    if (irStr(r['type']) === 'summary') {
      const s = irStr(r['summary']);
      if (s !== undefined) return s.slice(0, 200);
    }
  }
  return firstUserText.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 日志文件名（与 DSH 的 generation 命名一致：v0 无后缀，vN 带 .vN） */
export function dshSessionLogName(version: number): string {
  return version === 0 ? 'session.jsonl.zstd' : 'session.v' + version + '.jsonl.zstd';
}

export function transcodeClaudeSession(file: ClaudeSessionFile, options: TranscodeOptions): TranscodeResult {
  if (!SUPPORTED_DSH_SESSION_FORMAT_VERSIONS.includes(options.formatVersion)) {
    return { skip: { code: 'session-format-unsupported', detail: String(options.formatVersion) } };
  }
  if (!isSafeIrId(file.id)) return { skip: { code: 'session-unsafe-id', detail: file.id } };

  const parsed = parseClaudeSessionText(file, options);
  if (parsed.records.length === 0) return { skip: { code: 'session-empty' } };
  if (parsed.cwd === undefined) return { skip: { code: 'session-missing-cwd', detail: file.id } };
  // 有内容但一行都解析不出来：如实区分「空文件」与「解析不了」（诊断更准，不新增码 —— 两者
  // 在下游都是「这条会话没有产出」，区别只在忽略计数里可见）
  if (parsed.session.messages.length === 0 && parsed.unparsable > 0) {
    return { skip: { code: 'session-unparsable', detail: file.id } };
  }

  const now = options.now ?? Date.now();
  const stats: SynthesisStats = {
    ignored: {},
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
  };
  if (parsed.unparsable > 0) irBump(stats.ignored, 'unparsable', parsed.unparsable);

  // 未迁移的记录类型**逐类计数**（sidechain / attachment / queue-operation / system …）——
  // IR 只承载 user/assistant 消息，所以这里按原始记录把其余类型补进忽略计数
  for (const rec of parsed.records) {
    const type = typeOf(rec);
    if (type === 'user' || type === 'assistant') continue;
    irBump(stats.ignored, type);
  }

  const rows = synthesizeDshRows(parsed.session, {
    title: parsed.title,
    titleSource: { kind: 'fallback' },
    emptyBlocks: [],
    provider: CLAUDE_PROVIDER,
    reasoningEffort: CLAUDE_REASONING_EFFORT,
    maxTokens: CLAUDE_MAX_TOKENS,
  }, stats, now);

  if (rows.length === 0) return { skip: { code: 'session-empty' } };

  const header: DshSessionHeader = {
    type: 'session',
    version: options.formatVersion,
    id: file.id,
    createdAt: parsed.session.createdAt,
    cwd: parsed.cwd,
    isSeeded: false,
    delegationDepth: 0,
  };
  const data = encodeDshSessionLog(header, rows);
  return {
    session: {
      id: file.id,
      cwd: parsed.cwd,
      relativePath: projectKeyOf(parsed.cwd) + '/' + file.id + '/' + dshSessionLogName(options.formatVersion),
      data,
      info: {
        records: parsed.records.length,
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        ignored: stats.ignored,
      },
    },
  };
}

/** 帧拼接：首帧 = header 单行 JSON，之后每批事件一帧（与 DSH 的物理编码一致，帧带内容校验和） */
export function encodeDshSessionLog(header: DshSessionHeader, rows: readonly DshSessionRow[]): Uint8Array {
  const encoder = new TextEncoder();
  const frames: Uint8Array[] = [encodeZstdFrame(encoder.encode(JSON.stringify(header) + '\n'))];
  let batch: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    frames.push(encodeZstdFrame(encoder.encode(batch.join('\n') + '\n')));
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const line = JSON.stringify(row);
    batch.push(line);
    bytes += line.length + 1;
    if (bytes >= FRAME_TARGET_BYTES) flush();
  }
  flush();
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
