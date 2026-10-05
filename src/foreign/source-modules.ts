/**
 * 来源清单的**单一事实源**（t4，档 B 前置）。
 *
 * 背景：加第 N 个来源此前要改**至少 6 处**（TS union + 注册表装配 + 2 个新文件 + 4 处硬编码测试
 * + 4 处字典 + CLI help + 设计文档 §8.2，逐处核见 outputs/competitor-recon-2026-10-05/
 * read-chat-import.md §8.2）。其中**能被编译/测试挡住的只有一半**，漏掉的会静默降级。
 *
 * 这份模块把「一个来源由哪些模块构成」收敛成一份数据：\`file-budget.test.ts\` 用它枚举模块形状，
 * \`source-registry.test.ts\` 用它反查四条会静默漂移的清单（\`registry.ts\` 的 \`builtinForeignSources()\`、
 * \`registry.test.ts\` / \`routes/foreign.test.ts\` / \`cli/import-source.test.ts\` / \`ui/foreign-view.test.ts\`
 * 的硬编码快照）。**新增来源只改这里一处**，其余位置漏改即红灯。
 *
 * 与 \`registry.ts\` 的 \`FOREIGN_SOURCE_IDS\` 的关系（两处各自维护必然漂移 → 因此有断言）：
 *  - \`FOREIGN_SOURCE_IDS\` 是**运行期词表**（类型 union 的 runtime 投影，供 registry / UI / CLI 消费）；
 *  - 本模块是**来源清单的单一事实源**，词表由本模块派生；
 *  - \`file-budget.test.ts\` 与 \`source-registry.test.ts\` 双向断言二者同序同长。
 *
 * 本模块是**零依赖纯数据**（不 import fs / 不 import registry），因此可以被测试与运行期同时使用。
 */
import type { ForeignSourceId } from './types.ts';

/** 一个来源在 \`src/foreign/\` 里必须存在的模块（形状枚举的唯一事实源） */
export interface ForeignSourceModuleShape {
  readonly id: ForeignSourceId;
  /** 精确模块名（不含目录），按「读盘层 → 翻译层」的顺序 */
  readonly modules: readonly string[];
  /** 该来源是否带会话转码（带会话的来源必须经 IR 层，不许自己拼 DSH 行） */
  readonly sessions: boolean;
}

/**
 * 六个内置来源的形状（顺序 = 契约 §8.2 真值表顺序）。
 *
 * **新增来源 = 在这里加一条 + 建两个文件**；其余清单一律由测试反查本表，不在这里重复。
 */
export const FOREIGN_SOURCE_MODULE_SHAPES: readonly ForeignSourceModuleShape[] = [
  { id: 'claude-code', modules: ['read-claude-code.ts', 'claude-code.ts'], sessions: true },
  { id: 'hermes', modules: ['read-hermes.ts', 'hermes.ts'], sessions: false },
  { id: 'cursor', modules: ['read-cursor.ts', 'cursor.ts'], sessions: false },
  { id: 'codex', modules: ['read-codex.ts', 'codex.ts'], sessions: false },
  { id: 'copilot', modules: ['read-copilot.ts', 'copilot.ts'], sessions: false },
  { id: 'antigravity', modules: ['read-antigravity.ts', 'antigravity.ts'], sessions: false },
];

/** 由形状表派生的来源 id 清单（顺序稳定） */
export const FOREIGN_SOURCE_IDS_FROM_SHAPES: readonly ForeignSourceId[] =
  FOREIGN_SOURCE_MODULE_SHAPES.map((s) => s.id);

/** 由形状表派生的 \`labelKey\`（契约：\`foreign.source.<id>\`，不得各写各的） */
export function foreignSourceLabelKey(id: ForeignSourceId): string {
  return 'foreign.source.' + id;
}

/**
 * 「带会话转码」的来源 id（档 B 的会话类来源会往这里长）。
 * 会话转码**必须**经 \`session-ir.ts\` 的 IR 与合成器 —— 见 file-budget.test.ts 的分层白名单。
 */
export const FOREIGN_SESSION_SOURCE_IDS: readonly ForeignSourceId[] =
  FOREIGN_SOURCE_MODULE_SHAPES.filter((s) => s.sessions).map((s) => s.id);
