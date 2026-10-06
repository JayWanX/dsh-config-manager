/**
 * Pi（~\.pi/agent/sessions）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 pi 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致，无出入）：
 *  - 根：`<home>/.pi/agent/sessions`（三平台同形，**无环境变量覆盖**）
 *  - 布局：`<sessions>/--<cwd>--/<timestamp>_<uuid>.jsonl`
 *  - 形态：**首行 = 会话头**（`type:"session"`），其余条目 `id/parentId` 成树（convert/pi.mjs:14-27）
 *
 * 记录形态（本层单独解析，**不走通用 JSONL 解析**）：条目是 `{type, id, parentId, …}`，
 * 对话在 `{type:"message", message:{role, content}}` 里 —— role ∈ user / assistant /
 * toolResult；assistant 的 content 块用**驼峰** `toolCall`（入参是 `arguments` 对象）、
 * 思考是 `thinking`。三处与通用词表不同，必须专用解析（convert/pi.mjs）。
 *
 * 两条归一（都在本层做实）：
 *  ① **活动分支**：从末条目沿 `parentId` 走到根，再反转为时间序（visited 防环）；不在该路径上的
 *     旁支条目丢弃并计入 `off-branch`（绝不把旁支内容混进对话）。缺 `id/parentId` 的旧式线性
 *     条目按顺序链接（v1 语义）。
 *  ② 工具结果按 `toolCallId` 挂回**声明该调用的 assistant 记录之后**（共享合成器把 tool/result
 *     收进当前打开的 step）。IR 没有 reasoning 块 → `thinking` / `compaction` / `branch_summary`
 *     一律逐类计数，**不伪装成正文**（与 read-opencode / read-gemini 同口径）。
 *
 * cwd 的两档来源（绝不猜）：会话头里的 cwd 字段（权威）→ 目录名反解。反解要过
 * **存在性检查**（isDirectory）才落盘，并如实报 `session-cwd-derived`；反解不出真实目录时
 * 不产出会话（下游按 `session-missing-cwd` 跳过）。没有会话头的文件不是 Pi 会话，跳过并报码。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 pi 行）。本机无 ~/.pi，夹具 + 单测端到端跑
 * 同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { isAbsoluteFor, joinFor, normalizePlatform, sepFor } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
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
export const PI_SESSIONS_REL = '.pi/agent/sessions';

/** 会话文件（JSONL 是唯一形态） */
export const PI_SESSION_FILE_RE = /\.jsonl$/;

/** 会话目录名的包装：`--<cwd>--` */
export const PI_DIR_PREFIX = '--';

const MAX_SESSION_FILES = 500;

/** 会话头里的 cwd 候选键（与记录层用同一族键） */
const HEADER_CWD_KEYS: readonly string[] = ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory'];
const HEADER_TIME_KEYS: readonly string[] = ['timestamp', 'time', 'createdAt', 'created_at', 'startTime'];

/** Pi 的会话根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function piSessionsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.pi', 'agent', 'sessions');
}

/**
 * 通用 JSONL 形态（**遗留**：Pi 走专用事件流解析，本常量只为保留既有公开导出名）。
 */
