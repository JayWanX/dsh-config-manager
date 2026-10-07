/**
 * 面板「会话布局归位 / 重复 id 隔离」写入口的**展示模型**（E2；框架无关纯函数，node 可测）。
 *
 * 数据来自宿主 E1 的两态路由 `POST /recovery/sessions/layout`（apply!==true = 只读计划）。
 * 本模块只做四件事，全部可单测：
 *  ① 从体检响应里挑出**这一档**的行（`blocksStartup` + `location-mismatch` / `duplicate-id`）；
 *  ② 计划 / 应用结果 → 逐条状态与文案键（**未执行 / 未归位 / 已回滚绝不呈现为成功**）；
 *  ③ 「重复 id 必须选定保留哪一份」的完整性判定与「能否提交」（组件据此禁用按钮，不在 JSX 里判）；
 *  ④ 结果计数（组件只插值，不自己数）。
 *
 * 零 node 依赖（硬约束）：src/ui 会被打进 **client bundle**，一旦出现对 node: 内建模块的引用，
 * DSH loader 会报 missed the module table，**整个插件不加载**（本项目实测过）。因此这里只
 * `import type`（编译期擦除），不 import 任何宿主实现。
 *
 * 安全口径（必须与宿主一致，不得在界面上说反）：本入口在 **DSH 运行时**执行，与离线 CLI
 * `dcm sessions repair --fix` 的「须先停 DSH」**不同** —— 靠门前置（SAFE MODE / mutation lock /
 * 逐目标无 session.lock + 不在静止期）+ **索引刷新必须成功** + 失败逐条回滚来兜底。
 * 面板还比 CLI 严两条：重复 id 未选定 keep 直接拒绝；keep 必须指向已扫描的副本之一。
 * 本入口**只做搬目录 + 隔离副本**，不做首帧 cwd 改写（那是离线 CLI 的 `--map` 路径）。
 */
import type { SessionHealthResponse } from './session-inventory-view.ts'
import type { SessionRepairActionKind, SessionRepairReason, SessionRepairSummary } from '../core/session-repair.ts'

/* --------------------------------------------------------------- 输入类型（与 E1 响应同构） */

/** E1 计划里的一条动作（**不含绝对路径**：身份 = `<fromProjectKey>/<sessionId>`）。 */
export interface SessionLayoutPlanItemView {
  unitId: string
  sessionId: string
  kind: SessionRepairActionKind
  fromProjectKey: string
  toProjectKey?: string
  /** 面板入口不支持路径映射 ⇒ 恒缺席（这里保留字段只为与宿主同形） */
  rewrite?: { from: string; to: string }
  reason: SessionRepairReason
  applies: boolean
}

export interface SessionLayoutPlanView {
  ok: boolean
  readOnly: boolean
  /** 会话根读不出来时的机器码（`sessions-root-unreadable`） */
  reason?: string
  summary: SessionRepairSummary
  actions: SessionLayoutPlanItemView[]
  needsAttention: boolean
  /** 有重复 id 但**还没选定保留哪一份**的 sessionId（面板据此要求用户选） */
  needsKeep: string[]
}

export interface SessionLayoutApplyItemView {
  unitId: string
  sessionId: string
  action: SessionRepairActionKind
  ok: boolean
  reason?: string
  /** 隔离去向（**相对** `<home>/sessions`；可直接渲染） */
  quarantineDir?: string
  /** 归位后的新身份 */
  movedUnitId?: string
  /** 失败后是否已成功回滚（true = 已回到原状态；false = **回滚也没成功**，危险态） */
  rolledBack?: boolean
  needsAttention?: boolean
}

export interface SessionLayoutApplyView {
  ok: boolean
  applied: number
  failed: number
  skipped: number
  results: SessionLayoutApplyItemView[]
  /** 整体未执行：`reindex-unavailable`（宿主没给索引刷新端口）/ `sessions-root-unreadable` */
  reason?: string
}

/**
 * 这条路由的两种响应（apply=false → 计划；apply=true → 执行结果）。
 * 判别：执行结果带 `results` 数组，计划带 `actions`/`needsKeep`。
 */
export type SessionLayoutResponse = SessionLayoutPlanView | SessionLayoutApplyView

/**
 * 面板要用的**调用端口**（E2）。
 *
 * 为什么不并进 `src/ui/types.ts` 的 `RecoveryPort`：该契约文件不在本任务范围内；
 * 组件侧用 `RecoveryPort & Partial<SessionLayoutPort>` 收口，注入的实现
 * （`src/client/recovery/recovery-api.ts` 的 `RecoveryApi`）一定实现本方法。
 */
