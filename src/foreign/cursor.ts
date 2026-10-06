/**
 * Cursor（~/.cursor）→ DSH bundle 分区的**纯**翻译层。
 *
 * 输入 = 已经读好的 Cursor 数据（读盘层 read-cursor.ts；JSON 已解析、frontmatter 已分类，
 * 但凭据值仍在原文里 —— 本层负责剥离）；输出 = ForeignImportResult。
 *
 * 位置与结构真值见契约 §8.2（**文档取证**：cursor.com/help/customization/{mcp,rules}.md；
 * 本机无 ~/.cursor —— **未经真机验证**，取证强度如实标注，见 §8.7）：
 *  - mcp.json 的 mcpServers：command/args/env（stdio）、url/headers（streamable-http）；
 *    项目级 <项目>/.cursor/mcp.json 的同名 server **优先于**用户级（契约 §8.2 的优先级）
 *  - rules/*.mdc：frontmatter 的 alwaysApply / globs / description 决定四种激活类型
 *    （always / auto-attached / agent-requested / manual）
 *  - skills/**​/SKILL.md（DSH 单层，深层嵌套压平为叶子名并报 skill-category-flattened）
 *  - 旧式 .cursorrules：**只报告不导入**（legacy-rules-file；正文根本不进本层的输入结构）
 *
 * 规则 → agentInstructions 的映射决策（DSH 侧没有「规则」这种存储：src/adapters/prompts.ts
 * 明确「rules/commands 无独立存储」）：
 *  - 四种激活类型的规则**全部**按确定顺序合并进**唯一一个** AGENTS.md（契约 §8.6-4：agentInstructions
 *    每次导入至多一个文件），每条规则前面加一行注释头标出文件名 + 激活类型 + 作用域
 *    —— 激活语义在 DSH 没有对等字段，这一点由注释头 + counts 的四类计数**显式可见**，绝不静默；
 *  - 合并来源数 > 1 时逐条报 instructions-merged（与 convertCopilot 同口径）；
 *  - frontmatter 只用于分类，不并入正文（Cursor 专属的 globs/description 在注释头里以激活类型体现）。
 *
 * **会话（2026-10-06 起）**：`~/.cursor/projects/<slug>/agent-transcripts/<composer>/<composer>.jsonl`
 * 由读盘层解析成归一记录（见 read-cursor.ts 的 readCursorSessions / parseCursorTranscript），
 * 本层只负责装配成 sessions + workspaces 两个分区 —— 与 Hermes / Antigravity 同一条出口。
 * 会话记录里没有 tool_result（源里只发 tool/call），cwd 靠 slug 的存在性解码；解不出来时
 * 由 collectSessionSections → transcodeSessionDraft 如实报 `session-missing-cwd`，绝不伪造。
 *
 * 公共口径（MCP 映射与凭据剥离、SKILL.md frontmatter 校验、路径/名字安全、技能装配、
 * 会话 → DSH 字节）全部走共享内核 kernel.ts / session-source.ts —— 与 Claude Code / Hermes /
 * Antigravity 同一份实现，口径不可能分叉。
 */
import { isRecord } from '../utils/guards.ts';
import {
  collectSessionSections,
  collectSkills,
  instructionsSection,
  mcpSectionFromEntries,
  serverEntriesOf,
} from './kernel.ts';
import { draftFromTranscript, transcodeSessionDraft } from './session-source.ts';
import type { ParsedTranscript } from './session-source.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/** Cursor 的两层作用域：用户级（~/.cursor）与项目级（<项目>/.cursor） */
export type CursorScope = 'user' | 'project';

/** 规则的四种激活类型（契约 §8.2 的 Always / Intelligently / Specific Files / Manually） */
export type CursorRuleActivation = 'always' | 'auto-attached' | 'agent-requested' | 'manual';

/**
 * 一条已分类的 Cursor 规则（*​.mdc）。
 *
 * 正文（body）已经剥离 frontmatter：frontmatter 是 Cursor 的激活元数据，不是指令正文；
 * frontmatter 缺失（= Manual）或损坏（报码后按 Manual 保守归类）时 body = 全文，绝不丢内容。
 */
export interface CursorRuleInput {
  /** 规则文件名（含 .mdc）——只用于报告与合并注释头，不含任何配置值 */
  name: string;
  scope: CursorScope;
  activation: CursorRuleActivation;
  body: string;
}

/** 一个 Cursor skill 单元：叶子技能名 + 目录内文件（category 只用于报告压平，不参与命名） */
export interface CursorSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 中间目录（<技能根>/<外层>/<技能>/SKILL.md）——有值即报 skill-category-flattened */
  category?: string;
}

