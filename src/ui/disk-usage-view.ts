/**
 * 磁盘占用视图模型（框架无关纯函数层，node 可测）。
 *
 * 输入 = 宿主 `GET /disk-usage` 的报告（`src/core/disk-usage.ts` 的 DiskUsageReport），
 * 输出 = 界面要渲染的行/汇总（含**已翻译**的标签与说明）——组件只负责摆放，判定都在这里。
 *
 * 三条判定规则（都有单测钉住）：
 *  ① 读不到的子区**绝不显示 0 字节**，而是标 `unreadable`（未统计），否则用户会以为盘是空的；
 *  ② 只有 `policy === 'regenerable'` 的子区进「可立即清理」清单，且**不显示保留期**
 *     （它们本来就是随时可清，给一个「7 天后自动清理」的说明会误导）；
 *  ③ 定时备份（豁免前缀）不计入导出产物的「可回收」数字 —— 与宿主回收口径逐条一致。
 */
import type { DiskUsageArea, DiskUsageReport } from '../core/disk-usage.ts'
import type { UiT } from './i18n.ts'

/** 子区 → 字典键（标签 / 说明在字典里；本模块只挑键，不内嵌文案） */
const AREA_KEYS: Record<DiskUsageArea, { label: UiKey; desc: UiKey }> = {
  exports: { label: 'diskUsage.area.exports', desc: 'diskUsage.area.exportsDesc' },
  snapshots: { label: 'diskUsage.area.snapshots', desc: 'diskUsage.area.snapshotsDesc' },
  sync: { label: 'diskUsage.area.sync', desc: 'diskUsage.area.syncDesc' },
  marketCache: { label: 'diskUsage.area.marketCache', desc: 'diskUsage.area.marketCacheDesc' },
  marketWork: { label: 'diskUsage.area.marketWork', desc: 'diskUsage.area.marketWorkDesc' },
  tmp: { label: 'diskUsage.area.tmp', desc: 'diskUsage.area.tmpDesc' },
  logs: { label: 'diskUsage.area.logs', desc: 'diskUsage.area.logsDesc' },
  bootState: { label: 'diskUsage.area.bootState', desc: 'diskUsage.area.bootStateDesc' },
  migrationHistory: { label: 'diskUsage.area.migrationHistory', desc: 'diskUsage.area.migrationHistoryDesc' },
  transactions: { label: 'diskUsage.area.transactions', desc: 'diskUsage.area.transactionsDesc' },
  locks: { label: 'diskUsage.area.locks', desc: 'diskUsage.area.locksDesc' },
  vault: { label: 'diskUsage.area.vault', desc: 'diskUsage.area.vaultDesc' },
}

/** 字典键（`UiTextKey` 的窄别名，避免此处 import 整个 i18n 类型后与组件耦合） */
type UiKey = Parameters<UiT>[0]

/** 展示所需的最小注入面 */
export interface DiskUsageViewDeps {
  t: UiT
  /** 字节格式化（复用 `src/ui/report.ts` 的 formatBytes，保持全仓同口径） */
  formatBytes: (n: number) => string
}

/** 子区展示行 */
export interface DiskUsageRow {
  id: DiskUsageArea
  /** 子区名（已翻译） */
  label: string
  /** 一句话说明（已翻译） */
  desc: string
  /** 体积文本（未统计时为空串） */
  size: string
  /** 文件数文本 */
  files: string
  /** 目录读不到（界面显示「未统计」而不是 0） */
  unreadable: boolean
  policy: 'regenerable' | 'retained' | 'protected'
  /** 保留期文本（仅 retained 有值，形如「7 天」） */
  retention: string
  /** 按保留期已到回收条件的体积文本（仅 retained；无过期项为 null） */
  expired: string | null
  /** 是否属于「可立即清理」区（regenerable） */
  reclaimable: boolean
}

/** 可立即清理的动作（供界面按 _可用性_ 决定按钮 disabled —— 组件不再自行判断） */
export interface DiskUsageCleanAction {
  id: 'tmp-market' | 'expired-exports'
  label: string
  /** 该动作当前能释放多少（0 → 界面禁用它） */
  bytes: number
  /** 体积文本 */
  size: string
  /** 说明（已翻译；含保留期口径） */
  desc: string
}

