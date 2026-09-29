/**
 * 「档案」页（DSH profile 管理）—— 框架无关纯函数层（node 可测）。
 *
 * 职责：名字输入校验、列表排序（当前运行置顶）、列表摘要统计、危险态判定、运行中实例判定、
 * 展示格式化（时间/字节）、终端启动命令文本。不产出用户可见散文（文案走 locale 字典 `t()`），
 * 不 import node 模块、不 import React。
 *
 * 依赖方向：只从 `src/profiles/dsh-profile-shared.ts`（零依赖）取类型与纯函数——
 * 绝不 import 用 node fs 的引擎（否则 client bundle 会带上 node 内置模块依赖而整插件不加载）。
 */
import {
  checkProfileName, isLaunchableShape, isManagedProfileName,
  type DshProfileCopyWarning, type DshProfileIssue, type DshProfileLaunchResult, type DshProfileLaunchWarning,
  type DshProfileMeta, type DshProfileRunningView, type DshProfileShape, type DshProfileStopOutcome,
} from '../profiles/dsh-profile-shared.ts'

/** 名称输入校验结果（UI 按码映射 i18n；null = 合法）。 */
export type ProfileNameIssue = 'required' | 'tooLong' | 'illegal' | 'reserved'

/** 校验输入框里的 profile 名：与 host 侧同规则，但把「空」与「过长」细分以便给出更准的提示。 */
export function validateProfileNameInput(name: string): ProfileNameIssue | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'required'
  if (trimmed.length > 64) return 'tooLong'
  const reason = checkProfileName(trimmed)
  if (reason === 'invalidNameInput') return 'illegal'
  if (reason === 'reservedName') return 'reserved'
  return null
}