/** 一个已解析成**归一记录**的 Cursor 会话（读盘层产出；翻译层只负责装配） */
export interface CursorSessionInput {
  /**
   * composer uuid（`agent-transcripts/<composer>/<composer>.jsonl` 的目录名 / 文件名 stem；
   * 真机布局里两者同值）。它同时是 DSH 侧会话 id —— **必须过 isSafeIrId**，
   * 不过门的由 transcodeSessionDraft 如实报 session-unsafe-id，绝不静默写盘。
   */
  id: string;
  /** 归一记录（parsed.raw = 转录行原始条数；cwd 由读盘层按 slug 存在性解码后补入） */
  parsed: ParsedTranscript;
}

/**
 * Cursor 配置的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 为什么类型定义在本文件而不是 types.ts：本任务作用域只含 cursor.ts / read-cursor.ts /
 * cursor.test.ts / fixtures —— 来源专属类型留在来源模块里，不动其它来源的公共面。
 */
export interface CursorInput {
  /** ~/.cursor/mcp.json（已解析；缺失 / 0 字节 / 畸形 = undefined） */
  mcpJson?: unknown;
  /** <项目>/.cursor/mcp.json（可选的第二份；同名 server 项目级优先） */
  projectMcpJson?: unknown;
  /** rules/*.mdc（已按 frontmatter 分类；顺序由读盘层给出） */
  rules?: CursorRuleInput[];
  /** skills/**​/SKILL.md 的技能单元（读盘层保证项目级在前 = 同名冲突时项目级胜出） */
  skills?: CursorSkillInput[];
  /** 旧式 .cursorrules 的位置（**只报告不导入**；正文根本没有承载字段） */
  legacyRules?: { scope: CursorScope }[];
  /** ~/.cursor/projects/<slug>/agent-transcripts/<composer>/<composer>.jsonl 解析出的会话 */
  sessions?: CursorSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并整批报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
  /** 读盘层发现（0 字节 / 畸形 / 超限 / 旧式规则命中 / 会话读盘）——原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

const NL = String.fromCharCode(10);

/** 作用域排序：用户级在前、项目级在后（更具体的在后；规则合并按此顺序逐段拼接） */
const SCOPE_RANK: Readonly<Record<CursorScope, number>> = { user: 0, project: 1 };

/** mcp.json 容器键（Cursor 文档的真值形态就是顶层 mcpServers） */
const MCP_CONTAINER_KEY = 'mcpServers';

/** 作用域标签：只用于报告与注释头（绝不含绝对路径 —— 那是机器身份） */
export function cursorScopeLabel(scope: CursorScope): string {
  return scope === 'user' ? '~/.cursor' : 'project/.cursor';
}

/** 合并 MCP 条目：用户级打底，项目级同名覆盖**在原位置**且值取项目级（不产生重复 serverName） */
export function mergeMcpEntries(
  userEntries: readonly (readonly [string, unknown])[],
  projectEntries: readonly (readonly [string, unknown])[],
): { entries: [string, unknown][]; overridden: number } {
  const out = new Map<string, unknown>();
  for (const [name, def] of userEntries) out.set(name, def);
  let overridden = 0;
  for (const [name, def] of projectEntries) {
    if (out.has(name)) overridden++;
    out.set(name, def);
  }
  return { entries: [...out.entries()], overridden };
}

/** 容器形态检查：形态对不上就如实报（绝不静默少一片） */
function checkMcpContainer(cfg: unknown, label: string, skipped: ForeignSkip[]): void {
  if (cfg === undefined || !isRecord(cfg)) return;
  const raw = cfg[MCP_CONTAINER_KEY];
  if (raw !== undefined && !isRecord(raw)) {
    skipped.push({ code: 'mcp-server-empty', origin: label, detail: 'not-a-mapping' });
    return;
  }
  if (raw === undefined) {
    // 没有真值容器键、却带着别的「名字 → 定义」映射（如 servers）：如实报，绝不静默不产出
    const alt = cfg['servers'];
    if (isRecord(alt) && Object.keys(alt).length > 0) {
      skipped.push({ code: 'mcp-server-empty', origin: label, detail: 'unexpected-container-key' });
    }
  }
}

/** 一条规则的合并注释头（激活语义在 DSH 无对等字段，必须在产物里可见） */
export function cursorRuleHeader(rule: CursorRuleInput): string {
  return '<!-- cursor rule: ' + rule.name + ' [' + rule.activation + ', ' + rule.scope + '] -->';
}

/**
 * 规则 → AGENTS.md 正文。顺序确定（作用域 → 文件名），不依赖目录遍历顺序；
 * 空正文的规则不并入（分类计数仍然算它）。返回 { text, merged }（merged = 实际并入的条数）。
 */
export function mergeRuleBodies(rules: readonly CursorRuleInput[]): { text: string; merged: number } {
  const ordered = [...rules].sort((a, b) => {
    const rank = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (rank !== 0) return rank;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const parts: string[] = [];
  for (const rule of ordered) {
    if (rule.body.trim() === '') continue;
    parts.push(cursorRuleHeader(rule) + NL + rule.body);
  }
  return { text: parts.join(NL + NL), merged: parts.length };
}


export function convertCursor(input: CursorInput): ForeignImportResult {
  // 读盘层的发现排在前面：它们解释「为什么读到的少了」（与 convertHermes / convertCodex / convertCopilot 同口径）
  const skipped: ForeignSkip[] = [...(input.readFindings ?? [])];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  /* MCP：用户级打底 + 项目级同名覆盖（契约 §8.2 的优先级） */
  checkMcpContainer(input.mcpJson, 'mcp.json', skipped);
  checkMcpContainer(input.projectMcpJson, 'project/.cursor/mcp.json', skipped);
  const mergedMcp = mergeMcpEntries(
    serverEntriesOf(input.mcpJson, MCP_CONTAINER_KEY),
    serverEntriesOf(input.projectMcpJson, MCP_CONTAINER_KEY),
  );
  const mcp = mcpSectionFromEntries(mergedMcp.entries, credentialRefs, skipped);
  if (mcp !== null) {
    sections.push({ sectionId: 'mcp', data: mcp });
    counts['mcp.servers'] = mcp.servers.length;
    if (mergedMcp.overridden > 0) counts['mcp.projectOverridden'] = mergedMcp.overridden;
  }

  /* skills：单层 <名>/SKILL.md（嵌套已在读盘层压平并报码） */
  const skillFiles: { relativePath: string; data: Uint8Array }[] = [];
  collectSkills(input.skills ?? [], skillFiles, skipped);
  if (skillFiles.length > 0) {
    sections.push({ sectionId: 'skills', files: skillFiles });
    counts['skills.files'] = skillFiles.length;
  }

  /* rules：四种激活类型如实计数 + 全部合并进唯一一个 AGENTS.md */
  const rules = input.rules ?? [];
  if (rules.length > 0) {
    const byActivation: Record<CursorRuleActivation, number> = {
      always: 0, 'auto-attached': 0, 'agent-requested': 0, manual: 0,
    };
    for (const rule of rules) byActivation[rule.activation] += 1;
    counts['rules.total'] = rules.length;
    counts['rules.always'] = byActivation.always;
    counts['rules.auto-attached'] = byActivation['auto-attached'];
    counts['rules.agent-requested'] = byActivation['agent-requested'];
    counts['rules.manual'] = byActivation.manual;

    const merged = mergeRuleBodies(rules);
    if (merged.merged > 1) skipped.push({ code: 'instructions-merged', count: merged.merged });
    const instructions = instructionsSection(merged.text);
    if (instructions !== null) {
      sections.push(instructions);
      counts['agentInstructions.files'] = 1;
    }
  }

  /* 旧式 .cursorrules：只报告（DSH 无对等结构；契约 §8.5 的冻结码语义就是「只报告」） */
  const legacy = input.legacyRules ?? [];
  if (legacy.length > 0) {
    for (const entry of legacy) {
      skipped.push({ code: 'legacy-rules-file', origin: '.cursorrules', detail: entry.scope, count: 1 });
    }
    counts['rules.legacy'] = legacy.length;
  }

  /* 会话：读盘层已解析成归一记录 → sessions + workspaces（必须同源产出，见 kernel.collectSessionSections；
     cwd 缺失在这里变成 session-missing-cwd，即「解不出 slug 就如实跳过」的那条出口） */
  const formatVersion = input.targetSessionFormatVersion ?? -1;
  collectSessionSections<CursorSessionInput>({
    files: input.sessions ?? [],
    targetFormatVersion: input.targetSessionFormatVersion,
    transcode: (file) => transcodeSessionDraft(draftFromTranscript(file.id, file.parsed, 'cursor'), { formatVersion }),
    workspaceIdPrefix: 'cursor',
    sections,
    skipped,
    counts,
  });

  return { source: 'cursor', sections, skipped, credentialRefs, counts };
}
