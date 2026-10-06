/**
 * Vibe 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 vibe 行）。
 *
 * 布局（read-vault §10.1 vibe 行 + chat-import sources/vibe.mjs，**以 chat-import 为准**）：
 *   <vibeHome>/logs/session/<session_dir>/{meta.json, messages.jsonl}
 *   根 = $VIBE_HOME（**追加**，不是替换）|| <home>/.vibe   ← 两根**并存**，只取一根会漏扫
 *
 * 会话目录的**自证**不是目录名前缀，而是「目录里有 messages.jsonl」（对照
 * `lib/sources/vibe.mjs` 的 vibeIsSessionDir / collectVibeSessions）：从每个根**递归**
 * 收集，命中即收下且不再下钻（有界深度 MAX_SCAN_DEPTH）。目录名 `session_<ts>_<shortId>`
 * 只是默认形态，时间戳兜底仍按它解析。
 *
 * meta 的权威字段（对照 `lib/sources/vibe.mjs` readVibeSessionSummary 与
 * `lib/convert/vibe.mjs`）：cwd = `environment.working_directory` || `origin_directory`；
 * 创建时间 = `start_time`；标题 = `title`。顶层 `cwd` 仅作历史兼容兜底。
 *
 * messages.jsonl 是 LLMMessage 序列：role user/assistant/tool/system、`tool_calls`、
 * `tool_call_id`、`reasoning_content`、`context_boundary`、`images`。工具结果按
 * `tool_call_id` 挂回声明它的 assistant 记录（本地 IR 只能承载 text/tool_call/tool_result
 * 三块，见 session-ir.ts；reasoning / image / compaction 无承载块 → **逐类计数，绝不静默**）。
 *
 * 交叉核对记录（与 PLAN-B 草稿的差异）：草稿把 vibe 标成「VS Code User 根」并挂起「SQLite?」——
 * 那是 captain 表格的笔误；chat-import §3.1、read-vault §10.1、read-sessions-manager §表中第 28 行
 * 三份都说「VS Code（`~/.vibe`，**无平台分支**）+ messages.jsonl 目录源」，且 $VIBE_HOME 是追加语义
 * （read-vault §10.3-3 专门点出与 continue 的替换语义不同）。本实现按 chat-import。
 */
import { envValue, joinFor, normalizePlatform } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { irBump, irEarlier, irSafeTime, irStr, irTextBlock, irToolCallBlock, irToolResultBlock, parseJsonlObjects } from './session-ir.ts';
import type { IrBlock, IrParseStats, IrTimeMs } from './session-ir.ts';
import { isDirectory, isFile, listDirNames, readJsonSafe, readTextSafe, statOrNull } from './session-read.ts';
import { firstUserText } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const VIBE_HOME_ENV = 'VIBE_HOME';
export const VIBE_DEFAULT_DIR = '.vibe';
export const VIBE_LOG_SEGMENTS: readonly string[] = ['logs', 'session'];
export const VIBE_SESSION_DIR_PREFIX = 'session_';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_DIRS = 5000;
/** 递归收集的深度上限（根记为 0；参考实现用递归，这里给一个有界值防病态目录树） */
const MAX_SCAN_DEPTH = 6;

const CWD_KEYS: readonly string[] = [
  'cwd', 'workdir', 'workingDirectory', 'working_directory', 'workspace', 'workspacePath', 'projectPath', 'directory',
];
const TITLE_KEYS: readonly string[] = ['title', 'summary', 'name', 'topic', 'task'];
const TIME_KEYS: readonly string[] = ['start_time', 'startTime', 'createdAt', 'created_at', 'startedAt', 'timestamp', 'time'];

/** 静态探测位置（**两根并存**：$VIBE_HOME 根 + ~/.vibe 根；去重但不丢任一根） */
export function vibeSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const out: string[] = [];
  const explicit = envValue(opts.env, VIBE_HOME_ENV);
  if (explicit !== undefined) out.push(joinFor(platform, explicit, ...VIBE_LOG_SEGMENTS));
  const fallback = joinFor(platform, opts.homeDir, VIBE_DEFAULT_DIR, ...VIBE_LOG_SEGMENTS);
  if (!out.includes(fallback)) out.push(fallback);
  return out;
}

/** 一条已归一的会话文件（`ParsedTranscript` + 源侧 id，draftOf 直接透传） */
export interface VibeSessionFile extends ParsedTranscript { readonly id: string }

function firstStringIn(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** 秒/毫秒自动判定（对照 core.mjs parseTimeMs：< 1e11 视为 Unix 秒）；非数字走 irSafeTime（ISO） */
function vibeTimeOf(value: unknown): IrTimeMs | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round(value < 1e11 ? value * 1000 : value);
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  return irSafeTime(value);
}

