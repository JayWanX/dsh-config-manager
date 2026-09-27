/**
 * 形变图标数据层 —— 参与「状态形变」（morph）的图标，取自 vanilla `lucide` 的 IconNode 数据。
 *
 * 为什么要单独一层、不复用 Icon.tsx
 * --------------------------------
 * `MorphIcon` 消费的是 **IconNode 数据**（`[tag, attrs][]`），不是 React 组件；而
 * `lucide-react` 只导出组件。所以形变图标必须走 `lucide`（vanilla）包的深路径。
 * 两包并存是 morphicons 的既定设计（官方 README 明说），且都精确 tree-shake ——
 * 这里只列真正参与形变的图标，其余仍由 Icon.tsx 的 lucide-react 组件承担。
 *
 * 版本纪律（易漏，已由测试钉住）
 * ----------------------------
 * `lucide` 与 `lucide-react` 必须**同版本**：否则「静态图标」与「形变图标」会是两套
 * 图形（同一个 chevron 在形变前后端点/描边不一致，切换瞬间会跳一下）。
 * `morph-icons.test.ts` 直接读两个包的 package.json 断言相等。
 *
 * 体积纪律
 * -------
 * 深路径导入（`lucide/dist/esm/icons/<name>.mjs`），不用桶导出 —— 与 Icon.tsx 同一约定。
 * 这些深路径无随附类型，由 `src/client/lucide-icons.d.ts` 的 ambient 声明兜底。
 */
import type { IconNode } from 'morphicons'
import ChevronDown from 'lucide/dist/esm/icons/chevron-down.mjs'
import ChevronRight from 'lucide/dist/esm/icons/chevron-right.mjs'
import CopyCheck from 'lucide/dist/esm/icons/copy-check.mjs'

/* —— 「复制 → 已复制」对 —— */

/**
 * 空闲态的**隐藏对勾**：把 lucide `copy-check` 的对勾 `m12 15 2 2 4-4` 绕点 (8,15) 缩到 4% 后的折线。
 *
 * 为什么需要它（实测数据，**别凭直觉改回 `copy → copy-check`**）
 * ---------------------------------------------------------------
 * 直接 morph `copy`（2 条子路径）→ `copy-check`（3 条）是**拓扑不匹配**：morphicons 只能把一条
 * 已有子路径复用给新出现的对勾，于是那条要从 1.0 缩到 **0.20 倍**、途中还转 −159°
 * （实测 `lnSigma = −1.62`、`res = 0.66` —— 对照 chevron 那对是 0 / 0）。中途是一团缩在角上的
 * 乱线，不是形变。整个 lucide「A + 对勾」家族都这个毛病（clipboard-check ×0.50、file-check ×0.72、
 * square-check ×0.20 —— 全部实测否决）。
 *
 * 解法：让空闲态**也有 3 条子路径**，对勾预先存在但退化到不可见。拓扑 3↔3 之后，
 * 矩形与后板形变到自身（实测 `theta = 0`、`lnSigma = 0`、`res = 0` —— 纹丝不动），对勾从一点
 * 长出来（`lnSigma = 3.22`、`res = 0`）。三条子路径的旋转全为 0，所以这是一次**纯生长**。
 *
 * 为什么绕 (8,15) 而不是绕对勾自己的质心：`stroke-linecap: round` 会给退化路径画一个
 * 直径 = stroke-width（1.75）的**圆点**。把退化点放进矩形**左边框的描边带**内
 * （矩形 x=8、stroke-width 1.75 → 带 x ∈ [7.125, 8.875]），圆点被边框吞掉，空闲态与 lucide
 * `copy` **视觉完全一致**（`morph-icons.test.ts` 断言三点都在带内、包围盒 ≤ 0.5 单位）。
 */
const HIDDEN_CHECK_D = 'M8.16 15L8.24 15.08L8.4 14.92'

/**
 * 空闲态「复制」= `copy-check` 的结构（对勾 / 矩形 / 后板），只把对勾换成隐藏版本。
 *
 * 用 `slice(1)` 直接复用 lucide 的矩形与后板属性，**不手抄坐标**：实测这两个属性与 lucide
 * `copy` **逐字相同**，所以空闲态渲染出来就是标准的复制图标（测试断言相等）；lucide 日后若改了
 * 结构，测试会红，而不是静默画错一个图标。
 */
const COPY_IDLE: IconNode = [['path', { d: HIDDEN_CHECK_D }], ...CopyCheck.slice(1)]

/**
 * 语义名 → 形变图标数据（**只收真正需要形变的图标**，不要往里塞静态图标）。
 *
 * 收录标准：该图标的**状态切换本身携带信息**（展开↔收起、复制↔已复制），形变让「变了」可见。
 * 纯装饰性图标与**没有状态切换的静态图标**不得进入本表 —— 后者是纯体积亏损（DESIGN.md §6 / §9 #13）。
 */
export const MORPH_ICONS = {
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  copy: COPY_IDLE,
  copyDone: CopyCheck,
} satisfies Record<string, IconNode>

export type MorphIconName = keyof typeof MORPH_ICONS

/**
 * 形变弹簧参数：**临界阻尼**（无过冲）。
 *
 * ζ = damping / (2√stiffness) = 41 / (2√420) ≈ 1.000 —— 恰在临界阻尼线上：到达目标后不越过、
 * 不回弹。刚度取 morphicons `snappy` 预设的量级（k=420），但**不用 snappy**：它 ζ=0.73
 * 会有约 5% 回弹，与本仓库「克制、精致」的动效语言不符（用户只要求「快一点」，不是「更活泼」）。
 *
 * 速度对比 morphicons `smooth`（k=170，同为临界阻尼）：ω_n 由 13.0 → 20.5，
 * 感知完成时间约 230ms → 146ms（≈1.6 倍速）—— 这是 2026-09 用户反馈「展开/收起动画太慢」的修正值。
 * 再快（k≳700）会短到来不及被看见，反而失去「状态变了」的可见性价值。
 *
 * `morph-icons.test.ts` 断言 ζ ≈ 1 且 170 < stiffness ≤ 700（防止被改回「好看但慢」的参数，
 * 或悄悄引入回弹）。改这里必须同步 DESIGN.md §6。
 */
export const MORPH_SPRING = { stiffness: 420, damping: 41 } as const
