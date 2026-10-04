/**
 * 顶部导航条的自适应布局（UI v2，替代 v1 的 nav-overflow.ts）。
 *
 * 背景：v1 把「7 个文字页签 + 2 个文字动作按钮放不进 564px 画布」当成**可发现性问题**处理
 * —— `overflow-x: auto` 但隐藏滚动条 + 两侧渐隐遮罩，用户得按住 shift 滚轮才能看到右边的页签。
 * v2 承认它是**容量问题**：放不下就从末项开始移进「更多 ▾」菜单，绝不让页签藏在视口外。
 *
 * 本模块是纯函数（零依赖，node 可测）：
 *   - 输入宽度必须是**实测值**（标签文案随语言变化），由壳层用 ResizeObserver 量取；
 *   - **失败兜底优先于任何优化**：只要有一个度量不可信（非有限数 / 负数 / 容器宽 ≤ 0），
 *     就返回「全部可见」—— 宁可横向溢出（视觉瑕疵），也不能因为量不出来而把页签藏掉（功能丢失）。
 */

/** 页签条溢出的像素级容差：亚像素布局（缩放 / 字体度量）不该被当成「还能滚 0.4px」。 */
export const NAV_OVERFLOW_EPSILON = 1

/** 布局结果：visible 是留在条上的项下标，overflow 是进「更多」菜单的项下标（都按原顺序）。 */
export interface NavLayout {
  visible: number[]
  overflow: number[]
}

/** 度量可信吗（可数的正数）。 */
function isUsable(n: number): boolean {
  return Number.isFinite(n) && n > 0
}

/** 全部可见（也用作一切兜底分支的返回值）。 */
function allVisible(count: number): NavLayout {
  return { visible: Array.from({ length: count }, (_, i) => i), overflow: [] }
}

/**
 * 计算导航条布局。
 *
 * @param itemWidths 各项的实测宽度（当前语言下，含图标与左右内边距）
 * @param availWidth 容器**可用于页签**的宽度（已扣掉自身内边距）
 * @param moreWidth  「更多 ▾」按钮自身的实测宽度
 * @param gap       项间距
 *
 * 规则：
 *   ① 全放得下 → 全部可见，不渲染「更多」；
 *   ② 放不下 → 从**末项**开始移入 overflow，并为「更多」按钮及其占用的一个间隔留位；
 *   ③ 连「一个页签 + 更多」都放不下 → 隐藏没有收益，返回全部可见；
 *   ④ 任何度量不可信 → 全部可见。
 */
export function navLayout(
  itemWidths: readonly number[],
  availWidth: number,
  moreWidth: number,
  gap: number,
): NavLayout {
  const total = itemWidths.length
  if (total === 0) return { visible: [], overflow: [] }
  if (!isUsable(availWidth)) return allVisible(total)
  if (!Number.isFinite(moreWidth) || moreWidth < 0) return allVisible(total)
  if (itemWidths.some((w) => !Number.isFinite(w) || w < 0)) return allVisible(total)
  const safeGap = Number.isFinite(gap) && gap > 0 ? gap : 0

  /** 前 count 项排成一行需要多宽（不含「更多」）。 */
  const rowWidth = (count: number): number => {
    let sum = 0
    for (let i = 0; i < count; i++) sum += itemWidths[i] ?? 0
    return sum + (count > 1 ? safeGap * (count - 1) : 0)
  }

  if (rowWidth(total) <= availWidth + NAV_OVERFLOW_EPSILON) return allVisible(total)

  // 为「更多」留出：它自己的宽度 + 与最后一个可见项之间的一个间隔
  for (let visibleCount = total - 1; visibleCount >= 1; visibleCount--) {
    const needed = rowWidth(visibleCount) + safeGap + moreWidth
    if (needed <= availWidth + NAV_OVERFLOW_EPSILON) {
      return {
        visible: Array.from({ length: visibleCount }, (_, i) => i),
        overflow: Array.from({ length: total - visibleCount }, (_, i) => visibleCount + i),
      }
    }
  }

  // 连「一个页签 + 更多」都放不下：隐藏不会让它放得下
  return allVisible(total)
}
