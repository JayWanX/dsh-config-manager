/**
 * DSH profile 的**零依赖共享层**（host 与 client 双端复用）。
 *
 * 本文件不得 import 任何 node 模块：`src/client/` 的运行时 import 会把整条依赖链
 * 打进 lib/client.js，一旦带上 node 内置模块依赖，DSH loader 会拒绝加载整个插件。
 * 引擎（`dsh-profile-manager.ts`，用 node fs）与 UI 视图模型/React 壳都只从这里取
 * 类型、常量与纯函数。
 */

/** profile 形态：按 bundles 能力判定，不枚举界面（社区新形态无需改动即可归为 generic）。 */
export type DshProfileShape = 'web' | 'headless' | 'generic'
/** patch 层生命周期：live = 监视并热生效；startup = 只在启动时应用一次。 */
export type DshProfilePatchReload = 'live' | 'startup'

/** 一个 profile 的非致命问题（列表仍展示，便于用户删除损坏档案）。 */
export type DshProfileIssue = 'manifestInvalid' | 'patchTooLarge'

/** 列表行数据（全部非敏感：profile 定义本身不含秘密值）。 */
export interface DshProfileMeta {
  /** profile 名（= 目录名 = `dsh --profile <name>`） */
  name: string
  /** 绝对目录 */
  dir: string
  /** dsh.profile.bundles（有序 bundle 层） */
  bundles: string[]
  /** package.json dependencies（含 in-box bundle；原样展示） */
  dependencies: Record<string, string>
  shape: DshProfileShape
  patchReload: DshProfilePatchReload
  /** 是否已有 node_modules（树外插件是否装过） */
  hasNodeModules: boolean
  /** cordis.patch.yml 的 patch 条目数（以 `- ` 开头的行，启发式计数） */
  patchEntryCount: number
  /** cordis.patch.yml 字节数（不可读 = 0） */
  patchBytes: number
  /** 是否当前正在运行的 profile */
  isCurrent: boolean
  issues: DshProfileIssue[]
  /** package.json 的 mtime（毫秒）；不可读 = null */
  updatedAtMs: number | null
}

/** 详情：列表字段 + 原始文本（详情弹窗展示；过大时截断为 null）。 */
export interface DshProfileDetail extends DshProfileMeta {
  /** package.json 原文（不可读 = null） */
  manifest: string | null
  /** cordis.patch.yml 原文（不可读或过大 = null） */
  patch: string | null
}

/**
 * **由本插件启动、且仍在运行**的档案实例记录（落在 `<dataDir>/launches.json`，机器本地状态）。
 *
 * 为什么需要持久化：DSH 不认识「插件启动的实例」，停止/「哪个档案正跑着」只能由启动方自己记住；
 * 记录里存 pid 与端口，列表时按 pid 存活过滤（死记录顺手清掉），停止时按 pid 终止进程树。
 */
export interface DshProfileLaunchRecord {
  /** 档案名（= `dsh --profile <名>` 的那份） */
  name: string
  /** 新实例监听端口 */
  port: number
  /** 子进程 pid（Windows 上 taskkill /T 用它连带进程树） */
  pid: number
  /** 带进程 token 的认证 URL（当时抓到才有；重启浏览器后需要重开） */
  url: string | null
  /** 子进程日志文件绝对路径 */
  logFile: string
  /** 启动时刻（ISO 字符串，仅展示用） */
  startedAt: string
}

/**
 * 「用该档案启动」（独立实例）的结果。
 *
 * 为什么需要它：DSH 自身没有「默认 / 下次启动 profile」状态（profile 只由 `--profile` 决定），
 * 所以「切换档案」唯一真正可用的形态是**另起一个实例**——本结构就是那条路径的回执。
 */
export interface DshProfileLaunchResult {
  /** 被启动的档案名 */
  name: string
  /** 目前只支持 web 形态（有浏览器 GUI） */
  mode: 'web'
  /** 新实例监听的端口（自动挑的空闲端口） */
  port: number
  /** 带进程 token 的认证 URL（从子进程启动日志里抓；没抓到 = null，绝不臆造裸 URL） */
  url: string | null
  /** 子进程 pid（拿不到 = null） */
  pid: number | null
  /** 子进程日志文件绝对路径（未就绪时用户据此自查） */
  logFile: string
  /** HTTP 探活是否已就绪 */
  ready: boolean
  /** 非致命告警（UI 按码映射文案） */
  warnings: DshProfileLaunchWarning[]
}

/**
 * 「运行中实例」的**合并视图**（UI 唯一消费形状）：台账（本插件启动的） ∪ 心跳（任何在跑的实例）。
 *
 * 为什么必须合并：只认台账时，手动 `dsh web` 起来的实例对插件不可见 → 会在别的档案里被**再次启动**
 * （用户实测：从 web 启动 cmtest 后，在 cmtest 里还能再启动 web，同名多开）。心跳让每个实例互相可见。
 */
export interface DshProfileRunningView {
  name: string
  /** 实例 pid（停止用；缺心跳 pid 时为 null） */
  pid: number | null
  /** web 端口（心跳/台账里记的；未知 = null） */
  port: number | null
  /** 带 token 的认证 URL（**只有本插件启动的**才有：别人的 token 绝不落盘/回传） */
  url: string | null
  startedAt: string
  /** 本插件启动的（台账里有它）→ 本 UI 负责停止 */
  owned: boolean
  /** 就是当前正在跑本界面的这个实例（自己不能停自己） */
  current: boolean
}

/** 停止实例的结果码（gracious = 自己退了 / killed = 强杀 / already-stopped = 早就不在了）。 */
export type DshProfileStopOutcome = 'graceful' | 'killed' | 'already-stopped'

