/**
 * Reasonix 会话读盘层 —— 档 B 文件类来源（真值表见 truth-table.ts 的 reasonix 行）。
 *
 * 布局（chat-import discovery/jsonl.mjs:178-234、tools/source-derive.mjs:102-287；read-vault §10.2）：
 *   CLI ：<home>/.reasonix/sessions/<stem>.jsonl      + 伴生 <stem>.meta.json（旧版）
 *                                                      + 伴生 <file>.jsonl.meta（新版）
 *                                                      + WAL <stem>.events.jsonl（V2）
 *   桌面：<appdata>/reasonix/projects/<slug>/sessions/<file>.jsonl（.titles.json 权威标题）
 *   <appdata>/reasonix 仅在 win32 平台加入（**Windows 桌面端第二根**）。
 *
 * 四条归一（都在本层做实，翻译层只做草稿装配）：
 *  ① 两代消息形状都接受：assistant 的 `tool_calls`（v1 嵌套 `function{name,arguments}`，
 *     v2 扁平 `{id,name,arguments}`）与 `role:"tool"` 的结果记录**必须**配对成
 *     assistant(tool_call) + user(tool_result) 两条归一记录（DSH 合成器硬校验工具生命周期闭合）；
 *  ② `<stem>.events.jsonl`（V2 WAL）合并进 checkpoint：`{type:'replace',messages:[…]}` 整表接管，
 *     其余行按顺序追加（chat-import convert/reasonix.mjs:49-74）；
 *  ③ `.events/.conflicts/.guardian.jsonl` 是**旁路日志不是会话** → 绝不扫描（否则幻影会话 +
 *     幻影 session-empty）；`subagent-sub-*` 子代理会话只计数报码，不当独立对话；
 *  ④ usage 的 snake_case 桶名（input_tokens…）归一到 IR 的 camelCase 口径，
 *     stem 内嵌时刻（YYYYMMDDHHMM）作 createdAt 的最后兜底（否则会话时间落成导入时刻）。
 *
 * 纪律：路径函数显式收 platform；cwd 只有「记录字段 / sidecar / slug 逆解码」三种来源，
 * 都没有就留空由下游按 session-missing-cwd 跳过（**绝不猜**）；单文件 8 MiB 上限、
 * 目录树深度上限、根不存在 = 正常（未安装），读不到才报码。
 */
import { isAbsoluteFor, joinFor, normalizePlatform, roamingAppDataDir } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import {
  isDirectory,
  parseJsonlText,
  readJsonSafe,
  readTextSafe,
  statOrNull,
  stemOf,
  walkFiles,
} from './session-read.ts';
import type { WalkedFile } from './session-read.ts';
import { firstUserText } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import { irBump, irEarlier, irSafeTime, irStr, irToolCallBlock, irToolResultBlock, irTextBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

export const REASONIX_DIR = '.reasonix';
export const REASONIX_SESSIONS_SUBDIR = 'sessions';
export const REASONIX_DESKTOP_DIR = 'reasonix';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 6;

/** 子代理会话（chat-import convert/reasonix.mjs:46）：不是独立主会话，只计数报码 */
const REASONIX_SUBAGENT_RE = /^subagent-/;

/**
 * 伴生文件（chat-import discovery/jsonl.mjs:183-189 的 isReasonixSidecar）：
 * `.events.jsonl` 是 V2 的 WAL、`.conflicts/.guardian.jsonl` 是守护日志 —— 都不是会话。
 * 早期实现按「一切 .jsonl」扫描，于是每个会话都多出 1~3 条幻影会话（stem 变成
 * `desktop-1.events`，且因无 meta 而 session-missing-cwd 或 session-empty）。
 */
const REASONIX_SIDECAR_RE = /\.(events|conflicts|guardian)\.jsonl$/i;

const LEGACY_CWD_KEYS: readonly string[] = [
  'workspace', 'cwd', 'workdir', 'workingDirectory', 'working_directory', 'projectPath', 'directory', 'path',
];
const LEGACY_TITLE_KEYS: readonly string[] = ['summary', 'title', 'name', 'topic'];
const TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'startTime', 'startedAt', 'timestamp', 'time', 'updatedAt'];
const RECORD_TIME_KEYS: readonly string[] = ['createdAt', 'created_at', 'timestamp', 'time'];

