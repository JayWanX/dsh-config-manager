/**
 * 剪贴板原语（浏览器半）。
 *
 * 为什么单独成模块：CopyButton / 环境页 / GitHub 一次性授权代码自动复制走的是同一条路径，
 * 「成功才反馈、失败绝不给假信号」的语义必须只有一份实现（此前已有两处逐字重复的副本）。
 *
 * 语义：无 `navigator.clipboard`（不安全上下文 / 老宿主）或写入被拒 → **返回 false**，
 * 由调用方决定提示文案；本模块不弹 Toast、不吞异常之外的东西。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const pending = navigator.clipboard?.writeText(text)
    if (pending === undefined) return false
    await pending
    return true
  } catch {
    return false
  }
}