export interface SessionLayoutPort {
  layoutRepairSessions(apply: boolean, keep?: Record<string, string>): Promise<SessionLayoutResponse>
}

/* ------------------------------------------------- ① 这一档的候选行（来自体检响应） */

/** 本入口覆盖的两类问题码（`blocksStartup` 里可布局修复的那一档）。 */
export const SESSION_LAYOUT_ISSUE_CODES: readonly string[] = ['location-mismatch', 'duplicate-id']

/** 一行候选（组件只渲染这些字段）。 */
export interface SessionLayoutCandidateView {
  unitId: string
  sessionId: string
  projectKey: string
  /** 命中的问题码（按 SESSION_LAYOUT_ISSUE_CODES 顺序；未知码不进这里） */
  issueCodes: string[]
  /** 该 id 可能有重复副本 ⇒ 预览后要用户选保留哪一份 */
  mayNeedKeep: boolean
}

/**
 * 从体检响应里挑出可布局修复的行（`blocksStartup` + 两类码之一）。
 *
 * 只挑 `blocksStartup`：这一档才是「DSH 会直接拒绝启动」的硬故障（`corrupt session log` /
 * `duplicate JSONL session id`），也正是本入口存在的理由。其余严重级不在此列。
 */
export function sessionLayoutCandidates(response: SessionHealthResponse | null): SessionLayoutCandidateView[] {
  if (response === null) return []
  return response.rows
    .filter((row) => row.severity === 'blocksStartup')
    .map((row) => {
      const codes = SESSION_LAYOUT_ISSUE_CODES.filter((code) => row.issues.some((issue) => issue.code === code))
      return {
        unitId: row.unitId,
        sessionId: row.sessionId,
        projectKey: row.projectKey,
        issueCodes: [...codes],
        mayNeedKeep: codes.includes('duplicate-id'),
      }
    })
    .filter((candidate) => candidate.issueCodes.length > 0)
}


/* ------------------------------------------------- ①b 入口可见性（扫过之后不许消失） */

/** 入口状态：`hidden` = 还没扫过（此时无从判断）；`empty` = 扫过但没有这一档问题；`ready` = 有候选或有计划/结果。 */
export type SessionLayoutSectionState = 'hidden' | 'empty' | 'ready'

/**
 * 面板入口的可见性判定。
 *
 * 为什么单独成一个纯函数：入口**只在有候选行时**渲染的话，本机没有这一档问题（真机 1218 单元全
 * `already-placed`）的用户**根本看不到这个功能** —— 发现性缺陷。口径：**扫过之后入口始终可见**
 * （用空态说明"本机没有这一档"），只有"还没扫过 + 手上没计划/结果"才隐藏；有计划/结果时更不能消失
 * （否则刚做完的逐条结果被吞掉）。
 */
export function sessionLayoutSectionState(input: {
  response: SessionHealthResponse | null
  plan: SessionLayoutPlanView | null
  applied: SessionLayoutApplyView | null
}): SessionLayoutSectionState {
  if (input.plan !== null || input.applied !== null) return 'ready'
  if (input.response === null) return 'hidden'
  return sessionLayoutCandidates(input.response).length > 0 ? 'ready' : 'empty'
}

/* ------------------------------------------------- ② 计划：可执行的条 + keep 选择 */

/** 计划里的一条展示行（键已是字典键，**不是**裸机器码）。 */
export interface SessionLayoutPlanRowView {
  unitId: string
  sessionId: string
  kind: SessionRepairActionKind
  kindKey: SessionLayoutKindKey
  reason: SessionRepairReason
  reasonKey: SessionLayoutReasonKey
  fromProjectKey: string
  toProjectKey: string | null
  applies: boolean
  /** 该条被「未选定 keep」挡住（kind=quarantine 且 applies=false） */
  blockedByKeepSelection: boolean
}

function kindKeyOf(kind: SessionRepairActionKind): SessionLayoutKindKey {
  return SESSION_LAYOUT_KIND_KEYS[kind] ?? SESSION_LAYOUT_KIND_KEYS.unknown
}