/**
 * 静态探测位置（**多根**）：`<home>/.reasonix/sessions` +（win32）`%APPDATA%/reasonix`。
 *
 * 为什么 win32 的第二根无条件加入（而不是「仅 $APPDATA 存在时」）：真值表把这两条都写进了
 * `defaults.win32`，而 `roamingAppDataDir` 在缺 %APPDATA% 时会回落到 `<home>/AppData/Roaming`
 * —— 条件加入会让 probePaths 与真值表在「空环境」下逐项不等（t6 按合成真值交叉核对时必红）。
 */
export function reasonixSessionRoots(opts: RootProbeOptions): string[] {
  const platform = normalizePlatform(opts.platform);
  const roots = [joinFor(platform, opts.homeDir, REASONIX_DIR, REASONIX_SESSIONS_SUBDIR)];
  if (platform === 'win32') {
    roots.push(joinFor(platform, roamingAppDataDir(platform, opts.homeDir, opts.env), REASONIX_DESKTOP_DIR));
  }
  return roots;
}

/**
 * 一条已归一的会话文件（`ParsedTranscript` + 源侧 id，draftOf 直接透传）。
 *
 * `walMerged` / `walRecords` 是 WAL 合并的可见性报告（绝不静默）。
 */
export interface ReasonixSessionFile extends ParsedTranscript {
  readonly id: string;
  readonly walMerged: boolean;
  readonly walRecords: number;
}

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

/** 伴生元数据路径（**旧版**）：`<stem>.jsonl` → `<stem>.meta.json` */
export function reasonixMetaPath(jsonlPath: string): string {
  return jsonlPath.slice(0, jsonlPath.length - '.jsonl'.length) + '.meta.json';
}

/** 伴生元数据路径（**新版**）：`<file>.jsonl` → `<file>.jsonl.meta`（chat-import source-derive.mjs:118） */
export function reasonixModernMetaPath(jsonlPath: string): string {
  return jsonlPath + '.meta';
}

/** V2 事件日志（WAL）路径：`<stem>.jsonl` → `<stem>.events.jsonl` */
export function reasonixWalPath(jsonlPath: string): string {
  return jsonlPath.slice(0, jsonlPath.length - '.jsonl'.length) + '.events.jsonl';
}

/**
 * stem 内嵌的会话创建时刻（`YYYYMMDDHHMM`，本地时间；chat-import convert/reasonix.mjs:31-41）。
 * 转录行与 meta 都没有时间戳时回退到它 —— 否则会话创建时间会落成**导入时刻**。
 */
