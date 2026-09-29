/**
 * DeepSeek Harness Desktop（Electron 外壳）的 CLI 载体识别。
 *
 * 为什么需要它（真机问题：桌面端导入插件全部失败）：
 * Desktop 把 profile `desktop` 定为**保留档案**，普通 dsh CLI 会硬性拒绝它 ——
 * `error: profile "desktop" is managed exclusively by the Electron application`
 * （0.1.5-rc.1 与 0.2.0-rc.2 的 `@deepseek-ai/dsh/lib/bin.js` 里 rejectElectronProfile 都是无条件拒绝）。
 * 只有桌面端自带的 CLI 载体 `@deepseek-ai/dsh-desktop-host/lib/cli.js` 才允许操作它：它以
 * `runCli({ manageDesktopProfile: true, packageManager })` 启动，用桌面端**内置**的 runtime
 * 与内置 pnpm 跑 `runPlugin`，并把 `--profile desktop` 放行（bin.js 的 plugin 分支只在
 * `manageDesktopProfile` 为真时跳过 rejectElectronProfile）。
 *
 * 宿主进程由 Electron 主进程以 Node 模式拉起（`apps/desktop` 的 HostProcess.start），argv 形如：
 *   [electron.exe, <runtimeDir>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js,
 *    <runtimeDir>, <projectDir>, <primaryRuntime>, <pnpm>, <nodeBin>]
 * 同目录下的 cli.js 就是那条「普通 CLI + 桌面端保留档案例外」的入口，可以直接当 CLI 用。
 *
 * 本模块只依赖 node 内置模块，纯探测（argv1 / exists 可注入）便于单测。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** dsh-desktop-host 的主进程入口（Electron 以 Node 模式拉起的那个 index.js）。 */
const DESKTOP_HOST_ENTRY = /[\\/]dsh-desktop-host[\\/](?:lib[\\/])?index\.[cm]?js$/i

/** Electron Node 模式开关：让同一个可执行文件按 Node 跑而不是拉起 GUI。 */
export const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/**
 * Desktop 独占管理的保留档案名。
 *
 * 浏览器半的同一常量在 `src/profiles/dsh-profile-shared.ts`（那边必须保持零依赖，
 * 不能 import 本模块）—— 两处字面量由 `src/utils/desktop-carrier.test.ts` 互钉，
 * 保证不会单独漂移。
 */
export const DESKTOP_PROFILE_NAME = 'desktop'

export interface DesktopCarrier {
  /** `.../@deepseek-ai/dsh-desktop-host/lib/cli.js` 绝对路径。 */
  cliPath: string
  /** 启动它的可执行文件（= 当前宿主进程的 process.execPath，即 Electron 主程序）。 */
  execPath: string
  /** 载体子进程必须额外带上的环境（Electron Node 模式）。 */
  env: Readonly<Record<string, string>>
}

export interface DesktopCarrierProbe {
  /** 待探测的 `process.argv[1]`；缺省读当前进程。 */
  argv1?: string | undefined
  /** 载体可执行文件；缺省 `process.execPath`。 */
  execPath?: string
  /** 存在性判定；缺省 node:fs.existsSync。 */
  exists?: (path: string) => boolean
}

/**
 * 解析 Desktop CLI 载体：argv[1] 是 dsh-desktop-host 的主入口、且同目录存在 cli.js 才算命中。
 * 命中不了（普通 `dsh web` / tui / 源码树 tsx 直启）返回 null —— 此时沿用原来的 CLI 重放逻辑。
 */
export function resolveDesktopCarrier(probe: DesktopCarrierProbe = {}): DesktopCarrier | null {
  const argv1 = probe.argv1 !== undefined ? probe.argv1 : process.argv[1]
  if (typeof argv1 !== 'string' || argv1 === '' || !DESKTOP_HOST_ENTRY.test(argv1)) return null
  const exists = probe.exists ?? existsSync
  const cliPath = join(dirname(argv1), 'cli.js')
  if (!exists(cliPath)) return null
  return {
    cliPath,
    execPath: probe.execPath ?? process.execPath,
    env: { [ELECTRON_RUN_AS_NODE]: '1' },
  }
}

/** 当前进程是否由 Desktop 外壳（Electron Node 模式）拉起。 */
export function isDesktopHostProcess(probe: DesktopCarrierProbe = {}): boolean {
  return resolveDesktopCarrier(probe) !== null
}

/** profile 名是否是 Desktop 独占的保留档案（大小写不敏感，与 dsh CLI 同口径）。 */
export function isDesktopProfile(name: string): boolean {
  return name.trim().toLowerCase() === DESKTOP_PROFILE_NAME
}
