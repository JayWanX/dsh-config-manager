/**
 * 档案实例的**进程控制**内核（node）—— 存活判定 / 终止（优雅 → 强杀）的唯一实现。
 *
 * 为什么单独一层：停一个实例有两类调用方（启动器按自己的台账停；运行注册表停**别的**实例的心跳），
 * 而「优雅期多长 / Windows 上没有优雅通道」这类平台知识只能有一份，否则两边迟早漂移。
 *
 * 平台事实（实测）：
 *  - Windows：`taskkill /PID <pid> /T`（不带 /F）只对**有窗口**的进程投递关闭消息，控制台进程收不到；
 *    Node 的 `SIGTERM` 在 Windows 上被模拟成 TerminateProcess（等于直接杀）。所以 Windows 的「优雅期」
 *    只是一个很短的确认窗口（1.5s），最终必然落到强杀 —— 这一点由调用方如实回报（killed）。
 *  - POSIX：SIGTERM 是真的信号，给足 6s 让 DSH 收尾。
 */
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** 停止流程的优雅期（先请它自己退出，超时再强制；缺省 6s）。 */
export const PROFILE_STOP_GRACE_MS = 6_000
/** Windows 的优雅期（更短，原因见文件头）。 */
export const PROFILE_STOP_GRACE_MS_WINDOWS = 1_500

/** 一次停止的终态；failed = 强杀后仍活着（调用方必须如实报错，不许说成已停止）。 */
export type StopPidOutcome = 'graceful' | 'killed' | 'already-stopped' | 'failed'

/** 可注入的进程控制副作用（测试用；缺省即真实实现）。 */
export interface ProcessControlDeps {
  /** pid 是否存活（缺省 process.kill(pid, 0)；EPERM 视为存活） */
  isAlivePid?: (pid: number) => boolean
  /** 终止进程（缺省：Windows 用 taskkill /T [/F]，其余平台 SIGTERM/SIGKILL） */
  killPid?: (pid: number, mode: 'graceful' | 'force') => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 优雅期（缺省按平台：POSIX 6s / Windows 1.5s） */
  graceMs?: number
}

/** 解析后的进程控制依赖（构造器注入一次，后续只读）。 */
export interface ResolvedProcessControl {
  isAlivePid: (pid: number) => boolean
  killPid: (pid: number, mode: 'graceful' | 'force') => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  graceMs: number
}

/** 缺省优雅期（按平台）。 */
export function defaultStopGraceMs(): number {
  return process.platform === 'win32' ? PROFILE_STOP_GRACE_MS_WINDOWS : PROFILE_STOP_GRACE_MS
}

export function resolveProcessControl(deps: ProcessControlDeps = {}): ResolvedProcessControl {
  return {
    isAlivePid: deps.isAlivePid ?? defaultIsAlivePid,
    killPid: deps.killPid ?? defaultKillPid,
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    now: deps.now ?? (() => Date.now()),
    graceMs: deps.graceMs ?? defaultStopGraceMs(),
  }
}

/**
 * 停一个 pid：先优雅 → 等 graceMs → 仍活着则强杀 → 仍活着返回 'failed'。
 * 只做进程动作，不碰任何台账/心跳文件（那是调用方的事）。
 */
export async function stopPid(pid: number, deps: ResolvedProcessControl): Promise<StopPidOutcome> {
  if (!deps.isAlivePid(pid)) return 'already-stopped'
  deps.killPid(pid, 'graceful')
  const deadline = deps.now() + deps.graceMs
  while (deps.now() < deadline) {
    if (!deps.isAlivePid(pid)) return 'graceful'
    await deps.sleep(200)
  }
  if (!deps.isAlivePid(pid)) return 'graceful'
  deps.killPid(pid, 'force')
  return deps.isAlivePid(pid) ? 'failed' : 'killed'
}

/** 真实存活判定：kill(pid, 0)；EPERM 说明进程存在但没权限 → 仍视为存活。 */
export function defaultIsAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 真实终止：Windows 用 taskkill /T（连进程树），其余平台发信号。 */
export function defaultKillPid(pid: number, mode: 'graceful' | 'force'): void {
  if (process.platform === 'win32') {
    const args = mode === 'force' ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T']
    spawnSync('taskkill', args, { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, mode === 'force' ? 'SIGKILL' : 'SIGTERM')
  } catch {
    /* 已经没了：调用方会再查一次存活，这里不必报错 */
  }
}