/** 完整视图模型 */
export interface DiskUsageViewModel {
  summary: {
    total: string
    files: string
    dataDir: string
    /** 有子区读不到（界面顶部给一条「部分未统计」提示） */
    anyUnreadable: boolean
  }
  rows: DiskUsageRow[]
  clean: {
    /** 可立即清理区当前合计 */
    reclaimable: string
    /** 到回收期的导出产物合计 */
    expired: string
    actions: DiskUsageCleanAction[]
  }
}

/** 保留期 → 人类可读（7 天 / 24 小时；非整档按小时/分钟回落） */
export function formatRetention(ms: number, t: UiT): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('diskUsage.retention.none')
  const day = 24 * 60 * 60 * 1000
  const hour = 60 * 60 * 1000
  if (ms % day === 0) return t('diskUsage.retention.days', { count: String(ms / day) })
  if (ms % hour === 0) return t('diskUsage.retention.hours', { count: String(ms / hour) })
  return t('diskUsage.retention.minutes', { count: String(Math.max(1, Math.round(ms / 60000))) })
}

/**
 * 报告 → 视图模型。
 * `report` 为 null 时返回 null（界面显示加载态；调用方不必自己判空）。
 */
export function diskUsageViewModel(report: DiskUsageReport | null, deps: DiskUsageViewDeps): DiskUsageViewModel | null {
  if (report === null) return null
  const { t, formatBytes } = deps

  const rows: DiskUsageRow[] = []
  let anyUnreadable = false
  /**
   * 合计与「可回收」全部**由渲染出来的行现算**（不直接用报告里的聚合字段）。
   * 为什么：界面上的按钮数字必须与它旁边列出的行逐项对得上；一旦宿主聚合与明细漂移，
   * 用户会按「可释放 600 B」点下去却只释放 0 —— 宁可让两侧都基于同一份明细。
   */
  let totalBytes = 0
  let totalFiles = 0
  let reclaimableBytes = 0
  let expiredBytesTotal = 0
  for (const area of Object.keys(AREA_KEYS) as DiskUsageArea[]) {
    const entry = report.areas[area]
    if (entry === undefined) continue
    const keys = AREA_KEYS[area]
    if (entry.unreadable) anyUnreadable = true
    const expiredBytes = entry.expiredBytes ?? 0
    totalBytes += entry.sizeBytes
    totalFiles += entry.fileCount
    expiredBytesTotal += expiredBytes
    if (entry.policy === 'regenerable') reclaimableBytes += entry.sizeBytes
    rows.push({
      id: area,
      label: t(keys.label),
      desc: t(keys.desc),
      size: entry.unreadable ? '' : formatBytes(entry.sizeBytes),
      files: entry.unreadable ? '' : t('diskUsage.files', { count: String(entry.fileCount) }),
      unreadable: entry.unreadable,
      policy: entry.policy,
      retention: entry.policy === 'retained' && entry.retentionMs !== undefined ? formatRetention(entry.retentionMs, t) : '',
      expired: entry.policy === 'retained' && expiredBytes > 0 ? formatBytes(expiredBytes) : null,
      reclaimable: entry.policy === 'regenerable',
    })
  }

  const actions: DiskUsageCleanAction[] = [
    {
      id: 'tmp-market',
      label: t('diskUsage.clean.tmpMarket'),
      bytes: reclaimableBytes,
      size: formatBytes(reclaimableBytes),
      desc: t('diskUsage.clean.tmpMarketDesc'),
    },
    {
      id: 'expired-exports',
      label: t('diskUsage.clean.expiredExports'),
      bytes: expiredBytesTotal,
      size: formatBytes(expiredBytesTotal),
      desc: t('diskUsage.clean.expiredExportsDesc'),
    },
  ]

  return {
    summary: {
      total: formatBytes(totalBytes),
      files: t('diskUsage.files', { count: String(totalFiles) }),
      dataDir: report.dataDir,
      anyUnreadable,
    },
    rows,
    clean: {
      reclaimable: formatBytes(reclaimableBytes),
      expired: formatBytes(expiredBytesTotal),
      actions,
    },
  }
}
