/**
 * 千问办公 / Qwen（~\.qwenworkcn/projects）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 qwen 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致）：
 *  - 根：`<home>/.qwenworkcn/projects`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<projects>/<slug>/<session-uuid>.jsonl`（JSONL）
 *
 * cwd 的**唯一权威**（对照 chat-import `lib/convert/qwen.mjs` 的 realWorkspaceDir，
 * 2026-10-06 订正）：记录内的 `cwd` 字段是千问的临时工作区（`.qwenworkcn` 下），
 * **丢弃**；用户真正选择的项目目录在 `workspace-directories` 记录的 `directories[]` 里
 * —— 取第一个非 `.qwenworkcn` 项。slug 目录名只是存储层混写，**依旧不据它推导 cwd**
 * （推导 = 猜）；两者都没有的会话由下游 `transcodeSessionDraft` 按 `session-missing-cwd`
 * 跳过并在计划里可见。
 *
 * 真实提问在 `humanInput.text`（`message.content` 的 text 块常被 `<system-reminder>`
 * 等宿主注入包裹）→ humanInput 优先，回退 content 时跳过 `<system` 开头的块
 * （对照 chat-import `lib/convert/inject.mjs` 的 isSystemContextBlock 与
 * `lib/discovery/claude.mjs` 的 qwenUserQuery）。
 *
 * 主转录自证与去重（对照 `lib/discovery/claude.mjs` 的 scanQwen）：文件名 stem 必须等于
 * 记录里的 `sessionId`（不等的是异 slug 副本 / 辅助转写，跳过并报码）；同一 `sessionId`
 * 的双副本按 **mtime 留最新**。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 qwen 行）。本机无 ~/.qwenworkcn，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { isRecord } from '../utils/guards.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { irBump, irEarlier, irSafeTime, irStr, irTextBlock, irToolCallBlock, irToolResultBlock, parseJsonlObjects } from './session-ir.ts';
import type { IrBlock, IrParseStats, IrTimeMs } from './session-ir.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, firstUserText, flattenText } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const QWEN_PROJECTS_REL = '.qwenworkcn/projects';

/** 会话文件（JSONL 是唯一形态） */
export const QWEN_SESSION_FILE_RE = /\.jsonl$/;

const MAX_SESSION_FILES = 500;

/** Qwen 的项目根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function qwenProjectsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.qwenworkcn', 'projects');
}

/**
 * 通用 JSONL 兜底形态（历史实现；本来源自 2026-10-06 起改用下面的专用解析器
 * `parseQwenJsonl`，**不再据此解析**——保留导出仅为不破坏既有公开面）。
 */
export const QWEN_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 Qwen 会话 */
export interface QwenSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface QwenReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** `parseQwenJsonl` 的额外产物：主转录自证用的源 sessionId（记录里没有 = undefined） */
export interface QwenParsedTranscript extends ParsedTranscript {
  readonly sessionId: string | undefined;
}

/** 注入块判定：trim 后以 `<system` 开头（`<system-reminder>` 及同族标签） */
function isSystemContextText(text: string): boolean {
  return text.trimStart().startsWith('<system');
}

/**
 * `workspace-directories.directories[]` → 用户选的真实项目目录。
 *
 * 第一个非 `.qwenworkcn` 的字符串目录才是用户选的；全在 `.qwenworkcn` 下（纯聊天）
 * 返回 undefined（发现层归「无项目」桶，下游按 session-missing-cwd 跳过）。
 */
export function realQwenWorkspaceDir(directories: unknown): string | undefined {
  if (!Array.isArray(directories)) return undefined;
  for (const d of directories) {
    if (typeof d === 'string' && d !== '' && !/[\\/]\.qwenworkcn([\\/]|$)/i.test(d)) return d;
  }
  return undefined;
}