export function reasonixStemTime(stem: string): number | undefined {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(stem);
  if (m === null) return undefined;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const t = new Date(Number(m[1]), month - 1, day, hour, minute).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * 桌面版布局 `…/projects/<slug>/sessions/<file>.jsonl`（chat-import source-derive.mjs:210-218）：
 * 返回 slug 与 sessions 目录；不是该布局返回 undefined。
 */
export function reasonixDesktopLayout(path: string): { readonly slug: string; readonly sessionsDir: string } | undefined {
  const value = path.replace(/[\\/]+$/, '');
  const segs = value.split(/[\\/]/);
  const sessionsIdx = segs.lastIndexOf('sessions');
  if (sessionsIdx < 2 || segs[sessionsIdx - 2] !== 'projects') return undefined;
  const slug = segs[sessionsIdx - 1];
  if (slug === undefined || slug === '') return undefined;
  // 前 sessionsIdx+1 段在原串里的长度 = 各段长度 + 段间分隔符（保留输入的分隔符风格）
  const end = segs.slice(0, sessionsIdx + 1).reduce((n, seg) => n + seg.length, 0) + sessionsIdx;
  return { slug, sessionsDir: value.slice(0, end) };
}

/**
 * Reasonix 项目 slug 贪心逆解码（chat-import cwd-map.mjs:86-134）：磁盘存在性逐段匹配，
 * `c--users--name--proj` → `C:\users\name\proj`，兼容含 `-` 的目录名（合并 ≤3 段）。
 * 只接受**绝对路径**（相对候选会随进程 cwd 漂移，宁可返回 undefined）。
 */
export async function greedyDecodeSlugPath(slug: string, platform: ForeignPlatform): Promise<string | undefined> {
  const segments = slug.split('-').filter((s) => s !== '');
  if (segments.length === 0) return undefined;
  let base: string | undefined;
  let rest = segments;
  const head = segments[0] ?? '';
  if (platform === 'win32' && /^[a-z]$/.test(head)) {
    base = head.toUpperCase() + ':';
    rest = segments.slice(1);
  } else if (slug.startsWith('-')) {
    base = '/';
  }
  const build = (parts: readonly string[]): string =>
    base === undefined ? joinFor(platform, ...parts) : joinFor(platform, base, ...parts);
  const exists = async (p: string): Promise<boolean> => isAbsoluteFor(platform, p) && (await isDirectory(p));
  const matched: string[] = [];
  let i = 0;
  while (i < rest.length) {
    if (await exists(build([...matched, ...rest.slice(i)]))) return build([...matched, ...rest.slice(i)]);
    const single = rest[i] ?? '';
    if (await exists(build([...matched, single]))) {
      matched.push(single);
      i += 1;
      continue;
    }
    let consumed = 0;
    for (let n = 2; n <= 3 && i + n <= rest.length; n += 1) {
      const merged = rest.slice(i, i + n).join('-');
      if (await exists(build([...matched, merged]))) {
        consumed = n;
        break;
      }
    }
    if (consumed === 0) return undefined;
    matched.push(rest.slice(i, i + consumed).join('-'));
    i += consumed;
  }
  return matched.length > 0 ? build(matched) : undefined;
}

/* ---------------- 归一解析（两代消息形状 + 工具配对） ---------------- */

/** usage 桶名两代并存：V2 是 snake_case，IR 只认 camelCase → 在这里归一（否则整份记 0） */
const USAGE_KEY_MAP: readonly (readonly [string, string])[] = [
  ['input_tokens', 'inputTokens'],
  ['inputTokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['outputTokens', 'outputTokens'],
  ['cache_read_tokens', 'cacheReadTokens'],
  ['cacheReadTokens', 'cacheReadTokens'],
  ['reasoning_tokens', 'reasoningTokens'],
  ['reasoningTokens', 'reasoningTokens'],
];

function reasonixUsageOf(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [source, target] of USAGE_KEY_MAP) {
    const v = raw[source];
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && out[target] === undefined) out[target] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 工具入参：字符串是 JSON 就解析（与 session-source.ts 的 toolInputOf 同口径；合成器会再 JSON.stringify） */
function reasonixToolInput(raw: unknown): unknown {
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

function recordTimeOf(rec: Record<string, unknown>, keys: readonly string[]): IrTimeMs | undefined {
  for (const key of keys) {
    const t = irSafeTime(rec[key]);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * 归一记录（不含 WAL 合并）：user / assistant（两代 tool_calls） / tool（结果配对）。
 *
 * 结果按 callId 挂回**声明它的那条 assistant 记录**，随后者之后补一条 user(tool_result)：
 * DSH 合成器要求 tool/result 与 tool/call 同 step 且紧随其后（session-ir.ts:296）。
 */
function buildReasonixRecords(objects: readonly Record<string, unknown>[], ignored: Record<string, number>): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const callOwner = new Map<string, number>();
  const openCallIds: string[] = [];
  const resultsByCall = new Map<string, IrBlock[]>();
  let assistantCount = 0;

  const attach = (callId: string | undefined, text: string): void => {
    const declared = callId !== undefined && callOwner.has(callId) ? callId : undefined;
    // 对不上 callId 时挂到「最近一个尚无结果的调用」（参考 convert/reasonix.mjs:142 的 lastStep 口径）
    const target = declared ?? openCallIds[openCallIds.length - 1];
    if (target === undefined) {
      irBump(ignored, 'orphan-tool-result');
      return;
    }
    const block = irToolResultBlock(target, text, false);
    const list = resultsByCall.get(target);
    if (list === undefined) resultsByCall.set(target, [block]);
    else list.push(block);
    const i = openCallIds.indexOf(target);
    if (i >= 0) openCallIds.splice(i, 1);
  };

  for (const rec of objects) {
    const role = irStr(rec['role']);
    const time = recordTimeOf(rec, RECORD_TIME_KEYS);

    if (role === 'user') {
      const content = rec['content'];
      if (typeof content !== 'string') {
        irBump(ignored, content === undefined || content === null ? 'user-empty' : 'user:non-string-content');
        continue;
      }
      const prompt = content.trim();
      if (prompt === '') {
        irBump(ignored, 'user-empty');
        continue;
      }
      records.push({ role: 'user', blocks: [irTextBlock(content)], time });
      continue;
    }

    if (role === 'assistant') {
      assistantCount += 1;
      const blocks: IrBlock[] = [];
      const content = rec['content'];
      if (typeof content === 'string' && content.trim() !== '') blocks.push(irTextBlock(content));
      // reasoning_content：IR 没有 reasoning 承载块 → 逐类计数（绝不塞进正文）
      if (rec['reasoning_content'] !== undefined || rec['reasoningContent'] !== undefined) irBump(ignored, 'reasoning_content');
      const rawCalls = rec['tool_calls'] ?? rec['toolCalls'];
      let callIndex = 0;
      if (rawCalls !== undefined) {
        if (!Array.isArray(rawCalls)) {
          irBump(ignored, 'tool_calls:not-an-array');
        } else {
          for (const tc of rawCalls) {
            if (!isRecord(tc)) {
              irBump(ignored, 'toolCall:not-an-object');
              continue;
            }
            callIndex += 1;
            // v1：{id,type:'function',function:{name,arguments}}；v2：{id,name,arguments}（扁平）
            const fn = isRecord(tc['function']) ? tc['function'] : tc;
            const id = irStr(tc['id']) ?? 'reasonix-' + String(assistantCount) + '-' + String(callIndex);
            const name = irStr(fn['name']) ?? 'unknown';
            const args = fn['arguments'] ?? tc['arguments'] ?? fn['args'] ?? tc['args'];
            blocks.push(irToolCallBlock(id, name, reasonixToolInput(args)));
            callOwner.set(id, records.length);
            openCallIds.push(id);
          }
        }
      }
      if (blocks.length === 0) {
        irBump(ignored, 'assistant-empty');
        continue;
      }
      const model = irStr(rec['model']);
      const usage = reasonixUsageOf(rec['usage']);
      records.push({
        role: 'assistant',
        blocks,
        time,
        ...(model === undefined ? {} : { model }),
        ...(usage === undefined ? {} : { usage }),
      });
      continue;
    }

    if (role === 'tool') {
      const content = rec['content'];
      const text = typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content);
      attach(irStr(rec['tool_call_id']) ?? irStr(rec['call_id']), text);
      continue;
    }

    irBump(ignored, role ?? irStr(rec['type']) ?? 'unknown');
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

/** 一次解析的结果（含 WAL 合并报告，与参考的 `{walMerged, walRecords}` 同口径） */
export interface ReasonixParseResult extends ParsedTranscript {
  readonly walMerged: boolean;
  readonly walRecords: number;
}

/**
 * checkpoint JSONL（+ 可选 V2 WAL）→ 归一记录。
 *
 * WAL 合并（chat-import convert/reasonix.mjs:58-74）：
 *  · `{type:'replace', messages:[…]}` = 权威快照，**整表替换** checkpoint；
 *  · 其余行按出现顺序追加到 checkpoint 之后（晚到者胜）；
 *  · 无 WAL / 空 WAL → 纯 checkpoint（旧行为）。
 */
export function parseReasonixTranscript(checkpointText: string, walText?: string | null): ReasonixParseResult {
  const checkpoint = parseJsonlText(checkpointText);
  let objects = checkpoint.objects;
  let bad = checkpoint.bad;
  let walMerged = false;
  let walRecords = 0;
  if (typeof walText === 'string' && walText.trim() !== '') {
    const wal = parseJsonlText(walText);
    bad += wal.bad;
    const replace = wal.objects.find((r) => r['type'] === 'replace' && Array.isArray(r['messages']));
    if (replace !== undefined) {
      const messages = (replace['messages'] as readonly unknown[]).filter(isRecord);
      walMerged = true;
      walRecords = messages.length;
      objects = messages;
    } else if (wal.objects.length > 0) {
      walMerged = true;
      walRecords = wal.objects.length;
      objects = [...objects, ...wal.objects];
    }
  }
  const ignored: Record<string, number> = {};
  const records = buildReasonixRecords(objects, ignored);
  let createdAt: IrTimeMs | undefined;
  for (const rec of objects) createdAt = irEarlier(createdAt, recordTimeOf(rec, RECORD_TIME_KEYS));
  return {
    records,
    createdAt,
    title: firstUserText(records),
    raw: objects.length,
    bad,
    ignored,
    walMerged,
    walRecords,
  };
}

/* ---------------- 伴生元数据（两代 sidecar） ---------------- */

interface ReasonixMeta {
  readonly record: Record<string, unknown>;
  /** true = 新版 `<file>.jsonl.meta`（topic_title / workspace_root / scope） */
  readonly modern: boolean;
}

async function readMetaAt(
  path: string,
  label: string,
  findings: ForeignSkip[],
  detail: string,
): Promise<Record<string, unknown> | undefined> {
  const read = await readJsonSafe(path, MAX_FILE_BYTES);
  if (!read.ok) {
    if (read.problem !== 'missing') {
      findings.push({ code: 'source-unreadable', origin: label, detail: detail + '-' + read.problem });
    }
    return undefined;
  }
  if (!isRecord(read.value)) {
    findings.push({ code: 'source-unreadable', origin: label, detail: detail + '-not-object' });
    return undefined;
  }
  return read.value;
}

/** 两代 sidecar：新版 `<file>.jsonl.meta` 优先，旧版 `<stem>.meta.json` 回退 */
async function readReasonixMeta(file: WalkedFile, label: string, findings: ForeignSkip[]): Promise<ReasonixMeta | undefined> {
  const modern = await readMetaAt(reasonixModernMetaPath(file.abs), label, findings, 'meta');
  if (modern !== undefined) return { record: modern, modern: true };
  const legacy = await readMetaAt(reasonixMetaPath(file.abs), label, findings, 'meta');
  return legacy === undefined ? undefined : { record: legacy, modern: false };
}

/** 桌面版 sessions 目录级的 `.titles.json`（basename → 标题）；缺失是常态，读不出才报码 */
async function readReasonixTitles(
  platform: ForeignPlatform,
  sessionsDir: string,
  label: string,
  findings: ForeignSkip[],
): Promise<Record<string, unknown> | undefined> {
  return await readMetaAt(joinFor(platform, sessionsDir, '.titles.json'), label, findings, 'titles');
}

/* ---------------- 单文件读取 ---------------- */

async function readReasonixSession(
  file: WalkedFile,
  platform: ForeignPlatform,
  findings: ForeignSkip[],
): Promise<ReasonixSessionFile | undefined> {
  const id = stemOf(file.name);
  const label = id;
  const st = await statOrNull(file.abs);
  if (st === null || !st.isFile()) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'missing' });
    return undefined;
  }
  const text = await readTextSafe(file.abs, MAX_FILE_BYTES);
  if (text === null) {
    findings.push({
      code: 'source-unreadable',
      origin: label,
      detail: st.size > MAX_FILE_BYTES ? 'too-large' : 'read-error',
    });
    return undefined;
  }
  const walText = await readTextSafe(reasonixWalPath(file.abs), MAX_FILE_BYTES);
  const parsed = parseReasonixTranscript(text, walText);
  const meta = await readReasonixMeta(file, label, findings);
  const desktop = reasonixDesktopLayout(file.abs);

  // cwd：新版 workspace_root（scope='global' 的会话不属于任何工作区）→ 旧版 workspace →
  // 桌面版 slug 逆解码；都没有 = 留空（下游 session-missing-cwd，绝不猜）
  let cwd: string | undefined;
  if (meta !== undefined) {
    if (meta.modern) {
      if (meta.record['scope'] !== 'global') cwd = irStr(meta.record['workspace_root']);
    } else {
      cwd = firstStringIn(meta.record, LEGACY_CWD_KEYS);
    }
  }
  if (cwd === undefined && desktop !== undefined) cwd = await greedyDecodeSlugPath(desktop.slug, platform);

  // 标题：新版 topic_title → 旧版 summary → 桌面版 .titles.json → 首问兜底
  let title: string | undefined;
  if (meta !== undefined) {
    title = meta.modern ? irStr(meta.record['topic_title']) : firstStringIn(meta.record, LEGACY_TITLE_KEYS);
  }
  if (title === undefined && desktop !== undefined) {
    const titles = await readReasonixTitles(platform, desktop.sessionsDir, label, findings);
    const t = titles?.[id];
    if (typeof t === 'string' && t.trim() !== '') title = t.trim();
  }

  const metaTime = meta === undefined ? undefined : firstTimeIn(meta.record, TIME_KEYS);
  const createdAt = irEarlier(irEarlier(metaTime, parsed.createdAt), reasonixStemTime(id));
  return {
    id,
    cwd,
    createdAt,
    title: title === undefined ? parsed.title : title.slice(0, 200),
    records: parsed.records,
    raw: parsed.raw,
    bad: parsed.bad,
    ignored: parsed.ignored,
    walMerged: parsed.walMerged,
    walRecords: parsed.walRecords,
  };
}

/** 读全部 reasonix 会话（多根；同 id 先到先得，不覆盖 —— 与全局「同 id 只允许一条」同口径） */
export async function readReasonix(
  opts: RootProbeOptions & { readonly maxFiles?: number },
): Promise<SessionReadOutcome<ReasonixSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const findings: ForeignSkip[] = [];
  const files: ReasonixSessionFile[] = [];
  const seen = new Set<string>();
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  // walkFiles 只回数组、不报是否触顶 → 每个根多要一条：拿到 maxFiles+1 条即**证明**触顶（audit-foreign F4）。
  let truncated = false;
  let walked = 0;
  let subagents = 0;
  let walRecords = 0;
  for (const root of reasonixSessionRoots(opts)) {
    const foundAll = await walkFiles(root, {
      match: (name) => name.endsWith('.jsonl') && !REASONIX_SIDECAR_RE.test(name),
      maxDepth: MAX_DEPTH,
      maxFiles: maxFiles + 1,
    });
    if (foundAll.length > maxFiles) truncated = true;
    const found = foundAll.length > maxFiles ? foundAll.slice(0, maxFiles) : foundAll;
    for (const entry of found) {
      const stem = stemOf(entry.name);
      // 子代理会话不是独立主会话：只计数报码，绝不产出碎片对话（chat-import convert/reasonix.mjs:46）
      if (REASONIX_SUBAGENT_RE.test(stem)) {
        subagents += 1;
        continue;
      }
      walked += 1;
      if (seen.has(stem)) continue;
      const file = await readReasonixSession(entry, platform, findings);
      if (file === undefined) continue;
      seen.add(file.id);
      walRecords += file.walRecords;
      files.push(file);
    }
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (truncated) findings.push({ code: 'source-unreadable', origin: 'reasonix', detail: 'max-sessions-reached', count: maxFiles });
  const extraSkips: ForeignSkip[] = subagents > 0
    ? [{ code: 'unsupported-session-record', origin: 'subagents', detail: 'subagent-session', count: subagents }]
    : [];
  const extraCounts: Record<string, number> = { 'reasonix.files': walked };
  if (subagents > 0) extraCounts['reasonix.subagentSessions'] = subagents;
  if (walRecords > 0) extraCounts['reasonix.walRecords'] = walRecords;
  return { files, readFindings: findings, extraSkips, extraCounts };
}