function planRowOf(item: SessionLayoutPlanItemView): SessionLayoutPlanRowView {
  return {
    unitId: item.unitId,
    sessionId: item.sessionId,
    kind: item.kind,
    kindKey: kindKeyOf(item.kind),
    reason: item.reason,
    reasonKey: sessionLayoutReasonKey(item.reason),
    fromProjectKey: item.fromProjectKey,
    toProjectKey: item.toProjectKey ?? null,
    applies: item.applies,
    blockedByKeepSelection: item.kind === 'quarantine' && !item.applies,
  }
}

/** 计划全部动作 → 展示行（顺序 = 计划顺序，稳定）。 */
export function sessionLayoutPlanRows(plan: SessionLayoutPlanView | null): SessionLayoutPlanRowView[] {
  if (plan === null) return []
  return plan.actions.map(planRowOf)
}

/**
 * 计划里**要渲染**的行：只剔除 `ok`（「位置已经正确」是噪音）。
 *
 * 保留三类：真的会落盘的条（move）、被 keep 选择挡住的隔离条（用户正要去选）、
 * 以及规划器判定「只报告」的条（`skip`：缺 cwd / 加锁 / 多 generation 不一致）——
 * 界面必须如实说出「这几条本入口不动」。
 */
export function sessionLayoutPlanDisplayRows(plan: SessionLayoutPlanView | null): SessionLayoutPlanRowView[] {
  return sessionLayoutPlanRows(plan).filter((row) => row.kind !== 'ok')
}

/** 计划里**将要执行**的条（move / rewrite-move / quarantine，且 applies）。 */
export function sessionLayoutPlanActionableRows(plan: SessionLayoutPlanView | null): SessionLayoutPlanRowView[] {
  return sessionLayoutPlanRows(plan).filter((row) => row.applies && row.kind !== 'ok' && row.kind !== 'keep')
}

/** 某重复 id 的可选副本（`unitId` 列表，顺序 = 计划顺序）。 */
export function sessionLayoutKeepCandidates(plan: SessionLayoutPlanView | null, sessionId: string): string[] {
  if (plan === null) return []
  const out: string[] = []
  for (const item of plan.actions) {
    if (item.sessionId !== sessionId) continue
    if (item.kind !== 'quarantine' && item.kind !== 'keep') continue
    if (!out.includes(item.unitId)) out.push(item.unitId)
  }
  return out
}

export interface SessionLayoutKeepState {
  /** 还缺选择的 sessionId（计划要求但没选 / 选了一个不在候选里的） */
  missing: string[]
  /** 选择完整性：没有缺失项即可提交（计划为 null 时恒 false —— 还没预览） */
  complete: boolean
  /** 每个重复 id 的可选项（组件直接渲染选择项） */
  candidates: Record<string, string[]>
}

/**
 * keep 选择完整性（**判定只此一处**）。
 *
 * 重复 id 必须由用户显式选定保留哪一份：未选 ⇒ 不可提交（宿主也会拒绝 `missing-keep`）；
 * 选了但不在该 id 的候选副本里 ⇒ 同样不可提交（宿主 `keep-not-a-candidate`）。
 */
export function sessionLayoutKeepState(plan: SessionLayoutPlanView | null, keep: Record<string, string>): SessionLayoutKeepState {
  if (plan === null) return { missing: [], complete: false, candidates: {} }
  const candidates: Record<string, string[]> = {}
  const missing: string[] = []
  for (const sessionId of plan.needsKeep) {
    const options = sessionLayoutKeepCandidates(plan, sessionId)
    candidates[sessionId] = options
    const picked = keep[sessionId]
    if (picked === undefined || !options.includes(picked)) missing.push(sessionId)
  }
  return { missing, complete: missing.length === 0, candidates }
}

/**
 * 能否提交执行（**判定只此一处**，组件只读这个布尔量）：
 * 有计划 + 计划本身可用（ok）+ keep 选择已完整。任一不满足即不可提交。
 */
export function sessionLayoutPlanSubmittable(plan: SessionLayoutPlanView | null, keep: SessionLayoutKeepState): boolean {
  return plan !== null && plan.ok && keep.complete
}

/** 计划里被「只报告」的条数（缺 cwd / 加锁 / 多 generation 不一致），界面必须如实说明。 */
export function sessionLayoutPlanSkippedCount(plan: SessionLayoutPlanView | null): number {
  if (plan === null) return 0
  return plan.actions.filter((item) => item.kind === 'skip').length
}

/* ------------------------------------------------- ③ 应用结果：逐条状态（诚实） */

