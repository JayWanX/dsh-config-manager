/**
 * 「下载原始日志 (ZIP)」入口的**纯展示模型**（F-2，框架无关、node 可测）。
 *
 * 本模块**不做任何 I/O 与 React**：输入是宿主探测回来的结构化事实，输出是组件直接渲染的三件事 ——
 * 是否可用、给用户看的原因、按钮的交互状态。判定集中在这里的原因很实在：这条入口最容易犯的错
 * **不是**功能错，而是**显隐判据错**（生态竞品普遍用已过时的 `status !== 501` 探测，在本机 DSH 上
 * 会因为服务缺失返 500 而**几乎恒显示**）。判据只能有一份，且必须可单测。
 *
 * 三态语义（与宿主 src/routes/session-export.ts 的 `SessionExportAvailability` 同源）：
 *  - `available`  → 显示并可用；
 *  - `unavailable` → **显示但禁用**，并给出可读原因（绝不静默、也绝不直接消失让用户以为没这功能）；
 *  - `unknown`    → **保守显示为可用**（拿不到状态码时绝不猜成「不支持」——那会藏掉一个其实能用的功能）。
 *
 * 为什么 `unavailable` 是「禁用 + 说明」而不是「隐藏」：隐藏会让用户无从判断「是这台机器不支持」
 * 还是「插件没做这个功能」；禁用 + 一句话原因把这句话说清楚（与仓库「绝不静默」的既有取向一致）。
 */

/** 可用性三态（与宿主 src/routes/session-export.ts 的判定同源）。 */
export type SessionExportAvailability = 'available' | 'unavailable' | 'unknown'

/** 成因（机器可读；界面映射成文案，**绝不渲染裸码**）。 */
export type SessionExportReason =
  | 'service-missing'
  | 'auth-required'
  | 'read-failed'
  | 'network-error'
  | 'unexpected-status'

/** 宿主探测回来的结构化事实（与 GET /session-export 的响应字段一一对应）。 */
export interface SessionExportProbe {
  availability: SessionExportAvailability
  reason?: SessionExportReason
  /** DSH 返回的状态码（0 = 没拿到响应） */
  status: number
  /** 探测的路径（诊断用） */
  path: string
  /** 探测时刻（ISO） */
  checkedAt: string
}

/** 组件的可渲染状态（判定全在这里，组件只做映射）。 */
export interface SessionExportEntryState {
  /** 是否可用（false = 按钮禁用） */
  enabled: boolean
  /** 是否渲染这条入口（目前恒 true —— 见文件头「为什么是禁用而不是隐藏」） */
  visible: true
  /** 禁用原因（键 + 插值参数；enabled=true 时为 null） */
  reasonKey: SessionExportReasonKey | null
  reasonParams: Record<string, string> | null
  /** 探测是否尚未回来（组件据此显示加载态而不是误判为不可用） */
  pending: boolean
}

/** 原因 → 字典键（**唯一映射**；新增原因必须同时在这里与字典里加，漏了即编译错）。 */
export type SessionExportReasonKey =
  | 'sessions.zip.reason.serviceMissing'
  | 'sessions.zip.reason.authRequired'
  | 'sessions.zip.reason.readFailed'
  | 'sessions.zip.reason.networkError'
  | 'sessions.zip.reason.unexpectedStatus'

const REASON_KEYS: Record<SessionExportReason, SessionExportReasonKey> = {
  'service-missing': 'sessions.zip.reason.serviceMissing',
  'auth-required': 'sessions.zip.reason.authRequired',
  'read-failed': 'sessions.zip.reason.readFailed',
  'network-error': 'sessions.zip.reason.networkError',
  'unexpected-status': 'sessions.zip.reason.unexpectedStatus',
}

/**
 * 探测结果 → 可渲染状态（**唯一判定入口**）。
 *
 *  `probe === null` 表示探测还没回来（pending）：此时既不判可用也不判不可用，
 *  由组件显示加载态 —— 「还没问出来」与「问出来是不可用」是两件事，混起来会让按钮先闪禁用再启用。
 */
export function sessionExportEntryState(probe: SessionExportProbe | null): SessionExportEntryState {
  if (probe === null) {
    return { enabled: false, visible: true, reasonKey: null, reasonParams: null, pending: true }
  }
  if (probe.availability === 'unavailable') {
    const reason = probe.reason ?? 'service-missing'
    return {
      enabled: false,
      visible: true,
      reasonKey: REASON_KEYS[reason],
      // 状态码只作为**诊断信息**附在原因里（用户报障时可读；不泄漏任何本机路径或凭据）。
      reasonParams: { status: String(probe.status) },
      pending: false,
    }
  }
  // available 与 unknown 都显示为可用：unknown = 「拿不到状态码」，保守方向必须是**能用**。
  return { enabled: true, visible: true, reasonKey: null, reasonParams: null, pending: false }
}

/**
 * 是否应该**主动**告诉用户某个原因（渲染 hint 文本）。
 *
 * `unknown` 不打扰用户（按钮可用、点了也没问题）；只有真正禁用时才必须解释 ——
 * 「绝不静默」指的是**不静默地失效**，不是「有探测就一定要弹说明」。
 */
export function sessionExportHintKey(state: SessionExportEntryState): SessionExportReasonKey | null {
  return state.enabled ? null : state.reasonKey
}

/**
 * 把原因渲染成用户可读文本（缺参原样保留，与 UiT 的既有插值约定一致）。
 *
 * `t` 收成结构化的最小函数形态而不是直接要 `UiT`：本模块属于 `src/client/**`（浏览器 bundle），
 * 而 ui 字典是 src/ui 的资产；只要调用方给的函数认得这几个键即可，两端各自保持自己的字典来源。
 */
export function sessionExportReasonText(
  state: SessionExportEntryState,
  t: (key: SessionExportReasonKey, params?: Record<string, string | number>) => string,
): string | null {
  const key = sessionExportHintKey(state)
  if (key === null) return null
  return t(key, state.reasonParams ?? {})
}
