/**
 * GitHub Copilot CLI（~/.copilot）→ DSH bundle 分区的**纯**翻译层。
 *
 * 输入 = 已经读好的 Copilot 数据（读盘层 read-copilot.ts，纯数据、不含凭据剥离结果）；
 * 输出 = ForeignImportResult（分区载荷 + 未迁移项 + 凭据引用名）。
 *
 * 位置与结构真值见契约 §8.2（**文档取证**：docs.github.com 的 GitHub Copilot CLI configuration
 * directory；**本机无 ~/.copilot** —— 未经真机验证，取证强度如实标注）：
 *  - mcp-config.json：用户级 MCP（名字 → 定义）
 *  - copilot-instructions.md / instructions/*.instructions.md：官方 CLI 配置目录表里**没有列出**
 *    （那是 VS Code / 项目级约定）→ 存在即读、不存在不报错、绝不凭空造分区
 *  - skills/<名>/SKILL.md（个人技能，一层；手工嵌套按同一判据压平）
 *  - config.json / permissions-config.json / agents / hooks / logs / session-state /
 *    session-store.db / installed-plugins / ide：**不在本期范围**（契约 §8.2 未冻结），不读不报，
 *    绝不产出 sessions/workspaces 分区
 *
 * 公共口径（MCP 映射与凭据剥离、SKILL.md frontmatter 校验、路径/名字安全、技能装配）全部走
 * 共享内核 kernel.ts —— 与 Claude Code / Hermes / Codex 同一份实现，口径不可能分叉。
 */
import { isRecord } from '../utils/guards.ts';
import { collectSkills, instructionsSection, mcpSectionFromEntries } from './kernel.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/** 一个 Copilot skill 单元：技能名 + 目录内文件（category 只用于报告压平，不参与命名） */
export interface CopilotSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 外层目录名（手工嵌套时）——有值即报 skill-category-flattened */
  category?: string;
}

/**
 * 一份 Copilot 指令文件（copilot-instructions.md 或 instructions/*.instructions.md）。
 * name 只用于生成可读的合并来源标签（合并规则见下一行注释），不参与文件命名。
 */
export interface CopilotInstructionInput {
  name: string;
  text: string;
}

/**
 * Copilot 配置的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 为什么类型定义在本文件而不是 types.ts：本任务的作用域只含 copilot.* / read-copilot.ts /
 * antigravity.* / fixtures —— 把来源专属类型留在来源模块里，既不动其它来源的公共面，
 * 也便于 t22 装配时按需再导出（与 codex.ts 同一决定）。
 */
export interface CopilotInput {
  /** mcp-config.json（已解析；缺失 / 0 字节 / 畸形 = undefined） */
  mcpConfig?: unknown;
  /** copilot-instructions.md 原文 */
  instructions?: string;
  /** instructions/*.instructions.md（按文件名排序，已过滤空文件） */
  instructionFiles?: CopilotInstructionInput[];
  /** skills/ 的技能单元（frontmatter 校验在翻译层做） */
  skills?: CopilotSkillInput[];
  /** 读盘层发现（位置被 COPILOT_HOME 覆盖 / 0 字节 / 读不到）——原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

/** 「名字 → 定义」容器的候选键（按顺序取第一个是映射的） */
const MCP_CONTAINER_KEYS: readonly string[] = ['mcpServers', 'servers'];

/**
 * 合并指令源：DSH **只读一个全局指令文件**（契约 §8.6-4），所以多份指令必须在转换期合并，
 * 并逐份报 instructions-merged（合并是信息重排，必须可见）。
 *
 * 顺序：copilot-instructions.md 在前，instructions/*.instructions.md 按文件名紧随其后 ——
 * 顺序确定（不依赖目录遍历顺序），文件之间用一行注释分隔（来源名来自文件名，不含任何配置值）。
 */
function mergedInstructions(input: CopilotInput, skipped: ForeignSkip[]): string {
  const parts: string[] = [];
  const base = typeof input.instructions === 'string' ? input.instructions : '';
  if (base.trim() !== '') parts.push(base);
  for (const f of input.instructionFiles ?? []) {
    if (f.text.trim() === '') continue;
    parts.push('<!-- instructions/' + f.name + ' -->' + String.fromCharCode(10) + f.text);
  }
  if (parts.length > 1) {
    skipped.push({ code: 'instructions-merged', count: parts.length });
  }
  return parts.join(String.fromCharCode(10, 10));
}

export function convertCopilot(input: CopilotInput): ForeignImportResult {
  // 读盘层的发现排在前面：它们解释「为什么读到的少了」（与 convertHermes / convertCodex 同口径）
  const skipped: ForeignSkip[] = [...(input.readFindings ?? [])];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  let mcpEntries: [string, unknown][] = [];
  if (isRecord(input.mcpConfig)) {
    const containerKey = MCP_CONTAINER_KEYS.find((k) => isRecord(input.mcpConfig !== undefined ? (input.mcpConfig as Record<string, unknown>)[k] : undefined) || Array.isArray((input.mcpConfig as Record<string, unknown>)[k]));
    if (containerKey === undefined) {
      // 形态对不上就如实报（绝不静默少一片）：真值形态是「顶层含 mcpServers / servers 映射」
      skipped.push({ code: 'mcp-server-empty', origin: 'mcp-config.json', detail: 'no-servers-container' });
    } else {
      const raw = (input.mcpConfig as Record<string, unknown>)[containerKey];
      // 数组形态（部分版本可能给出 [{name, command}]）与映射形态都接受：名字取自条目的 name 字段
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!isRecord(item)) continue;
          const name = item['name'];
          if (typeof name !== 'string' || name === '') continue;
          mcpEntries.push([name, item]);
        }
      } else if (isRecord(raw)) {
        mcpEntries = Object.entries(raw);
      }
    }
  }
  const mcp = mcpSectionFromEntries(mcpEntries, credentialRefs, skipped);
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

  const instructions = instructionsSection(mergedInstructions(input, skipped));
  if (instructions !== null) {
    sections.push(instructions);
    counts['agentInstructions.files'] = 1;
  }

  return { source: 'copilot', sections, skipped, credentialRefs, counts };
}
