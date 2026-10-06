/**
 * WorkBuddy（~\.workbuddy/projects）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 workbuddy 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致，无出入）：
 *  - 根：`<home>/.workbuddy/projects`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<projects>/<project-hash>/<session-uuid>.jsonl`（JSONL）
 *  - 目录名 = cwd 的**哈希**（convert/workbuddy.mjs:3-18）
 *
 * cwd 只有**一个**合法来源：记录里的字段。目录名是哈希、**不可逆** —— 本层刻意不做任何
 * 反解，也不拿「第一个用户消息里看起来像路径的串」凑数（那是猜）。没有 cwd 字段的会话
 * 由下游 `transcodeSessionDraft` 按 `session-missing-cwd` 跳过并报码（绝不产出一条
 * 指向不存在目录的会话，也绝不静默丢弃）。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 workbuddy 行）。本机无 ~/.workbuddy，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律（与 read-claude-code.ts / read-qoder.ts 同口径）：只读固定位置、不跟随符号链接、
 * 单文件有字节上限（超限即**不读**并如实报码，绝不截断）、读不到一律记账不抛、结果排序确定。
 * 路径函数**显式收 platform**（joinFor），绝不在真值表里读运行时平台。
 */
import fs from 'node:fs/promises';

import { joinFor, normalizePlatform } from './platform-paths.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, firstUserText, flattenText } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptRecord, TranscriptShape } from './session-source.ts';
import { irBump, irEarlier, irSafeTime, irStr, irTextBlock, irToolCallBlock, irToolResultBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const WORKBUDDY_PROJECTS_REL = '.workbuddy/projects';

/** 会话文件（JSONL 是唯一形态） */
export const WORKBUDDY_SESSION_FILE_RE = /\.jsonl$/;

/** 单次读盘的会话文件数上限 */
const MAX_SESSION_FILES = 500;

/** WorkBuddy 的项目根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function workbuddyProjectsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.workbuddy', 'projects');
}

/**
 * 记录形态的**键候选**单一来源（`parseWorkbuddyJsonl` 从这里取 cwd / 时间 / 模型 / 角色候选）
 * —— 形态本身是事件流（见下面的解析器），不是通用 JSONL。cwd 同义键集合刻意**保守**。
 *
 * cwdKeys 的取法是「只收语义唯一、不会被别的字段占用」的键：`cwd`/`workdir`/`working_directory`
 * 一类。刻意**不收** `path`/`file` 这类在 tool-call 里到处都是的键 —— 收进来就会把工具
 * 参数里的路径当成会话 cwd（那是猜，且错得静默）。`titleKeys` 去掉 `name`（常是工具名）。
 */
export const WORKBUDDY_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 WorkBuddy 会话 */
export interface WorkbuddySessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface WorkbuddyReadOptions extends RootProbeOptions {
  /** 单文件读取上限（缺省 8 MiB） */
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

/* ---------------- ② 事件流解析（通用 shape 不承载的字段在这里补齐） ---------------- */

const WORKBUDDY_USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;

/** 剥掉全部 <system-reminder …>…</system-reminder> 信封块（连同正文，大小写不敏感） */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '');
}

/**
 * 从注入的 user content 里提取**人类真实提问**（参考 convert/workbuddy.mjs 的
 * extractWorkbuddyUserQuery）。
 *
 * WorkBuddy 把 system-reminder / project_context / connector-status / expert_selection 等
 * 系统上下文和人类提问写进**同一条** user 消息，人类提问包在 `<user_query>…</user_query>` 里。
 * 不提取就会把整段注入上下文当成提问（并进一步当成会话标题）—— 旧行为。
 * 优先取信封正文；缺失时剥掉 system-reminder 整块、其余标签替换为空格（标签两侧常是不同
 * 块的文字，直接删会粘成一个词）后折叠空白。
 */
