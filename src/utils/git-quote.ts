/**
 * git config 值转义（唯一实现）。
 *
 * 两个调用方此前各有一份逐字相同的私有实现：`src/market/git-file-writer.ts`（市场写入器）
 * 与 `src/sync/git/git-transport.ts`（同步 git 通道）。
 */
/** git config 值里的路径转义：含空白/引号时用引号包裹（Windows 路径转正斜杠） */
export function quoteGitValue(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
