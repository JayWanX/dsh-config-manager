/**
 * 缓存自动清理（cache-cleaner）
 *
 * 只清理「可重建 / 一次性」的缓存与临时文件，绝不触碰用户数据与安全网：
 *   - tmpDir 下**整块**可回收的暂存产物（upload-* / market-* / publish-* / decrypted-* /
 *     export-plain-* 等导入/导出/市场暂存、SyncEngine 遗留的 dsh-sync-pull-* 临时目录、
 *     以及原子写半成品 `*.tmp` / `.dshcm.*`）——保留期内文件不删
 *     （自动清理沿用保留期，供「刷新恢复导入」等跨请求流程继续消费；手动清理忽略保留期）；
 *   - exportsDir 下过期的导出产物 `.zip`（导出时用户已通过浏览器下载/另存到本地，
 *     host 端只是暂存副本，按保留期回收）；
 *   - market/cache/<url-hash>/（市场 index 缓存与条目缓存，refresh/download 可重建）；
 *   - market/work/<url-hash>/（市场 git 只读工作副本，readIndex 时自动重新 clone）。
 *
 * 保留不动（属用户数据/安全网，由各自 UI 或业务逻辑管理）：
 *   - snapshots/（导入前强制快照）、sync/（同步配置/历史/git 工作副本）。
 *
 * 实现：与 DSH 运行时解耦的纯函数（node:fs/promises），保留期与时间源参数化，
 * 任何单项失败均不阻断其余清理（尽力而为），返回清理报告供宿主日志。
 * 健康性：删除前按 mtime 判定超期（now - mtime > retention），stat 失败保守不删。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import { isENOENT } from '../utils/guards.ts'

/** 临时文件缺省保留期：24 小时（覆盖跨会话「刷新恢复导入」窗口，昨天的残留自动清） */
export const TMP_RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000

/** 导出产物缺省保留期：7 天（导出时用户已通过浏览器下载/另存到本地，host 端副本按周回收） */
export const EXPORTS_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/** 市场缓存/工作副本缺省保留期：7 天（重建成本 = 一次网络拉取） */
export const MARKET_RETENTION_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 原子写半成品判据（**单一事实源**，cross-F1）。
 *
 * 这些名字只可能来自「写盘 → rename」中途被强杀留下的孤儿：`src/utils/atomic-write.ts` 产出
 * `.dshcm.<base>.<pid>.<rand>.tmp`，导出/打包侧产出 `<base>.zip.tmp-hso-<rand>`。
 * 它们没有任何读取路径（`journal.ts` 的 isJournalBasename 显式排除 TMP_PREFIX），
 * 因此在**可回收分区**里发现它们就必须清掉 —— 否则 /disk-usage 把整块分区算进「可回收」，
 * 而清理按钮永远删不掉它们（界面数字与按钮效果长期不一致）。
 */
export function isAtomicTempName(name: string): boolean {
  return name.startsWith('.dshcm.') || name.endsWith('.tmp') || name.includes('.tmp-hso-')
}

export interface CacheCleanupOptions {
  /** 临时目录（$DSH_HOME/dsh-config-manager/tmp） */
  tmpDir: string
  /** 导出产物目录（$DSH_HOME/dsh-config-manager/exports） */
  exportsDir: string
  /** 市场缓存根（$DSH_HOME/dsh-config-manager/market/cache） */
  marketCacheRoot: string
  /** 市场工作副本根（$DSH_HOME/dsh-config-manager/market/work） */
  marketWorkRoot: string
  /** 临时文件保留期（缺省 24h） */
  tmpRetentionMs?: number
  /** 导出产物保留期（缺省 7 天） */
  exportsRetentionMs?: number
  /**
   * exports 清理豁免的文件名前缀（如定时备份的 dsh-config-auto-）：
   * 匹配该前缀的 ZIP 不按保留期回收 —— 其生命周期由业务保留策略管理
   * （BackupScheduler.pruneAutoBackups「保留最近 N 个」）。缺省不豁免。
   */
  exportsExemptPrefix?: string
  /** 市场缓存/工作副本保留期（缺省 7 天） */
  marketRetentionMs?: number
  /**
   * true = 忽略保留期，**立即整块清空可重建的缓存**（tmp / market cache / market work）；
   * exports 仍只按保留期回收（导出产物是用户可能还要下载/导入的备份文件，绝不「立即清空」）。
   * 缺省 false —— 定时自动清理必须沿用保留期（保留窗口内的文件还要供跨请求流程消费）。
   */
  includeRecent?: boolean
  /**
   * 只跑这些分区（缺省 = 全部四个）。手动清理必须传 —— 用户只勾了「清理缓存」时
   * **导出产物一个都不能碰**（即使有过期项；否则界面说「只清缓存」却删了他的备份）。
   */
  sections?: readonly CacheCleanupSection[]
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number
}

