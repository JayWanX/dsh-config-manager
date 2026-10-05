/**
 * 外部来源路由（/foreign-sources 与 /foreign-import）的**纯函数内核**。
 *
 * 为什么必须独立成文件（两条硬约束，都是实测踩出来的）：
 *
 * ① **纯单测环境不得连带加载 src/index.ts**。路由模块 `./foreign.ts` 若要读插件版本，
 *    最自然的写法是 `import { PLUGIN_VERSION } from '../index.ts'`（prefs.ts 就是这么做的）——
 *    但 `src/index.ts` 顶部 import 了 `@deepseek-ai/*` 运行时包，于是**任何直接 import 路由模块的
 *    单测**都会 ERR_MODULE_NOT_FOUND 而根本跑不起来。既有先例 `session-format.test.ts` 的解法是：
 *    判定逻辑放纯函数模块，测试只 import 它。本文件即为此而设。
 *
 * ② **三个调用点必须共用同一份「来源上下文」构造**。六来源真值表（契约 §8.2）全部相对
 *    **用户 home**（~/.claude、~/.cursor、~/.codex、~/.copilot、~/.gemini、~/.agents/skills），
 *    而宿主 context 的 `homeDir` 是 **\$DSH_HOME**（≈ ~/.dsh），两者不是一回事。
 *    此处曾写过 `homeDir: host.homeDir` → POST 会去找 ~/.dsh/.claude，全部读不到 → 稳定回
 *    400 nothing-to-import；而 GET 用 os.homedir() 显示 found=true —— **同一来源两个接口互相矛盾**。
 *    本机若恰有 HERMES_HOME 之类的环境变量覆盖，还会掩盖其余五个来源，属于最难发现的那类缺陷。
 *    故：GET / POST / CLI（src/cli/import-source.ts）三处的来源上下文构造收敛到本文件的
 *    `foreignSourceContext()`，杜绝再度分叉。
 *
 * 本文件**零 @deepseek-ai 依赖**、零 fs 访问、零副作用 —— 可被单测直接 import。
 */
import os from 'node:os'
import path from 'node:path'

import type { ForeignSourceContext } from '../foreign/registry.ts'

/** 构造来源上下文的输入（三个调用点各自把自己的「宿主事实」投影成这几项）。 */
export interface ForeignContextInput {
  /**
   * **用户 home**（六来源真值表的基准）。
   *
   * 刻意不接受「宿主 context 的 homeDir」——那个值是 \$DSH_HOME。调用方必须显式传用户 home，
   * 缺省由本函数回退 `os.homedir()`；这样「传错」在类型与命名上都是可见的，而不是静默走空。
   */
  userHome?: string
  /** 进程环境快照（位置覆盖判定：CLAUDE_CONFIG_DIR / HERMES_HOME / CODEX_HOME / COPILOT_HOME） */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * 项目级真值位置（Cursor/Codex 的 <项目>/.cursor/**）。
   * **只在调用方明确知道用户的项目时传入**；缺省不传 = 不扫项目级（绝不拿宿主 cwd 当用户的项目）。
   */
  projectDir?: string
  /** 目标机 DSH 的 SESSION_FORMAT_VERSION；缺省 = 不转码任何会话（内核如实报码，绝不猜版本） */
  targetSessionFormatVersion?: number
}

/**
 * 唯一的来源上下文构造点（GET / POST / CLI 共用）。
 *
 * 三条纪律：
 *  · `homeDir` 恒为**用户 home**（不是 \$DSH_HOME）；
 *  · `projectDir` 为空串 / 未给 → 该键**不出现**（内核据此不扫项目级，而不是拿 '' 去拼路径）；
 *  · `targetSessionFormatVersion` 未给 → 该键不出现（内核据此逐条报 session-format-version-unknown，
 *    绝不擅自填一个默认版本 —— 那会把「本机读不了」的会话当成能读的写进去）。
 */
export function foreignSourceContext(input: ForeignContextInput = {}): ForeignSourceContext {
  const home = input.userHome !== undefined && input.userHome !== '' ? input.userHome : os.homedir()
  const project = input.projectDir !== undefined && input.projectDir !== '' ? input.projectDir : undefined
  return {
    homeDir: home,
    env: input.env ?? process.env,
    ...(project !== undefined ? { projectDir: project } : {}),
    ...(input.targetSessionFormatVersion !== undefined
      ? { targetSessionFormatVersion: input.targetSessionFormatVersion }
      : {}),
  }
}

/**
 * 产物的**受控目录自检**：写出去的 bundle 必须落在受控暂存根之内。
 *
 * 这条断言的价值不是「防注入」（路径是我们自己拼的），而是把「受控目录约定」变成
 * **运行期不变量**：将来有人把 outPath 改成别的目录，这里立刻红，而不是静默把包写进用户配置区。
 *
 * 用 `+ path.sep` 而不是裸 `startsWith`：后者会让 `/tmp-evil` 通过 `/tmp` 的判定。
 */
export function isInsideStaging(outPath: string, roots: readonly string[]): boolean {
  const target = path.resolve(outPath)
  return roots.some((root) => {
    const base = path.resolve(root)
    return target === base || target.startsWith(base + path.sep)
  })
}

/** 来源 id 非法（未知 / 空）时给客户端的稳定码 —— 与 ForeignSourceError 的 code 同域。 */
export const FOREIGN_IMPORT_MISSING_SOURCE_CODE = 'missing-source'
/** 一个分区都产不出来时的稳定码（绝不静默产空包：自检能过，用户却拿到什么都没有的包）。 */
export const FOREIGN_IMPORT_EMPTY_CODE = 'nothing-to-import'
