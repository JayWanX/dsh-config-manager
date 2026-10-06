/**
 * Codex CLI（~/.codex）→ DSH bundle 分区的**纯**翻译层。
 *
 * 输入 = 已经读好的 Codex 数据（读盘层 read-codex.ts；TOML 已解析、凭据值仍在原文里但翻译层会剥离）；
 * 输出 = ForeignImportResult（分区载荷 + 未迁移项 + 凭据引用名）。
 *
 * 位置与结构真值见契约 §8.2（**文档取证**：developers.openai.com/codex/config-basic；
 * 本机无 ~/.codex —— 未经真机验证，取证强度如实标注）：
 *  - config.toml 的 [mcp_servers.<id>]：command / args / env（stdio），url / headers（streamable-http）
 *  - AGENTS.override.md **优先于** AGENTS.md（发现层级由读盘层决定并报码）→ agentInstructions/AGENTS.md
 *  - ~/.agents/skills/<名>/SKILL.md（深层嵌套压平为叶子名并报 skill-category-flattened）
 *  - **会话（2026-10-06 起）**：<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl 与
 *    <CODEX_HOME>/archived_sessions/rollout-*.jsonl（双根，chat-import discovery.mjs:108-110）
 *    由读盘层解析成归一记录，在本层装配成 sessions + workspaces（唯一出口 = kernel.collectSessionSections）。
 *    history.jsonl 仍不在范围内（它不是会话转录，本层不读不报）。
 *
 * 公共口径（MCP 映射与凭据剥离、SKILL.md frontmatter 校验、路径/名字安全、会话→DSH 字节）全部走
 * 共享内核 kernel.ts / session-source.ts —— 与 Claude Code / Hermes / Antigravity 同一份实现，口径不可能分叉。
 */
import { isRecord } from '../utils/guards.ts';
import { collectSessionSections, collectSkills, instructionsSection, mcpSectionFromEntries, serverEntriesOf } from './kernel.ts';
import { draftFromTranscript, firstUserText, genericBlocksOf, transcodeSessionDraft } from './session-source.ts';
import type { ParsedTranscript, TranscriptRecord } from './session-source.ts';
import { irBump, irSafeTime, irToolCallBlock, irToolResultBlock, isSafeIrId } from './session-ir.ts';
import type { IrBlock } from './session-ir.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/** 换行（避免源码里出现裸控制字符；与 session-source 的拼接口径一致） */
const NL = String.fromCharCode(10);

/** Codex 把仓库指令贴在 user 消息里，块正文以该前缀开头（竞品 inject.mjs 的 INJECT_MARKERS 同源） */
const AGENTS_MD_PREFIX = '# agents.md';

/**
 * 去扩展名（与 session-read.stemOf 同口径）。刻意**不 import** session-read.ts：
 * 那个模块带 node:fs，本层要保持「纯函数、零 I/O」。
 */
function stemOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** 一个 Codex skill 单元：技能名 + 目录内文件（category 只用于报告压平，不参与命名） */
export interface CodexSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 外层目录名（~/.agents/skills/<外层>/<技能>/SKILL.md）——有值即报 skill-category-flattened */
  category?: string;
}

/**
 * 一个已解析成**归一记录**的 Codex 会话（读盘层产出；翻译层只负责装配）。
 *
 * id 一律由读盘层保证「过 isSafeIrId 或明知不安全」——不安全 id 由
 * transcodeSessionDraft 报 session-unsafe-id，本层绝不改名（改名等于伪造另一个会话的身份）。
 */
export interface CodexSessionInput {
  /** session_meta.payload.id（安全 id 时）；否则回落 rollout 文件名去扩展名 */
  id: string;
  /** 归一记录（parsed.raw = rollout 原始行数，含被忽略的） */
  parsed: ParsedTranscript;
}

/**
 * Codex 配置的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 为什么类型定义在本文件而不是 types.ts：本任务的作用域只含 codex.ts / read-codex.ts /
 * codex.test.ts / fixtures —— 把来源专属类型留在来源模块里，既不动其它来源的公共面，
 * 也便于 t22 装配时按需再导出。
 */
