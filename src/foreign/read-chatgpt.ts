/**
 * ChatGPT 导出包读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 chatgpt 行）。
 *
 * **本来源刻意没有自动根**（chat-import discovery.mjs:164 的 `defaultRoots.chatgpt = null`，
 * :1861 的 scan 只接受显式 path）：自动探测永远 0 命中，如实报 `source-needs-explicit-path`，
 * **绝不猜 cwd、绝不扫 home**。
 *
 * 显式路径的唯一入口是宿主已有的 `projectDir`（CLI 的 --cwd / 宿主路由的 ?projectDir=）：
 *   · 指向文件 → 直接读该文件（网页导出的 conversations.json）；
 *   · 指向目录 → 读其中的 conversations.json；
 *   · 未给 → 空结果 + `source-needs-explicit-path`（detect 与 build 同口径）。
 *
 * cwd 的来源（**唯一一处推导，且必须显式上报**）：导出文件**所在目录**。这不是「猜」——
 * 用户显式指出了这个路径，目录因该路径存在而存在；按契约报 `session-cwd-derived`（t6 新增码，
 * 语义正是「cwd 由源侧路径推导」）。ChatGPT 的导出数据本身**没有** cwd 字段，所以没有别的选择。
 *
 * 归一：mapping 是 DAG（chat-import convert/chatgpt.mjs:12-15 点名「每会话 mapping DAG」），
 * 链取法 = current_node 向上回溯（缺 current_node 时取最长根链），绝不做拓扑排序式的乱序拼接。
 */
import { isAbsoluteFor, joinFor, normalizePlatform } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { readJsonSafe, statOrNull } from './session-read.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { firstUserText } from './session-source.ts';
import { irBump, irTextBlock, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const CHATGPT_EXPORT_FILE = 'conversations.json';
export const CHATGPT_NEEDS_PATH_CODE = 'source-needs-explicit-path';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 20000;

/** 显式路径（= 宿主的 projectDir；未给 → undefined，**绝不回落到 cwd/home**） */
export function chatgptExplicitPath(opts: RootProbeOptions): string | undefined {
  const raw = opts.projectDir;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 目标平台下的父目录（不用 node:path：运行平台可能与目标平台不同） */
export function dirnameFor(platform: ForeignPlatform, p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf(String.fromCharCode(92)));
  if (cut <= 0) return p;
  const head = p.slice(0, cut);
  // win32 的 `C:` → 保留盘符根（不返回 `C:` 之外的空串）
  if (platform === 'win32' && head.length === 2 && head.charAt(1) === ':') return head + String.fromCharCode(92);
  return head;
}

/** 一条已归一的会话文件（`ParsedTranscript` + 源侧 id） */
export interface ChatgptSessionFile extends ParsedTranscript { readonly id: string }

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 秒/毫秒自适应的 epoch → 毫秒（导出文件的 create_time 是**浮点秒**） */
export function epochMsOf(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    if (typeof v === 'string' && v !== '') {
      const asNumber = Number(v);
      if (!Number.isFinite(asNumber)) {
        const parsed = Date.parse(v);
        return Number.isNaN(parsed) ? undefined : parsed;
      }
      return epochMsOf(asNumber);
    }
    return undefined;
  }
  const ms = Math.round(v < 1e11 ? v * 1000 : v);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** 会话列表（顶层数组；或 `{conversations: [...]}` 包装形态） */
function conversationListOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const wrapped = value['conversations'];
    if (Array.isArray(wrapped)) return wrapped;
  }
  return undefined;
}

interface MessageBox { readonly text: string; readonly isCode: boolean }

const LF = String.fromCharCode(10);

/** `content.parts`（字符串或 `{text}` 对象；非数组一律空） */
function messageParts(message: Record<string, unknown>): unknown[] {
  const content = message['content'];
  if (!isRecord(content)) return [];
  const parts = content['parts'];
  return Array.isArray(parts) ? parts : [];
}

/** 单个 part 的文本投影（只有字符串 / `{text}` 两种形态算正文） */
function partText(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (isRecord(part)) return str(part['text']);
  return undefined;
}

/**
 * 工具调用载体判定（参考 convert/chatgpt.mjs 的 toolCallCarrier）。
 *
 * ChatGPT 导出的工具调用是 **assistant content.parts 里的一个 part**：JSON **字符串**，
 * 或直接的**对象**（个别导出用 `name` 而非 `tool_name`，参数包在 `action` / `metadata` 里）。
 * 认出来必须**从正文里剥掉**（否则整段 JSON 被拼进对话）并**结构化**成 tool/call
 * （不认出来就是对象载体被静默丢掉）。
 */
