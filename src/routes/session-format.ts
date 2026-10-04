/**
 * 会话格式处置（T1）的路由侧接线 —— 判定逻辑全在 `src/ui/session-format-disposition.ts`
 * （与浏览器半共用同一份纯函数），本模块只负责「读插件级缺省」与「把阻断结果翻译成 409 体」。
 *
 * 为什么独立成文件：/plan（src/index.ts）、/execute（src/routes/import.ts）、
 * 同步 preview/apply（src/routes/sync.ts）四处必须**同一条口径** —— 任何一处自己判定，
 * 都会出现「界面说拦住了、服务端照写」或反过来的鬼故事。
 */
import { readUiPrefs } from '../sync/ui-prefs.ts'
import {
  DEFAULT_SESSION_FORMAT_DISPOSITION,
  parseSessionFormatDisposition,
  sessionFormatBlocksPlan,
  sessionFormatFactsFromPlan,
  type SessionFormatUnreadableUnit,
} from '../ui/session-format-disposition.ts'
import type { MsgFunc } from '../core/messages.ts'
import type { ImportPlan, SessionFormatDisposition } from '../core/types.ts'

/**
 * 解析本次请求的处置：请求体 > 插件级配置项（ui-prefs.json）> 缺省 `abort`。
 *
 * 为什么请求体优先：决策权在界面（用户当场选的三选一）；插件级配置项只服务不带该字段的
 * 调用方（脚本 / 第三方客户端 / 老客户端），它读不到时的缺省必须是安全侧的 abort ——
 * 默认放过会让用户在没看清的情况下丢对话。
 */
export async function resolveSessionFormatDisposition(
  syncDir: string,
  raw: unknown,
): Promise<SessionFormatDisposition> {
  const fromRequest = parseSessionFormatDisposition(raw)
  if (fromRequest !== undefined) return fromRequest
  try {
    const fromPrefs = parseSessionFormatDisposition((await readUiPrefs(syncDir)).sessionFormatDisposition)
    if (fromPrefs !== undefined) return fromPrefs
  } catch {
    // 读不到偏好不是错误：回退缺省（绝不因为读不到配置就放行）
  }
  return DEFAULT_SESSION_FORMAT_DISPOSITION
}

/** 阻断响应体（409；`unreadable`/`target` 供界面渲染阻断态，无需再读一遍归档）。 */
export interface SessionFormatAbortBody {
  code: 'sessionFormatUnsupported'
  error: string
  unreadable: SessionFormatUnreadableUnit[]
  target: number
}

/**
 * abort 处置的守卫：计划里含「本机读不了的会话」时，**在任何写入之前**返回阻断体。
 *
 * 调用点必须在真正落盘之前（/plan 计划生成后、/execute 执行前、同步 preview/apply 前）：
 * abort 的语义是「零写入」，晚一步拦就等于没拦。
 */
export function sessionFormatAbortResponse(
  plan: ImportPlan,
  disposition: SessionFormatDisposition,
  msg: MsgFunc,
): SessionFormatAbortBody | null {
  const facts = sessionFormatFactsFromPlan(plan.items)
  if (facts === null || !sessionFormatBlocksPlan(facts, disposition)) return null
  const newest = facts.unreadable.reduce((max, unit) => (unit.version > max ? unit.version : max), 0)
  return {
    code: 'sessionFormatUnsupported',
    error: msg('import.sessionsFormatAborted', {
      count: String(facts.unreadable.length),
      newer: String(newest),
      target: String(facts.target),
    }),
    unreadable: facts.unreadable,
    target: facts.target,
  }
}
