/**
 * Grok Build（grokbuild）会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 grokbuild 行）。
 *
 * 布局（chat-import discovery/session-dirs.mjs:204-268、convert/grokbuild.mjs:129-446）：
 *   <grokHome>/sessions/<encodeURIComponent(cwd)>/<sessionId>/{summary.json, chat_history.jsonl}
 *   <grokHome>/archived_sessions/...   ← **双根**
 *   <grokHome> = $GROK_HOME（非空即**替换**）|| <home>/.grok
 *
 * 五条实现纪律：
 *  ① 路径函数**显式收 platform**（joinFor），绝不用运行平台的分隔符 —— Windows 真值必须在
 *     macOS/Linux 的 CI 上也能断言（platform-paths.ts 文件头）；
 *  ② 会话目录 = **含 summary.json 的目录**，递归识别（不再固定「根/cwd 目录/sessionId」两层，
 *     也不再强制 chat_history.jsonl 才认目录）—— 布局漂移与深层嵌套都能发现；
 *  ③ summary.json 的真实字段是 info.{id,cwd} + generated_title/session_summary +
 *     created_at/updated_at/last_active_at（读错层级 = 标题/工作区/时间三项全空）；
 *  ④ chat_history.jsonl 的行是 {type, …} 形状：assistant 的工具调用在**顶层 tool_calls**、
 *     结果在 **type:'tool_result'** 记录里（与 role/content 的通用形状不同），必须配对成
 *     assistant(tool_call) + user(tool_result) 两条归一记录（DSH 合成器硬校验生命周期闭合）；
 *  ⑤ synthetic_reason 非空且 ≠'human' 的行是 harness 注入（system_reminder / compaction_meta），
 *     绝不进正文。compaction_meta 的交接摘要按 IR 能力计数上报（见下）。
 *
 * cwd 取值顺序 = summary.json 的 info.cwd（记录字段）→ 目录名的 encodeURIComponent 逆变换
 * （该编码可逆、是布局自证的事实，不是「猜」）；两者都没有才落 session-missing-cwd。
 *
 * 读不到一律进 readFindings（稳定机器码），**绝不抛、绝不静默**。
 */
import { envValue, isAbsoluteFor, joinFor, normalizePlatform } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { isFile, listDirSafe, parseJsonlText, readJsonSafe, readTextSafe, statOrNull } from './session-read.ts';
import { flattenText } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irBump, irEarlier, irSafeTime, irStr, irToolCallBlock, irToolResultBlock, irTextBlock, isSafeIrId } from './session-ir.ts';
import type { IrBlock, IrTimeMs, IrToolResultBlock } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const GROK_HOME_ENV = 'GROK_HOME';
export const GROK_DEFAULT_HOME_DIR = '.grok';
/** 双根：chat-import 的注释点名「归档目录此前未纳入默认根，其下的 rollout 完全扫不到」 */
export const GROK_SESSION_SUBDIRS: readonly string[] = ['sessions', 'archived_sessions'];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_DIRS = 5000;
const MAX_DEPTH = 6;

const CWD_KEYS: readonly string[] = [
  'cwd', 'workdir', 'workingDirectory', 'working_directory', 'workspace', 'workspacePath', 'projectPath', 'directory',
];
const TITLE_KEYS: readonly string[] = ['generated_title', 'session_summary', 'title', 'summary', 'name', 'task'];
const TIME_KEYS: readonly string[] = [
  'created_at', 'createdAt', 'updated_at', 'updatedAt', 'last_active_at', 'lastActiveAt', 'startTime', 'startedAt', 'timestamp', 'time',
];

export interface GrokResolvedHome { readonly home: string; readonly overridden: boolean }

/** GROK_HOME（非空即替换；**只报键名，绝不读值进产物**）→ 默认 ~/.grok */
export function resolveGrokHome(opts: RootProbeOptions): GrokResolvedHome {
  const platform = normalizePlatform(opts.platform);
  const explicit = envValue(opts.env, GROK_HOME_ENV);
  if (explicit !== undefined) return { home: explicit, overridden: true };
  return { home: joinFor(platform, opts.homeDir, GROK_DEFAULT_HOME_DIR), overridden: false };
}

