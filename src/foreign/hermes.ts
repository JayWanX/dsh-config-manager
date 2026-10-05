/**
 * Hermes（NousResearch/hermes-agent）→ DSH bundle 分区的**纯**翻译层。
 *
 * 输入 = 已经读好的 Hermes 数据（读盘层 read-hermes.ts，纯数据、不含任何凭据值与记忆正文）；
 * 输出 = ForeignImportResult（分区载荷 + 未迁移项 + 凭据引用名）。
 *
 * 位置与结构真值见契约 §8.2（本机实测）：
 *  - config.yaml 顶层含 mcp_servers（名字 → 定义；有非空 url → streamable-http，否则 stdio）
 *  - skills/<分类>/<技能>/SKILL.md（**两层**），也有 <分类>/SKILL.md（分类自己就是技能）
 *  - SOUL.md = 主身份 → agentInstructions（用户决策：**导入**）
 *  - memories/{MEMORY.md,USER.md} → 只报告不导入（用户决策；正文根本不在输入结构里）
 *  - .env → 只报告（值绝不读、绝不进包）
 *  - 对话在 SQLite（state.db）里 → 本版**不迁移**，只报告，绝不产出 sessions 分区
 *
 * 公共口径（MCP 映射与凭据剥离、SKILL.md frontmatter 校验、路径/名字安全、技能装配）全部走
 * 共享内核 kernel.ts —— 与 Claude Code 同一份实现，口径不可能分叉。
 */
import { collectSkills, instructionsSection, mcpSectionFromEntries, serverEntriesOf } from './kernel.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip, HermesInput } from './types.ts';

export function convertHermes(input: HermesInput): ForeignImportResult {
  // 读盘层的发现（0 字节 / 位置被 HERMES_HOME 覆盖 / 读不到）排在前面：它们解释「为什么读到的少了」
  const skipped: ForeignSkip[] = [...(input.readFindings ?? [])];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  const rawMcp = isRecord(input.config) ? input.config['mcp_servers'] : undefined;
  if (rawMcp !== undefined && !isRecord(rawMcp)) {
    // 形态对不上就如实报（绝不静默少一片）：Hermes 的真值形态是「名字 → 定义」映射
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

  const instructions = instructionsSection(typeof input.soul === 'string' ? input.soul : '');
  if (instructions !== null) {
    sections.push(instructions);
    counts['agentInstructions.files'] = 1;
  }

  // 记忆：只报告不导入（用户决策）。这里只有文件名，正文根本没有进入过本进程的输入结构。
  for (const rel of input.memoryFiles ?? []) {
    skipped.push({ code: 'memory-report-only', origin: rel, count: 1 });
  }

  // 凭据文件：只报告（值连内存都不进）。导入后由用户在 DSH 里自行补录。
  if (input.dotEnvPresent === true) {
    skipped.push({ code: 'credentials-not-migrated', origin: '.env', count: 1 });
  }

  // 对话：Hermes 存在 SQLite（state.db）；本版不迁移，**并且绝不产出 sessions 分区**。
  if (input.sessionStore?.present === true) {
    skipped.push({ code: 'sessions-not-migrated', origin: input.sessionStore.detail ?? 'state.db', count: 1 });
  }

  return { source: 'hermes', sections, skipped, credentialRefs, counts };
}