/**
 * 逐条状态（**没有一个「未执行」态被算成成功**）：
 *  moved / quarantined / kept = 真的做成了；skipped = 规划器只报告（从没打算动）；
 *  failed = 被门或护栏拒绝、或执行失败；rolledBack = 失败但已回到原状态；
 *  rollbackFailed = 失败且**回滚也没成功**（危险态，必须最醒目）。
 */
export type SessionLayoutItemStatus = 'moved' | 'quarantined' | 'kept' | 'skipped' | 'failed' | 'rolledBack' | 'rollbackFailed'

/** 状态 → 徽章语义（与 Badge 四态一一对应；**只报不修/回滚**绝不给 ok）。 */
export function sessionLayoutStatusBadgeKind(status: SessionLayoutItemStatus): 'info' | 'ok' | 'warn' | 'error' {
  if (status === 'moved') return 'ok'
  if (status === 'quarantined') return 'ok'
  if (status === 'kept') return 'info'
  if (status === 'rolledBack') return 'warn'
  if (status === 'skipped') return 'warn'
  return 'error'
}

export interface SessionLayoutApplyItemDisplay {
  unitId: string
  sessionId: string
  status: SessionLayoutItemStatus
  statusKey: SessionLayoutStatusKey
  badgeKind: 'info' | 'ok' | 'warn' | 'error'
  reasonKey: SessionLayoutReasonKey | null
  quarantineDir: string | null
  movedUnitId: string | null
  needsAttention: boolean
}

/** 单条应用结果 → 状态（判定只此一处；组件不写这个分支）。 */
export function sessionLayoutItemStatus(item: SessionLayoutApplyItemView): SessionLayoutItemStatus {
  if (item.ok) {
    if (item.action === 'quarantine') return 'quarantined'
    if (item.action === 'keep') return 'kept'
    if (item.action === 'move' || item.action === 'rewrite-move') return 'moved'
    // 成功但类别未知：绝不当成「已归位」（宁可中性成功态也不谎称搬过）
    return 'kept'
  }
  if (item.rolledBack === false) return 'rollbackFailed'
  if (item.rolledBack === true) return 'rolledBack'
  if (item.action === 'skip') return 'skipped'
  return 'failed'
}

/** 应用结果 → 逐条展示项（组件只渲染）。 */
export function sessionLayoutApplyItems(result: SessionLayoutApplyView | null): SessionLayoutApplyItemDisplay[] {
  if (result === null) return []
  return result.results.map((item) => {
    const status = sessionLayoutItemStatus(item)
    return {
      unitId: item.unitId,
      sessionId: item.sessionId,
      status,
      statusKey: SESSION_LAYOUT_STATUS_KEYS[status],
      badgeKind: sessionLayoutStatusBadgeKind(status),
      reasonKey: item.reason === undefined ? null : sessionLayoutReasonKey(item.reason),
      quarantineDir: item.quarantineDir ?? null,
      movedUnitId: item.movedUnitId ?? null,
      needsAttention: item.needsAttention === true,
    }
  })
}

/** 逐条结果的计数（组件只插值，不自己数）。 */
export interface SessionLayoutResultCounts {
  moved: number
  quarantined: number
  kept: number
  skipped: number
  /** 失败且未回滚（原状态未知：宿主没回传 rolledBack） */
  failed: number
  /** 失败但已回到原状态 */
  rolledBack: number
  /** 失败且回滚也没成功（危险态） */
  rollbackFailed: number
  /** 失败总数（含已回滚 / 回滚失败；与宿主 `failed` 同口径） */
  failedTotal: number
}

export function sessionLayoutResultCounts(items: readonly SessionLayoutApplyItemDisplay[]): SessionLayoutResultCounts {
  let moved = 0
  let quarantined = 0
  let kept = 0
  let skipped = 0
  let failed = 0
  let rolledBack = 0
  let rollbackFailed = 0
  for (const item of items) {
    if (item.status === 'moved') moved += 1
    else if (item.status === 'quarantined') quarantined += 1
    else if (item.status === 'kept') kept += 1
    else if (item.status === 'skipped') skipped += 1
    else if (item.status === 'rolledBack') rolledBack += 1
    else if (item.status === 'rollbackFailed') rollbackFailed += 1
    else failed += 1
  }
  return { moved, quarantined, kept, skipped, failed, rolledBack, rollbackFailed, failedTotal: failed + rolledBack + rollbackFailed }
}

