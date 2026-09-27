/**
 * 自定义下拉（Select）—— 替换原生 <select> 的唯一出口。
 *
 * 为什么自绘：原生 <select> 的外观由**浏览器**渲染（`appearance: none` 只能改触发器，
 * 展开后的弹层仍是系统控件），在深色主题下是亮底系统菜单，与工作台其余控件不属于同一套
 * 视觉语言；且它无法使用 `--dsw-*` token（DESIGN.md §3 硬约束：颜色/字体/阴影必走 token）。
 * 因此这里用 button + div 自绘，并自己承担原生控件原本免费提供的：
 *   - 键盘语义（↑/↓ 移动、Home/End、Enter/Space 提交、Esc 关闭、Tab 关闭）；
 *   - 无障碍角色（combobox + listbox + option，aria-expanded / aria-activedescendant /
 *     aria-selected / aria-disabled）；
 *   - 点击外部关闭、禁用项跳过、值失效时的显示回退。
 *
 * 可测的那部分（高亮项推导与移动）在 `src/ui/select-model.ts`（node 单测覆盖），
 * 本文件**只做装配**（与仓库「逻辑在 src/ui、React 壳只装配」的分层铁律一致）。
 *
 * 两条实现约束：
 *   ① 弹层留在原地（absolute 定位），**不 portal** —— 本插件的 Radix 弹窗必须挂在
 *      #dsh-config-manager-root 内（见 common/Modal.tsx），额外 portal 会引入第二套层叠上下文；
 *   ② Esc 必须 `stopPropagation` —— 它可能位于 Radix 弹窗 / 活动抽屉内，冒泡出去会连带
 *      关掉整个弹窗或抽屉。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  edgeActiveIndex, initialActiveIndex, selectDisplayLabel, stepActiveIndex,
  type SelectOption,
} from '../../ui/select-model.ts'
import { ChevronDownIcon } from './Icon.tsx'
import { MODAL_ROOT_ID } from './Modal.tsx'
import css from '../config-manager.module.css'

export type { SelectOption }

/** 弹层最大宽度（与 CSS 的 .selectMenu max-width 对齐）：用于判断贴右边界时是否需要翻转对齐。 */
const MENU_MAX_WIDTH = 260

export interface SelectProps {
  /** 当前值（字符串；数字枚举在调用点转换） */
  value: string
  options: SelectOption[]
  /** 选择变化（仅在实际变化时触发；重复选择同值不回调） */
  onChange: (value: string) => void
  /** 无障碍名（无可见 label 挂在本控件上时必填） */
  ariaLabel?: string
  disabled?: boolean
  title?: string
  className?: string
  style?: CSSProperties
  /**
   * 展开时回调。原生 select 靠 onFocus/onMouseDown/onClick 触发惰性加载的地方
   * （同步页「选择历史快照」），改为在这里触发 —— 一次展开只拉一次，语义更准。
   */
  onOpen?: () => void
}

/**
 * 弹层对齐方向量测：触发器右侧剩余空间不足 MENU_MAX_WIDTH 时右对齐。
 * 画布边界取插件根节点（#dsh-config-manager-root）—— 它的 overflow:hidden 就是实际裁剪线，
 * 用 window 宽度判断会误判（宿主设置弹窗比视口窄）。
 */
function menuAlign(root: HTMLElement | null): 'start' | 'end' {
  if (root === null || typeof document === 'undefined') return 'start'
  const bound = document.getElementById(MODAL_ROOT_ID)?.getBoundingClientRect()
  const rect = root.getBoundingClientRect()
  if (bound === undefined) return 'start'
  return rect.left + MENU_MAX_WIDTH > bound.right - 4 ? 'end' : 'start'
}

export function Select(props: SelectProps) {
  const { value, options, onChange, ariaLabel, disabled = false, title, className, style, onOpen } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  /** 弹层对齐方向：贴画布右边界时改为右对齐，否则 260px 的弹层会被 .section 的 overflow 裁掉。 */
  const [align, setAlign] = useState<'start' | 'end'>('start')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const label = selectDisplayLabel(options, value)

  const close = (refocus: boolean): void => {
    setOpen(false)
    setActive(-1)
    if (refocus) rootRef.current?.querySelector('button')?.focus()
  }

  const openMenu = (): void => {
    if (disabled || open) return
    setActive(initialActiveIndex(options, value))
    setAlign(menuAlign(rootRef.current))
    setOpen(true)
    onOpen?.()
  }

  /** 高亮项提交：禁用项与越界索引都不动，其余写回并关闭。 */
  const commit = (index: number): void => {
    const option = options[index]
    if (option === undefined || option.disabled === true) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  // 点击外部关闭：监听 mousedown（比 click 早，且能覆盖右键/拖拽结束）
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  // 键盘移动后把高亮项滚进可视区（长清单：24 小时 / 快照列表）
  useEffect(() => {
    if (!open || active < 0) return
    const node = listRef.current?.querySelector('[data-active]')
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        if (!open) {
          setActive(initialActiveIndex(options, value))
          setOpen(true)
          onOpen?.()
          return
        }
        setActive((current) => stepActiveIndex(options, current, delta))
        return
      }
      case 'Home':
      case 'End': {
        if (!open) return
        event.preventDefault()
        setActive(edgeActiveIndex(options, event.key === 'Home' ? 'first' : 'last'))
        return
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        if (!open) openMenu()
        else commit(active)
        return
      }
      case 'Escape': {
        if (!open) return
        // 必须吞掉：外层可能是 Radix 弹窗 / 活动抽屉，冒泡会把它们一起关掉
        event.stopPropagation()
        event.preventDefault()
        close(true)
        return
      }
      case 'Tab': {
        if (open) close(false)
        return
      }
      default:
        return
    }
  }

  return (
    <div
      ref={rootRef}
      className={className === undefined ? css.selectRoot : `${css.selectRoot} ${className}`}
      style={style}
      data-open={open ? '' : undefined}
      data-align={align}
    >
      <button
        type="button"
        className={css.selectTrigger}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        title={title ?? (label !== '' ? label : undefined)}
        disabled={disabled}
        onClick={() => { if (open) close(false); else openMenu() }}
        onKeyDown={onKeyDown}
      >
        <span className={css.selectLabel}>{label}</span>
        <ChevronDownIcon size={13} className={css.selectChevron} />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className={css.selectMenu}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-opt-${index}`}
              className={css.selectOption}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled === true ? true : undefined}
              data-active={index === active ? '' : undefined}
              data-disabled={option.disabled === true ? '' : undefined}
              title={option.label}
              onMouseEnter={() => { if (option.disabled !== true) setActive(index) }}
              // mousedown 先于 blur：阻止默认行为，避免触发器的焦点在提交前丢失
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { commit(index) }}
            >
              <span className={css.selectOptionLabel}>{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
