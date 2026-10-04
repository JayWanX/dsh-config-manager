/**
 * 兼容性评分的客户端标签映射（2026-09）。
 *
 * 为什么单独一个 client 模块：`src/ui/import-wizard.ts` 只产出**等级语义**（可测、框架无关），
 * 而这里的键属于**客户端字典**（`src/client/locales.ts`）—— 分层上不该让 src/ui 感知它。
 * 此前只有导入向导做了映射，同步确认页直接渲染裸枚举（`{compatibility}` → 界面显示
 * "partial" 这种机器 token，中文界面下尤其突兀）；把映射抽到这里，两处共用一份。
 *
 * 纯常量 + 纯函数：node 可测，无 React / 无 DOM。
 */
import type { TranslateNS } from '../client-types.ts'
import type { CompatibilityLevel } from '../../ui/import-wizard.ts'

/** 客户端字典键类型（与 `t()` 的入参域一致） */
export type ConfigManagerKey = Parameters<TranslateNS<'config-manager'>>[0]

/** 等级 → 字典键（四档全覆盖；等级由 `compatibilityLevel()` 归一化后传入） */
export const COMPATIBILITY_SCORE_KEYS: Record<CompatibilityLevel, ConfigManagerKey> = {
  unsupported: 'import.compatibility.score.unsupported',
  partial: 'import.compatibility.score.partial',
  good: 'import.compatibility.score.good',
  excellent: 'import.compatibility.score.excellent',
}

/** 等级 → 字典键（唯一实现；禁止在视图里再写一份映射） */
export function compatibilityScoreKey(level: CompatibilityLevel): ConfigManagerKey {
  return COMPATIBILITY_SCORE_KEYS[level]
}
