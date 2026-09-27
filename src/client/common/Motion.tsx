/**
 * Motion —— 内容出现/消失的动效原语（折叠容器）。
 *
 * 为什么需要：折叠树（ContentPicker 的分区/分组）点击后内容是**瞬变**的 ——
 * `{open && <div/>}` 只能做「出现」，而 `height: auto` 不可过渡，于是展开/收起都没有
 * 高度动画，只有 chevron 形变在动，控件整体显得「跳」。
 *
 * 做法（纯 CSS，无第三方、无 JS 测量、无 ResizeObserver）：
 * `grid-template-rows: 0fr ⇄ 1fr` 是可以插值的，内层 `overflow: hidden` 负责裁剪。
 *
 * 代价与取舍（必须知道）：内容**始终挂载**才能让「收起」也有高度动画 —— 被卸载的子树
 * 没有高度可插值，收起只能瞬塌。因此 ContentPicker 的单元行（上限 1000 行，
 * 见 `src/ui/selection-model.ts` 的 `UNIT_RENDER_LIMIT`）在收起后仍在 DOM 里；
 * 同一量级的静态 DOM 已被该文件判定为可接受，换来两端都有动画。
 * 收起态用 `visibility: hidden`（延迟到高度动画结束）退出 tab 序与绘制（见 CSS §2）。
 *
 * 用法：触发器保持 `aria-expanded`；`aria-controls` 引用本容器的 `id`（**恒有值**，
 * 因为容器始终存在，不再需要 `open ? id : undefined`）。
 */
import type { ReactNode } from 'react'
import css from '../config-manager.module.css'

export interface ViewSwitchProps {
  /** 视图标识：变化即重放入场动画（同一个值不重放） */
  viewKey: string
  children: ReactNode
}

/**
 * 视图切换入场（页内子视图 / 分支级切换）。
 *
 * 做法：用一个带 key 的容器包住内容 —— key 变化 = React 重建该节点 = CSS 动画重放一次。
 * 之前这类切换是**瞬变**的（Segmented 点了以后内容整块换掉，没有任何过渡）。
 *
 * 硬约定：只用于**分支渲染不同组件**的视图级切换。key 变化会卸载重挂整棵子树，
 * 因此「需要保留组件内部 state」的容器不能用它（会让进行中态之类的本地态归零）——
 * 这与 AGENTS.md「进行中操作也算状态」的教训是同一条红线。
 * 包装层透传纵向 flex 填充链（CSS `.viewEnter`），否则子视图的 `flex: 1` 会失效、
 * 页面底部重新出现空洞（DESIGN.md 的 canvas 纪律）。
 */
export function ViewSwitch({ viewKey, children }: ViewSwitchProps) {
  return (
    <div key={viewKey} className={css.viewEnter}>
      {children}
    </div>
  )
}

export interface CollapseProps {
  /** 展开态 */
  open: boolean
  /** 折叠体 id（供触发器的 aria-controls 引用） */
  id?: string
  className?: string
  children: ReactNode
}

/** 折叠容器：展开/收起两端都有高度动画（实现与代价见文件头）。 */
export function Collapse({ open, id, className, children }: CollapseProps) {
  return (
    <div
      id={id}
      className={className === undefined ? css.collapse : css.collapse + ' ' + className}
      data-open={open ? '' : undefined}
      aria-hidden={open ? undefined : true}
    >
      <div className={css.collapseInner}>{children}</div>
    </div>
  )
}
