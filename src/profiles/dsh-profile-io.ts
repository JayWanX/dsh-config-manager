/**
 * 档案侧的同步文件读取 / 文件名清洗（host 专用，唯一实现）。
 *
 * 为什么不并进 `dsh-profile-shared.ts`：那个模块被**浏览器半**import
 * （`src/client/run-store.ts`、`src/client/api.ts`、`src/client/profiles/ProfilesPanel.tsx`、
 * `src/ui/dsh-profiles-view.ts`），必须保持零依赖；本模块用 `node:fs` 的 `readFileSync`
 * （档案数量级为个位数，同步读最简单），并进去就会把 node: 依赖打进 client bundle。
 *
 * 此前 `dsh-profile-manager.ts` / `dsh-profile-runtime.ts` / `dsh-profile-launcher.ts`
 * 各有一份 `readTextSafe`（runtime 与 launcher 逐字相同）、`sanitizeFileName` 与
 * `sanitizeFilePart`（同一正则）。
 */
import { readFileSync } from 'node:fs'

/**
 * 读文本文件；不可读返回 **null** —— 语义差异由调用方显式表达（**不得把 null 统一成 ''**）：
 *  - 档案管理器用 null 参与「该档案没有清单 → 视为非 DSH profile」的判定；
 *  - 运行时 / 启动器用 `readTextSafe(p) ?? ''`，靠 `JSON.parse('')` 抛错来「忽略这条记录」。
 */
export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 文件名片段清洗（profile 名已过校验；这里只是防意外字符）。 */
export function sanitizeFilePart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}
