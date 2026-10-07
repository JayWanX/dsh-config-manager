/**
 * 会话体检的**宿主侧只读采集器**（T3）：把 <home>/sessions 扫成「每条会话一行事实」，
 * 交给 `core/session-health.ts` 做分类。**本模块绝不写任何字节**。
 *
 * 分层纪律：会话容器的字节结构属 DSH 存储细节 —— core 不得 import 本模块（AGENTS.md），
 * 所以这里的产物是**已经读出来的事实**（数值 / 字符串 / 结构结论），不是字节。
 *
 * 两档体检（设计稿 §9.3 的结论：零依赖结构体检为默认，深度解码为可选增强）：
 *  ① 结构档（恒做）：帧扫描（撕裂尾帧 / 非法帧）+ 首帧 header；
 *  ② 行档（**限额内**才做，默认 200 条）：解压各帧 → 逐行 JSON —— 只做**能从字节证明**的判定
 *     （不可解析行 / 字节相同的重复已提交行 / seq 空洞 / **能证明撞上真实续写**的合成 closer 块）。
 *     注意「合成 closer」的形状判据只是**必要条件**：真机实测（2026-10-04）只看形状会把每一次正常的
 *     「回合结束 → 下一个回合开始」都误报成崩溃残留（同一台机器 86 条健康会话被误报为 nextRequestFails），
 *     所以还必须证明「收尾块之后、下一个 turn/start 之前，同一个 turn 还在继续」。
 *
 * 「绝不猜」：任何读不出的东西一律记成事实缺省（`unreadable` / 计数字段），既不当作「没问题」，
 * 也不编造具体原因。
 *
 * 工具生命周期判定（T4）全部**只从行文本证明**，不引入 DSH codec：
 *  ① 缺 message id（user/message 的 data.id、assistant/message 与 tool/result 的 data.message.id）；
 *  ② 空 tool-call id（tool/call.callId 或 assistant/message 内容里 tool-call 块的 id）；
 *  ③ 已关闭 step 里的悬空 tool-call —— **两种声明载体合并判定**：tool/call 行，以及只由
 *     assistant/message 内容块（type:`tool-call`）声明、没有对应 tool/call 行的调用
 *     （官方 ToolCallRecovery 的待恢复集合正是以 assistant 内容块为入口）；尾部仍开着的 step
 *     是正常崩溃形状，不报；
 *  ④ 同一步内重复通告的 tool-call id；
 *  ⑤ tool/result 的 toolCallId 与 message.source.callId 不配对。
 *
 * 严重级**不是注释断言，是真 codec 实测**（2026-10-06，真机日志 + 官方读取路径；t13/t16 口径订正后）：
 *  - v4（headerVersion === 4）：tool/result 缺 message.id / toolCallId 不配对 → decodeRow 当场拒读；
 *    user/message 缺 data.id、assistant/message 缺 message.id、tool/call.callId 空、内容块 id 空、
 *    **同一步重复通告同一 advertised tool call** → 被**已安装 Session 的 seed/restore 闸门**拒读。
 *    以上一律 **unloadable**。
 *    真机原始输出（v4 日志 + `validation:'current'` = 安装版 Session 的校验层，即上面的 ②③④）：
 *      `finish: seed user/message at index 9 lacks an identified message`
 *      `finish: tool call id requires a nonempty string`
 *      `finish: assistant/message repeats advertised tool call call_00_rCbEBWsfXGrfOhog9cud3396`
 *  - pre-v4（headerVersion < 4）：三类消息缺 id / 空 tool-call id / 重复通告同一 callId 走 v0→v1、v3→v4
 *    迁移并被迁移器拒绝 → unloadable。
 *  - 版本读不出：按较轻的 nextRequestFails 报，detail 记 codec-uncalibrated（不谎称已验证）。
 *
 * **前台管线的分层必须写准**（官方源码 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`），
 * 否则容易误读成「transformed 容忍 ⇒ 也许还能打开」。官方当前代际（v4）读盘是**四层串行**的：
 *  ① `parseHeaderRecord` 的 `sessionFormatCatalog.createRestore(parsed, { recovery:'strict',
 *     validation:'transformed' })`：**既解首帧 header，也被 `readZstdPrefix` / `SessionLogScanner`
 *     用来逐行 `decodeRow`** —— 也就是说 strict+transformed 同样是 v4 前台的**行解码器**，
 *     而不是一次性的首帧校验；
 *  ② `assertV4RowAdmission` / `assertReleasedV4Relationships`：行准入与关系（引用/工具生命周期）校验；
 *  ③ `adoptSessionEvent`（内部如 `assertMessageEventShape`）：收编成事件时的形状校验；
 *  ④ `Session.fromRestore(generation.meta.id, generation.events, generation.meta,
 *     generation.inheritedEventCount, 'detached', currentSessionMessageProjections)` +
 *     `assertCurrentAssistantStreams(generation.events)`。
 *  **只有 ① 的 `decodeRow` / `finish` 那一层**会对「user/assistant 缺 message.id」「空 tool-call id」
 *  放行；②③④ 任何一层都会拒整份日志 —— 用户真实撞到的是后者（上面的原始输出即来自完整前台管线）。
 *  历史代际（version <= 3）走 `historicalSessionFormatCatalog.createRestore(header,
 *  { recovery:'recoverable', validation:'current' })` 加同一套 v0→v1 / v3→v4 迁移器。
 *  结论不变：本模块按**完整前台管线**定严重级（unloadable）；① 那一层的容忍不得用于降级，
 *  也不得据此推测「也许能打开」。
 */