function toolCallCarrier(part: unknown): Record<string, unknown> | undefined {
  let obj: unknown = part;
  if (typeof part === 'string') {
    const trimmed = part.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(obj)) return undefined;
  const carrier = isRecord(obj['action']) ? obj['action'] : obj;
  const callId = str(carrier['tool_call_id']) ?? str(carrier['id']);
  const name = str(carrier['tool_name']) ?? str(carrier['name']);
  return callId === undefined || name === undefined ? undefined : carrier;
}

/** assistant 消息里的工具调用（结构化；FIFO 配对用它的 id） */
function extractToolCalls(message: Record<string, unknown>): { readonly id: string; readonly name: string; readonly args: unknown }[] {
  const out: { readonly id: string; readonly name: string; readonly args: unknown }[] = [];
  for (const part of messageParts(message)) {
    const carrier = toolCallCarrier(part);
    if (carrier === undefined) continue;
    out.push({
      id: str(carrier['tool_call_id']) ?? str(carrier['id']) ?? '',
      name: str(carrier['tool_name']) ?? str(carrier['name']) ?? '',
      args: carrier['args'] ?? {},
    });
  }
  return out;
}

/** 工具入参：字符串若是 JSON 就解析（合成期要写回 JSON 文本，传裸串会被二次编码） */
function parseToolArgs(raw: unknown): unknown {
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

/** 消息正文的纯文本投影（**跳过工具调用载体 part**，否则 JSON 字符串会重复进正文） */
function contentText(message: Record<string, unknown>): string {
  const texts: string[] = [];
  for (const part of messageParts(message)) {
    if (toolCallCarrier(part) !== undefined) continue;
    const inner = partText(part);
    if (inner !== undefined) texts.push(inner);
  }
  return texts.join(LF);
}

function contentOf(message: Record<string, unknown>): MessageBox | undefined {
  const content = message['content'];
  if (typeof content === 'string') return { text: content, isCode: false };
  if (!isRecord(content)) return undefined;
  const type = str(content['content_type']) ?? '';
  if (Array.isArray(content['parts'])) {
    const text = contentText(message);
    if (text !== '') return { text, isCode: type === 'code' };
  }
  const direct = str(content['text']);
  if (direct !== undefined) return { text: direct, isCode: type === 'code' };
  return undefined;
}

function messageOf(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  const message = node['message'];
  return isRecord(message) ? message : undefined;
}

/** 节点时间（活跃分支排序用）：消息 create_time 的数值形态；缺时 0（稳定排序保持插入序） */
function messageTimeOf(node: Record<string, unknown> | undefined): number {
  const message = messageOf(node);
  if (message === undefined) return 0;
  const t = message['create_time'];
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const parsed = Date.parse(t);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 子节点解析：优先节点自带的 `children`；**缺失时按 `parent` 指针还原**
 * （参考 convert/chatgpt.mjs 的 childrenResolver）。
 *
 * 为什么必须有还原支：官方「slim」导出**完全不写 children**，只沿 children 走的话
 * root 之后一个节点都遍历不到 —— 整份导出只导入 1 条消息（旧行为）。
 * 还原出的兄弟顺序按消息 create_time 升序，这样「最后一个 child = 活跃分支」的既有语义
 * 在还原后依然成立（与自带 children 的导出侧排序对齐）。
 */
function childrenResolver(nodes: Map<string, Record<string, unknown>>): (id: string) => string[] {
  const derived = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    const parent = node['parent'];
    if (typeof parent !== 'string' || parent === id || !nodes.has(parent)) continue;
    const list = derived.get(parent);
    if (list === undefined) derived.set(parent, [id]);
    else list.push(id);
  }
  for (const list of derived.values()) {
    list.sort((a, b) => messageTimeOf(nodes.get(a)) - messageTimeOf(nodes.get(b)));
  }
  return (id: string): string[] => {
    const node = nodes.get(id);
    if (node === undefined) return [];
    const declared = node['children'];
    if (Array.isArray(declared)) {
      const kids: string[] = [];
      for (const child of declared) {
        if (typeof child === 'string' && nodes.has(child)) kids.push(child);
      }
      if (kids.length > 0) return kids;
    }
    return derived.get(id) ?? [];
  };
}

/**
 * 缺 current_node 时的兜底：从每条无父链出发取**最长**链（导出文件里通常只有一条根链）。
 *
 * **迭代**（显式栈）实现：递归版在深层导出（上限 20000 节点）会爆栈 —— 超过调用栈上限时
 * 整个来源炸掉，而不是「导入得少一点」。环保护靠 visiting 集合。
 */
function longestChain(nodes: Map<string, Record<string, unknown>>, childrenOf: (id: string) => string[]): string[] {
  const roots: string[] = [];
  for (const [id, node] of nodes) {
    const parent = node['parent'];
    if (typeof parent === 'string' && parent !== id && nodes.has(parent)) continue;
    roots.push(id);
  }
  // memo 只存「以该节点为头的最长链长度 + 下一跳」：直接存链数组会退化成 O(N²)
  //（25000 节点的深链上实测 7 秒 + 数百 MB 拷贝）
  const memoLen = new Map<string, number>();
  const memoNext = new Map<string, string | undefined>();
  const state = new Map<string, 'visiting' | 'done'>();
  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: { id: string; kids: string[]; next: number }[] = [{ id: root, kids: childrenOf(root), next: 0 }];
    state.set(root, 'visiting');
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (top.next < top.kids.length) {
        const kid = top.kids[top.next];
        top.next += 1;
        if (kid === undefined || state.has(kid)) continue;
        state.set(kid, 'visiting');
        stack.push({ id: kid, kids: childrenOf(kid), next: 0 });
        continue;
      }
      stack.pop();
      state.set(top.id, 'done');
      let childLen = 0;
      let next: string | undefined;
      for (const kid of top.kids) {
        const len = memoLen.get(kid) ?? 0;
        if (len > childLen) {
          childLen = len;
          next = kid;
        }
      }
      memoLen.set(top.id, childLen + 1);
      memoNext.set(top.id, next);
    }
  }
  let bestRoot: string | undefined;
  let bestLen = 0;
  for (const root of roots) {
    const len = memoLen.get(root) ?? 0;
    if (len > bestLen) {
      bestLen = len;
      bestRoot = root;
    }
  }
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = bestRoot;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = memoNext.get(cursor);
  }
  return chain;
}