/** 工具入参：字符串若是 JSON 就解析（源侧两种形态并存） */
function qwenToolInput(raw: unknown): unknown {
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
 * assistant `message.content` 块 → IR 块（text / tool_use / tool_result）。
 *
 * `thinking` 在 IR 里**没有承载块**（IrBlock 只有 text/tool_call/tool_result，见
 * session-ir.ts 头注释；同 read-opencode / read-gemini 口径）→ **不伪装成正文**，逐类计数。
 */
function qwenBlocksOf(content: unknown, ignored: Record<string, number>): IrBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [irTextBlock(content)];
  if (!Array.isArray(content)) return [];
  const out: IrBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block['type'] === 'string' ? block['type'] : '';
    if (type === 'text') {
      const text = block['text'];
      if (typeof text === 'string') out.push(irTextBlock(text));
      else irBump(ignored, 'block:text:no-text');
      continue;
    }
    if (type === 'thinking') {
      irBump(ignored, 'reasoning-block');
      continue;
    }
    if (type === 'tool_use') {
      out.push(irToolCallBlock(irStr(block['id']) ?? '', irStr(block['name']) ?? '', qwenToolInput(block['input'])));
      continue;
    }
    if (type === 'tool_result') {
      const id = irStr(block['tool_use_id']) ?? irStr(block['tool_call_id']) ?? '';
      const body = block['content'] ?? block['output'] ?? block['text'];
      const isError = block['is_error'] === true || block['isError'] === true;
      out.push(irToolResultBlock(id, flattenText(body, ignored, 'toolResult'), isError));
      continue;
    }
    irBump(ignored, 'block:' + (type === '' ? 'unmapped' : type));
  }
  return out;
}

/**
 * 人类提问：`humanInput.text` **权威**（content 里常混注入块）；缺失时回退 content，
 * 并跳过 `<system` 开头的注入块。`hadContent` 区分「注入型 user」与「内容形态不认得」。
 */
function qwenPromptOf(rec: Record<string, unknown>): { prompt: string | undefined; hadContent: boolean } {
  const hi = rec['humanInput'];
  if (isRecord(hi) && typeof hi['text'] === 'string' && hi['text'].trim() !== '') {
    return { prompt: hi['text'], hadContent: true };
  }
  const message = isRecord(rec['message']) ? rec['message'] : undefined;
  const content = message === undefined ? undefined : message['content'];
  if (typeof content === 'string') {
    return { prompt: content.trim() !== '' && !isSystemContextText(content) ? content : undefined, hadContent: true };
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'text') continue;
      const text = block['text'];
      if (typeof text !== 'string' || text.trim() === '' || isSystemContextText(text)) continue;
      texts.push(text);
    }
    const joined = texts.join(String.fromCharCode(10));
    return { prompt: joined === '' ? undefined : joined, hadContent: true };
  }
  return { prompt: undefined, hadContent: false };
}

/**
 * 千问 JSONL → 归一记录（本来源专用；对照 `lib/convert/qwen.mjs` 的 convertQwenJsonl）。
 *
 * 三条与通用 parser 的差异：① cwd 只认 `workspace-directories`（记录内 cwd 丢弃）；
 * ② 提问走 `humanInput` 优先 + 注入块过滤；③ `sessionId` 回传供主转录自证。
 */