import fs from 'node:fs/promises';
import { join } from 'node:path';

import { isSessionLogName, readLogHeaderFromBytes, PROJECT_KEY_RE } from './session-log.ts';
import { decodeZstdFrame, scanZstdFrames } from './zstd-frame.ts';
import type {
  SessionHealthInput,
  SessionHealthIssueCode,
  SessionHealthSeverity,
  SessionHealthSummary,
  SessionHealthRow,
} from '../core/session-health.ts';
import { analyzeSessionHealth } from '../core/session-health.ts';
import { sessionIdKey } from '../core/session-select.ts';
import { findSyntheticCloserRun, parseSessionRowFacts, type SessionRowFacts } from './session-row-facts.ts';

export { PROJECT_KEY_RE };

/** 单份日志参与体检的字节上限：超过则不读（如实计 unreadable，绝不半读后下结论）。 */
const MAX_LOG_BYTES = 256 * 1024 * 1024;
/** 行档默认限额（条）：超过的会话只做结构档（设计稿 §10.4 的深度解码限额）。 */
export const DEFAULT_DEEP_LIMIT = 200;
/** 会话单元扫描上限（防止异常大的会话库把一次体检拖成分钟级）；超出的如实计入 untested。 */
export const DEFAULT_MAX_UNITS = 2000;

export interface SessionHealthScanOptions {
  /** DSH home（会话根 = <home>/sessions） */
  homeDir: string;
  /** 本机 DSH 支持的会话格式版本（读不到 = undefined → 不做「超前」判定） */
  targetFormatVersion?: number;
  /** 本机工作区记录的 cwd 目录键（`projectKeyOf(path)`） */
  workspaceKeys?: ReadonlySet<string>;
  /**
   * 本机全部已知会话 id 的归一化键（父对话存在性判定）。
   *
   * **不传 = 未知**（调用方没有本机会话全量清单）→ 采集器**自证**：用本次遍历到的全部单元 id
   * 作为已知集合（见 `scanSessionHealth`），绝不伪造成「确知为空集」；传了就用调用方的
   * （UI 侧 `parentRelations` 更权威：它连注册表里的会话一起算）。
   */
  knownSessionIds?: ReadonlySet<string>;
  /** 出现在多个 projectKey 的会话 id（归一化键） */
  duplicateSessionIds?: ReadonlySet<string>;
  /** 行档条数上限（0 = 只做结构档；缺省 DEFAULT_DEEP_LIMIT）——覆盖的是**最新**的那些会话，见下 */
  deepLimit?: number;
  /** 单元数上限（缺省 DEFAULT_MAX_UNITS） */
  maxUnits?: number;
}

export interface SessionHealthScanResult {
  rows: SessionHealthRow[];
  summary: SessionHealthSummary;
  /** 因单元数上限**未体检**的会话数（>0 时界面必须写明「另有 N 条未检查」） */
  untested: number;
  /** 目录/文件读取失败次数（如实计数，绝不静默） */
  unreadableEntries: number;
  /** 会话根绝对路径（界面/诊断用） */
  sessionsDir: string;
  /** 会话根是否存在（false = 这台机器没有会话数据，不是错误） */
  sessionsDirExists: boolean;
}

/** 一行已提交事件的事实（字段判据见 session-row-facts；本模块只再带上原始字节）。 */
interface RowFacts extends SessionRowFacts {
  /** 原始行字节（重复行判定用：字节相同才算「重复」） */
  raw: string;
}

/** 解析一行 JSON —— 委托 `session-row-facts` 的**唯一实现**（体检与修复计划必须同判据）。 */
function parseRow(line: string): SessionRowFacts | null {
  return parseSessionRowFacts(line);
}

/* ---------------- 工具生命周期：只从行文本证明的本地解析（T4） ---------------- */

/**
 * 只看这些行类型（其余事件不解第二次 JSON）—— `session-row-facts` 是另一任务的写作用域，
 * 需要的新行级事实在本模块本地解析，绝不改动它。
 */
const LIFECYCLE_ROW_TYPES: ReadonlySet<string> = new Set([
  'user/message', 'assistant/message', 'tool/result', 'tool/call',
  'step/start', 'step/end', 'turn/start', 'turn/end',
]);