/** 静态探测位置（**双根**；运行时再在它下面递归枚举会话目录） */
export function grokSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const { home } = resolveGrokHome(opts);
  return GROK_SESSION_SUBDIRS.map((sub) => joinFor(platform, home, sub));
}

/** 一条已归一的会话文件（结构上就是 ParsedTranscript + 源侧 id，draftOf 可直接透传） */
export interface GrokSessionFile extends ParsedTranscript { readonly id: string }

function firstStringIn(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function firstTimeIn(rec: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const t = irSafeTime(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 目录名 → cwd：encodeURIComponent(cwd) 的逆变换（可逆，故不是「猜」）。
 * 解不出 / 解出来不是目标平台的绝对路径 → undefined（宁可不给，也不落一条错 cwd 的会话）。
 */
export function grokCwdFromDirName(name: string, platform: ForeignPlatform): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  if (decoded === '' || !isAbsoluteFor(platform, decoded)) return undefined;
  return decoded;
}

/* ---------------- chat_history.jsonl 解析（真实 {type,…} 形状） ---------------- */

/** 工具入参：字符串是 JSON 就解析（与 session-source.ts 的 toolInputOf 同口径；合成器会再 JSON.stringify） */
function grokToolInput(raw: unknown): unknown {
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

interface GrokContent {
  readonly blocks: IrBlock[];
  /** 记录内自带的工具结果（结果块类型收窄，配对时要取它的 id/text/isError） */
  readonly results: IrToolResultBlock[];
}

/**
 * 一条记录的 content → { blocks, results }。
 * 覆盖：字符串、block 数组（text / input_text / output_text / tool_use / tool_result）、
 * 单块对象；不认识的块逐类计数（绝不静默丢）。
 */
function grokContentBlocks(content: unknown, ignored: Record<string, number>): GrokContent {
  const blocks: IrBlock[] = [];
  const results: IrToolResultBlock[] = [];
  if (typeof content === 'string') {
    if (content !== '') blocks.push(irTextBlock(content));
    return { blocks, results };
  }
  if (!Array.isArray(content)) return { blocks, results };
  for (const item of content) {
    if (!isRecord(item)) {
      irBump(ignored, 'block:not-an-object');
      continue;
    }
    const type = (irStr(item['type']) ?? '').toLowerCase();
    if (type === 'tool_result' || type === 'tool_response') {
      const id = irStr(item['tool_use_id']) ?? irStr(item['tool_call_id']) ?? '';
      results.push(irToolResultBlock(id, flattenText(item['content'], ignored, 'toolResult'), item['is_error'] === true));
      continue;
    }
    if (type === 'tool_use' || type === 'tool_call' || type === 'function_call') {
      const name = irStr(item['name']) ?? 'unknown';
      const id = irStr(item['id']) ?? '';
      blocks.push(irToolCallBlock(id, name, grokToolInput(item['input'] ?? item['arguments'])));
      continue;
    }
    if (type === '' || type === 'text' || type === 'input_text' || type === 'output_text' || type === 'message') {
      const text = item['text'] ?? item['content'];
      if (typeof text === 'string') {
        if (text !== '') blocks.push(irTextBlock(text));
        continue;
      }
    }
    irBump(ignored, 'block:' + (type === '' ? 'unmapped' : type));
  }
  return { blocks, results };
}

function grokTextOf(blocks: readonly IrBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) if (b.type === 'text') parts.push(b.text);
  return parts.join(String.fromCharCode(10));
}

/**
 * {type,…} 行 → 归一记录（含工具配对）。
 *
 * 结果按 tool_call_id 挂回**声明它的那条 assistant 记录**，随后者之后补一条 user(tool_result)：
 * DSH 合成器要求 tool/result 与 tool/call 同 step 且紧随其后（session-ir.ts:296）。
 */
function buildGrokRecords(objects: readonly Record<string, unknown>[], ignored: Record<string, number>): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const callOwner = new Map<string, number>();
  const openCallIds: string[] = [];
  const resultsByCall = new Map<string, IrBlock[]>();
  let stepCount = 0;

  const attach = (rawCallId: string | undefined, text: string, isError: boolean): void => {
    const declared = rawCallId !== undefined && rawCallId !== '' && callOwner.has(rawCallId) ? rawCallId : undefined;
    // 缺 id 时兜底「最近一个尚未收到结果的调用」（chat-import grokbuild.mjs:250-256 的 openCallIds 口径）
    const target = declared ?? openCallIds[openCallIds.length - 1];
    if (target === undefined) {
      irBump(ignored, 'orphan-tool-result');
      return;
    }
    const block = irToolResultBlock(target, text, isError);
    const list = resultsByCall.get(target);
    if (list === undefined) resultsByCall.set(target, [block]);
    else list.push(block);
    const i = openCallIds.indexOf(target);
    if (i >= 0) openCallIds.splice(i, 1);
  };

  for (const rec of objects) {
    // v0 兼容：行无 type 有 role 时按 role 走同一管线（chat-import grokbuild.mjs:270）
    const kind = (irStr(rec['type']) ?? irStr(rec['role']) ?? '').toLowerCase();

    if (kind === 'system') {
      irBump(ignored, 'system');
      continue;
    }
    if (kind === 'reasoning') {
      // IR 没有 reasoning 承载块（IrBlock 只有 text/tool_call/tool_result）→ 逐条计数
      irBump(ignored, 'reasoning');
      continue;
    }
    if (kind === 'backend_tool_call') {
      // 后端工具（web_search 等）的结果不在转录里，映射成调用会破坏「每个调用恰好一条结果」
      irBump(ignored, 'backend_tool_call');
      continue;
    }
    if (kind === 'tool_result') {
      attach(irStr(rec['tool_call_id']) ?? irStr(rec['call_id']), flattenText(rec['content'], ignored, 'toolResult'), rec['is_error'] === true);
      continue;
    }
    if (kind === 'tool') {
      // Claude 风格 tool 记录（export/grokbuild.mjs 写出的形状）
      const pc = grokContentBlocks(rec['content'], ignored);
      if (pc.results.length > 0) {
        for (const b of pc.results) attach(b.id, b.text, b.isError);
        continue;
      }
      attach(irStr(rec['tool_use_id']) ?? irStr(rec['tool_call_id']), grokTextOf(pc.blocks), rec['is_error'] === true);
      continue;
    }
    if (kind === 'user') {
      const pc = grokContentBlocks(rec['content'], ignored);
      // 记录内自带的 tool_result 块是结果消息，配对、不开新轮
      if (pc.results.length > 0) {
        for (const b of pc.results) attach(b.id, b.text, b.isError);
        continue;
      }
      const raw = grokTextOf(pc.blocks).trim();
      const reason = irStr(rec['synthetic_reason']);
      if (reason !== undefined && reason !== 'human') {
        // 注入行绝不进正文：compaction_meta 是压缩边界（IR 层没有压缩检查点承载块，见文件头 ⑤）
        irBump(ignored, reason === 'compaction_meta' ? 'compaction-meta' : 'injected-user');
        continue;
      }
      if (raw === '') {
        irBump(ignored, 'user-empty');
        continue;
      }
      records.push({ role: 'user', blocks: [irTextBlock(raw)] });
      continue;
    }
    if (kind === 'assistant') {
      stepCount += 1;
      const pc = grokContentBlocks(rec['content'], ignored);
      const blocks = pc.blocks.slice();
      const rawCalls = rec['tool_calls'];
      if (rawCalls !== undefined) {
        if (!Array.isArray(rawCalls)) {
          irBump(ignored, 'tool_calls:not-an-array');
        } else {
          let callIndex = 0;
          for (const tc of rawCalls) {
            if (!isRecord(tc)) {
              irBump(ignored, 'toolCall:not-an-object');
              continue;
            }
            callIndex += 1;
            const id = irStr(tc['id']) ?? 'grokbuild-' + String(stepCount) + '-' + String(callIndex);
            const name = irStr(tc['name']) ?? 'unknown';
            blocks.push(irToolCallBlock(id, name, grokToolInput(tc['arguments'])));
            callOwner.set(id, records.length);
            openCallIds.push(id);
          }
        }
      }
      for (const b of pc.results) attach(b.id, b.text, b.isError);
      if (blocks.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      const model = irStr(rec['model_id']) ?? irStr(rec['model']);
      records.push(model === undefined ? { role: 'assistant', blocks } : { role: 'assistant', blocks, model });
      continue;
    }
    irBump(ignored, kind === '' ? 'unknown' : kind);
  }

  // 结果插到「声明它的 assistant 记录」之后（保持源顺序内的相对位置）
  const out: TranscriptRecord[] = [];
  for (const rec of records) {
    out.push(rec);
    if (rec.role !== 'assistant') continue;
    const collected: IrBlock[] = [];
    for (const block of rec.blocks) {
      if (block.type !== 'tool_call') continue;
      const got = resultsByCall.get(block.id);
      if (got !== undefined) {
        collected.push(...got);
        resultsByCall.delete(block.id);
      }
    }
    if (collected.length > 0) out.push({ role: 'user', blocks: collected });
  }
  let orphaned = 0;
  for (const leftover of resultsByCall.values()) orphaned += leftover.length;
  if (orphaned > 0) irBump(ignored, 'orphan-tool-result', orphaned);
  return out;
}

/** chat_history.jsonl → 归一记录（真实 {type,…} 形状；不是通用 role/content 形状） */
export function parseGrokHistory(text: string): ParsedTranscript {
  const lines = parseJsonlText(text);
  const ignored: Record<string, number> = {};
  const records = buildGrokRecords(lines.objects, ignored);
  let createdAt: IrTimeMs | undefined;
  for (const rec of lines.objects) createdAt = irEarlier(createdAt, irSafeTime(rec['timestamp']) ?? irSafeTime(rec['created_at']));
  return {
    records,
    createdAt,
    title: firstUserTitleOf(records),
    raw: lines.objects.length,
    bad: lines.bad,
    ignored,
  };
}

/** 首问兜底标题（跳过注入行后由调用链保证；口径与共享 firstUserText 一致，此处只取首条 user 文本） */
function firstUserTitleOf(records: readonly TranscriptRecord[]): string {
  for (const rec of records) {
    if (rec.role !== 'user') continue;
    const text = grokTextOf(rec.blocks).replace(/\s+/g, ' ').trim();
    if (text !== '') return text.slice(0, 80);
  }
  return '';
}

/* ---------------- 会话目录发现 + 读取 ---------------- */

interface GrokSessionDir {
  readonly dir: string;
  /** 会话目录名（id 兜底） */
  readonly name: string;
  /** 父目录名（cwd 目录名逆变换的输入） */
  readonly parent: string;
}

/**
 * 递归找出「含 summary.json 的目录」（chat-import discovery/session-dirs.mjs:208-220）。
 * 不再固定 <root>/<cwdDir>/<sessionId> 两层：布局漂移与更深嵌套的会话同样能发现。
 */
async function findGrokSessionDirs(platform: ForeignPlatform, root: string, maxDirs: number): Promise<GrokSessionDir[]> {
  const out: GrokSessionDir[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < maxDirs) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const entry of await listDirSafe(cur.dir)) {
      if (out.length >= maxDirs) break;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const abs = joinFor(platform, cur.dir, entry.name);
      if (await isFile(joinFor(platform, abs, 'summary.json'))) {
        // parent = 会话目录的**上一级**目录名（cwd 目录名逆变换的输入；会话直接挂在根下时
        // 它就是 'sessions'/'archived_sessions' → 逆变换必不成绝对路径 → 安全落 undefined）
        out.push({ dir: abs, name: entry.name, parent: basenameOf(cur.dir) });
      } else if (cur.depth < MAX_DEPTH) {
        stack.push({ dir: abs, depth: cur.depth + 1 });
      }
    }
  }
  return out;
}