export interface CodexInput {
  /** ~/.codex/config.toml（已解析；缺失 / 0 字节 / 畸形 = undefined） */
  config?: unknown;
  /** 按发现层级选中的全局指令文件原文（AGENTS.override.md 优先于 AGENTS.md） */
  instructions?: string;
  /** ~/.agents/skills 的技能单元（frontmatter 校验在翻译层做） */
  skills?: CodexSkillInput[];
  /** sessions/ 与 archived_sessions/ 下读出的 rollout 会话（已归一记录；子代理 rollout 已被读盘层剔除） */
  sessions?: CodexSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并整批报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
  /** 读盘层发现（位置被 CODEX_HOME 覆盖 / 0 字节 / 命中 override / 读不到 / 子代理 rollout）——原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

export function convertCodex(input: CodexInput): ForeignImportResult {
  // 读盘层的发现排在前面：它们解释「为什么读到的少了」（与 convertHermes 同口径）
  const skipped: ForeignSkip[] = [...(input.readFindings ?? [])];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  const rawMcp = isRecord(input.config) ? input.config['mcp_servers'] : undefined;
  if (rawMcp !== undefined && !isRecord(rawMcp)) {
    // 形态对不上就如实报（绝不静默少一片）：Codex 的真值形态是「名字 → 定义」映射
    skipped.push({ code: 'mcp-server-empty', origin: 'mcp_servers', detail: 'not-a-mapping' });
  }
  const mcp = mcpSectionFromEntries(serverEntriesOf(input.config, 'mcp_servers'), credentialRefs, skipped);
  if (mcp !== null) {
    sections.push({ sectionId: 'mcp', data: mcp });
    counts['mcp.servers'] = mcp.servers.length;
  }

  const skillFiles: { relativePath: string; data: Uint8Array }[] = [];
  collectSkills(input.skills ?? [], skillFiles, skipped);
  if (skillFiles.length > 0) {
    sections.push({ sectionId: 'skills', files: skillFiles });
    counts['skills.files'] = skillFiles.length;
  }

  const instructions = instructionsSection(typeof input.instructions === 'string' ? input.instructions : '');
  if (instructions !== null) {
    sections.push(instructions);
    counts['agentInstructions.files'] = 1;
  }

  // 对话：rollout JSONL 读出的**归一记录** → DSH 会话 + 工作区。
  // 必须走 kernel.collectSessionSections（唯一出口）：冲突语义（同 id 只允许一条）与
  // 「只给会话不给工作区 = 目标机一条对话都看不见」这两条硬不变量只有那一处实现。
  const formatVersion = input.targetSessionFormatVersion ?? -1;
  collectSessionSections<CodexSessionInput>({
    files: input.sessions ?? [],
    targetFormatVersion: input.targetSessionFormatVersion,
    transcode: (file) => transcodeSessionDraft(draftFromTranscript(file.id, file.parsed, 'codex'), { formatVersion }),
    workspaceIdPrefix: 'codex',
    sections,
    skipped,
    counts,
  });

  return { source: 'codex', sections, skipped, credentialRefs, counts };
}

/* ================= 源格式解析：rollout JSONL → 归一记录（纯函数，零 I/O） ================= */

/**
 * Codex 子代理 rollout 判定（与竞品 `codexSubagentMarker` 同一份判据）。
 *
 * thread_source='subagent' 是权威标记；source.subagent 是 spawned thread 形态（含
 * thread_spawn.parent_thread_id）。**不据此跳过 fork**：forked_from_id / parent_thread_id
 * 描述「从某会话 fork 出的新主会话」，它仍是可独立继续的用户会话，必须保留。
 * 返回命中的标记名（供 skipReason 诊断），未命中 null。
 */
export function codexSubagentMarker(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload['thread_source'] === 'subagent') return 'thread_source=subagent';
  const source = payload['source'];
  if (isRecord(source) && Boolean(source['subagent'])) return 'source.subagent';
  return null;
}

/**
 * 会话 id：session_meta.payload.id **过 isSafeIrId 才用**，否则回落 rollout 文件名（去扩展名）。
 * 两者都不安全时原样带出，由 transcodeSessionDraft 报 session-unsafe-id —— 绝不静默改名成别的会话。
 */
export function codexSessionId(payloadId: unknown, fileName: string): string {
  if (typeof payloadId === 'string' && isSafeIrId(payloadId)) return payloadId;
  return stemOfName(fileName);
}

/** rollout 的解析结果（读盘层据此决定「建会话」还是「剔除并报码」） */
export interface CodexRolloutParse {
  readonly parsed: ParsedTranscript;
  readonly id: string;
  /** 子代理标记（非 null = 不是独立会话） */
  readonly subagent: string | null;
}

