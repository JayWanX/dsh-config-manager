/**
 * dsh4 来源（DSH V4 代次会话日志）—— 与 dsh **共用同一扫描器与同一装配器**。
 *
 * 真值：同一份 <DSH_HOME>/sessions，`session.v4.jsonl.zstd`（本机实测首帧 version=4）。
 * evidence 与 truth-table.ts 的 dsh4 行一致：`measured`。
 */
import { createDshLikeSource } from './dsh.ts';
import { readDsh4 } from './read-dsh4.ts';
import type { ForeignSource } from './registry.ts';

export function createDsh4Source(): ForeignSource {
  return createDshLikeSource('dsh4', 'v4', (opts) => readDsh4(opts));
}

export const dsh4Source: ForeignSource = createDsh4Source();