/** 列表排序：当前运行中的置顶 → 接着是「本插件启动的实例」→ 其余按名字（localeCompare）。 */
export function sortProfilesForDisplay(
  profiles: readonly DshProfileMeta[],
  opts: { currentName?: string | null; runningNames?: readonly string[] } = {},
): DshProfileMeta[] {
  const running = new Set(opts.runningNames ?? [])
  const rank = (p: DshProfileMeta): number => {
    if (opts.currentName !== undefined && opts.currentName !== null && p.name === opts.currentName) return 0
    if (running.has(p.name)) return 1
    return 2
  }
  return [...profiles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * 面板阶段：**由切片派生**，不另存 status 字段 —— 列表已恢复时一次后台刷新不该把视图打回
 * 「加载中」（旧实现每次挂载都先置 loading，切回页签必然闪一下空态）；只有真正还没有数据
 * （`profiles === null`）才显示加载中。`loadError` 优先：加载失败要如实报错，不假装有数据。
 */
export type ProfilesPanelPhase = 'loading' | 'ready' | 'error'

export function profilesPanelPhase(profiles: readonly DshProfileMeta[] | null, loadError: string | null): ProfilesPanelPhase {
  if (loadError !== null) return 'error'
  return profiles === null ? 'loading' : 'ready'
}

/** 列表页顶部的概览统计（全部来自列表本身，无额外 IO）。 */
export interface ProfilesSummary {
  total: number
  web: number
  headless: number
  generic: number
  /** 有 issue 的档案数（如 package.json 损坏） */
  broken: number
  /** 已装 node_modules（有树外插件）的档案数 */
  withNodeModules: number
  /** patch 条目总数（启发式计数） */
  patchEntries: number
}

export function summarizeProfiles(profiles: readonly DshProfileMeta[]): ProfilesSummary {
  const summary: ProfilesSummary = { total: profiles.length, web: 0, headless: 0, generic: 0, broken: 0, withNodeModules: 0, patchEntries: 0 }
  for (const p of profiles) {
    summary[p.shape] += 1
    if (p.issues.length > 0) summary.broken += 1
    if (p.hasNodeModules) summary.withNodeModules += 1
    summary.patchEntries += p.patchEntryCount
  }
  return summary
}

/**
 * 列表行摘要事实：行内**只显示计数**（bundle 层数 / patch 条目 / 依赖数 / 是否装了 node_modules），
 * 完整清单（有序 bundle 层、逐条依赖）只在详情弹窗里展开——行内铺开整串包名会把行撑爆
 * （实测 web 档案 13 个包名把元信息挤成窄列）。
 */
export interface ProfileRowFacts {
  bundles: number
  patchEntries: number
  deps: number
  hasNodeModules: boolean
}

export function profileRowFacts(profile: DshProfileMeta): ProfileRowFacts {
  return {
    bundles: profile.bundles.length,
    patchEntries: profile.patchEntryCount,
    deps: Object.keys(profile.dependencies).length,
    hasNodeModules: profile.hasNodeModules,
  }
}

/** 详情弹窗：bundle 层（**保持声明顺序** —— 顺序就是 patch 应用顺序，不可排序）。 */
export function bundleLines(profile: DshProfileMeta): string[] {
  return [...profile.bundles]
}

/** 详情弹窗：依赖行（按包名排序，`<name> <spec>`；spec 为空时只给包名）。 */
export function dependencyLines(profile: DshProfileMeta): string[] {
  return Object.entries(profile.dependencies)
    .map(([name, spec]) => (spec === '' ? name : `${name} ${spec}`))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * 副本缺依赖时的安装命令（DSH 自己的 `cannot resolve profile bundle` 报错指向的就是这条）。
 * 只作为**文本**给用户复制，本插件不去执行它。
 */
export function profileInstallCommand(name: string): string {
  return `dsh plugin --profile ${name} install`
}

/**
 * 复制档案时建议的副本名：`<name>-copy`，被占用则 `-copy-2`、`-copy-3`…（总长不超过 64 = checkProfileName 的上限）。
 * 超长前缀只截断前缀，避免用户一打开弹窗就吃 tooLong 校验。
 */
export function suggestCopyName(name: string, existingNames: readonly string[], maxLength = 64): string {
  const taken = new Set(existingNames)
  let index = 1
  for (;;) {
    const suffix = index === 1 ? '-copy' : `-copy-${index}`
    const prefix = name.slice(0, Math.max(1, maxLength - suffix.length))
    const candidate = `${prefix}${suffix}`
    if (!taken.has(candidate)) return candidate
    index += 1
  }
}

/**
 * 复制告警码 → i18n key。目前只有 `depsNotInstalled` 一类（副本没带 node_modules 却声明了依赖），
 * 返回类型写成字面量联合：新增告警码时这里会编译报错，逼着补文案而不是静默吞掉。
 */
export function copyWarningKey(warning: DshProfileCopyWarning): 'profiles.duplicate.warn.depsNotInstalled' {
  if (warning === 'depsNotInstalled') return 'profiles.duplicate.warn.depsNotInstalled'
  return 'profiles.duplicate.warn.depsNotInstalled'
}

/** 终端启动命令（非 web 形态没有浏览器界面，只能在终端用它拉起）。 */
export function restartCommand(name: string): string {
  return `dsh --profile ${name}`
}

/**
 * 能否「用该档案启动」独立实例：
 *  - 只有 web 形态有浏览器 GUI（headless/generic spawn 出去只会是用户看不见的进程）；
 *  - Desktop 独占档案（desktop）命令行根本起不来 —— 普通 dsh CLI 对它硬报
 *    'profile "desktop" is managed exclusively by the Electron application'。
 * 判据在 shared（宿主引擎共用同一份），这里只是视图层的名字。
 */
export function canLaunchProfile(profile: Pick<DshProfileMeta, 'name' | 'shape'>): boolean {
  if (isManagedProfileName(profile.name)) return false
  return isLaunchableShape(profile.shape)
}

/**
 * 「启动被挡下」的原因分类 —— UI 据此选文案：managed 档案**不能**给
 * `dsh --profile desktop` 这条命令（那条命令本身就是被拒绝的那条），只能指路桌面端应用。
 */
export type ProfileLaunchBlockReason = 'managed' | 'notWeb'

export function launchBlockReason(profile: Pick<DshProfileMeta, 'name' | 'shape'>): ProfileLaunchBlockReason {
  return isManagedProfileName(profile.name) ? 'managed' : 'notWeb'
}

/** 启动回执的界面语义：ready = 已就绪（有 URL）；pending = 进程起来了但还没探通/没抓到 URL。 */
export type ProfileLaunchState = 'ready' | 'pending'

export function launchState(result: DshProfileLaunchResult): ProfileLaunchState {
  return result.ready && result.url !== null ? 'ready' : 'pending'
}

/** 该档案是否有实例正在运行（台账 ∪ 心跳的合并视图；UI 的「启动 ↔ 停止」判据）。 */
export function isProfileRunning(running: readonly DshProfileRunningView[], name: string): boolean {
  return running.some((r) => r.name === name)
}

/** 取该档案的运行记录（没有 = undefined）；UI 用它显示端口/URL/来源。 */
export function runningRecordFor(running: readonly DshProfileRunningView[], name: string): DshProfileRunningView | undefined {
  return running.find((r) => r.name === name)
}

/**
 * 行内按钮该显示什么 —— 唯一判据，UI 不得各写一份。
 *  - `launch`：没有实例在跑 → 「启动」（非 web 形态点了给终端命令）；
 *  - `stop`：有实例在跑且不是自己 → 「停止」（owned = 本插件启动的；否则是别的实例，同样可停）；
 *  - `current`：就是当前这个实例 → 按钮禁用（停自己会死在响应途中，请关窗口/终端）。
 */
export type ProfileRowAction = 'launch' | 'stop' | 'current'

export function profileRowAction(name: string, running: readonly DshProfileRunningView[]): ProfileRowAction {
  const record = runningRecordFor(running, name)
  if (record === undefined) return 'launch'
  return record.current ? 'current' : 'stop'
}

/** 停止回执 → i18n key（强制杀掉要如实说，不能假装是优雅退出）。 */
export function stopResultKey(result: DshProfileStopOutcome): 'profiles.stop.done' | 'profiles.stop.forced' | 'profiles.stop.gone' {
  if (result === 'killed') return 'profiles.stop.forced'
  if (result === 'already-stopped') return 'profiles.stop.gone'
  return 'profiles.stop.done'
}

/** 启动告警码 → i18n key（保持 key 字面量类型，便于 t() 编译期校验）。 */
export function launchWarningKey(warning: DshProfileLaunchWarning): 'profiles.launch.warn.notReady' | 'profiles.launch.warn.urlNotFound' {
  return warning === 'notReady' ? 'profiles.launch.warn.notReady' : 'profiles.launch.warn.urlNotFound'
}

/** 形态 → i18n key（保持 key 字面量类型，便于 t() 编译期校验）。 */
export function shapeLabelKey(shape: DshProfileShape): 'profiles.shape.web' | 'profiles.shape.headless' | 'profiles.shape.generic' {
  if (shape === 'web') return 'profiles.shape.web'
  if (shape === 'headless') return 'profiles.shape.headless'
  return 'profiles.shape.generic'
}

/** issue → i18n key。 */
export function issueLabelKey(issue: DshProfileIssue): 'profiles.issue.manifestInvalid' | 'profiles.issue.patchTooLarge' {
  return issue === 'manifestInvalid' ? 'profiles.issue.manifestInvalid' : 'profiles.issue.patchTooLarge'
}

/** 时间戳（毫秒）→ 本地 `YYYY-MM-DD HH:mm`；null / 非法 = 空串。 */
export function formatProfileTime(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 字节数 → 人类可读（B / KB / MB，保留一位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
