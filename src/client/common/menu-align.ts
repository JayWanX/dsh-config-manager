/**
 * 自绘弹层的对齐量测（**留在原地**的弹层用：当前只有导航条的 MoreMenu）—— 从 Select.tsx 抽出。
 *
 * Select 的弹层已改为 portal + fixed + 夹紧：左右对齐不再看「右侧剩余多少」，
 * 而是由 `src/ui/menu-placement.ts` 的 `placeMenu` 把菜单真正夹进夹紧矩形
 * （右侧越界 → 先右对齐、再夹到右边界内侧）。本文件保留给留在原地、
 * 靠 CSS `data-align` 决定左/右的那类弹层。
 *
 * 为什么必须按**插件画布**而不是 window 判断：宿主设置弹窗比视口窄得多
 * （插件内容区恒 ≈564px，而视口可能 1400px+）。用 window 宽度判断会认为「右边还很宽」，
 * 于是 260px 的弹层被 .section 的 overflow: hidden 直接裁掉 —— 用户看到菜单被切了一半。
 * 唯一可信的裁剪线是插件根节点（#dsh-config-manager-root）的右边界。
 */
import { MODAL_ROOT_ID } from './Modal.tsx'

/** 弹层最大宽度（与 CSS 的 .selectMenu max-width 对齐）：判断贴右边界时是否需要翻转对齐。 */
export const MENU_MAX_WIDTH = 260

/**
 * 触发器右侧剩余空间不足 MENU_MAX_WIDTH 时改为右对齐。
 * 根节点还没挂载（或被弹窗替换）时保守返回 'start'。
 */
export function menuAlign(root: HTMLElement | null): 'start' | 'end' {
  if (root === null || typeof document === 'undefined') return 'start'
  const bound = document.getElementById(MODAL_ROOT_ID)?.getBoundingClientRect()
  const rect = root.getBoundingClientRect()
  if (bound === undefined) return 'start'
  return rect.left + MENU_MAX_WIDTH > bound.right - 4 ? 'end' : 'start'
}
