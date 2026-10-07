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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/* ------------------------------- 布局展开：hoisted / dsh 嵌套 / pnpm 隔离（issue #74） */

/** pnpm 隔离布局的存储目录名（`<node_modules>/.pnpm`）。 */
const PNPM_STORE_DIR = '.pnpm'
/**
 * pnpm 段名前缀（`@deepseek-ai+dsh-session@<version>[_<peerHash>]`）。
 * 末尾那个 `@` 是必须的：`@deepseek-ai+dsh-session-projection@…` 也以同名开头，但它**不是**我们要的包。
 */
const PNPM_SESSION_ENTRY_PREFIX = '@deepseek-ai+dsh-session@'
/** 向上找存储目录的最大层数（隔离安装下锚点本身就在 store 段内，最多要爬 4 层）。 */
const PNPM_UPWARD_LEVELS = 8

/** pnpm 段名 → 版本（`…@<version>[_<peerHash>]`）；不是 dsh-session 段 → undefined。 */
export function pnpmSessionEntryVersion(entryName: string): string | undefined {
  if (!entryName.startsWith(PNPM_SESSION_ENTRY_PREFIX)) return undefined
  const rest = entryName.slice(PNPM_SESSION_ENTRY_PREFIX.length)
  if (rest === '') return undefined
  // semver 标识符里不含 '_'，pnpm 用它拼接 peer 后缀（如 @a@1.0.0_react@18.2.0）
  const peerAt = rest.indexOf('_')
  return peerAt === -1 ? rest : rest.slice(0, peerAt)
}

/** 从 startDir 起向上找最近的 `.pnpm` 存储目录；找不到 → undefined。 */
export function findPnpmStore(startDir: string): string | undefined {
  let dir = startDir
  for (let level = 0; level < PNPM_UPWARD_LEVELS; level++) {
    const candidate = join(dir, PNPM_STORE_DIR)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      /* 这一层没有 .pnpm（或读不到）→ 继续向上 */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * pnpm 隔离布局下 dsh-session 的候选 node_modules 根（issue #74）。
 *
 * 为什么需要：pnpm 全局安装 DSH 时，installAnchor 落在
 *   `<…>/node_modules/.pnpm/@deepseek-ai+dsh@<ver>_<hash>/node_modules/@deepseek-ai/dsh/package.json`
 * 而它的同级 @deepseek-ai 下**没有** dsh-session（`dsh` 的 dependencies 里也没有它，只有
 * dsh-session-projection / -reference），`dsh/node_modules` 同样不存在 —— 「同级目录拼路径」
 * 在隔离布局下必然落空。真实的 dsh-session 在**同一 store 的另一个段**里：
 *   `<store>/@deepseek-ai+dsh-session@<ver>_<hash>/node_modules/@deepseek-ai/dsh-session/lib/index.js`
 *
 * 多个版本共存时取「与本机 dsh 同版本」的那个（DSH 内部包按同一版本号一起发布）；
 * 同版本多份（peer 哈希不同）等价，全试。**版本读不出来且不止一个候选 → 返回空（不猜）**：
 * 体检宁可整体跳过，也不能拿另一份 dsh-session 的常量谎报本机格式。
 */
export function pnpmSessionFormatRoots(nodeModulesDir: string, dshVersion?: string): string[] {
  const store = findPnpmStore(nodeModulesDir)
  if (store === undefined) return []
  let entries: string[]
  try {
    entries = readdirSync(store).filter((name) => name.startsWith(PNPM_SESSION_ENTRY_PREFIX))
  } catch {
    return []
  }
  if (entries.length === 0) return []
  let chosen: string[]
  if (typeof dshVersion === 'string' && dshVersion !== '') {
    const exact = entries.filter((name) => pnpmSessionEntryVersion(name) === dshVersion)
    if (exact.length > 0) chosen = exact
    else if (entries.length === 1) chosen = entries
    else return []
  } else if (entries.length === 1) {
    chosen = entries
  } else {
    return []
  }
  return chosen.sort().map((name) => join(store, name, 'node_modules'))
}

/**
 * 一个「同树」根展开成全部候选（顺序即真伪顺序）：
 *   ① hoisted 同级 `<nm>/@deepseek-ai/dsh-session`
 *   ② dsh 自己的嵌套 `<nm>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session`
 *   ③ pnpm 隔离 store（见 `pnpmSessionFormatRoots`）
 */
export function sessionFormatRoots(nodeModulesDir: string, dshVersion?: string): string[] {
  return [
    nodeModulesDir,
    join(nodeModulesDir, '@deepseek-ai', 'dsh', 'node_modules'),
    ...pnpmSessionFormatRoots(nodeModulesDir, dshVersion),
  ]
}

/** 在一棵（含 pnpm 存储的）依赖树里读格式常量；读不到 → undefined（不猜）。 */
export function readSessionFormatVersionInTree(nodeModulesDir: string, dshVersion?: string): number | undefined {
  for (const root of sessionFormatRoots(nodeModulesDir, dshVersion)) {
    const version = readSessionFormatVersionAt(root)
    if (version !== undefined) return version
  }
  return undefined
}

/** 读一个 package.json 的 version（只读；不可读 / 不是非空字符串 → undefined）。 */
export function readPackageVersionAt(packageJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------- 解析入口 */

/**
 * 按「@deepseek-ai/dsh/package.json 的路径」候选逐个找同树的会话格式常量。
 *
 * 顺序即真伪顺序（与 `resolveDshVersion` 同源）：installAnchor（拉起本宿主的那份运行时，
 * 桌面端在 app.asar 内）优先，其次该档案自己的依赖树。每处再试三种布局（见 `sessionFormatRoots`）。
 *
 * `tried` 可选：收集**所有尝试过的路径**（解析失败时由调用方写进日志——真机排查看的是这个，
 * 而不是一句「解析不到」）。
 */
export function resolveSessionFormatVersion(
  dshPackageJsonCandidates: readonly string[],
  tried: string[] = [],
): number | undefined {
  for (const candidate of dshPackageJsonCandidates) {
    const nodeModulesDir = join(dirname(candidate), '..', '..')
    // 本机 dsh 版本只用于在 pnpm store 的多个 dsh-session 之间挑同版本者；读不到就不挑（见上）。
    const dshVersion = readPackageVersionAt(candidate)
    for (const root of sessionFormatRoots(nodeModulesDir, dshVersion)) {
      tried.push(root)
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
