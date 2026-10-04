/**
 * 「会话体检」面板的**展示模型**（T5；框架无关纯函数，node 可测）。
 *
 * 数据来自只读路由 `GET /recovery/sessions`（宿主扫本机会话库 → core 分类器出结论）。
 * 本模块只做三件事，全部可单测：
 *  ① 行 → 可渲染的展示行（严重级徽章语义 / 版本 / 归属 / 大小 / 时间 / 可复制命令）；
 *  ② 摘要 → 一行可读的计数（**必须能说清「未检查」与「未验证」**）；
 *  ③ 空态 / 截断 / 只读提示的判定 —— 界面据此渲染，不在组件里写业务判断。
 *
 * 「绝不猜」：缺字段一律不显示该列（不填 0、不写「未知」当结论）。
 */
import type { SessionHealthSeverity } from '../core/session-health.ts'

/** 路由返回的一行（与宿主 session-health 的 SessionHealthRow 同构；此处只取展示所需）。 */
export interface SessionHealthRowView {
  unitId: string
  sessionId: string
  projectKey: string
  severity: SessionHealthSeverity
  issues: { code: string; severity: SessionHealthSeverity; detail?: string }[]
  version?: number
  cwd?: string
  origin?: string
  sizeBytes?: number
  mtimeMs?: number
}

/** 路由响应（`GET /recovery/sessions`）。 */
export interface SessionHealthResponse {
  ok: boolean
  readOnly: boolean
  sessionsDir: string
  sessionsDirExists: boolean
  targetFormatVersion: number | null
  summary: {
    total: number
    bySeverity: Record<SessionHealthSeverity, number>
    structurallyChecked: number
    deepVerified: number
    deepUnverified: number
    untested: number
    unreadableEntries: number
  }
  rows: SessionHealthRowView[]
  /** 被 limit 截断掉的条数 */
  truncated: number
  nextSteps: { commands: { command: string; reason: string }[]; notes: string[] }
  /** T8：本机可回滚的修复（台账；宿主保证**不含任何绝对路径**） */
  repairs?: SessionRepairEntry[]
  /** 台账读不出来时的事实（界面如实提示，不谎报「没有可回滚的修复」） */
  repairsError?: string
}

/** 一次修复的台账记录（宿主回传；只有标识与计数，没有目录）。 */
export interface SessionRepairEntry {
  repairId: string
  unitId: string
  sessionId: string
  projectKey?: string
  logName?: string
  backupName?: string
  /** 修复时刻（epoch ms） */
  at?: number
  droppedRows?: number
  bytesBefore?: number
  bytesAfter?: number
  /** 已回滚时刻（epoch ms；缺省 = 未回滚） */
  rolledBackAt?: number
}

/** 计划里的一步动作（与宿主 SessionRepairAction 同构；界面只渲染）。 */
export interface SessionRepairActionView {
  code: string
  detail: string
  lossy: boolean
  rows: number
}

/** 修复预览 / 应用结果（POST /recovery/sessions/repair）。 */
export interface SessionRepairResult {
  ok: boolean
  /** 机器可读原因（文案由界面映射；未知原因回退通用文案） */
  reason?: string
  unitId: string
  sessionId?: string
  logName?: string
  droppedRows?: number
  bytesBefore?: number
  bytesAfter?: number
  /** 应用时必须回传的指纹（预览给出） */
  expect?: { size: number; mtimeMs: number }
  /** busy 时的最近写入时间（epoch ms） */
  mtimeMs?: number
  repairId?: string
  backupName?: string
  /** 修复发生了但台账没记上（回滚入口不可用；备份文件仍在） */
  ledgerRecorded?: boolean
  /** 计划里的动作清单（预览也回传：界面据此逐条说明「将要做什么」） */
  actions?: SessionRepairActionView[]
  /** 计划含**有损**动作（截断）：应用时必须显式放行 */
  lossy?: boolean
  /** 保留的行数 */
  keptRows?: number
}