/** 路径末段（不引入 path 的平台差异：两种分隔符都认） */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

async function readGrokSession(
  platform: ForeignPlatform,
  entry: GrokSessionDir,
  findings: ForeignSkip[],
): Promise<GrokSessionFile | undefined> {
  // 位置标签只用目录名：**绝不把机器路径回传**（detect/build 的产物会被 GUI/CLI 展示）
  const label = entry.name;
  const summaryPath = joinFor(platform, entry.dir, 'summary.json');
  const historyPath = joinFor(platform, entry.dir, 'chat_history.jsonl');

  const summaryRead = await readJsonSafe(summaryPath, MAX_FILE_BYTES);
  let summary: Record<string, unknown> | undefined;
  if (summaryRead.ok) {
    if (isRecord(summaryRead.value)) summary = summaryRead.value;
    else findings.push({ code: 'source-unreadable', origin: label, detail: 'summary-not-object' });
  } else if (summaryRead.problem !== 'missing') {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'summary-' + summaryRead.problem });
  }

  const historyStat = await statOrNull(historyPath);
  if (historyStat === null || !historyStat.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'history-missing' });
    return undefined;
  }
  const text = await readTextSafe(historyPath, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: historyStat.size > MAX_FILE_BYTES ? 'history-too-large' : 'history-read-error',
    });
    return undefined;
  }

  const parsed = parseGrokHistory(text);
  // summary.json 的真实字段在 info 下（info.id / info.cwd）；顶层同名字段作为容忍回退
  const info = summary !== undefined && isRecord(summary['info']) ? summary['info'] : undefined;
  const infoId = info === undefined ? undefined : irStr(info['id']);
  const id = infoId !== undefined && isSafeIrId(infoId) ? infoId : entry.name;
  const infoCwd = info === undefined ? undefined : irStr(info['cwd']);
  const cwd = infoCwd
    ?? (summary === undefined ? undefined : firstStringIn(summary, CWD_KEYS))
    ?? grokCwdFromDirName(entry.parent, platform);
  const summaryTitle = summary === undefined ? undefined : firstStringIn(summary, TITLE_KEYS);
  const createdAt = irEarlier(summary === undefined ? undefined : firstTimeIn(summary, TIME_KEYS), parsed.createdAt);
  return {
    id,
    cwd,
    createdAt,
    title: summaryTitle === undefined ? parsed.title : summaryTitle.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
  };
}