export const PI_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: [...HEADER_CWD_KEYS, 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 Pi 会话 */
export interface PiSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface PiReadOptions extends RootProbeOptions {
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

/**
 * `--<cwd>--` 目录名 → 绝对路径**候选**（按目标平台排序；唯一判据是**存在性**）。
 *
 * 编码是有损的（路径里的 `-` 与分隔符同形），所以本函数只产出候选、**不做判断** ——
 * 由调用方逐个 `isDirectory` 验真。两种编码形态都收：
 *  - `C:-Users-u-proj`（posix 形态的 `/`→`-`）；
 *  - `C--Users-u-proj`（分隔符与冒号一起 → `-`）。
 */
export function piCwdCandidates(dirName: string, platform: ForeignPlatform): string[] {
  const sep = sepFor(platform);
  let inner = dirName.startsWith(PI_DIR_PREFIX) ? dirName.slice(PI_DIR_PREFIX.length) : dirName;
  if (inner.endsWith(PI_DIR_PREFIX)) inner = inner.slice(0, inner.length - PI_DIR_PREFIX.length);
  const out: string[] = [];
  const driveA = /^([A-Za-z]):-?(.*)$/.exec(inner);
  const driveB = /^([A-Za-z])--(.*)$/.exec(inner);
  const formA = driveA === null ? undefined : driveA[1] + ':' + sep + (driveA[2] ?? '').split('-').join(sep);
  const formB = driveB === null ? undefined : driveB[1] + ':' + sep + (driveB[2] ?? '').split('-').join(sep);
  const posixForm = '/' + inner.split('-').join('/');
  const ordered = platform === 'win32'
    ? [formA, formB, inner, posixForm]
    : [inner, posixForm, formA, formB];
  for (const candidate of ordered) {
    if (candidate === undefined || candidate === '') continue;
    if (!isAbsoluteFor(platform, candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** 目录名反解 → 本机真实存在的目录（不存在 = undefined，**绝不猜**） */
export async function derivedCwdOfDirName(dirName: string, platform: ForeignPlatform): Promise<string | undefined> {
  for (const candidate of piCwdCandidates(dirName, platform)) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

function headerCwd(header: Record<string, unknown> | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const key of HEADER_CWD_KEYS) {
    const v = irStr(header[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * 会话 id：头的 id > 文件名 `<timestamp>_<uuid>` 的 uuid 段 > 文件名主干。
 * 自证安全性（isSafeIrId）留给下游 `transcodeSessionDraft` —— 不安全就报 session-unsafe-id，
 * **绝不在这里悄悄换一个 id**。
 */
export function piSessionIdOf(header: Record<string, unknown> | undefined, fileStem: string): string {
  const fromHeader = header === undefined ? undefined : irStr(header['id']);
  if (fromHeader !== undefined) return fromHeader;
  const underscore = fileStem.lastIndexOf('_');
  if (underscore > 0 && underscore < fileStem.length - 1) return fileStem.slice(underscore + 1);
  return fileStem;
}

/* ---------------- 专用事件流解析（纯函数；不读盘） ---------------- */

/** 用户消息 content → 提问文本（string 原样；块数组取 text，image 降级为占位符） */
function piUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') parts.push(block['text'].trim());
    else if (block['type'] === 'image') parts.push('[image: ' + (irStr(block['mimeType']) ?? 'image') + ']');
  }
  return parts.join('\n');
}

/** 工具结果 content → 纯文本（块数组取 text；image 降级为占位符） */
function piToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text']);
    else if (block['type'] === 'image') parts.push('[image: ' + (irStr(block['mimeType']) ?? 'image') + ']');
  }
  return parts.join('\n');
}

/** assistant content → IR 块（text / toolCall；thinking 与其余块逐类计数，IR 无承载块） */
function piAssistantBlocks(content: unknown, ignored: Record<string, number>, fallbackBase: string): IrBlock[] {
  if (!Array.isArray(content)) return [];
  const out: IrBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = irStr(block['type']);
    if (type === 'text') {
      if (typeof block['text'] === 'string') out.push(irTextBlock(block['text']));
      continue;
    }
    if (type === 'thinking') {
      // IR 没有 reasoning 块 → 不伪装成正文，逐类计数（与 read-opencode / read-gemini 同口径）
      irBump(ignored, 'block:thinking');
      continue;
    }
    if (type === 'toolCall') {
      // 驼峰 toolCall：入参是 arguments 对象（convert/pi.mjs 的 piToolCall）
      const id = irStr(block['id']) ?? fallbackBase + '-' + String(out.length);
      out.push(irToolCallBlock(id, irStr(block['name']) ?? 'unknown', block['arguments'] ?? {}));
      continue;
    }
    if (type === 'image') {
      out.push(irTextBlock('[image: ' + (irStr(block['mimeType']) ?? 'image') + ']'));
      irBump(ignored, 'image-degraded');
      continue;
    }
    irBump(ignored, 'block:' + (type ?? 'unmapped'));
  }
  return out;
}

export interface PiParseOutcome {
  /** 会话头（`type:"session"`）；缺省 = 不是 Pi 会话文件 */
  readonly header?: Record<string, unknown> | undefined;
  readonly parsed: ParsedTranscript;
}

/**
 * Pi 会话 JSONL（纯函数：原文 → 已归一记录）。
 *
 * 步骤：① 找会话头（`type:"session"`；没有 → `header` 留空，调用方跳过该文件）；
 * ② 其余条目按 `id/parentId` 组树（缺 id 的旧式条目按顺序链接）；
 * ③ 从末条目沿 `parentId` 走到根 = **活动分支**（visited 防环），旁支条目丢弃并计数；
 * ④ 沿活动分支把 message 归一成记录，toolResult 挂回声明它的 assistant 记录之后；
 * ⑤ 标题取活动分支上最后一个 `session_info.name`，缺省回退首条用户文本。
 */
export function parsePiTranscript(text: string): PiParseOutcome {
  const { objects, bad } = parseJsonlText(text);
  const ignored: Record<string, number> = {};
  if (!objects.some((o) => o['type'] === 'session')) {
    return { parsed: { records: [], cwd: undefined, createdAt: undefined, title: '', raw: objects.length, bad, ignored } };
  }
  const header = objects.find((o) => o['type'] === 'session');
  if (header === undefined) {
    return { parsed: { records: [], cwd: undefined, createdAt: undefined, title: '', raw: objects.length, bad, ignored } };
  }

  interface PiEntry { readonly rec: Record<string, unknown>; readonly id: string; readonly parentId: string | null }
  const entries: PiEntry[] = [];
  for (const rec of objects) {
    if (rec === header) continue;
    const id = irStr(rec['id']) ?? 'e' + String(entries.length);
    const last = entries[entries.length - 1];
    const parentId = typeof rec['parentId'] === 'string' ? rec['parentId'] : (last === undefined ? null : last.id);
    entries.push({ rec, id, parentId });
  }

  // 活动分支：末条目即当前叶，沿 parentId 走到根（visited 防环），再反转为时间序
  const byId = new Map(entries.map((e) => [e.id, e]));
  const active: PiEntry[] = [];
  let cursor: PiEntry | undefined = entries[entries.length - 1];
  const seen = new Set<string>();
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    active.push(cursor);
    if (cursor.parentId === null) break;
    cursor = byId.get(cursor.parentId);
  }
  active.reverse();
  const offBranch = entries.length - active.length;
  if (offBranch > 0) irBump(ignored, 'off-branch', offBranch);

  const ordered: TranscriptRecord[] = [];
  const callOwner = new Map<string, TranscriptRecord>();
  const callOrder = new Map<string, number>();
  const resultsOf = new Map<TranscriptRecord, { readonly record: TranscriptRecord; readonly order: number }[]>();
  let title = '';
  let createdAt = irEarlier(undefined, headerTimeOf(header));

  for (const entry of active) {
    const rec = entry.rec;
    const time = irSafeTime(rec['timestamp']);
    createdAt = irEarlier(createdAt, time);
    const type = irStr(rec['type']);

    if (type === 'session_info') {
      const name = irStr(rec['name']);
      if (name !== undefined) title = name;
      continue;
    }
    if (type !== 'message') {
      // model_change / label / custom / thinking_level_change / compaction / branch_summary …
      // IR 无对等语义（更没有压缩检查点 / reasoning 块）→ 逐类计数，绝不静默
      irBump(ignored, type ?? 'unknown');
      continue;
    }

    const msg = rec['message'];
    if (!isRecord(msg)) {
      irBump(ignored, 'message:no-content');
      continue;
    }
    const role = irStr(msg['role']);

    if (role === 'user') {
      const prompt = piUserText(msg['content']);
      if (prompt.trim() === '') {
        irBump(ignored, 'message:no-content');
        continue;
      }
      ordered.push({ role: 'user', blocks: [irTextBlock(prompt)], time, id: entry.id });
      continue;
    }

    if (role === 'assistant') {
      const blocks = piAssistantBlocks(msg['content'], ignored, 'pi-' + String(ordered.length + 1));
      const record: TranscriptRecord = { role: 'assistant', blocks, time, id: entry.id };
      let order = 0;
      for (const block of blocks) {
        if (block.type !== 'tool_call') continue;
        callOwner.set(block.id, record);
        callOrder.set(block.id, order);
        order += 1;
      }
      ordered.push(record);
      continue;
    }

    if (role === 'toolResult') {
      const callId = irStr(msg['toolCallId']);
      const owner = callId === undefined ? undefined : callOwner.get(callId);
      if (callId === undefined || owner === undefined) {
        // 孤儿结果：没有声明它的调用 → 丢弃并计数（绝不塞进别的 step）
        irBump(ignored, 'tool-result-orphan');
        continue;
      }
      const list = resultsOf.get(owner) ?? [];
      list.push({
        record: {
          role: 'user',
          blocks: [irToolResultBlock(callId, piToolResultText(msg['content']), msg['isError'] === true)],
          time,
          id: entry.id,
        },
        order: callOrder.get(callId) ?? Number.MAX_SAFE_INTEGER,
      });
      resultsOf.set(owner, list);
      continue;
    }

    // bashExecution / branchSummary / compactionSummary / custom …
    irBump(ignored, 'role:' + (role ?? 'unknown'));
  }

  const records: TranscriptRecord[] = [];
  for (const rec of ordered) {
    records.push(rec);
    const results = resultsOf.get(rec);
    if (results === undefined) continue;
    results.sort((a, b) => a.order - b.order);
    for (const r of results) records.push(r.record);
  }

  return {
    header,
    parsed: {
      records,
      cwd: headerCwd(header),
      createdAt,
      title: title === '' ? firstUserText(records) : title,
      raw: objects.length,
      bad,
      ignored,
    },
  };
}

function headerTimeOf(header: Record<string, unknown>): IrTimeMs | undefined {
  for (const key of HEADER_TIME_KEYS) {
    const t = irSafeTime(header[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

export async function readPiSessions(opts: PiReadOptions): Promise<SessionReadOutcome<PiSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const sessionsDir = piSessionsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: PiSessionFile[] = [];

  if (!(await isDirectory(sessionsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）：候选数超过上限即报码，与是否成功解析无关
  const candidates = await walkFiles(sessionsDir, { match: (n) => PI_SESSION_FILE_RE.test(n) });
  const truncated = candidates.length > maxFiles;
  const chosen = truncated ? candidates.slice(0, maxFiles) : candidates;

  for (const file of chosen) {
    const sep = file.rel.lastIndexOf('/');
    const relDir = sep < 0 ? '' : file.rel.slice(0, sep);
    const label = PI_SESSIONS_REL + (relDir === '' ? '' : '/' + relDir) + '/' + file.name;
    const text = await readTextGuarded(file.abs, label, maxBytes, findings);
    if (text === null) continue;
    const { header, parsed } = parsePiTranscript(text);
    if (header === undefined) {
      // 没有会话头 = 不是 Pi 会话文件（convert/pi.mjs：无头行即自拒）→ 跳过并如实报码
      findings.push({ code: 'source-unreadable', origin: label, detail: 'not-a-session' });
      continue;
    }
    const id = piSessionIdOf(header, stemOf(file.name));
    const topDir = file.rel.split('/')[0] ?? '';
    const derivedCwd = parsed.cwd === undefined && topDir.startsWith(PI_DIR_PREFIX)
      ? await derivedCwdOfDirName(topDir, platform)
      : undefined;
    if (parsed.cwd === undefined && derivedCwd !== undefined) {
      findings.push({ code: 'session-cwd-derived', origin: id, detail: 'session-dir-name' });
    }
    files.push({ id, parsed: { ...parsed, cwd: parsed.cwd ?? derivedCwd } });
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'pi', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