/** 启动回执里的非致命告警码。 */
export type DshProfileLaunchWarning = 'notReady' | 'urlNotFound'

/** 等待新实例就绪的上限（宿主探活默认值；UI 文案引用同一常量，避免两处各写一个数字）。 */
export const DSH_PROFILE_LAUNCH_TIMEOUT_MS = 20_000

/** GET /profiles 的响应负载（列表 + 当前运行 + 运行中实例 + 模板清单）。 */
export interface DshProfilesSnapshot {
  profiles: DshProfileMeta[]
  /** 当前运行中的 profile 名（宿主从 config/argv 解析） */
  current: string
  /** 在跑的实例（台账 ∪ 心跳；空数组 = 没有。UI 据此把「启动」换成「停止」/「当前运行」） */
  running: DshProfileRunningView[]
  /** 可选的起步模板（新建档案时用） */
  templates: DshProfileTemplate[]
}

/** 新建 profile 可选的官方模板（与 dsh-app-boot PROFILE_TEMPLATES 对齐，dsh 0.1.5-rc.1）。 */
export interface DshProfileTemplate {
  /** 模板 id（= 官方 `--from-default-profile <template>` 名；base = `dsh plugin` 的默认起步） */
  id: string
  bundles: string[]
  patchReload: DshProfilePatchReload
}

export const DSH_PROFILE_TEMPLATES: readonly DshProfileTemplate[] = [
  { id: 'base', bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' },
  { id: 'web', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  { id: 'headless', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' },
  { id: 'sdk', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  { id: 'sdk-minimal', bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
  { id: 'acp', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' },
]

/**
 * 不允许自建的保留名：shipped template 名（DSH 会自行按模板初始化，手建语义冲突）
 * + Electron 独占的 desktop（CLI 明确拒绝）。
 */
export const RESERVED_PROFILE_NAMES: readonly string[] = [
  'web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'desktop',
]

/** engine 错误码（用户可见文案由 UI 层按 code 映射 i18n；未知 code 才回退 message）。 */
export type DshProfileErrorCode =
  | 'invalidName' | 'reservedName' | 'exists' | 'notFound'
  | 'currentProfile' | 'unknownTemplate' | 'invalidNameInput'
  /** 该档案不是 web 形态（没有浏览器 GUI，spawn 出来只会是隐形进程） */
  | 'notLaunchable'
  /** 定位不到 dsh CLI（源码树 tsx 直启 / Electron 等非标准启动方式） */
  | 'launcherUnavailable'
  /** 子进程早退或没拿到 pid（消息里附日志尾部） */
  | 'launchFailed'
  /** 该档案已经有本插件启动的存活实例（先停止再启动；不允许同名多开） */
  | 'alreadyRunning'
  /** 该档案没有本插件记录的运行实例（停止时多半是已手动关掉） */
  | 'notRunning'
  /** 停止实例失败（进程杀不掉；消息里附原因） */
  | 'stopFailed'
  /** 该档案的实例正在运行 → 拒绝删除（否则实例会当场失去自己的文件） */
  | 'instanceRunning'
  /** 复制档案中途失败（目标目录已回滚，磁盘上不留半套副本） */
  | 'copyFailed'

/** 复制档案的非致命告警码（UI 按码映射文案，绝不静默）。 */
export type DshProfileCopyWarning =
  /** 副本没有 node_modules 却声明了依赖：直接启动会解析不到 bundle，必须先装依赖 */
  'depsNotInstalled'

/**
 * 「复制档案」的回执（UI 横幅用）：副本名 + 是否带 node_modules + 耗时 + 告警。
 *
 * 为什么把 warnings 一路带回前端：includeNodeModules=false 出来的副本**不能直接启动**
 * （bundles 里的树外插件解析不到），这条必须显式告诉用户并给出安装命令 —— 静默成功等于骗人。
 */
export interface DshProfileCopyResult {
  /** 副本档案名 */
  name: string
  /** 源档案名 */
  sourceName: string
  /** 是否一并复制了 node_modules */
  includeNodeModules: boolean
  /** 宿主侧实际耗时（毫秒；大档案含 node_modules 时可达数十秒） */
  durationMs: number
  warnings: DshProfileCopyWarning[]
}

/** 形态判定：按 bundles 是否包含官方表层 bundle。 */
export function classifyShape(bundles: readonly string[]): DshProfileShape {
  if (bundles.includes('@deepseek-ai/dsh-web-app')) return 'web'
  if (bundles.includes('@deepseek-ai/dsh-headless')) return 'headless'
  return 'generic'
}

/**
 * 该形态能否作为独立实例启动。
 *
 * 只有 web 形态有浏览器 GUI；headless 是「一次性任务」形态、generic（如 base 模板）根本没有
 * 应用表层——把这两类 spawn 出去只会得到一个用户看不见的进程，所以判据是硬性的，
 * UI 与宿主引擎共用这一份（避免两边各写一份后漂移）。
 */
export function isLaunchableShape(shape: DshProfileShape): boolean {
  return shape === 'web'
}

/**
 * 名字校验（与 DSH 的 resolveProfileDir 同规则）→ 返回错误码，合法则 null。
 * 纯函数，供 UI 输入校验与 host 侧二次校验共用（host 侧仍走 validateProfileName 兜底）。
 */
export function checkProfileName(name: string): DshProfileErrorCode | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'invalidNameInput'
  if (trimmed.length > 64) return 'invalidNameInput'
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return 'invalidNameInput'
  if (trimmed === '.' || trimmed === '..' || trimmed === 'node_modules') return 'invalidNameInput'
  if (RESERVED_PROFILE_NAMES.includes(trimmed)) return 'reservedName'
  return null
}