export function extractWorkbuddyUserQuery(content: unknown): string {
  const joined = flattenText(content);
  const matched = WORKBUDDY_USER_QUERY_RE.exec(joined);
  if (matched !== null && matched[1] !== undefined && matched[1].trim() !== '') return matched[1].trim();
  return stripSystemReminders(joined).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** function_call_result → 纯文本结果；取不到返回 null（**绝不虚构**） */
function workbuddyResultText(output: unknown, providerData: Record<string, unknown> | undefined): string | null {
  const toolResult = providerData === undefined ? undefined : providerData['toolResult'];
  for (const candidate of [output, toolResult]) {
    if (candidate === undefined || candidate === null) continue;
    const text = flattenText(candidate);
    if (text !== '') return text;
    if (isRecord(candidate)) {
      const direct = candidate['output'];
      if (typeof direct === 'string' && direct !== '') return direct;
    }
  }
  return null;
}

/** 工具入参：字符串若是 JSON 就解析（合成期要写回 JSON 文本，传裸串会被二次编码） */
function parseWorkbuddyArgs(raw: unknown): unknown {
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

function workbuddyFirstString(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = irStr(rec[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function workbuddyFirstTime(rec: Record<string, unknown>, keys: readonly string[]): IrTimeMs | undefined {
  for (const key of keys) {
    const parsed = irSafeTime(rec[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function workbuddyRoleOf(rec: Record<string, unknown>, msg: Record<string, unknown>): 'user' | 'assistant' | undefined {
  for (const raw of [irStr(msg['role']), irStr(rec['role']), irStr(rec['type'])]) {
    if (raw === undefined) continue;
    const lower = raw.toLowerCase();
    if (WORKBUDDY_SHAPE.userValues.includes(lower)) return 'user';
    if (WORKBUDDY_SHAPE.assistantValues.includes(lower)) return 'assistant';
  }
  return undefined;
}

/**
 * WorkBuddy 会话 JSONL → 归一记录（参考 convert/workbuddy.mjs 的事件流水）。
 *
 * 事件词汇：`message`（user/assistant + content 块）、`reasoning`（rawContent[]）、
 * `function_call`（工具调用）、`function_call_result`（结果，按 callId 配对）、
 * `file-history-snapshot`（运行期元数据）。
 *
 * 本地 IR 只有 text / tool_call / tool_result 三种块 → `reasoning` **没有承载位**：
 * 只**显式计数**（`workbuddy:reasoning`），绝不把推理伪装成正文（与 continue 同一口径）。
 */
export function parseWorkbuddyJsonl(text: string): ParsedTranscript {
  const records: TranscriptRecord[] = [];
  const ignored: Record<string, number> = {};
  let raw = 0;
  let bad = 0;
  let cwd: string | undefined;
  let createdAt: IrTimeMs | undefined;
  let model: string | undefined;

  // 事件流状态：user 消息开一轮；assistant 消息 / function_call 聚成「一步」
  let turnOpen = false;
  let stepBlocks: IrBlock[] | undefined;
  // 当前步里仍未取到结果的调用（结果只认**本步**的 callId —— 跨步结果挂错步会被 DSH codec 拒）
  let stepCalls = new Set<string>();

  for (const line of text.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isRecord(rec)) {
      bad += 1;
      continue;
    }
    raw += 1;
    if (cwd === undefined) cwd = workbuddyFirstString(rec, WORKBUDDY_SHAPE.cwdKeys);
    createdAt = irEarlier(createdAt, workbuddyFirstTime(rec, WORKBUDDY_SHAPE.timeKeys));
    const type = irStr(rec['type']) ?? '';
    const time = workbuddyFirstTime(rec, WORKBUDDY_SHAPE.timeKeys);

    if (type === 'reasoning') {
      const texts: string[] = [];
      const rawContent = rec['rawContent'];
      if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          if (!isRecord(block) || block['type'] !== 'reasoning_text') continue;
          const t = irStr(block['text']);
          if (t !== undefined) texts.push(t);
        }
      }
      // 推理没有承载位 → 显式计数（空推理单独一档，绝不静默）
      irBump(ignored, texts.length === 0 ? 'workbuddy:empty-reasoning' : 'workbuddy:reasoning');
      continue;
    }

    if (type === 'function_call') {
      const pd = isRecord(rec['providerData']) ? rec['providerData'] : undefined;
      if (pd !== undefined && (pd['isPartialAborted'] === true || pd['discard'] === true)) {
        irBump(ignored, 'workbuddy:aborted-call');
        continue;
      }
      if (!turnOpen) {
        irBump(ignored, 'workbuddy:call-without-turn');
        continue;
      }
      if (stepBlocks === undefined) {
        // 没有前置 assistant 消息的调用：新开一步承载它的 tool/call（参考 lastStep || openStep）
        stepBlocks = [];
        records.push({ role: 'assistant', blocks: stepBlocks, ...(time !== undefined ? { time } : {}) });
      }
      const callId = irStr(rec['callId']) ?? '';
      const name = irStr(rec['name']) ?? 'unknown';
      stepBlocks.push(irToolCallBlock(callId, name, parseWorkbuddyArgs(rec['arguments'])));
      if (callId !== '') stepCalls.add(callId);
      continue;
    }

    if (type === 'function_call_result') {
      const status = irStr(rec['status']);
      if (status !== undefined && status !== 'completed') {
        irBump(ignored, 'workbuddy:incomplete-result');
        continue;
      }
      const callId = irStr(rec['callId']);
      if (callId === undefined || !stepCalls.has(callId)) {
        // 孤儿结果（转录从中途开始 / 调用被过滤 / 结果跨步到达）：丢弃并计数，
        // 绝不挂最近一步（会投影出无 call 的孤儿 tool 消息，模型 API 直接拒绝）
        irBump(ignored, 'workbuddy:orphan-tool-result');
        continue;
      }
      const resultText = workbuddyResultText(rec['output'], isRecord(rec['providerData']) ? rec['providerData'] : undefined);
      if (resultText === null) {
        irBump(ignored, 'workbuddy:empty-tool-result');
        continue;
      }
      records.push({
        role: 'user',
        blocks: [irToolResultBlock(callId, resultText, false)],
        ...(time !== undefined ? { time } : {}),
      });
      // 一次调用只收一条结果：重复结果按孤儿处理（绝不产出两条同 callId 的 tool/result）
      stepCalls.delete(callId);
      continue;
    }

    const msg = isRecord(rec['message']) ? rec['message'] : rec;
    const role = workbuddyRoleOf(rec, msg);
    if (role === undefined) {
      // 其余事件（file-history-snapshot / 未知类型）逐类计数，绝不静默
      irBump(ignored, 'workbuddy:' + (type === '' ? 'unknown' : type));
      continue;
    }
    if (model === undefined) {
      model = workbuddyFirstString(msg, WORKBUDDY_SHAPE.modelKeys) ?? workbuddyFirstString(rec, WORKBUDDY_SHAPE.modelKeys);
    }
    const content = msg['content'] ?? rec['content'];

    if (role === 'user') {
      const prompt = extractWorkbuddyUserQuery(content);
      if (prompt === '') {
        irBump(ignored, 'workbuddy:empty-user');
        continue;
      }
      records.push({ role: 'user', blocks: [irTextBlock(prompt)], ...(time !== undefined ? { time } : {}) });
      turnOpen = true;
      stepBlocks = undefined;
      stepCalls = new Set();
      continue;
    }

    // assistant：新开一步（旧步的结果窗口在此关闭）
    if (!turnOpen) {
      irBump(ignored, 'workbuddy:orphan-assistant');
      continue;
    }
    const bodyText = flattenText(content);
    const blocks: IrBlock[] = bodyText === '' ? [] : [irTextBlock(bodyText)];
    stepBlocks = blocks;
    stepCalls = new Set();
    records.push({
      role: 'assistant',
      blocks,
      ...(time !== undefined ? { time } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }

  return {
    records,
    cwd,
    createdAt,
    title: firstUserText(records),
    raw,
    bad,
    ignored,
  };
}

export async function readWorkbuddySessions(
  opts: WorkbuddyReadOptions,
): Promise<SessionReadOutcome<WorkbuddySessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const projectsDir = workbuddyProjectsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: WorkbuddySessionFile[] = [];

  if (!(await isDirectory(projectsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）：静默 break 会让「报成功但条目缺失」。
  let truncated = false;
  // 目录名是**哈希**：本层只把它当遍历键，绝不参与 cwd 推导（不可逆 → 推导就是猜）
  for (const projectHash of await listDirNames(projectsDir)) {
    const projectDir = joinFor(platform, projectsDir, projectHash);
    for (const name of await listFileNames(projectDir, (n) => WORKBUDDY_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = WORKBUDDY_PROJECTS_REL + '/' + projectHash + '/' + name;
      const text = await readTextGuarded(joinFor(platform, projectDir, name), label, maxBytes, findings);
      if (text === null) continue;
      files.push({ id: stemOf(name), parsed: parseWorkbuddyJsonl(text) });
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'workbuddy', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