/** 回滚结果（POST /recovery/sessions/rollback）。 */
export interface SessionRepairRollbackResult {
  ok: boolean
  reason?: string
  repairId: string
  unitId?: string
  sessionId?: string
}

/**
 * 应用内**可修**的问题码（与执行器 planSessionLogRepair 的三类动作同源）：
 *  重放重复行 / 可证明的合成收尾块（零损失）；seq 空洞 / 不可解析行（截断，**有损**，需显式确认）。
 * 其余码（撕裂尾帧自愈、格式超前、缺工作区/缺父对话…）一律不给应用内入口。
 */
export const SESSION_REPAIRABLE_ISSUE_CODES: ReadonlySet<string> = new Set([
  'replay-duplicate-rows',
  'synthetic-closer',
  'seq-gap',
  'unparsable-event',
])

/** 单个问题码是否可应用内修复。 */
export function sessionIssueRepairable(code: string): boolean {
  return SESSION_REPAIRABLE_ISSUE_CODES.has(code)
}

/** 严重级 → 徽章语义（与 Badge 的四态一一对应；DESIGN.md 先想语义再选 kind）。 */
export function sessionSeverityBadgeKind(severity: SessionHealthSeverity): 'info' | 'ok' | 'warn' | 'error' {
  if (severity === 'blocksStartup') return 'error'
  if (severity === 'unloadable') return 'error'
  if (severity === 'nextRequestFails') return 'warn'
  if (severity === 'invisible') return 'warn'
  return 'ok'
}

/** 严重级 → 面板文案键（config-manager-recovery 命名空间）。 */
export const SESSION_SEVERITY_KEYS = {
  blocksStartup: 'sessions.severity.blocksStartup',
  unloadable: 'sessions.severity.unloadable',
  nextRequestFails: 'sessions.severity.nextRequestFails',
  invisible: 'sessions.severity.invisible',
  ok: 'sessions.severity.ok',
} as const

/** 展示行（组件只渲染这些字段）。 */
export interface SessionHealthDisplayRow {
  unitId: string
  /** 会话目录名（列表主键） */
  sessionId: string
  projectKey: string
  severity: SessionHealthSeverity
  severityKey: (typeof SESSION_SEVERITY_KEYS)[SessionHealthSeverity]
  badgeKind: 'info' | 'ok' | 'warn' | 'error'
  /** 问题码列表（文案由界面映射；顺序 = 由重到轻） */
  issueCodes: string[]
  /** 版本徽章文本（缺省 = 不显示） */
  versionText: string | null
  /** 归属工作区目录键（缺省 = 不显示） */
  projectKeyText: string | null
  /** 子代理会话标记 */
  subagent: boolean
  /** 体积文本（如 `1.2 MiB`；缺省 = 不显示） */
  sizeText: string | null
  /** 最近活动时间（毫秒；缺省 = 不显示） */
  mtimeMs: number | null
  /** T8：本行有「重放重复行」——应用内可零损失修复的那一类 */
  repairable: boolean
}