/** mapping DAG → 线性链（current_node 向上回溯；缺则最长根链） */
export function chatgptChainOf(mapping: unknown, currentNode: unknown): string[] {
  if (!isRecord(mapping)) return [];
  const nodes = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(mapping)) {
    if (isRecord(value)) nodes.set(key, value);
  }
  if (nodes.size === 0) return [];
  const start = str(currentNode);
  if (start !== undefined && nodes.has(start)) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      const node = nodes.get(cursor);
      const parent = node === undefined ? undefined : node['parent'];
      cursor = typeof parent === 'string' && nodes.has(parent) ? parent : undefined;
    }
    chain.reverse();
    return chain;
  }
  return longestChain(nodes, childrenResolver(nodes));
}

function recordsFromConversation(
  item: Record<string, unknown>,
  ignored: Record<string, number>,
  maxNodes: number,
): {
  records: TranscriptRecord[];
  raw: number;
  createdAt: number | undefined;
} {
  const mapping = item['mapping'];
  const chain = chatgptChainOf(mapping, item['current_node']);
  const records: TranscriptRecord[] = [];
  let idIndex = 0;
  // 未配对调用（ChatGPT 导出的 tool 消息**没有** tool_call_id → 按 FIFO 位置配对）
  const pendingCalls: string[] = [];
  // 当前「打开的」assistant 步：工具结果与孤儿文本都挂回它的 blocks
  let openAssistant: IrBlock[] | undefined;
  for (const nodeId of chain) {
    // 节点触顶绝不静默（audit-foreign F4）：逐类计数 → 下游 unsupported-session-record 可见。
    if (idIndex >= maxNodes) { irBump(ignored, 'chatgpt:max-nodes'); break; }
    idIndex += 1;
    const node = isRecord(mapping) ? (mapping as Record<string, unknown>)[nodeId] : undefined;
    const message = messageOf(node);
    if (message === undefined) {
      irBump(ignored, 'chatgpt:node-without-message');
      continue;
    }
    const author = message['author'];
    const rawRole = isRecord(author) ? str(author['role']) : undefined;
    const role = rawRole === undefined ? undefined : rawRole.toLowerCase();
    const time = epochMsOf(message['create_time']);
    if (role === 'tool') {
      // 结构化还原：结果挂到配对的调用所在步（参考 buildTurns 的 FIFO）
      const text = contentText(message);
      const callId = pendingCalls.shift();
      if (callId !== undefined && openAssistant !== undefined) {
        records.push({
          role: 'user',
          blocks: [irToolResultBlock(callId, text, false)],
          ...(time !== undefined ? { time } : {}),
          id: nodeId,
        });
      } else {
        // 孤儿结果（转录从中途开始）：绝不挂错步；正文不丢（参考把它们并回最近一步的正文）
        irBump(ignored, 'chatgpt:orphan-tool-result');
        if (text !== '' && openAssistant !== undefined) openAssistant.push(irTextBlock(text));
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant') {
      irBump(ignored, 'chatgpt:role-' + (role ?? 'unknown'));
      continue;
    }
    if (role === 'user') {
      openAssistant = undefined;
      const box = contentOf(message);
      if (box === undefined || box.text.trim() === '') {
        irBump(ignored, 'chatgpt:no-content');
        continue;
      }
      if (box.isCode) irBump(ignored, 'chatgpt:code-block');
      records.push({
        role: 'user',
        blocks: [irTextBlock(box.text)],
        ...(time !== undefined ? { time } : {}),
        id: nodeId,
      });
      continue;
    }
    // assistant：正文（已剥掉工具调用载体 part）+ 结构化的工具调用块
    const box = contentOf(message);
    if (box !== undefined && box.isCode) irBump(ignored, 'chatgpt:code-block');
    const blocks: IrBlock[] = [];
    if (box !== undefined && box.text.trim() !== '') blocks.push(irTextBlock(box.text));
    for (const call of extractToolCalls(message)) {
      blocks.push(irToolCallBlock(call.id, call.name, parseToolArgs(call.args)));
      pendingCalls.push(call.id);
    }
    if (blocks.length === 0) {
      irBump(ignored, 'chatgpt:no-content');
      continue;
    }
    openAssistant = blocks;
    records.push({
      role: 'assistant',
      blocks,
      ...(time !== undefined ? { time } : {}),
      id: nodeId,
    });
  }
  return { records, raw: chain.length, createdAt: epochMsOf(item['create_time']) };
}

function sessionOf(
  item: Record<string, unknown>,
  cwd: string | undefined,
  maxNodes: number,
): ChatgptSessionFile | undefined {
  const id = str(item['id']) ?? str(item['conversation_id']);
  if (id === undefined) return undefined;
  const ignored: Record<string, number> = {};
  const parsed = recordsFromConversation(item, ignored, maxNodes);
  const title = str(item['title']) ?? '';
  return {
    id,
    cwd,
    createdAt: parsed.createdAt,
    title: title === '' ? firstUserText(parsed.records) : title.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    // ChatGPT 导出是**单个 JSON 文档**（不是 JSONL）：没有「坏行」这个概念，恒 0。
    // 未迁移的节点/角色逐类进 ignored（下游 unsupported-session-record），绝不静默丢。
    bad: 0,
    ignored,
  };
}

/** 读显式给出的 ChatGPT 导出包（无显式路径 → 空结果 + source-needs-explicit-path） */
export async function readChatgpt(
  opts: RootProbeOptions & { readonly maxNodes?: number },
): Promise<SessionReadOutcome<ChatgptSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const explicit = chatgptExplicitPath(opts);
  if (explicit === undefined) {
    return {
      files: [],
      extraSkips: [{ code: CHATGPT_NEEDS_PATH_CODE }],
      extraCounts: { 'chatgpt.conversations': 0 },
    };
  }
  const findings: ForeignSkip[] = [];
  const stat = await statOrNull(explicit);
  if (stat === null) {
    findings.push({ code: 'source-unreadable', origin: CHATGPT_EXPORT_FILE, detail: 'explicit-path-missing' });
    return { files: [], readFindings: findings, extraCounts: { 'chatgpt.conversations': 0 } };
  }
  const filePath = stat.isDirectory() ? joinFor(platform, explicit, CHATGPT_EXPORT_FILE) : explicit;
  const cwdBase = stat.isDirectory() ? explicit : dirnameFor(platform, explicit);
  const read = await readJsonSafe(filePath, MAX_FILE_BYTES);
  if (!read.ok) {
    findings.push({ code: 'source-unreadable', origin: CHATGPT_EXPORT_FILE, detail: read.problem });
    return { files: [], readFindings: findings, extraCounts: { 'chatgpt.conversations': 0 } };
  }
  const list = conversationListOf(read.value);
  if (list === undefined) {
    findings.push({ code: 'source-unreadable', origin: CHATGPT_EXPORT_FILE, detail: 'unexpected-root-shape' });
    return { files: [], readFindings: findings, extraCounts: { 'chatgpt.conversations': 0 } };
  }
  const derived = cwdBase !== '' && isAbsoluteFor(platform, cwdBase);
  const files: ChatgptSessionFile[] = [];
  const seen = new Set<string>();
  let notObjects = 0;
  for (const item of list) {
    if (!isRecord(item)) { notObjects += 1; continue; }
    const file = sessionOf(item, derived ? cwdBase : undefined, maxNodes);
    if (file === undefined || seen.has(file.id)) continue;
    seen.add(file.id);
    files.push(file);
  }
  if (derived && files.length > 0) {
    findings.push({ code: 'session-cwd-derived', origin: CHATGPT_EXPORT_FILE, count: files.length });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    files,
    readFindings: findings,
    extraCounts: { 'chatgpt.conversations': list.length, 'chatgpt.nonObjectEntries': notObjects },
  };
}