function firstTimeIn(rec: Record<string, unknown>, keys: readonly string[]): IrTimeMs | undefined {
  for (const key of keys) {
    const t = vibeTimeOf(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * meta.json → cwd。千问式的顶层 `cwd` 在 vibe 里**不是**权威位置：真实布局是
 * `environment.working_directory`（Vibe 记录的进程工作目录）与 `origin_directory`。
 */
function metaCwdOf(meta: Record<string, unknown>): string | undefined {
  const env = meta['environment'];
  if (isRecord(env)) {
    const v = irStr(env['working_directory']);
    if (v !== undefined) return v;
  }
  const origin = irStr(meta['origin_directory']);
  if (origin !== undefined) return origin;
  return firstStringIn(meta, CWD_KEYS);
}

/** 消息 content → 文本（string / 文本块数组 / 单块对象） */
function vibeTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'string') { parts.push(p); continue; }
      if (!isRecord(p)) continue;
      if (typeof p['text'] === 'string') { parts.push(p['text']); continue; }
      if (typeof p['content'] === 'string') parts.push(p['content']);
    }
    return parts.join(String.fromCharCode(10));
  }
  if (isRecord(content) && typeof content['text'] === 'string') return content['text'];
  return '';
}

/** 工具入参：字符串若是 JSON 就解析（源侧两种形态并存） */
function vibeToolInput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { return raw; }
    }
  }
  return raw;
}

/** images[] 无 IR 承载块（IrBlock 只有 text/tool_call/tool_result）→ 逐张计数 */
function countVibeImages(images: unknown, ignored: Record<string, number>): void {
  if (Array.isArray(images) && images.length > 0) irBump(ignored, 'image-block', images.length);
}

/**
 * 目录名 `session_<ts>_<shortId>` 里的时间戳（毫秒安全整数才采信）。
 * 这是**布局自证的元数据**（不是从内容猜 cwd），meta.json 缺时间时用它兜底。
 * `<ts>` 既可能是毫秒（13 位）也可能是秒（10 位）→ 交给 `vibeTimeOf` 判定。
 */
export function vibeTimeFromDirName(name: string): number | undefined {
  if (!name.startsWith(VIBE_SESSION_DIR_PREFIX)) return undefined;
  const rest = name.slice(VIBE_SESSION_DIR_PREFIX.length);
  const sep = rest.indexOf('_');
  const head = sep < 0 ? rest : rest.slice(0, sep);
  if (!/^[0-9]{10,16}$/.test(head)) return undefined;
  return vibeTimeOf(Number(head));
}

/**
 * messages.jsonl → 归一记录（对照 `lib/convert/vibe.mjs` 的 convertVibeJson）。
 *
 * 工具结果按 `tool_call_id` 挂回声明它的 assistant 记录 → **产出顺序**里紧跟该记录
 * （本地合成器按位置把结果收进「当前 step」，参考实现同样要求结果归属 call 所在 step）。
 */
export function parseVibeJsonl(text: string): ParsedTranscript {
  const stats: IrParseStats = { records: 0, unparsable: 0, issues: [] };
  const objects = parseJsonlObjects(text, stats);
  const ignored: Record<string, number> = {};
  const records: TranscriptRecord[] = [];
  const declaredCalls = new Set<string>();
  const toolResults = new Map<string, { block: IrBlock; time: IrTimeMs | undefined }>();
  let createdAt: IrTimeMs | undefined;
  let hasTurn = false;

  for (const m of objects) {
    const role = typeof m['role'] === 'string' ? m['role'].toLowerCase() : '';
    if (role === 'system') continue; // DSH 会话自带 system head，避免污染
    const time = vibeTimeOf(m['time'] ?? m['timestamp'] ?? m['createdAt'] ?? m['created_at']);
    createdAt = irEarlier(createdAt, time);

    if (m['context_boundary'] === 'compaction') {
      // 参考实现映射为 DSH 原生压缩检查点；本地合成器暂无此能力位（shared 层）→ 计数不静默
      irBump(ignored, 'compaction');
      continue;
    }

    if (role === 'user') {
      const prompt = vibeTextOf(m['content']) || (typeof m['input_text'] === 'string' ? m['input_text'] : '');
      countVibeImages(m['images'], ignored);
      if (prompt.trim() === '') { irBump(ignored, 'user-empty'); continue; }
      records.push({ role: 'user', blocks: [irTextBlock(prompt)], time, id: irStr(m['id']) ?? irStr(m['messageId']) });
      hasTurn = true;
      continue;
    }

    if (role === 'assistant') {
      if (!hasTurn) { irBump(ignored, 'orphan-assistant'); continue; }
      const contentText = vibeTextOf(m['content']);
      const reasoning = vibeTextOf(m['reasoning_content']);
      const blocks: IrBlock[] = [];
      if (reasoning.trim() !== '') irBump(ignored, 'reasoning-block');
      if (contentText.trim() !== '') blocks.push(irTextBlock(contentText));
      countVibeImages(m['images'], ignored);
      const toolCalls = m['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!isRecord(tc)) continue;
          const fn = isRecord(tc['function']) ? tc['function'] : undefined;
          const callId = irStr(tc['id']) ?? '';
          const name = fn === undefined ? '' : (irStr(fn['name']) ?? '');
          const argsRaw = fn === undefined ? undefined : fn['arguments'];
          blocks.push(irToolCallBlock(callId, name, typeof argsRaw === 'string' ? vibeToolInput(argsRaw) : (argsRaw ?? {})));
          declaredCalls.add(callId);
        }
      }
      if (blocks.length === 0) { irBump(ignored, 'assistant-empty'); continue; }
      records.push({ role: 'assistant', blocks, time, id: irStr(m['id']) ?? irStr(m['messageId']) });
      continue;
    }

    if (role === 'tool') {
      const callId = irStr(m['tool_call_id']) ?? '';
      if (callId === '' || !declaredCalls.has(callId) || toolResults.has(callId)) {
        irBump(ignored, 'dropped-tool-result');
        continue;
      }
      let resText = vibeTextOf(m['content']);
      const rawResult = isRecord(m['tool_result']) ? m['tool_result'] : undefined;
      if (resText === '' && rawResult !== undefined && rawResult['output'] !== undefined) {
        resText = vibeTextOf(rawResult['output']);
        if (resText === '' && typeof rawResult['output'] !== 'string') irBump(ignored, 'toolResult:unmapped');
      }
      const isError = rawResult !== undefined && rawResult['cancelled'] === true;
      toolResults.set(callId, { block: irToolResultBlock(callId, resText, isError), time });
      continue;
    }

    irBump(ignored, role === '' ? 'unknown' : 'role:' + role);
  }

  const withResults: TranscriptRecord[] = [];
  for (const rec of records) {
    withResults.push(rec);
    if (rec.role !== 'assistant') continue;
    const blocks: IrBlock[] = [];
    let time: IrTimeMs | undefined;
    for (const b of rec.blocks) {
      if (b.type !== 'tool_call') continue;
      const r = toolResults.get(b.id);
      if (r === undefined) continue;
      blocks.push(r.block);
      if (time === undefined) time = r.time;
      toolResults.delete(b.id);
    }
    if (blocks.length > 0) withResults.push({ role: 'user', blocks, time });
  }

  return {
    records: withResults,
    createdAt,
    title: firstUserText(withResults),
    raw: objects.length + stats.unparsable,
    bad: stats.unparsable,
    ignored,
  };
}

