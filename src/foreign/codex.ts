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
 *  - ~/.codex/sessions、history.jsonl：**不在本期范围**（契约 §8.2 未冻结），不读不报、不产出 sessions 分区
 *
 * 公共口径（MCP 映射与凭据剥离、SKILL.md frontmatter 校验、路径/名字安全、技能装配）全部走
 * 共享内核 kernel.ts —— 与 Claude Code / Hermes 同一份实现，口径不可能分叉。
 */
import { isRecord } from '../utils/guards.ts';
import { collectSkills, instructionsSection, mcpSectionFromEntries, serverEntriesOf } from './kernel.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/** 一个 Codex skill 单元：技能名 + 目录内文件（category 只用于报告压平，不参与命名） */
export interface CodexSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 外层目录名（~/.agents/skills/<外层>/<技能>/SKILL.md）——有值即报 skill-category-flattened */
  category?: string;
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
  /** 读盘层发现（位置被 CODEX_HOME 覆盖 / 0 字节 / 命中 override / 读不到）——原样带出，调用方无需二次合并 */
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

  return { source: 'codex', sections, skipped, credentialRefs, counts };
}
