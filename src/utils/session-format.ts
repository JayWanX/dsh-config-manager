/**
 * 会话格式（DSH 的 `SESSION_FORMAT_VERSION`）识别与体检 —— **宿主侧**工具。
 *
 * 为什么在宿主侧：格式常量只存在于 DSH 的 `@deepseek-ai/dsh-session` 包里，读它是安装细节；
 * 会话日志的字节结构由 `utils/session-log.ts` 负责（core 禁止 import 存储格式）。
 * core 只收到两个数字：**本机 DSH 支持的版本**（`HostContext.sessionFormatVersion`）与
 * 探针抽查到的版本集合，然后决定要不要告警。
 *
 * 背景（真机事实）：DSH 读会话时对**非本 build 的 version 直接拒绝**，而会话列表
 * （`listArtifacts()`）对 `SessionFormatUnsupportedError` **静默 continue** —— 不报错、
 * 不显示，用户看到的就是「对话消失」。高版本能读低版本（DSH 自带 V0→V4 迁移链），
 * 反向不可读，所以「桌面端（新）导出 → 旧 CLI 档案导入」必须在导入前说清楚。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SessionFormatProbeResult } from '../core/types.ts'
import { isSessionLogName, readLogHeaderFromBytes } from './session-log.ts'

/** DSH 会话包（相对 node_modules）。 */
const DSH_SESSION_PKG = join('@deepseek-ai', 'dsh-session')
/** 读 DSH 源码文本的上限：正常远小于它，超出说明不是我们要的文件 → 放弃（不猜）。 */
const SOURCE_READ_LIMIT = 4 * 1024 * 1024
/** 一次体检最多解多少条会话日志（每条只解首帧，成本很低；上限只为兜住异常包）。 */
export const MAX_PROBED_SESSION_LOGS = 200

/**
 * 从 DSH 源码文本里解出 `SESSION_FORMAT_VERSION = <n>`。
 *
 * 读不到（打包形态变了/常量改名）→ undefined：调用方按「无法判定」处理，
 * **绝不**拿 DSH 的 semver 去猜格式版本。
 */
export function parseSessionFormatVersion(source: string): number | undefined {
  const m = /\bSESSION_FORMAT_VERSION\s*=\s*(\d+)\b/.exec(source)
  if (m === null || m[1] === undefined) return undefined
  const value = Number(m[1])
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 从 `<node_modules>/@deepseek-ai/dsh-session/lib/index.js` 读格式常量；读不到 → undefined。 */
export function readSessionFormatVersionAt(nodeModulesDir: string): number | undefined {
  const file = join(nodeModulesDir, DSH_SESSION_PKG, 'lib', 'index.js')
  try {
    if (!existsSync(file)) return undefined
    if (statSync(file).size > SOURCE_READ_LIMIT) return undefined
    return parseSessionFormatVersion(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 按「@deepseek-ai/dsh/package.json 的路径」候选逐个找同树的会话格式常量。
 *
 * 顺序即真伪顺序（与 `resolveDshVersion` 同源）：installAnchor（拉起本宿主的那份运行时，
 * 桌面端在 app.asar 内）优先，其次该档案自己的依赖树。每处再试 hoisted 与 pnpm 嵌套两种布局。
 */
export function resolveSessionFormatVersion(dshPackageJsonCandidates: readonly string[]): number | undefined {
  for (const candidate of dshPackageJsonCandidates) {
    const nodeModulesDir = join(dirname(candidate), '..', '..')
    const roots = [nodeModulesDir, join(nodeModulesDir, '@deepseek-ai', 'dsh', 'node_modules')]
    for (const root of roots) {
      const version = readSessionFormatVersionAt(root)
      if (version !== undefined) return version
    }
  }
  return undefined
}

/** 体检输入：备份里 sessions 分区的条目（`data` 是归档内的原始字节）。 */
export interface SessionFormatProbeFile {
  relativePath: string
  data: Uint8Array
}

/**
 * 抽查备份里的会话日志格式版本（每个会话单元只看一条日志）。
 *
 * 只解**首帧**（`readLogHeaderFromBytes` 自己会停在第 1 帧），所以成本与分区大小无关、
 * 只与抽查条数有关。读不出 header 的日志计入 `unreadable`（可能是撕裂/损坏，
 * 也可能是运行环境没有 zstd 能力）—— 一律如实计数，绝不当作「没问题」。
 */
export function probeSessionFormats(
  files: readonly SessionFormatProbeFile[],
  maxLogs: number = MAX_PROBED_SESSION_LOGS,
): SessionFormatProbeResult {
  const seen = new Set<string>()
  const versions: number[] = []
  const units: { unitId: string; version: number }[] = []
  let sampled = 0
  let unreadable = 0
  let skipped = 0
  for (const file of files) {
    const parts = file.relativePath.split(/[\\/]+/).filter((part) => part !== '')
    const name = parts[parts.length - 1]
    if (name === undefined || !isSessionLogName(name)) continue
    // 会话单元 = 前两段（projectKey/会话目录）；同一会话的多个 generation 只体检一次。
    const unit = parts.slice(0, 2).join('/')
    if (seen.has(unit)) continue
    if (sampled + unreadable >= maxLogs) {
      skipped++
      continue
    }
    seen.add(unit)
    const header = readLogHeaderFromBytes(file.data)
    if (header?.version === undefined) {
      unreadable++
      continue
    }
    versions.push(header.version)
    units.push({ unitId: unit, version: header.version })
    sampled++
  }
  return { versions, sampled, unreadable, skipped, units }
}