/**
 * 读全部 grokbuild 会话（双根；源码位置一律按**目标平台**拼接）。
 *
 * 上限：单文件 8 MiB、单根最多 MAX_SESSION_DIRS 个会话目录；触顶**如实报码**（source-unreadable
 * 的 detail=max-sessions-reached），绝不静默截断。
 */
export async function readGrokbuild(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<GrokSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const resolved = resolveGrokHome(opts);
  const findings: ForeignSkip[] = [];
  if (resolved.overridden) findings.push({ code: 'source-location-overridden', origin: GROK_HOME_ENV });
  const maxFiles = opts.maxFiles ?? MAX_SESSION_DIRS;
  const files: GrokSessionFile[] = [];
  // 多要一条：拿到 maxFiles+1 个会话目录即**证明**触顶（audit-foreign F4，绝不静默截断）
  const discovered: GrokSessionDir[] = [];
  for (const root of grokSessionRoots(opts)) {
    const remaining = maxFiles + 1 - discovered.length;
    if (remaining <= 0) break;
    discovered.push(...await findGrokSessionDirs(platform, root, remaining));
  }
  const truncated = discovered.length > maxFiles;
  const considered = truncated ? discovered.slice(0, maxFiles) : discovered;
  for (const entry of considered) {
    const file = await readGrokSession(platform, entry, findings);
    if (file !== undefined) files.push(file);
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'grokbuild', detail: 'max-sessions-reached', count: maxFiles });
  }
  return { files, readFindings: findings, extraCounts: { 'grokbuild.sessionDirs': considered.length } };
}