/** 字节 → 人类可读体积（与磁盘占用卡同一套阈值，避免两处口径）。 */
export function formatSessionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${mib.toFixed(1)} MiB`
  return `${(mib / 1024).toFixed(2)} GiB`
}

/** 行 → 展示行（纯映射；缺字段不填假值）。 */
/** 严重级是否需要处理（ok = 不需要）。 */
function needsAttention(severity: SessionHealthSeverity): boolean {
  return severity !== 'ok'
}

/**
 * 行列表：**默认只显示「需要处理」的行**（非 ok），
 * 但**可应用内修复的行一律保留**（哪怕它当前被判为 ok —— 那说明判据分叉，宁可显示也不藏）。
 * 全绿时返回空列表，界面据此渲染空态；「共 N 条」仍在摘要里如实给出总数。
 */
export function sessionHealthRows(response: SessionHealthResponse | null): SessionHealthDisplayRow[] {
  if (response === null) return []
  const all = response.rows.map((row) => ({
    unitId: row.unitId,
    sessionId: row.sessionId,
    projectKey: row.projectKey,
    severity: row.severity,
    severityKey: SESSION_SEVERITY_KEYS[row.severity],
    badgeKind: sessionSeverityBadgeKind(row.severity),
    issueCodes: row.issues.map((issue) => issue.code),
    versionText: row.version !== undefined ? 'v' + String(row.version) : null,
    projectKeyText: row.projectKey !== '' ? row.projectKey : null,
    subagent: row.origin === 'subagent',
    sizeText: row.sizeBytes !== undefined ? formatSessionBytes(row.sizeBytes) : null,
    mtimeMs: row.mtimeMs ?? null,
    // 应用内修复只做「能从字节证明」的三类（与执行器 planSessionLogRepair 同源判据）
    repairable: row.issues.some((issue) => sessionIssueRepairable(issue.code)),
  }))
  return all.filter((row) => row.repairable || needsAttention(row.severity))
}

/** 这一档严重级是否需要处理（ok = 不需要；与 healthNeedAttention 同口径）。 */
export function sessionSeverityNeedsAttention(severity: SessionHealthSeverity): boolean {
  return needsAttention(severity)
}

/** 摘要展示模型。 */
export interface SessionHealthSummaryView {
  /** 需要处理的总条数（非 ok） */
  needsAttention: number
  /** 按严重级（含 ok） */
  bySeverity: Record<SessionHealthSeverity, number>
  total: number
  /** **必须显示**：未做深度校验的条数（把「没检查」说成「没问题」是本轮要消灭的谎报） */
  deepUnverified: number
  deepVerified: number
  /** 因上限未体检的会话数 */
  untested: number
  /** 读取失败的目录/文件数 */
  unreadableEntries: number
  /** 本机 DSH 会话格式版本（null = 读不到 → 不做「超前」判定） */
  targetFormatVersion: number | null
  /** 是否一条问题都没有（空态判定） */
  allHealthy: boolean
  /** 返回行里**可应用内零损失修复**的条数（重放重复行；界面据此决定给不给「修复」入口） */
  repairable: number
  /** 因「只显示有问题的对话」而被隐藏的正常会话数（界面必须说明，绝不静默少显示） */
  hiddenHealthy: number
}

export function sessionHealthSummaryView(response: SessionHealthResponse | null): SessionHealthSummaryView | null {
  if (response === null) return null
  const by = response.summary.bySeverity
  const needsAttention = by.blocksStartup + by.unloadable + by.nextRequestFails + by.invisible
  return {
    needsAttention,
    bySeverity: { ...by },
    total: response.summary.total,
    deepUnverified: response.summary.deepUnverified,
    deepVerified: response.summary.deepVerified,
    untested: response.summary.untested,
    unreadableEntries: response.summary.unreadableEntries,
    targetFormatVersion: response.targetFormatVersion,
    allHealthy: response.summary.total === 0 ? true : needsAttention === 0,
    // 只数**返回行**里的可修复条数（没回传的行界面看不到，也就不该给它入口）
    repairable: response.rows.filter((row) => row.issues.some((issue) => sessionIssueRepairable(issue.code))).length,
    hiddenHealthy: response.rows.filter((row) => row.severity === 'ok' && !row.issues.some((issue) => sessionIssueRepairable(issue.code))).length,
  }
}

/** 空态判定：没有会话数据（不是错误）。 */
export function sessionHealthEmpty(response: SessionHealthResponse | null): boolean {
  return response !== null && response.summary.total === 0
}

/** 截断提示（>0 时必须显示）。 */
export function sessionHealthTruncated(response: SessionHealthResponse | null): number {
  return response?.truncated ?? 0
}

/**
 * 每行的「复制修复命令」（离线）。
 *
 * 为什么仍然保留：应用内修复（T8）只覆盖「重放重复行」这一零损失类；其它损坏类别
 * （seq 空洞 / 不可解析行 / 容器非法 / 格式超前 …）仍然只能离线处理，所以这条出路必须一直在。
 * 按问题码精细生成命令会给人「点一下就能修」的错觉 —— 那是错的。
 */
export function sessionRepairCommands(): { command: string; reason: string }[] {
  return [
    { command: 'dsh-config-manager sessions doctor --json', reason: 'diagnose' },
    { command: 'dsh-config-manager sessions repair', reason: 'preview' },
    { command: 'dsh-config-manager sessions repair --fix', reason: 'apply' },
  ]
}

/** 修复失败/提示原因 → 文案键（config-manager-recovery 命名空间；未知原因回退通用文案）。 */
export const SESSION_REPAIR_REASON_KEYS = {
  'unknown-unit': 'sessions.repair.reason.unknownUnit',
  'not-found': 'sessions.repair.reason.notFound',
  locked: 'sessions.repair.reason.locked',
  busy: 'sessions.repair.reason.busy',
  changed: 'sessions.repair.reason.changed',
  'repair-not-found': 'sessions.repair.reason.repairNotFound',
  'already-rolled-back': 'sessions.repair.reason.alreadyRolledBack',
  unavailable: 'sessions.repair.reason.unavailable',
  unreadable: 'sessions.repair.reason.unreadable',
  'corrupt-container': 'sessions.repair.reason.corruptContainer',
  'torn-tail': 'sessions.repair.reason.tornTail',
  'invalid-header': 'sessions.repair.reason.invalidHeader',
  'nothing-to-fix': 'sessions.repair.reason.nothingToFix',
  'lossy-required': 'sessions.repair.reason.lossyRequired',
  'verification-refused': 'sessions.repair.reason.verificationRefused',
  'write-failed': 'sessions.repair.reason.writeFailed',
  'postcheck-failed': 'sessions.repair.reason.postcheckFailed',
  'backup-invalid': 'sessions.repair.reason.backupInvalid',
  unknown: 'sessions.repair.reason.unknown',
} as const

export type SessionRepairReasonKey = (typeof SESSION_REPAIR_REASON_KEYS)[keyof typeof SESSION_REPAIR_REASON_KEYS]

/** 机器可读原因 → 字典键（未知原因一律回退 unknown，**绝不**把裸枚举渲染出去）。 */
export function sessionRepairReasonKey(reason: string | undefined): SessionRepairReasonKey {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SESSION_REPAIR_REASON_KEYS, reason)) {
    return SESSION_REPAIR_REASON_KEYS[reason as keyof typeof SESSION_REPAIR_REASON_KEYS]
  }
  return SESSION_REPAIR_REASON_KEYS.unknown
}

/** 台账记录 → 展示行（跳过没有 repairId 的坏记录；最近在前）。 */
export interface SessionRepairEntryView {
  repairId: string
  unitId: string
  sessionId: string
  logName: string | null
  backupName: string | null
  at: number | null
  droppedRows: number
  rolledBack: boolean
}

export function sessionRepairEntries(response: SessionHealthResponse | null): SessionRepairEntryView[] {
  const raw = response?.repairs
  if (raw === undefined) return []
  return raw
    .filter((entry): entry is SessionRepairEntry => typeof entry?.repairId === 'string' && entry.repairId !== '')
    .map((entry) => ({
      repairId: entry.repairId,
      unitId: entry.unitId,
      sessionId: entry.sessionId,
      logName: entry.logName ?? null,
      backupName: entry.backupName ?? null,
      at: entry.at ?? null,
      droppedRows: entry.droppedRows ?? 0,
      rolledBack: entry.rolledBackAt !== undefined,
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** 面板状态（loading / error / ready）的判定 —— 组件只映射，不自己判。 */
export type SessionHealthPhase = 'idle' | 'loading' | 'ready' | 'error'

export function sessionHealthPhase(state: {
  loading: boolean
  error: string | null
  response: SessionHealthResponse | null
}): SessionHealthPhase {
  if (state.error !== null) return 'error'
  if (state.loading) return 'loading'
  return state.response === null ? 'idle' : 'ready'
}