/** 清理分区（与 disk-usage 的子区 id 对齐；presence 口径见 cachedSections） */
export type CacheCleanupSection = 'tmp' | 'exports' | 'marketCache' | 'marketWork'

export interface CacheCleanupResult {
  /** 删除条目数（文件 + 目录） */
  removed: number
  /** 释放字节数（仅被删文件的 size 累计；目录删除统计为 0） */
  freedBytes: number
  /**
   * 释放字节数（含目录递归：目录按删除前递归统计）。
   * 与 freedBytes 并存 —— freedBytes 逐字保持旧语义（避免历史调用方/日志口径漂移），
   * 界面用本字段（删整块缓存目录时 freedBytes 恒为 0，展示会误导）。
   */
  freedBytesRecursive: number
  /** 单项失败数（不影响主流程） */
  errors: number
  /** 每条删除记录（相对 dataDir 的描述 + 字节数），供日志/审计 */
  detail: string[]
  /** 本次实际清理过的分区（只含**确实执行**清理的分区；供路由把结果映射回界面子区） */
  sections: CacheCleanupSection[]
}

/** 新建空结果（导出给调用方拼装「无操作」回执，保证形状单点） */
export function emptyCleanupResult(): CacheCleanupResult {
  return { removed: 0, freedBytes: 0, freedBytesRecursive: 0, errors: 0, detail: [], sections: [] }
}

/** 目录是否超期（stat 失败保守视为未超期 → 不删） */
async function isExpired(target: string, retentionMs: number, nowMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(target)
    return nowMs - st.mtimeMs > retentionMs
  } catch {
    return false
  }
}

/**
 * 删除前递归统计一个条目的字节数（仅用于「释放了多少」的回执）。
 * 不跟随符号链接；读不到的条目不计数（宁可少报，不谎报）。
 */
async function measureBytes(target: string, depth = 0): Promise<number> {
  if (depth > 48) return 0
  let st: Stats
  try {
    st = await fs.lstat(target)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let total = 0
  let entries: Dirent[]
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    total += await measureBytes(path.join(target, entry.name), depth + 1)
  }
  return total
}

/** 删除一个文件/目录并计入报告；目录按删除前递归体积计入 freedBytesRecursive（freedBytes 保持旧语义） */
async function removeEntry(target: string, label: string, result: CacheCleanupResult): Promise<void> {
  try {
    let fileSize = 0
    let totalSize = 0
    try {
      const st = await fs.lstat(target)
      if (st.isFile()) {
        fileSize = st.size
        totalSize = st.size
      } else if (st.isDirectory()) {
        totalSize = await measureBytes(target)
      }
    } catch {
      /* stat 失败仍尝试删除（rm 自己会兜底不存在） */
    }
    await fs.rm(target, { recursive: true, force: true })
    result.removed += 1
    result.freedBytes += fileSize
    result.freedBytesRecursive += totalSize
    result.detail.push(`${label} (${totalSize} bytes)`)
  } catch {
    result.errors += 1
  }
}

