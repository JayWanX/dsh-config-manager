/**
 * 流程任务层的容器（UI v2 §5.8）—— 内容区上的**全宽侧滑面板**。
 *
 * 它不占布局、覆盖 `.shellContent`（不是整个画布）：导航条、全局横幅、状态栏都保留可见可点 ——
 * 横幅是急救可达性的硬要求（§4.4），导航条保留才能「切走收起、切回续做」（§5.8 的可见性规则）。
 * 面板是覆盖层，所以**底下的页面不卸载**：关闭是瞬时的，滚动位置与展开态都还在。
 *
 * 定位用 `absolute` 而不是 `fixed`：`.shellContent` 是 `position: relative`，
 * `inset: 0` 自动贴合内容区，与浏览器窗口尺寸无关。v1 抽屉用 `fixed` 是相对**视口**解析的，
 * 所以它才需要一条 `@media (max-width: 900px){ width: 100vw }` 的错误补丁（那条已删除）。
 *
 * 关闭途径只有两种，且都在这里集中：`← 返回` 恒有；`escToClose` 只对**只读视图**开
 * （多阶段流程里可能有未保存的计划或已输入的密码，Esc 误退的代价太大）。
 *
 * **换视图不重挂外壳**（调用方不得给本组件加 `key={kind}`）：按 kind 重挂 = 旧面板卸载 +
 * 新面板以 `.taskPanelIn`（opacity: 0 起步）入场，两步之间会露出一帧底下的页面 ——
 * 观感就是「切换侧拉页面时闪一下」。现在外壳只在「无面板 ⇄ 有面板」时挂载/卸载，
 * 换视图 = 原地换内容；`.taskBody` 的滚动位置由 `resetKey` 显式归零（重挂时代它自动归零）。
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../common/ui.tsx'
import css from '../config-manager.module.css'

export interface TaskShellProps {
  /** 面板标题（已本地化） */
  title: string
  /** 返回按钮文案（已本地化，如「← 返回产物库」） */
  backLabel: string
  onBack: () => void
  /** 只读视图可开：Esc 关闭。多阶段流程保持缺省 false */
  escToClose?: boolean
  /** 流程自己的 Stepper / 进度条（可选，渲染在标题右侧） */
  trailing?: ReactNode
  /**
   * 视图标识（= `task.kind`）：变化时把正文滚回顶部。
   * 为什么需要：外壳不再按 kind 重挂，滚动位置会跨视图残留（旧面板滚到底 → 新面板从中段开始）。
   */
  resetKey?: string
  children: ReactNode
}

export function TaskShell({ title, backLabel, onBack, escToClose = false, trailing, resetKey, children }: TaskShellProps) {
  const rootRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // 打开时把焦点移进面板：面板盖住了原来的内容，焦点留在底下的页面会让键盘用户「迷路」
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // 换视图（resetKey 变化）= 原地换内容，所以滚动位置必须显式归零（原先靠重挂自动归零）
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null) body.scrollTop = 0
  }, [resetKey])

  return (
    <section
      ref={rootRef}
      className={css.taskPanel}
      // 不用 role="dialog"：导航条仍可点，这不是模态对话；aria-modal 也会谎报语义。
      role="region"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!escToClose || event.key !== 'Escape') return
        // 吞掉：外层可能是 Radix 弹窗，冒泡会把它一起关掉（与 Select/MoreMenu 同一条纪律）
        event.stopPropagation()
        event.preventDefault()
        onBack()
      }}
    >
      <header className={css.taskHead}>
        <Button size="sm" onClick={onBack}>{backLabel}</Button>
        <span className={css.taskTitle}>{title}</span>
        <span className={css.spacer} />
        {trailing}
      </header>
      <div ref={bodyRef} className={css.taskBody}>{children}</div>
    </section>
  )
}
