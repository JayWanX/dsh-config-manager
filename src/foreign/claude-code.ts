/**
 * Claude Code（~/.claude）→ DSH bundle 分区的**纯**翻译层（v1）。
 *
 * 重构后本文件只保留 Claude 特有的部分，公共口径全部走共享内核（kernel.ts）：
 *  - 路径/名字安全、SKILL.md frontmatter 校验、MCP 映射与凭据剥离、skill 装配、会话归集
 *    → 内核（Hermes 等其它来源共用同一份实现，口径不可能分叉）；
 *  - 本文件只剩：~/.claude.json 的 mcpServers 取值、settings.json 的 hooks/env 只读发现、
 *    CLAUDE.md → AGENTS.md、commands 计数。
 *
 * **对外行为与产物与重构前逐字一致**（回归护栏 claude-code.test.ts / claude-sessions.test.ts 的
 * 断言一行未改，且既有导出名与模块路径保持不变 —— 它们是 v1 的公开面）。
 *
 * v1 范围：mcp / skills / agentInstructions / sessions+workspaces。
 * 明确不搬、并**可见地**记进 skipped（绝不静默）：
 *  - settings.json 的 hooks（DSH 无对等结构）
 *  - settings.json 的 env（凭据：只报名字与条数，值不读）
 *  - commands/*.md（斜杠命令与 DSH prompts 不是同一语义）
 *  - ~/.claude.json 的 projects / sessions / history（机器状态，且与源机路径强绑定）
 */
import { defaultSecretScanner } from '../core/exporter.ts';
import { isRecord } from '../utils/guards.ts';
import { transcodeClaudeSession } from './claude-sessions.ts';
import {
  collectSessionSections,
  collectSkills,
  instructionsSection,
  mcpSectionFromEntries,
  serverEntriesOf,
} from './kernel.ts';
import type { ClaudeCodeInput, ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/* 公共判据/工具**从共享内核再导出**：v1 的既有 import 路径与名字保持不变（外部只 import 这一层） */
export {
  frontmatterProblem,
  isSafeRelPath,
  isSafeUnitName,
  mcpEntryOf,
  splitFrontmatter,
  stripUserInfo,
} from './kernel.ts';

/* ---------------- settings.json 里只看不搬的部分 ---------------- */

function collectSettingsFindings(settings: unknown, skipped: ForeignSkip[], refs: string[]): void {
  if (!isRecord(settings)) return;
  const hooks = settings['hooks'];
  if (isRecord(hooks) && Object.keys(hooks).length > 0) {
    skipped.push({ code: 'unsupported-hooks', count: Object.keys(hooks).length });
  }
  const env = settings['env'];
  if (isRecord(env) && Object.keys(env).length > 0) {
    // 只问「哪些名字像凭据」——值一律不读、不落盘、不回传
    const { hits } = defaultSecretScanner().scanAndRedact(env);
    if (hits.length > 0) {
      skipped.push({ code: 'credentials-not-migrated', count: hits.length });
      for (const h of hits) refs.push('settings.env:' + h.field);
    }
  }
}

/* ---------------- 入口 ---------------- */

export function convertClaudeCode(input: ClaudeCodeInput): ForeignImportResult {
  const skipped: ForeignSkip[] = [];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  const mcp = mcpSectionFromEntries(serverEntriesOf(input.claudeJson, 'mcpServers'), credentialRefs, skipped);
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

  const instructions = instructionsSection(typeof input.memory === 'string' ? input.memory : '');
  if (instructions !== null) {
    sections.push(instructions);
    counts['agentInstructions.files'] = 1;
  }

  // 内核在 formatVersion === undefined 时**一条都不转**并整批报码；这里的 -1 是不可达分支的兜底
  // （转码器会把它判成 session-format-unsupported），刻意不写 0/3 之类的"最近版本"，避免猜。
  const formatVersion = input.targetSessionFormatVersion ?? -1;
  collectSessionSections({
    files: input.sessions ?? [],
    targetFormatVersion: input.targetSessionFormatVersion,
    transcode: (file) => transcodeClaudeSession(file, { formatVersion }),
    workspaceIdPrefix: 'claude-code',
    sections,
    skipped,
    counts,
  });

  collectSettingsFindings(input.settings, skipped, credentialRefs);
  const commandCount = input.commandCount ?? 0;
  if (commandCount > 0) skipped.push({ code: 'unsupported-commands', count: commandCount });

  return { source: 'claude-code', sections, skipped, credentialRefs, counts };
}
