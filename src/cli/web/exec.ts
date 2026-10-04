/**
 * 救急台的命令执行器（仅供「重装 DSH」用）。
 *
 * 与 CLI 的 createDefaultExec 同语义：Windows 走 `powershell -NoProfile -Command`，
 * Unix 走 `bash -c`。**不做任何包装或"更安全"的改写** —— 重装步骤是 core 生成的固定命令串，
 * 这里只是把它交给系统 shell（用户选择的那几步原样执行，绝不静默改写）。
 */
import { execFile } from 'node:child_process'

export function createExec(platform: NodeJS.Platform = process.platform): (cmd: string) => Promise<string> {
  return (cmd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const file = platform === 'win32' ? 'powershell' : 'bash'
      const args = platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd]
      execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
        if (error !== null) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout))
      })
    })
}