/** harness 注入块判定：以 '<' 开头的环境块 / 系统提醒，或 '# AGENTS.md instructions' 前缀块 */
function isInjectedBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<') || trimmed.slice(0, AGENTS_MD_PREFIX.length).toLowerCase() === AGENTS_MD_PREFIX;
}

/**
 * user 消息 content → 内容块：**过滤 harness 注入**后逐块走通用映射。
 *
 * 为什么必须过滤：Codex 把 <environment_context> 之类的环境块塞进 user 消息，不过滤时它会成为
 * 首条用户文本 —— 会话标题（DSH 回退首问）就会显示成环境块正文。非文本块（图片等）仍走通用映射
 * 并被逐类计数。全被过滤掉的消息由调用方计入 user-message-no-text，不开空轮。
 */
function codexUserBlocks(content: unknown, ignored: Record<string, number>): IrBlock[] {
  if (!Array.isArray(content)) return genericBlocksOf(content, ignored, 'block');
  const out: IrBlock[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block['text'] === 'string' && isInjectedBlock(block['text'])) {
      irBump(ignored, 'injected-block');
      continue;
    }
    out.push(...genericBlocksOf(block, ignored, 'block'));
  }
  return out;
}

/** 工具输出的块数组 → 单个文本（未知块类型逐类计数，绝不静默吞） */
function codexBlockTexts(blocks: readonly unknown[], ignored: Record<string, number>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = typeof block['type'] === 'string' ? block['type'] : 'unknown';
    if ((type === 'input_text' || type === 'output_text') && typeof block['text'] === 'string') {
      parts.push(block['text']);
      continue;
    }
    // 图片块（input_image / image_url）在本共享 IR 里没有承载块（IrBlock 只有 text/tool_call/tool_result）
    irBump(ignored, 'tool-output:' + type);
  }
  return parts.join(NL);
}

/**
 * payload.output → 工具结果正文（竞品实测的三种形态）：
 *  ① 纯字符串，或 {"output":"…","metadata":{…}} JSON 信封 → 取正文；
 *  ② 块数组（[{type:'input_text',text},…]，shell/exec 输出）→ 逐块取文本；
 *  ③ {"output":[…]} 信封对象 → 同 ②。
 * 其余形态 JSON.stringify 保底并计数（schema 漂移不静默吞）。
 */
function codexOutputText(out: unknown, ignored: Record<string, number>): string {
  if (typeof out === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      return out; // 纯文本
    }
    if (isRecord(parsed)) {
      const inner = parsed['output'];
      if (typeof inner === 'string') return inner;
      if (Array.isArray(inner)) return codexBlockTexts(inner, ignored);
    }
    return out;
  }
  if (Array.isArray(out)) return codexBlockTexts(out, ignored);
  if (isRecord(out)) {
    const inner = out['output'];
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) return codexBlockTexts(inner, ignored);
  }
  irBump(ignored, 'tool-output-shape');
  return JSON.stringify(out ?? '');
}

/** function_call / custom_tool_call → assistant 记录（工具调用块必须进 assistant 内容，否则结果是孤儿） */
function codexToolCallRecord(
  payload: Record<string, unknown>,
  kind: string,
  time: number | undefined,
  model: string | undefined,
): TranscriptRecord | null {
  const callId = typeof payload['call_id'] === 'string' && payload['call_id'] !== '' ? payload['call_id'] : '';
  if (callId === '') return null;
  const name = typeof payload['name'] === 'string' && payload['name'] !== '' ? payload['name'] : 'unknown';
  // function_call 的 arguments / custom_tool_call 的 input 都是字符串形态；
  // custom_tool_call 的 JS 调用形态（tools.exec_command({…})）在本版**不做 JS→JSON 转换**，
  // 原样字符串进 arguments（绝不猜、绝不丢）
  const rawInput = kind === 'function_call' ? payload['arguments'] : payload['input'];
  let input: unknown = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        input = JSON.parse(trimmed);
      } catch {
        input = rawInput;
      }
    }
  }
  return {
    role: 'assistant',
    blocks: [irToolCallBlock(callId, name, input)],
    time,
    id: typeof payload['id'] === 'string' ? payload['id'] : undefined,
    model,
  };
}