async function readVibeSession(
  platform: ForeignPlatform,
  dir: string,
  dirName: string,
  findings: ForeignSkip[],
): Promise<VibeSessionFile | undefined> {
  const label = dirName; // 位置标签只用会话目录名（绝不回传机器路径）
  const metaPath = joinFor(platform, dir, 'meta.json');
  const messagesPath = joinFor(platform, dir, 'messages.jsonl');

  const metaRead = await readJsonSafe(metaPath, MAX_FILE_BYTES);
  let meta: Record<string, unknown> | undefined;
  if (metaRead.ok) {
    if (isRecord(metaRead.value)) meta = metaRead.value;
    else findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-not-object' });
  } else if (metaRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'meta-' + metaRead.problem });
  }

  const st = await statOrNull(messagesPath);
  if (st === null || !st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'messages-missing' });
    return undefined;
  }
  const text = await readTextSafe(messagesPath, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: st.size > MAX_FILE_BYTES ? 'messages-too-large' : 'messages-read-error',
    });
    return undefined;
  }
  const parsed = parseVibeJsonl(text);
  const metaCwd = meta === undefined ? undefined : metaCwdOf(meta);
  const metaTitle = meta === undefined ? undefined : firstStringIn(meta, TITLE_KEYS);
  const createdAt = irEarlier(
    meta === undefined ? undefined : firstTimeIn(meta, TIME_KEYS),
    parsed.createdAt ?? vibeTimeFromDirName(dirName),
  );
  return {
    id: dirName,
    cwd: metaCwd,
    createdAt,
    title: metaTitle === undefined ? parsed.title : metaTitle.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
  };
}

/** 读全部 vibe 会话（两根；**递归**收集含 messages.jsonl 的目录，命中即收下不下钻） */
export async function readVibe(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<VibeSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const findings: ForeignSkip[] = [];
  const maxFiles = opts.maxFiles ?? MAX_SESSION_DIRS;
  const files: VibeSessionFile[] = [];
  const seen = new Set<string>();
  let dirs = 0;
  let truncated = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const name of await listDirNames(dir)) {
      if (truncated) return;
      const child = joinFor(platform, dir, name);
      if (await isFile(joinFor(platform, child, 'messages.jsonl'))) {
        if (files.length >= maxFiles) { truncated = true; return; }
        dirs += 1;
        const file = await readVibeSession(platform, child, name, findings);
        if (file === undefined || seen.has(file.id)) continue;
        seen.add(file.id);
        files.push(file);
        continue; // 会话目录不下钻（子目录不是另一个会话）
      }
      if (depth + 1 < MAX_SCAN_DEPTH && (await isDirectory(child))) await visit(child, depth + 1);
    }
  };

  for (const root of vibeSessionRoots(opts)) {
    if (truncated) break;
    if (await isDirectory(root)) await visit(root, 0);
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'vibe', detail: 'max-sessions-reached', count: maxFiles });
  }
  return { files, readFindings: findings, extraCounts: { 'vibe.sessionDirs': dirs } };
}