export function parseQwenJsonl(text: string): QwenParsedTranscript {
  const stats: IrParseStats = { records: 0, unparsable: 0, issues: [] };
  const objects = parseJsonlObjects(text, stats);
  const ignored: Record<string, number> = {};

  // runtime-config.model / sessionId / 标题载体都是**会话级**信息，先扫一遍（不依赖记录顺序）
  let model: string | undefined;
  let sessionId: string | undefined;
  let title = '';
  for (const rec of objects) {
    if (sessionId === undefined) sessionId = irStr(rec['sessionId']);
    if (model === undefined && rec['type'] === 'runtime-config') model = irStr(rec['model']);
    if (title === '') {
      const candidate = irStr(rec['title']) ?? irStr(rec['summary']) ?? irStr(rec['sessionTitle']);
      if (candidate !== undefined) title = candidate.slice(0, 200);
    }
  }

  const records: TranscriptRecord[] = [];
  let cwd: string | undefined;
  let createdAt: IrTimeMs | undefined;
  // 无前驱提问的孤儿 assistant 丢弃（回合平衡；对照 convert/qwen.mjs 的 `rec.type === 'assistant' && cur`）
  let hasTurn = false;

  for (const rec of objects) {
    const type = typeof rec['type'] === 'string' ? rec['type'] : '';
    if (type === 'workspace-directories') {
      if (cwd === undefined) cwd = realQwenWorkspaceDir(rec['directories']);
      continue;
    }
    if (type === 'runtime-config') continue;

    const time = irSafeTime(rec['timestamp']) ?? irSafeTime(rec['time']);
    createdAt = irEarlier(createdAt, time);
    const id = irStr(rec['uuid']) ?? irStr(rec['id']);

    if (type === 'user' && isRecord(rec['message'])) {
      const content = rec['message']['content'];
      const blocks = Array.isArray(content) ? content : [];
      const hasToolResult = blocks.some((b) => isRecord(b) && b['type'] === 'tool_result');
      if (hasToolResult) {
        const resultBlocks = qwenBlocksOf(blocks.filter((b) => isRecord(b) && b['type'] === 'tool_result'), ignored);
        if (resultBlocks.length === 0) { irBump(ignored, 'toolResult:no-content'); continue; }
        records.push({ role: 'user', blocks: resultBlocks, time, id });
        continue;
      }
      const { prompt, hadContent } = qwenPromptOf(rec);
      if (prompt === undefined) {
        // 注入型 user（去包裹后无人类文本且非 tool_result）是宿主噪声，单独计数不标丢失
        irBump(ignored, hadContent ? 'skipped-system-user' : 'dropped-user-prompt');
        continue;
      }
      records.push({ role: 'user', blocks: [irTextBlock(prompt)], time, id });
      hasTurn = true;
      continue;
    }

    if (type === 'assistant') {
      if (!hasTurn) { irBump(ignored, 'orphan-assistant'); continue; }
      const message = isRecord(rec['message']) ? rec['message'] : undefined;
      const blocks = qwenBlocksOf(message === undefined ? undefined : message['content'], ignored);
      if (blocks.length === 0) { irBump(ignored, 'assistant:no-content'); continue; }
      const record: TranscriptRecord = model === undefined
        ? { role: 'assistant', blocks, time, id }
        : { role: 'assistant', blocks, time, id, model };
      records.push(record);
      continue;
    }

    irBump(ignored, type === '' ? 'unknown' : type);
  }

  if (title === '') title = firstUserText(records);
  return {
    records,
    cwd,
    createdAt,
    title,
    raw: objects.length + stats.unparsable,
    bad: stats.unparsable,
    ignored,
    sessionId,
  };
}

/** 读一个文件（大小闸门在前，绝不截断）；空文件 / 超限 / 读失败都变成稳定机器码 */
async function readTextGuarded(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<{ text: string; mtimeMs: number } | null> {
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
  return { text, mtimeMs: st.mtimeMs };
}

export async function readQwenSessions(opts: QwenReadOptions): Promise<SessionReadOutcome<QwenSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const projectsDir = qwenProjectsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  // sessionId → 会话（同 id 双副本留 mtime 最新；对照 scanQwen 的 bySession）
  const byId = new Map<string, { file: QwenSessionFile; mtimeMs: number }>();

  if (!(await isDirectory(projectsDir))) {
    return { files: [], readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）：静默 break 会让「报成功但条目缺失」。
  let truncated = false;
  let candidates = 0;
  // slug 只当遍历键：编码语义未经取证 → 不参与 cwd 推导（见文件头）
  outer:
  for (const slug of await listDirNames(projectsDir)) {
    const slugDir = joinFor(platform, projectsDir, slug);
    for (const name of await listFileNames(slugDir, (n) => QWEN_SESSION_FILE_RE.test(n))) {
      if (candidates >= maxFiles) { truncated = true; break outer; }
      candidates += 1;
      const label = QWEN_PROJECTS_REL + '/' + slug + '/' + name;
      const read = await readTextGuarded(joinFor(platform, slugDir, name), label, maxBytes, findings);
      if (read === null) continue;
      const stem = stemOf(name);
      const parsed = parseQwenJsonl(read.text);
      // 文件名 stem ≠ 记录 sessionId 的是辅助 / 异构转写，不建会话（双 slug 副本两者一致）
      if (parsed.sessionId !== undefined && parsed.sessionId !== stem) {
        findings.push({ code: 'unsupported-session-record', origin: label, detail: 'auxiliary-transcript' });
        continue;
      }
      const prev = byId.get(stem);
      if (prev !== undefined && prev.mtimeMs >= read.mtimeMs) continue;
      byId.set(stem, { file: { id: stem, parsed }, mtimeMs: read.mtimeMs });
    }
  }

  const files = [...byId.values()].map((v) => v.file).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) findings.push({ code: 'source-unreadable', origin: 'qwen', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