/** 一行里「从行文本可证明」的生命周期事实（读不出的一律缺省 → 不参与判定）。 */
interface LifecycleRow {
  type: string;
  /** `data.turn` / `data.step`（安全非负整数才记） */
  turn?: number;
  step?: number;
  /** 消息载体的 id 是否合法（仅 user/message、assistant/message、tool/result 有值；false = 缺失/非字符串/空串） */
  messageIdOk?: boolean;
  /** tool/call 的 `data.callId` 原文（缺失 = undefined；可能是空串或非字符串） */
  rawCallId?: unknown;
  /** assistant/message 内容里 tool-call 块的 id 原文（含缺省项） */
  blockIds?: unknown[];
  /** tool/result 的配对信息（仅 tool/result 有值） */
  result?: { sourceCallId: unknown; toolCallId: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 本地解析（只做生命周期判定所需的字段；JSON 解析失败 = undefined，调用方已按不可解析行计数）。 */
function parseLifecycleRow(line: string, type: string): LifecycleRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const rec = asRecord(parsed);
  if (rec === undefined) return undefined;
  const data = asRecord(rec['data']);
  const row: LifecycleRow = { type };
  const turn = readCount(data?.['turn']);
  const step = readCount(data?.['step']);
  if (turn !== undefined) row.turn = turn;
  if (step !== undefined) row.step = step;
  if (type === 'user/message') {
    // user/message 的 data **本身即 message**，id 在 data.id
    row.messageIdOk = isNonEmptyString(data?.['id']);
  } else if (type === 'assistant/message') {
    const message = asRecord(data?.['message']);
    row.messageIdOk = isNonEmptyString(message?.['id']);
    const content = message?.['content'];
    if (Array.isArray(content)) {
      const ids: unknown[] = [];
      for (const block of content) {
        const blockRec = asRecord(block);
        if (blockRec?.['type'] === 'tool-call') ids.push(blockRec['id']);
      }
      if (ids.length > 0) row.blockIds = ids;
    }
  } else if (type === 'tool/result') {
    const message = asRecord(data?.['message']);
    row.messageIdOk = isNonEmptyString(message?.['id']);
    const sourceCallId = asRecord(message?.['source'])?.['callId'];
    // 代际差异（真机实测）：v4 行把 toolCallId 放在 message 上（content[0] 是文本块）；
    // v0/v3 行沿用 content[0].toolCallId（block 形状）。两处都读，取实际存在的那一个。
    let toolCallId: unknown;
    if (message !== undefined && Object.prototype.hasOwnProperty.call(message, 'toolCallId')) {
      toolCallId = message['toolCallId'];
    } else {
      const content = message?.['content'];
      const first = Array.isArray(content) ? asRecord(content[0]) : undefined;
      if (first !== undefined && Object.prototype.hasOwnProperty.call(first, 'toolCallId')) {
        toolCallId = first['toolCallId'];
      }
    }
    row.result = { sourceCallId, toolCallId };
  } else if (type === 'tool/call') {
    row.rawCallId = data?.['callId'];
  }
  return row;
}

/** 生命周期判定的可证明事实（计数）。 */
interface ToolLifecycleFacts {
  /** 消息载体 id 不合法的行数（三类载体合计） */
  missingMessageId: number;
  /** 其中 tool/result 载体的行数（任何代际下真 codec 都拒读） */
  missingMessageIdToolResult: number;
  /** tool/call.callId 或 assistant/message 内容块 id 为空 / 非字符串的次数 */
  emptyToolCallId: number;
  /** tool/result 的 toolCallId 缺失 / 非字符串 / 与 source.callId 不一致的次数 */
  toolResultIdMismatch: number;
  /** 已关闭 step 里没有配对 tool/result 的 tool/call 数 */
  danglingClosedStep: number;
  /** 同一步同一 callId 被多次通告的 (step, callId) 对数 */
  duplicateToolCallId: number;
}

interface LifecycleScan {
  facts: ToolLifecycleFacts;
  /** 仍开着的 step（键 = `<turn>/<step>`） */
  openSteps: Set<string>;
  /** 已关闭的 step（step/end，或它所属回合的 turn/end） */
  closedSteps: Set<string>;
  /**
   * 已通告的调用（非空 id 且能定位到 step）。**两种载体共用一个队列**：tool/call 行与
   * assistant/message 内容块；同一个 callId 两者都有时只入队一次（否则悬空会双报）。
   */
  calls: { key: string; callId: string }[];
  /** step 键 → 已入队的 callId（入队去重；嵌套 Map 避免拼接分隔符带来的碰撞面） */
  queuedCalls: Map<string, Set<string>>;
  /** 出现过的 tool/result 配对 id（按 message.source.callId） */
  resultIds: Set<string>;
  /**
   * step 键 → callId → 分类通告次数。
   * **必须分类计数**：健康日志里同一个 callId 本来就会同时出现在 assistant/message 的内容块
   * 与 tool/call 行里（真机实测），跨类相加会把健康会话误报成重复。
   */
  declarations: Map<string, Map<string, { blocks: number; rows: number }>>;
}

function createLifecycleScan(): LifecycleScan {
  return {
    facts: {
      missingMessageId: 0,
      missingMessageIdToolResult: 0,
      emptyToolCallId: 0,
      toolResultIdMismatch: 0,
      danglingClosedStep: 0,
      duplicateToolCallId: 0,
    },
    openSteps: new Set<string>(),
    closedSteps: new Set<string>(),
    calls: [],
    queuedCalls: new Map(),
    resultIds: new Set<string>(),
    declarations: new Map(),
  };
}

function stepKeyOf(row: LifecycleRow): string | undefined {
  return row.turn !== undefined && row.step !== undefined ? row.turn + '/' + row.step : undefined;
}

function closeStep(scan: LifecycleScan, key: string): void {
  scan.openSteps.delete(key);
  scan.closedSteps.add(key);
}

function bumpDeclaration(scan: LifecycleScan, key: string, callId: string, kind: 'blocks' | 'rows'): void {
  let perStep = scan.declarations.get(key);
  if (perStep === undefined) {
    perStep = new Map();
    scan.declarations.set(key, perStep);
  }
  const counts = perStep.get(callId) ?? { blocks: 0, rows: 0 };
  counts[kind] += 1;
  perStep.set(callId, counts);
}

/**
 * 把一个调用放进悬空判定队列（去重）。
 *
 * 两种声明载体都走这里：`tool/call` 行与 `assistant/message` 内容块。健康日志里同一个 callId
 * 两个载体都有，不去重就会把**同一次调用**数成两处悬空。
 */
function queueCall(scan: LifecycleScan, key: string, callId: string): void {
  let ids = scan.queuedCalls.get(key);
  if (ids === undefined) {
    ids = new Set<string>();
    scan.queuedCalls.set(key, ids);
  }
  if (ids.has(callId)) return;
  ids.add(callId);
  scan.calls.push({ key, callId });
}

/** 应用一行（顺序即日志顺序；边界按 step/start→step/end、turn/start→turn/end 收窄）。 */
function applyLifecycleRow(scan: LifecycleScan, row: LifecycleRow): void {
  const key = stepKeyOf(row);
  switch (row.type) {
    case 'step/start':
      if (key !== undefined) {
        scan.openSteps.add(key);
        scan.closedSteps.delete(key);
      }
      break;
    case 'step/end':
      if (key !== undefined) closeStep(scan, key);
      break;
    case 'turn/end': {
      // 回合已结束 → 该回合里仍开着的 step 不可能再有续写（崩溃恢复补写的 closer 也走这条边界）
      if (row.turn === undefined) break;
      const prefix = row.turn + '/';
      for (const open of [...scan.openSteps]) if (open.startsWith(prefix)) closeStep(scan, open);
      break;
    }
    case 'tool/call': {
      // 空 / 非字符串 callId 只进 ②（能否配对已不可判定），不进悬空判定
      if (!isNonEmptyString(row.rawCallId)) {
        scan.facts.emptyToolCallId += 1;
        break;
      }
      // 定位不到 step（turn/step 读不出）→ 无法证明「step 已关闭」→ 不报悬空
      if (key !== undefined) {
        queueCall(scan, key, row.rawCallId);
        bumpDeclaration(scan, key, row.rawCallId, 'rows');
      }
      break;
    }
    default:
      break;
  }
  if (row.messageIdOk === false) {
    scan.facts.missingMessageId += 1;
    if (row.type === 'tool/result') scan.facts.missingMessageIdToolResult += 1;
  }
  if (row.blockIds !== undefined) {
    for (const id of row.blockIds) {
      if (!isNonEmptyString(id)) {
        scan.facts.emptyToolCallId += 1;
        continue;
      }
      // 与 tool/call 行走**同一份** calls → 同一 closedSteps / resultIds 判定（绝不另起一套）
      if (key !== undefined) {
        queueCall(scan, key, id);
        bumpDeclaration(scan, key, id, 'blocks');
      }
    }
  }
  if (row.result !== undefined) {
    if (isNonEmptyString(row.result.sourceCallId)) scan.resultIds.add(row.result.sourceCallId);
    // toolCallId 缺失 / 非字符串 / 与 source.callId 不一致 → 真 codec 直接拒读（v4 decodeRow；pre-v4 迁移同样拒）
    if (!isNonEmptyString(row.result.toolCallId)
      || !isNonEmptyString(row.result.sourceCallId)
      || row.result.toolCallId !== row.result.sourceCallId) {
      scan.facts.toolResultIdMismatch += 1;
    }
  }
}

function finalizeLifecycleScan(scan: LifecycleScan): ToolLifecycleFacts {
  for (const call of scan.calls) {
    // 只报「所属 step 已经关闭」的悬空调用（无论它是由 tool/call 行还是 assistant 内容块声明）：
    // 日志尾部还开着的 step 是正常崩溃形状（引擎的 interruptedTurnClosers 会补），报它就是误报。
    if (scan.closedSteps.has(call.key) && !scan.resultIds.has(call.callId)) scan.facts.danglingClosedStep += 1;
  }
  let duplicate = 0;
  for (const perStep of scan.declarations.values()) {
    for (const counts of perStep.values()) if (counts.blocks >= 2 || counts.rows >= 2) duplicate += 1;
  }
  scan.facts.duplicateToolCallId = duplicate;
  return scan.facts;
}

/**
 * 缺 message id 的严重级（t13 口径订正）。
 *
 * v4：安装版 Session 的 seed/restore 闸门（`Session.fromRestore`）拒读整份日志 → unloadable
 *     （真机原始输出：`seed user/message at index 9 lacks an identified message`）；
 * pre-v4：迁移器（v0→v1 / v3→v4）同样拒 → unloadable；
 * 只有**版本读不出**才取较轻的 nextRequestFails 并在 detail 注明未校准。
 * tool/result 载体与代际无关（三种口径下都拒读），单独短路。
 */
function missingMessageIdSeverity(facts: ToolLifecycleFacts, headerVersion: number | undefined): SessionHealthSeverity {
  if (facts.missingMessageIdToolResult > 0) return 'unloadable';
  return headerVersion === undefined ? 'nextRequestFails' : 'unloadable';
}

/**
 * 空 tool-call id 的严重级（t13 口径订正）。
 *
 * v4：`Session.fromRestore` 闸门拒读（原始输出：`tool call id requires a nonempty string`）→ unloadable；
 * pre-v4：迁移器拒 → unloadable；只有版本读不出才取较轻值。
 */
function emptyToolCallIdSeverity(headerVersion: number | undefined): SessionHealthSeverity {
  return headerVersion === undefined ? 'nextRequestFails' : 'unloadable';
}

/**
 * 重复通告同一 advertised tool call 的严重级（t16 口径订正）。
 *
 * v4：`Session.fromRestore` 闸门拒读（真机原始输出：
 *     `assistant/message repeats advertised tool call call_00_rCbEBWsfXGrfOhog9cud3396`）→ unloadable；
 * pre-v4：v0→v1 迁移同样拒读（生态矩阵 #5909 记录同一结论）→ unloadable；
 * 只有**版本读不出**才取较轻的 nextRequestFails 并在 detail 注明未校准。
 */
function duplicateToolCallIdSeverity(headerVersion: number | undefined): SessionHealthSeverity {
  return headerVersion === undefined ? 'nextRequestFails' : 'unloadable';
}


/** 行档结论（全部是「从字节可证明」的事实）。 */
interface RowScanResult {
  unparsable: number;
  /** 字节相同且 seq 相同的重复已提交行数（重放族：零损失可丢弃） */
  duplicateRows: number;
  /** 真实 seq 空洞（空洞数量，不是缺失事件数） */
  seqGaps: number;
  /** 合成 closer 块（后面还有真实续写） */
  syntheticCloser: boolean;
  /** 工具生命周期（T4 四类 + tool/result 配对） */
  lifecycle: ToolLifecycleFacts;
}

/** 行档：解压各帧 → 逐行判定（只做能从字节证明的判定）。 */
function scanRows(frames: readonly { start: number; end: number }[], bytes: Uint8Array): RowScanResult {
  const rows: RowFacts[] = [];
  const lifecycle = createLifecycleScan();
  let unparsable = 0;
  for (const frame of frames) {
    let text: string;
    try {
      text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      unparsable += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const facts = parseRow(line);
      if (facts === null) {
        unparsable += 1;
        continue;
      }
      const entry: RowFacts = { raw: line };
      if (facts.type !== undefined) entry.type = facts.type;
      if (facts.seq !== undefined) entry.seq = facts.seq;
      if (facts.turn !== undefined) entry.turn = facts.turn;
      rows.push(entry);
      const type = facts.type;
      if (type !== undefined && LIFECYCLE_ROW_TYPES.has(type)) {
        const lifecycleRow = parseLifecycleRow(line, type);
        if (lifecycleRow !== undefined) applyLifecycleRow(lifecycle, lifecycleRow);
      }
    }
  }
  // ① 字节相同且 seq 相同 → 重放族（同一 seq 被重写，重复的那份可零损失丢弃）
  let duplicateRows = 0;
  // ② seq 空洞（只在同一份日志内部判定；跨 generation 不连续是正常形态，不算空洞）
  let seqGaps = 0;
  let previous: RowFacts | undefined;
  let seenSeq = new Set<number>();
  for (const row of rows) {
    if (previous !== undefined && row.seq !== undefined && previous.seq === row.seq && row.raw === previous.raw) {
      duplicateRows += 1;
    }
    if (row.seq !== undefined) {
      if (previous?.seq !== undefined && row.seq !== previous.seq) {
        if (row.seq > previous.seq + 1) seqGaps += 1;
        // 回退的 seq（重放的另一形态）不计空洞：它已被重复行/重放族覆盖
      }
      seenSeq.add(row.seq);
    }
    previous = row;
  }
  // ③ 合成 closer 块：整块都是收尾类型且含 turn/end，且**后面还有行**（真实续写）
  const syntheticCloser = detectSyntheticCloser(rows);
  return { unparsable, duplicateRows, seqGaps, syntheticCloser, lifecycle: finalizeLifecycleScan(lifecycle) };
}

/** 合成 closer 块探测 —— 委托 `session-row-facts.findSyntheticCloserRun` 的唯一实现（判据见其文件头）。 */
function detectSyntheticCloser(rows: readonly RowFacts[]): boolean {
  return findSyntheticCloserRun(rows) !== undefined;
}

/** 结构档 + 首帧 header 读取（单份日志）。 */
interface LogScan {
  header?: { id?: string; cwd?: string; origin?: string; parentSessionId?: string; version?: number };
  structural: SessionHealthInput['structural'];
  rows?: RowScanResult;
  sizeBytes?: number;
}

async function scanLogFile(absPath: string, withRows: boolean): Promise<LogScan> {
  let bytes: Buffer;
  let sizeBytes: number;
  try {
    const st = await fs.stat(absPath);
    sizeBytes = st.size;
    if (st.size > MAX_LOG_BYTES) {
      return { structural: { ok: false, headerUnreadable: true, corruptReason: 'too-large' }, sizeBytes };
    }
    bytes = await fs.readFile(absPath);
  } catch {
    return { structural: { ok: false, headerUnreadable: true } };
  }
  let frames: { start: number; end: number }[];
  let tornTail = false;
  try {
    const scan = scanZstdFrames(bytes);
    frames = scan.frames;
    tornTail = scan.tornStart !== undefined;
  } catch (error) {
    return {
      structural: { ok: false, corruptReason: error instanceof Error ? error.message : String(error) },
      sizeBytes,
    };
  }
  const header = readLogHeaderFromBytes(bytes);
  const structural: SessionHealthInput['structural'] = {
    ok: header !== undefined,
    frames: frames.length,
    ...(tornTail ? { tornTail: true } : {}),
    ...(header === undefined ? { headerUnreadable: true } : {}),
  };
  const out: LogScan = { structural, sizeBytes };
  if (header !== undefined) out.header = header;
  if (withRows) out.rows = scanRows(frames, bytes);
  return out;
}

/** 会话目录 → 体检输入（单条；不抛错）。 */
async function scanUnit(
  sessionsDir: string,
  projectKey: string,
  sessionId: string,
  withRows: boolean,
): Promise<{ input: SessionHealthInput; unreadable: number; headerSessionId?: string }> {
  const dir = join(sessionsDir, projectKey, sessionId);
  let unreadable = 0;
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => isSessionLogName(n)).sort();
  } catch {
    unreadable += 1;
  }
  // 同一会话可能有多份 generation：体检以**最新的一份**为准（时间读不到则取字典序最后一份），
  // 但目录里全部日志的字节都计入 sizeBytes —— 用户关心的是「这条会话占了多少盘」。
  let totalBytes = 0;
  let picked: LogScan | undefined;
  let pickedName: string | undefined;
  for (const name of names) {
    const scan = await scanLogFile(join(dir, name), false);
    if (scan.sizeBytes !== undefined) totalBytes += scan.sizeBytes;
    if (picked === undefined || name > (pickedName ?? '')) {
      picked = scan;
      pickedName = name;
    }
  }
  // 行档只对「被选中的那份」日志做（其余 generation 不重复解压）
  if (withRows && pickedName !== undefined) {
    const withRowScan = await scanLogFile(join(dir, pickedName), true);
    if (withRowScan.sizeBytes !== undefined) {
      totalBytes = totalBytes - (picked?.sizeBytes ?? 0) + withRowScan.sizeBytes;
    }
    picked = withRowScan;
  }
  const header = picked?.header;
  const structural = picked?.structural ?? { ok: false, headerUnreadable: true };
  const rows = picked?.rows;
  // 行档结论 → 深度校验事实（**只标 verified=true 当真的逐行解析过**）
  const deepIssues: { code: SessionHealthIssueCode; severity?: SessionHealthSeverity; detail?: string }[] = [];
  if (rows !== undefined) {
    if (rows.unparsable > 0) deepIssues.push({ code: 'unparsable-event', detail: String(rows.unparsable) + ' line(s)' });
    if (rows.duplicateRows > 0) deepIssues.push({ code: 'replay-duplicate-rows', detail: String(rows.duplicateRows) });
    if (rows.seqGaps > 0) deepIssues.push({ code: 'seq-gap', detail: String(rows.seqGaps) });
    if (rows.syntheticCloser) deepIssues.push({ code: 'synthetic-closer' });
    // ---- T4：工具生命周期（只报不修；严重级 = 真 codec 实测口径，见文件头）----
    const lifecycle = rows.lifecycle;
    const version = header?.version;
    if (lifecycle.missingMessageId > 0) {
      const severity = missingMessageIdSeverity(lifecycle, version);
      // 只有「版本读不出 → 取较轻值」需要注明未校准；v4/pre-v4 都已实测拒读。
      const note = version === undefined ? '; codec-uncalibrated' : '';
      deepIssues.push({ code: 'missing-message-id', severity, detail: String(lifecycle.missingMessageId) + ' row(s)' + note });
    }
    if (lifecycle.toolResultIdMismatch > 0) {
      deepIssues.push({ code: 'tool-result-id-mismatch', severity: 'unloadable', detail: String(lifecycle.toolResultIdMismatch) });
    }
    if (lifecycle.emptyToolCallId > 0) {
      const severity = emptyToolCallIdSeverity(version);
      const note = version === undefined ? '; codec-uncalibrated' : '';
      deepIssues.push({ code: 'empty-tool-call-id', severity, detail: String(lifecycle.emptyToolCallId) + note });
    }
    if (lifecycle.danglingClosedStep > 0) {
      deepIssues.push({ code: 'dangling-tool-call', severity: 'unloadable', detail: String(lifecycle.danglingClosedStep) + ' unresolved' });
    }
    if (lifecycle.duplicateToolCallId > 0) {
      const severity = duplicateToolCallIdSeverity(version);
      const note = version === undefined ? '; codec-uncalibrated' : '';
      deepIssues.push({ code: 'duplicate-tool-call-id', severity, detail: String(lifecycle.duplicateToolCallId) + note });
    }
  }
  const input: SessionHealthInput = {
    unitId: projectKey + '/' + sessionId,
    sessionId,
    projectKey,
    logFiles: names.length,
    structural,
    ...(header?.cwd !== undefined ? { headerCwd: header.cwd } : {}),
    ...(header?.origin !== undefined ? { origin: header.origin } : {}),
    ...(header?.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header?.version !== undefined ? { headerVersion: header.version } : {}),
    ...(names.length > 0 ? { sizeBytes: totalBytes } : {}),
    ...(rows !== undefined
      ? { deep: { verified: true, ...(deepIssues.length > 0 ? { issues: deepIssues } : {}) } }
      : { deep: { verified: false, unverifiedReason: 'row-scan-not-run' } }),
  };
  // 首帧 header 的 id 是这一条会话的**真身份**（目录名可能是 `session-<uuid>`，也可能被手工改过）；
  // 采集器自证时优先用它，取不到才回落到目录名。
  const out: { input: SessionHealthInput; unreadable: number; headerSessionId?: string } = { input, unreadable };
  if (header?.id !== undefined) out.headerSessionId = header.id;
  return out;
}