/**
 * 执行一次缓存清理（幂等；可重复调用）。
 *
 * 缺省（`includeRecent` 未开）：只清理**超期**（超过保留期）的缓存/临时条目，其余一律保留 ——
 * 定时自动清理必须走这条（保留窗口内的文件还要供「刷新恢复导入/下载」跨请求流程消费）。
 * `includeRecent: true`（用户点「立即清理」）：tmp / market cache / market work **忽略保留期整块清空**
 * （都可重建/可重新下载），exports **仍只按保留期回收** —— 导出产物是用户可能还要下载/导入的备份文件。
 */
export async function cleanupCaches(opts: CacheCleanupOptions): Promise<CacheCleanupResult> {
  const nowMs = (opts.now ?? Date.now)()
  const tmpRetentionMs = opts.tmpRetentionMs ?? TMP_RETENTION_DEFAULT_MS
  const exportsRetentionMs = opts.exportsRetentionMs ?? EXPORTS_RETENTION_DEFAULT_MS
  const marketRetentionMs = opts.marketRetentionMs ?? MARKET_RETENTION_DEFAULT_MS
  const includeRecent = opts.includeRecent === true
  const wanted = opts.sections ?? ['tmp', 'exports', 'marketCache', 'marketWork']
  const result = emptyCleanupResult()

  // 1) tmpDir：**整块可回收**（cross-F1）。
  //    为什么是「整块」而不是只认 *.zip / dsh-sync-pull-*：/disk-usage 对 tmp 的 policy 是
  //    regenerable，可回收数字 = 整个目录递归 sizeBytes（src/core/disk-usage.ts 的
  //    `reclaimableBytes` 累计），手动清理的既定语义也是「可重建区忽略保留期整块清掉」
  //    （AGENTS.md 磁盘体检硬边界 ③：tmp 现在就能整块清掉）。此前只删两类名字，于是中断导出
  //    残留的原子写半成品（`export-plain-*.zip.tmp-hso-*`）既被算进「可回收」又永远删不掉，
  //    且 removed===0 让前端提前返回 —— 用户连失败提示都看不到。
  //    保留期语义不变：自动清理只删超期项，`includeRecent`（手动）忽略保留期。
  if (wanted.includes('tmp')) {
  try {
    const entries = await fs.readdir(opts.tmpDir, { withFileTypes: true })
    result.sections.push('tmp')
    for (const entry of entries) {
      const target = path.join(opts.tmpDir, entry.name)
      if (includeRecent || await isExpired(target, tmpRetentionMs, nowMs)) {
        await removeEntry(target, `tmp/${entry.name}`, result)
      }
    }
  } catch (err) {
    // tmpDir 不存在/不可读 → 跳过（尽力而为）
    // e2e-F3：可选目录**不存在**（ENOENT）不是失败 —— 全新安装时 market/cache、market/work 尚未创建，
    // 此前一律 +1 会让「本次真删了文件」的清理被前端渲染成红色「清理失败 N 项」（detail 为空、无可操作信息）。
    // 真正的读失败（EACCES/EBUSY/…）仍必须计入 errors（「读不到 ≠ 没有」） 。
    if (!isENOENT(err)) result.errors += 1
  }
  }

  // 2) exportsDir：过期的导出产物 .zip（导出时已下载/另存到本地，host 端副本按保留期回收）。
  //    豁免前缀（定时备份产物）跳过 —— 由备份保留策略管理，不按天回收。
  //    **includeRecent 不作用于本区**：绝不「立即清空」用户的备份文件。
  const exemptPrefix = opts.exportsExemptPrefix
  if (wanted.includes('exports')) {
  try {
    const entries = await fs.readdir(opts.exportsDir, { withFileTypes: true })
    result.sections.push('exports')
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
      if (exemptPrefix !== undefined && entry.name.startsWith(exemptPrefix)) continue
      const target = path.join(opts.exportsDir, entry.name)
      if (await isExpired(target, exportsRetentionMs, nowMs)) {
        await removeEntry(target, `exports/${entry.name}`, result)
      }
    }
  } catch (err) {
    // exportsDir 不存在/不可读 → 跳过（ENOENT 不算失败，见上）
    if (!isENOENT(err)) result.errors += 1
  }
  }

  // 3) market/cache：过期（或 includeRecent 时全部）index.json 与 items/<itemId> 条目缓存；删空后回收 hash 目录
  if (wanted.includes('marketCache')) {
  try {
    const hashes = await fs.readdir(opts.marketCacheRoot)
    result.sections.push('marketCache')
    for (const hash of hashes) {
      const hashDir = path.join(opts.marketCacheRoot, hash)
      // 根级原子写半成品：不是 hash 目录 → 会被下面的 isDirectory 跳过，但 /disk-usage 的
      // 递归统计把它算在这个分区里 ⇒ 必须就地回收（cross-F1 同类）。
      if (isAtomicTempName(hash) && (includeRecent || await isExpired(hashDir, marketRetentionMs, nowMs))) {
        await removeEntry(hashDir, `market/cache/${hash}`, result)
        continue
      }
      let st
      try {
        st = await fs.stat(hashDir)
      } catch {
        continue // 竞态删除/不可读 → 跳过该 hash
      }
      if (!st.isDirectory()) continue

      const indexFile = path.join(hashDir, 'index.json')
      if (includeRecent || await isExpired(indexFile, marketRetentionMs, nowMs)) {
        await removeEntry(indexFile, `market/cache/${hash}/index.json`, result)
      }

      // 原子写半成品（index.json 写入中途被杀）也必须清：否则 hash 目录永远非空、回收不掉，
      // 而 /disk-usage 照旧把它计入可回收（cross-F1 同类不同区）。
      for (const name of await fs.readdir(hashDir).catch(() => [] as string[])) {
        if (!isAtomicTempName(name)) continue
        const tmpFile = path.join(hashDir, name)
        if (includeRecent || await isExpired(tmpFile, marketRetentionMs, nowMs)) {
          await removeEntry(tmpFile, `market/cache/${hash}/${name}`, result)
        }
      }

      const itemsDir = path.join(hashDir, 'items')
      const itemDirs = await fs.readdir(itemsDir).catch(() => [] as string[])
      for (const itemId of itemDirs) {
        const itemDir = path.join(itemsDir, itemId)
        if (includeRecent || await isExpired(itemDir, marketRetentionMs, nowMs)) {
          await removeEntry(itemDir, `market/cache/${hash}/items/${itemId}`, result)
        }
      }
      // items 子目录删空后回收；hash 目录删空后回收
      const itemsLeft = await fs.readdir(itemsDir).catch(() => [] as string[])
      if (itemsLeft.length === 0) {
        await removeEntry(itemsDir, `market/cache/${hash}/items`, result)
      }
      const remaining = await fs.readdir(hashDir).catch(() => [] as string[])
      if (remaining.length === 0) {
        await removeEntry(hashDir, `market/cache/${hash}`, result)
      }
    }
  } catch (err) {
    // marketCacheRoot 不存在/不可读 → 跳过（ENOENT 不算失败，见上）
    if (!isENOENT(err)) result.errors += 1
  }
  }

  // 4) market/work：过期（或 includeRecent 时全部）git 只读工作副本（readIndex 时会按需重新 clone）
  if (wanted.includes('marketWork')) {
  try {
    const hashes = await fs.readdir(opts.marketWorkRoot)
    result.sections.push('marketWork')
    for (const hash of hashes) {
      const workDir = path.join(opts.marketWorkRoot, hash)
      if (isAtomicTempName(hash) && (includeRecent || await isExpired(workDir, marketRetentionMs, nowMs))) {
        await removeEntry(workDir, `market/work/${hash}`, result)
        continue
      }
      const st = await fs.stat(workDir).catch(() => null)
      if (st === null || !st.isDirectory()) continue
      if (includeRecent || await isExpired(workDir, marketRetentionMs, nowMs)) {
        await removeEntry(workDir, `market/work/${hash}`, result)
      }
    }
  } catch (err) {
    // marketWorkRoot 不存在/不可读 → 跳过（ENOENT 不算失败，见上）
    if (!isENOENT(err)) result.errors += 1
  }
  }

  return result
}