/**
 * 用系统默认浏览器打开 URL（跨平台）。
 *
 * 失败**不阻断**：终端里已经打印了带 token 的 URL，用户可以自己复制。绝不因为打不开浏览器
 * 就让救急台起不来 —— 那是「DSH 都起不来时」唯一的可视化通道。
 */
import { spawn } from 'node:child_process'

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  // Windows 的 start 需要一个空标题参数，否则会把 URL 当成窗口标题
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // 打开失败不影响服务本身（终端已打印 URL）
  }
}