/**
 * 扫描本机会话库（只读；**绝不写任何字节**，绝不抛错）。
 *
 * 任何目录/文件读不出来只计入 unreadableEntries，不中断整次体检 —— 体检本身不能成为
 * 新的故障点。
 */
export async function scanSessionHealth(options: SessionHealthScanOptions): Promise<SessionHealthScanResult> {
  const sessionsDir = join(options.homeDir, 'sessions');
  const deepLimit = options.deepLimit ?? DEFAULT_DEEP_LIMIT;
  const maxUnits = options.maxUnits ?? DEFAULT_MAX_UNITS;
  const result: SessionHealthScanResult = {
    rows: [],
    summary: {
      total: 0,
      bySeverity: { blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0 },
      structurallyChecked: 0,
      deepVerified: 0,
      deepUnverified: 0,
    },
    untested: 0,
    unreadableEntries: 0,
    sessionsDir,
    sessionsDirExists: false,
  };
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    result.sessionsDirExists = true;
  } catch {
    return result;
  }
  const projectKeys = projectDirs.filter((name) => PROJECT_KEY_RE.test(name));
  const inputs: SessionHealthInput[] = [];
  const duplicates = new Set<string>();
  /**
   * **采集器自证**用的已知会话 id 集合（调用方不提供 `knownSessionIds` 时用它）。
   *
   * 为什么需要：调用方（CLI / 救急台）不提供 `knownSessionIds` 时，旧实现用 `?? new Set()`
   * 把「未知」伪造成「确知为空集」，于是「父对话存在性」判据对**每一条**子代理会话都成立 ——
   * 真机实测 1199 条里 800 条被误报 `subagent-without-parent`（bySeverity.invisible=800）。
   *
   * **真实覆盖（两个来源，边界不同，别读成「一律含全部单元」）**：
   *  · **目录名**（第一趟，`sessionIdKey(sessionId)`）：覆盖本机**全部**单元目录，不受 `maxUnits` 约束 ——
   *    这是集合的主干，DSH 的目录名就是会话 id（`session-<uuid>` 与裸 `<uuid>` 由 `sessionIdKey` 归一）；
   *  · **首帧 header.id**：只在**被扫到**的单元上补（`scanned < maxUnits` 的循环里）—— 它只多给出
   *    「目录名被手工改过、header id 才是真身份」这种窄情况，**不覆盖**超出限额而未扫的单元。
   * 两个来源都只**加**不进「未知」：集合越全 ⇒ 越少报「缺父」，所以这个窄边界只会让**超限那批单元**
   * 的父对话在极端情形下被多报一次（保守方向），绝不会把「确知为空集」重新伪造成未知。
   */
  const knownIdsFromTraversal = new Set<string>();
  // 第一趟：只数「同一会话 id 出现在几个 projectKey 目录」（重复 id 是启动级故障）
  const idLocations = new Map<string, Set<string>>();
  for (const projectKey of projectKeys) {
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(join(sessionsDir, projectKey), { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      result.unreadableEntries += 1;
      continue;
    }
    for (const sessionId of dirs) {
      const key = sessionIdKey(sessionId);
      knownIdsFromTraversal.add(key);
      const set = idLocations.get(key) ?? new Set<string>();
      set.add(projectKey);
      idLocations.set(key, set);
    }
  }
  for (const [key, set] of idLocations) if (set.size > 1) duplicates.add(key);
  // 第二趟：逐单元扫结构 / （限额内的）行档
  //
  // 顺序**必须**是「最近写入优先」：行档（解压 + 逐行判定）最贵，所以有限额；
  // 而「哪些会话被行档覆盖」决定了 synthetic-closer / 重放重复行 / seq 空洞这些深档结论
  // 能不能出现在界面上。此前按 projectKey 字典序 + sessionId 字典序取前 N 条 ——
  // 结果是**最老的那批**被深查，最近出事（刚崩过 / 刚被强杀）的那批永远看不到，
  // 同一个库每次体检给出不同的深档结论（实测：同一台机器 1024 条会话，深查恒为
  // 字典序最前的 200 条，synthetic-closer 时有时无）。改成按目录 mtime 倒序，
  // 顺序**确定且可解释**：最近写过的会话优先被深查。
  const units: Array<{ projectKey: string; sessionId: string; mtimeMs: number }> = [];
  for (const projectKey of projectKeys) {
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(join(sessionsDir, projectKey), { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      continue;
    }
    for (const sessionId of dirs) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(join(sessionsDir, projectKey, sessionId))).mtimeMs;
      } catch {
        // 读不到 mtime：按最旧处理（不中断体检，也绝不因此把它排除在体检之外）
      }
      units.push({ projectKey, sessionId, mtimeMs });
    }
  }
  units.sort((a, b) => (b.mtimeMs - a.mtimeMs)
    || a.projectKey.localeCompare(b.projectKey)
    || a.sessionId.localeCompare(b.sessionId));
  let deepUsed = 0;
  let scanned = 0;
  for (const unit of units) {
    if (scanned >= maxUnits) {
      result.untested += 1;
      continue;
    }
    scanned += 1;
    const withRows = deepLimit > 0 && deepUsed < deepLimit;
    if (withRows) deepUsed += 1;
    const { input, unreadable, headerSessionId } = await scanUnit(sessionsDir, unit.projectKey, unit.sessionId, withRows);
    result.unreadableEntries += unreadable;
    // 补一个 header.id 的归一键（只覆盖**被扫到**的单元，见 knownIdsFromTraversal 的覆盖说明）：
    // 目录名被手工改过时，header id 才是这条会话的真身份；取不到 header 就不补，绝不用目录名冒充。
    if (headerSessionId !== undefined) knownIdsFromTraversal.add(sessionIdKey(headerSessionId));
    inputs.push(input);
  }
  const analyzed = analyzeSessionHealth(inputs, {
    ...(options.targetFormatVersion !== undefined ? { targetFormatVersion: options.targetFormatVersion } : {}),
    // workspaceKeys 维持「size > 0 才判未登记」：调用方读不到注册表与「注册表为空」不可区分，
    // 把空集当确知会让每一条会话都报未登记（另一种误报）。这一点与 knownSessionIds 不同 —— 那里
    // 「未知」由调用方用 undefined 显式表达。
    workspaceKeys: options.workspaceKeys ?? new Set<string>(),
    // 「未知」绝不伪造成「确知为空集」：调用方提供了就用它的（UI 的 parentRelations 更权威）；
    // 没提供 → 用本次遍历到的全部单元 id 自证。
    knownSessionIds: options.knownSessionIds ?? knownIdsFromTraversal,
    duplicateSessionIds: options.duplicateSessionIds ?? duplicates,
  });
  result.rows = analyzed.rows;
  result.summary = analyzed.summary;
  return result;
}
