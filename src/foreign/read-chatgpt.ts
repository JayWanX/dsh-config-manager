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
import { irBump, irTextBlock } from './session-ir.ts';
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

function contentOf(message: Record<string, unknown>): MessageBox | undefined {
  const content = message['content'];
  if (typeof content === 'string') return { text: content, isCode: false };
  if (!isRecord(content)) return undefined;
  const type = str(content['content_type']) ?? '';
  const parts = content['parts'];
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      if (typeof part === 'string') texts.push(part);
      else if (isRecord(part)) {
        const inner = str(part['text']);
        if (inner !== undefined) texts.push(inner);
      }
    }
    const text = texts.join(String.fromCharCode(10));
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

/** 缺 current_node 时的兜底：从每条无父链出发取**最长**链（导出文件里通常只有一条根链） */
function longestChain(nodes: Map<string, Record<string, unknown>>): string[] {
  // 「有父」集合存**子节点自己的 id**（先前写成把 parent 塞进去，等于把根当成有父 → 只返回末节点）
  const hasParent = new Set<string>();
  for (const [id, node] of nodes) {
    const parent = node['parent'];
    if (typeof parent === 'string' && nodes.has(parent)) hasParent.add(id);
  }
  const memo = new Map<string, string[]>();
  const walk = (id: string, guard: Set<string>): string[] => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return [id];
    guard.add(id);
    const node = nodes.get(id);
    const children = node === undefined ? undefined : node['children'];
    let best: string[] = [];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child !== 'string' || !nodes.has(child)) continue;
        const branch = walk(child, new Set(guard));
        if (branch.length > best.length) best = branch;
      }
    }
    guard.delete(id);
    const chain = [id, ...best];
    memo.set(id, chain);
    return chain;
  };
  let best: string[] = [];
  for (const id of nodes.keys()) {
    if (hasParent.has(id)) continue;
    const chain = walk(id, new Set());
    if (chain.length > best.length) best = chain;
  }
  return best;
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
  return longestChain(nodes);
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
    if (role !== 'user' && role !== 'assistant') {
      irBump(ignored, 'chatgpt:role-' + (role ?? 'unknown'));
      continue;
    }
    const box = contentOf(message);
    if (box === undefined || box.text.trim() === '') {
      irBump(ignored, 'chatgpt:no-content');
      continue;
    }
    if (box.isCode) irBump(ignored, 'chatgpt:code-block');
    const time = epochMsOf(message['create_time']);
    records.push({
      role,
      blocks: [irTextBlock(box.text)],
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
