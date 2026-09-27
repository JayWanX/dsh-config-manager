/**
 * 自定义下拉（Select）的纯交互模型 —— src/client/common/Select.tsx 只做装配。
 *
 * 为什么需要它：原生 <select> 的外观由浏览器渲染（无法跟随 `--dsw-*` token，
 * 深色主题下是白底系统控件、与工作台其余控件格格不入），故改为 div/button 自绘。
 * 自绘换来的是**无障碍与键盘语义要自己扛**（ARIA combobox + listbox 模式），
 * 所以可测的那部分（高亮项推导 / 上下移动 / 首尾跳转）全部落在这里，node 可测。
 *
 * 分层铁律：本文件零依赖（不 import react / 浏览器 API），client 与 node 单测都能用。
 */

/** 下拉选项（value 一律字符串：调用点的数字枚举在边界处 String/Number 转换）。 */
export interface SelectOption {
  /** 回传给 onChange 的值（唯一键） */
  value: string
  /** 展示文本（已本地化；不在本层做 i18n） */
  label: string
  /** 禁用项：键盘移动跳过、不可提交（灰显） */
  disabled?: boolean
}

/** 选中值对应的选项；值不在清单里（如远端快照已被清理）→ undefined。 */
export function selectedOption(options: SelectOption[], value: string): SelectOption | undefined {
  for (const option of options) {
    if (option.value === value) return option
  }
  return undefined
}

/**
 * 触发器上的显示文本。
 *
 * 值不在清单里时**不显示空**：先用 fallback（调用点给的占位文案），
 * 仍为空则显示原值本身 —— 显示「一个不存在的 id」也比显示空白强
 * （用户至少能看出当前选中的是什么；空白会被读成「没选中」）。
 */
export function selectDisplayLabel(options: SelectOption[], value: string, fallback = ''): string {
  const hit = selectedOption(options, value)
  if (hit !== undefined) return hit.label
  return fallback !== '' ? fallback : value
}

/**
 * 打开菜单时的初始高亮项：
 * 选中项优先（它是用户下次最可能改动的锚点）；选中项不存在或已禁用 → 第一个可用项。
 * 全部禁用 / 空清单 → -1（表示没有高亮项）。
 */
export function initialActiveIndex(options: SelectOption[], value: string): number {
  const selected = options.findIndex((option) => option.value === value)
  if (selected >= 0 && options[selected]?.disabled !== true) return selected
  return firstEnabledIndex(options)
}

/** 第一个可用项下标；没有 → -1。 */
export function firstEnabledIndex(options: SelectOption[]): number {
  return options.findIndex((option) => option.disabled !== true)
}

/** 最后一个可用项下标；没有 → -1。 */
export function lastEnabledIndex(options: SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (options[i]?.disabled !== true) return i
  }
  return -1
}

/**
 * 从 from 出发按 delta（±1）移动高亮项。
 *
 * 三条语义（与原生 <select> 的键盘行为对齐）：
 *   ① 禁用项跳过，不停留；
 *   ② 到达末尾**环绕**（原生 select 也环绕），环绕一整圈回到原位；
 *   ③ 当前无高亮（from < 0）时：delta > 0 → 第一个可用项，delta < 0 → 最后一个可用项。
 * 全部项禁用 / 空清单 → -1。
 */
export function stepActiveIndex(options: SelectOption[], from: number, delta: number): number {
  const total = options.length
  if (total === 0) return -1
  if (firstEnabledIndex(options) < 0) return -1
  if (from < 0) return delta >= 0 ? firstEnabledIndex(options) : lastEnabledIndex(options)
  let index = from
  for (let hop = 0; hop < total; hop++) {
    index = (index + delta + total) % total
    if (options[index]?.disabled !== true) return index
  }
  return from
}

/** Home/End：跳到第一个/最后一个可用项。 */
export function edgeActiveIndex(options: SelectOption[], edge: 'first' | 'last'): number {
  return edge === 'first' ? firstEnabledIndex(options) : lastEnabledIndex(options)
}