/**
 * 整体未执行的机器码 → 文案键（`reindex-unavailable` **不是**成功：
 * 宿主没给索引刷新端口时一条也不执行，界面必须如实说明「什么都没做」）。
 * 没有整体原因时返回 null（界面据此不渲染这一行）。
 */
export function sessionLayoutOverallReasonKey(reason: string | undefined): SessionLayoutReasonKey | null {
  if (reason === undefined || reason === '') return null
  return sessionLayoutReasonKey(reason)
}

/* ------------------------------------------------- 文案键（config-manager-recovery） */

/** 动作类别 → 文案键。 */
export const SESSION_LAYOUT_KIND_KEYS = {
  ok: 'sessions.layout.kind.ok',
  move: 'sessions.layout.kind.move',
  'rewrite-move': 'sessions.layout.kind.rewriteMove',
  skip: 'sessions.layout.kind.skip',
  keep: 'sessions.layout.kind.keep',
  quarantine: 'sessions.layout.kind.quarantine',
  unknown: 'sessions.layout.kind.unknown',
} as const

export type SessionLayoutKindKey = (typeof SESSION_LAYOUT_KIND_KEYS)[keyof typeof SESSION_LAYOUT_KIND_KEYS]

/** 逐条状态 → 文案键。 */
export const SESSION_LAYOUT_STATUS_KEYS = {
  moved: 'sessions.layout.status.moved',
  quarantined: 'sessions.layout.status.quarantined',
  kept: 'sessions.layout.status.kept',
  skipped: 'sessions.layout.status.skipped',
  failed: 'sessions.layout.status.failed',
  rolledBack: 'sessions.layout.status.rolledBack',
  rollbackFailed: 'sessions.layout.status.rollbackFailed',
} as const

export type SessionLayoutStatusKey = (typeof SESSION_LAYOUT_STATUS_KEYS)[keyof typeof SESSION_LAYOUT_STATUS_KEYS]

/** 计划原因（core 的 SessionRepairReason）+ 应用原因（E1 的 SessionLayoutApplyReason）+ 整体原因 → 文案键。 */
export const SESSION_LAYOUT_REASON_KEYS = {
  // 规划期（core/session-repair.ts）
  'no-cwd': 'sessions.layout.reason.noCwd',
  'inconsistent-generations': 'sessions.layout.reason.inconsistentGenerations',
  locked: 'sessions.layout.reason.locked',
  'already-placed': 'sessions.layout.reason.alreadyPlaced',
  'needs-move': 'sessions.layout.reason.needsMove',
  'needs-rewrite-move': 'sessions.layout.reason.needsRewriteMove',
  'duplicate-id': 'sessions.layout.reason.duplicateId',
  // 执行期（E1 session-layout-repair-service.ts）
  busy: 'sessions.layout.reason.busy',
  'missing-keep': 'sessions.layout.reason.missingKeep',
  'keep-not-a-candidate': 'sessions.layout.reason.keepNotACandidate',
  'target-exists': 'sessions.layout.reason.targetExists',
  'quarantine-exists': 'sessions.layout.reason.quarantineExists',
  'rewrite-failed': 'sessions.layout.reason.rewriteFailed',
  'missing-target-key': 'sessions.layout.reason.missingTargetKey',
  'move-failed': 'sessions.layout.reason.moveFailed',
  'reindex-failed': 'sessions.layout.reason.reindexFailed',
  'not-found': 'sessions.layout.reason.notFound',
  'io-error': 'sessions.layout.reason.ioError',
  // 整体未执行
  'reindex-unavailable': 'sessions.layout.reason.reindexUnavailable',
  'sessions-root-unreadable': 'sessions.layout.reason.sessionsRootUnreadable',
  unknown: 'sessions.layout.reason.unknown',
} as const

export type SessionLayoutReasonKey = (typeof SESSION_LAYOUT_REASON_KEYS)[keyof typeof SESSION_LAYOUT_REASON_KEYS]

/** 机器可读原因 → 文案键（**未知一律回落 unknown，绝不把裸码渲染出去**）。 */
export function sessionLayoutReasonKey(reason: string | undefined): SessionLayoutReasonKey {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SESSION_LAYOUT_REASON_KEYS, reason)) {
    return SESSION_LAYOUT_REASON_KEYS[reason as keyof typeof SESSION_LAYOUT_REASON_KEYS]
  }
  return SESSION_LAYOUT_REASON_KEYS.unknown
}