/**
 * Codex rollout JSONL → 归一记录（一行一条 {timestamp, type, payload} 信封）。
 *
 *  - session_meta → id / cwd / 创建时间 / 子代理标记（元数据，不占记录）
 *  - turn_context → 模型（Codex 可中途换模型：逐条生效，落到其后开的记录上）
 *  - response_item → 真正的产物：message（user / assistant）、function_call(_output)、
 *    custom_tool_call(_output)、reasoning，其余类型逐类计数
 *  - event_msg 的 user_message / agent_message 是 response_item 的**重复**（竞品明确警告会重复
 *    计数）→ 不记账、不产出记录
 *  - compacted（上下文压缩）与 reasoning 在本共享 IR 里没有承载块 → **逐类计数**，绝不伪装成正文
 *  - 坏行不抛，只计入 bad（与 parseGenericJsonl 同口径）
 */
export function parseCodexRollout(text: string, fileName: string): CodexRolloutParse {
  const records: TranscriptRecord[] = [];
  const ignored: Record<string, number> = {};
  let raw = 0;
  let bad = 0;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let payloadId: unknown;
  let subagent: string | null = null;
  let currentModel: string | undefined;

  for (const line of text.split(NL)) {
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
    const envelope = typeof rec['type'] === 'string' ? rec['type'] : 'unknown';
    const payload = rec['payload'];
    const time = irSafeTime(rec['timestamp']);

    if (envelope === 'session_meta' && isRecord(payload)) {
      if (payloadId === undefined) payloadId = payload['id'];
      if (cwd === undefined && typeof payload['cwd'] === 'string' && payload['cwd'] !== '') cwd = payload['cwd'];
      if (createdAt === undefined) createdAt = irSafeTime(payload['timestamp']) ?? time;
      if (subagent === null) subagent = codexSubagentMarker(payload);
      continue;
    }
    if (envelope === 'turn_context' && isRecord(payload)) {
      if (typeof payload['model'] === 'string' && payload['model'] !== '') currentModel = payload['model'];
      continue;
    }
    // event_msg 与 response_item 重复（重复记账会把每条消息算两遍）
    if (envelope === 'event_msg') continue;
    if (envelope === 'compacted') {
      irBump(ignored, 'compacted');
      continue;
    }
    if (envelope !== 'response_item' || !isRecord(payload)) {
      irBump(ignored, 'envelope:' + envelope);
      continue;
    }

    const kind = typeof payload['type'] === 'string' ? payload['type'] : 'unknown';
    const messageId = typeof payload['id'] === 'string' ? payload['id'] : undefined;
    if (kind === 'message') {
      const role = typeof payload['role'] === 'string' ? payload['role'] : '';
      if (role === 'user') {
        const blocks = codexUserBlocks(payload['content'], ignored);
        if (blocks.length === 0) {
          irBump(ignored, 'user-message-no-text');
          continue;
        }
        records.push({ role: 'user', blocks, time, id: messageId });
      } else if (role === 'assistant') {
        const blocks = genericBlocksOf(payload['content'], ignored, 'block');
        if (blocks.length === 0) {
          irBump(ignored, 'assistant-message-no-content');
          continue;
        }
        records.push({ role: 'assistant', blocks, time, id: messageId, model: currentModel });
      } else {
        // developer（系统提示词 / 系统注入）与其它角色默认忽略，逐类计数
        irBump(ignored, 'message-role:' + (role === '' ? 'unknown' : role));
      }
      continue;
    }
    if (kind === 'reasoning') {
      // 可读部分在 summary 块里，但本共享 IR 没有 reasoning 承载块 → 逐类计数，
      // 绝不把摘要伪装成正文（竞品用 reasoning 块与原生压缩检查点承载，本仓 IR 暂无这两个能力位）
      irBump(ignored, 'reasoning');
      continue;
    }
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      const call = codexToolCallRecord(payload, kind, time, currentModel);
      if (call === null) {
        irBump(ignored, kind + ':no-call-id');
        continue;
      }
      records.push(call);
      continue;
    }
    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : '';
      if (callId === '') {
        irBump(ignored, kind + ':no-call-id');
        continue;
      }
      // 工具结果按与调用相同的 call_id 配对（合成器据此发 tool/result 行）；
      // 找不到调用的孤儿结果由合成器丢弃并计入 orphan-tool-result
      records.push({
        role: 'user',
        blocks: [irToolResultBlock(callId, codexOutputText(payload['output'], ignored), false)],
        time,
        id: messageId,
      });
      continue;
    }
    // 其余 response_item（local_shell_call / web_search_call / …）逐类计数
    irBump(ignored, 'response_item:' + kind);
  }

  return {
    parsed: { records, cwd, createdAt, title: firstUserText(records), raw, bad, ignored },
    id: codexSessionId(payloadId, fileName),
    subagent,
  };
}


