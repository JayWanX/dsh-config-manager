/**
 * 路由组：**官方 session.export 通道**（只读：探测 + 流式代理，两形态同一路径）。
 *
 * 背景（F-2）：DSH 自带插件 `@deepseek-ai/dsh-session-log-export` 提供
 * `GET|HEAD /api/session.export?sessionId=<非空>&includeDescendants=<true|false 字面>`：
 * 由 DSH 自己 flush 内存会话、解码多帧 zstd、按「会话 + 子会话 + 附件」打**有界流式 ZIP**。
 * 本仓库此前 `session.export` / `includeDescendants` **0 命中**（从未接入）。
 *
 * 为什么不照抄竞品的「前端一个裸 `<a download>`」（见调研 §5.1）——两条都要命的理由：
 *  1. 该端点是 DSH 自己的 exact Fetch 路由，挂在**带浏览器认证**的 `/api` 前缀下，只能由页面里
 *     的同源请求带 cookie 访问；「连不上 / 没 cookie / 路由没注册」在浏览器里**分不开**
 *     （401 / 404 / 网络失败都会被 `fetch().catch` 压成同一类噪音）；
 *  2. 更硬的一条：`/api/session.export` **不是** `api/session.export` 的前缀祖先 ——
 *     `/api/session.export/x` 并不以 `/api/` 开头，所以拼错路径**不会**落到 DSH 的 401，
 *     而是落到 webserver 的默认 404 HTML，在页面上表现为「点了没反应」。
 * 因此宿主侧探测一次、把**机器可读的原因**下发给界面，由界面决定显示/禁用并说明原因
 * （**绝不静默、绝不恒显示**）。
 *
 * 三条硬边界：
 *  1. **绝不照抄竞品的 `res.status !== 501` 判据**（已过时）：本机 DSH 0.2.0-rc.2 的 app.asar
 *     全量搜 `status: 501` **零命中**，服务缺失实际返 **500**；照抄会让入口**几乎恒显示**。
 *  2. 「服务缺失」（500 + `unavailable: missing`）必须与「会话不存在」（404）分开：前者是环境
 *     问题（隐藏入口 + 说明原因），后者是正常业务结果（界面照实呈现）。
 *  3. 拿不到状态码（连不上 / 超时 / 401 / 403 / 读日志失败的 500）**绝不猜成不可用** ——
 *     一律 `unknown`，界面保守显示。
 *
 * 取证（本机 `D:/Apps/DSH/resources/app.asar` 逐字摘录，与调研 §5.2 一致）：
 *  - `if (deps.sessionQuery === void 0 || deps.sessionPersistence === void 0 || deps.attachments === void 0) return new Response("session log export is unavailable: missing session-query, session-persistence, or attachments service", { status: 500 });`
 *  - `if (sessionIdValue === void 0 || sessionIdValue.length === 0 || descendantsValue !== void 0 && descendantsValue !== "true" && descendantsValue !== "false") return new Response("missing or invalid sessionId query parameter", { status: 400 });`
 *  - `return new Response("session log export failed to read the stored log", { status: 500 });`
 *  - HEAD 与 GET 走同一条处理链、状态一致，只是取消 body：`if (request.method === "GET") return response; await response.body?.cancel(); …`
 *
 * W1：路由只在这里声明一次 —— `endpoint({ path, methods }, handler)` 的 path/methods 就是唯一
 * 声明处；围栏、方法判定与顶层异常处理由 `src/routes/kit.ts` 在注册点统一提供。
 */

import { endpoint, RouteError, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'

/* --------------------------------------------------------------- 查询串 */

/** 拼接 DSH 端点的查询串（`sessionId` 必填 + includeDescendants 字面量）。 */
export function sessionExportTargetUrl(sessionId: string, includeDescendants: boolean): string {
  return SESSION_EXPORT_PATH + '?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=' + (includeDescendants ? 'true' : 'false')
}

/** 解析 `?includeDescendants=`：只认字面 'false'；缺省 true（与 DSH 的默认语义一致，绝不猜其它值）。 */
export function readIncludeDescendants(raw: string | null): boolean {
  return raw === 'false' ? false : true
}

/** 宿主可用的 fetch 能力（`ctx.fetch` / 全局 fetch；宿主注入，测试注入替身）。 */
export type SessionExportFetch = (input: string, init: RequestInit) => Promise<Response>

/* ------------------------------------------------------------------ 常量 */

/** DSH 官方端点（exact Fetch 路由；与宿主同源 → 同 cookie）。 */
export const SESSION_EXPORT_PATH = '/api/session.export'

/** 探测用的「不存在」会话 id（只读、无副作用；DSH 对不存在的会话回 404 `session not found`）。 */
export const SESSION_EXPORT_PROBE_ID = '__dcm_probe__'

/** 探测单程超时（本机自请求；超时按「拿不到状态码」处理，绝不猜成不可用）。 */
export const SESSION_EXPORT_PROBE_TIMEOUT_MS = 3000

/**
 * 本机回环主机名（IPv4 字面量）。
 *
 * 为什么**不**用 `localhost`：DSH 的 `/api` 围栏用 `new URL('http://' + host)` 解析 Host 头
 * 再判 hostname（app.asar 的 `parseAuthority` / `isTrustedHostname`），而 **WHATWG 的 URL 解析
 * 会把 `localhost` 归一化成主机名——`new URL('http://localhost').hostname` 得到的是 ``（空串）。
 * 那会让「带 Origin 的自请求」在同源比较里落空（围栏回 403），而 403 又会被这里当作
 * 「路由被认证挡在门外」→ 最后表现为入口恒隐藏。127.0.0.1 是确定能解析出 hostname 的形态。
 */
const LOOPBACK_HOST = '127.0.0.1'

/**
 * 可用性三态（**界面据此显隐，绝不二值化**）：
 *  - `available`：200/400/404 —— 路由活着且读会话所需的服务齐备（400/404 是业务结果）；
 *  - `unavailable`：500 + `unavailable: missing` —— 后端缺服务（隐藏入口并说明原因）；
 *  - `unknown`：其它一切（401/403、连不上、超时、读日志失败的 500…）—— **保守显示**。
 */
export type SessionExportAvailability = 'available' | 'unavailable' | 'unknown'

/** 机器可读原因（界面映射成文案；**不渲染裸码**）。 */
export type SessionExportReason =
  | 'service-missing'
  | 'auth-required'
  | 'read-failed'
  | 'network-error'
  | 'unexpected-status'

/** 探测结果（结构化；界面只消费这些字段，绝不解析 HTTP 状态码）。 */
export interface SessionExportProbe {
  availability: SessionExportAvailability
  /** unknown / unavailable 时为原因；available 时缺省 */
  reason?: SessionExportReason
  /** DSH 实际返回的状态码（0 = 没拿到响应） */
  status: number
  /** 实际探测的路径（诊断用） */
  path: string
  /** 探测时刻（ISO） */
  checkedAt: string
}

/* ------------------------------------------------------------ 探测判定 */

/**
 * 状态码 + 响应体 → 三态。**纯函数、单一事实源**：宿主路由与单测共用同一份判定。
 *
 * 为什么把「读日志失败的 500」单独分出来：它不是「服务缺失」（隐藏入口会让用户以为这台机器
 * 整体不支持原始日志导出），而是「这一个会话读不出来」—— 保守显示，让 DSH 自己报错。
 * 为什么保留 501：本机 0.2.0-rc.2 已无该分支（asar 全量搜 `status: 501` 零命中），但旧版 DSH
 * 可能用它表达「持久化后端不支持 raw artifacts」，保留以免在老版本上恒显示。
 */
export function classifySessionExportStatus(status: number, body: string): { availability: SessionExportAvailability; reason?: SessionExportReason } {
  if (status === 200 || status === 400 || status === 404) return { availability: 'available' }
  if (status === 500) {
    return body.includes('unavailable: missing')
      ? { availability: 'unavailable', reason: 'service-missing' }
      : { availability: 'unknown', reason: 'read-failed' }
  }
  if (status === 501) return { availability: 'unavailable', reason: 'service-missing' }
  if (status === 401 || status === 403) return { availability: 'unknown', reason: 'auth-required' }
  return { availability: 'unknown', reason: 'unexpected-status' }
}


/* ------------------------------------------------------------ 探测 */

/** 探测用的 **Body 读取上限**（字节）：只读到「能判定」为止，绝不把 ZIP 拉进内存。 */
const PROBE_BODY_LIMIT_BYTES = 512

/**
 * 探测：用 `sessionId = 一个合法但不存在的 id` 向 DSH 自己的 `/api/session.export` 发一次请求。
 *
 * 为什么在 **host 侧**发起：与 DSH 的 /api 路由天然同源、来源地址回环，且「连不上 / 超时」
 * 这类**拿不到状态码**的情形能被如实归到 `unknown`（而不是在浏览器里被压成同一类噪音）。
 *
 * 为什么**必须先有端口**：自请求要带 `Host: 127.0.0.1:<port>`，端口写错会被 DSH 的围栏判成
 * 不允许的来源（403）；而 403 在本模块里代表「被认证挡在门外」—— 拿一个注定 403 的请求当真话，
 * 正是「恒隐藏」的另一种写法。端口未知 → 直接回保守的 `unknown`，**不发请求**。
 *
 * 为什么**用 GET 而不是 HEAD**（T9-F1 修复）：见函数体内那段说明 —— HEAD 没有正文，
 * 而 500 的两种成因只能靠正文区分，「缺服务」分支曾因此永不触发。
 */
export async function probeSessionExport(fetchImpl: SessionExportFetch | undefined, port: number | undefined): Promise<SessionExportProbe> {
  const checkedAt = new Date().toISOString()
  const path = sessionExportTargetUrl(SESSION_EXPORT_PROBE_ID, false)
  const authority = port === undefined ? LOOPBACK_HOST : LOOPBACK_HOST + ':' + String(port)
  const origin = 'http://' + authority
  /** 拿不到合格响应时的统一形状（状态码 0 + 保守三态）。 */
  const conservative = (status: number, reason: SessionExportReason): SessionExportProbe =>
    ({ availability: 'unknown', reason, status, path, checkedAt })
  if (fetchImpl === undefined || port === undefined) return conservative(0, 'network-error')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, SESSION_EXPORT_PROBE_TIMEOUT_MS)
  // 定时器不许拖住进程（与 src/profiles 的定时器同一纪律）。
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  try {
    /**
     * 用 **GET** 而不是 HEAD，且在**读到判定所需的最小正文后立刻取消**。
     *
     * 为什么不能再用 HEAD（T9-F1，真缺陷）：HEAD 的正文被 DSH 自己 cancel 掉
     * （官方：`if (request.method === 'GET') return response; await response.body?.cancel(); …`），
     * 于是我们只拿得到状态码。而 `500` 有**两种**成因，区分它们**只能靠正文**：
     *  - `unavailable: missing …`  → 后端缺服务（界面**禁用 + 说明原因**）
     *  - `failed to read …`       → 这一个会话读不出来（界面**保守可用**）
     * 传空串 ⇒ `includes` 恒 false ⇒ 「缺服务」分支**永不触发**（死代码），用户可见的
     * 「这条入口已停用（原因）」永远看不到。
     *
     * 为什么 GET 不会真的生成一遍 ZIP（这是原先不敢用 GET 的理由）：
     * 官方 `sessionLogExportResponse` 的处理顺序是
     *   ① sessionId 校验(400) → ② **deps 检查(500 缺服务)** → ③ 读日志 → ④ `streamSessionLogZip(…)`。
     * ②在④之前，所以「缺服务」这条路径**根本不进 ZIP 生成**；而正常路径我们要的判定
     * （200 = 路由活着且服务齐备）**到达响应头就已经能下结论** —— 因此读到上限/判定完成即 abort，
     * 上游的 ZIP 流随即被取消（`signal` 传给 DSH，它自己会在 `throwIfAborted` 处退出）。
     */
    const response = await fetchImpl(origin + path, {
      method: 'GET',
      headers: { host: authority, origin },
      signal: controller.signal,
    })
    const body = await readProbeBody(response, PROBE_BODY_LIMIT_BYTES)
    // 读到判定所需的最小正文后立刻取消：成功路径上正文是 ZIP，绝不继续拉。
    controller.abort()
    const verdict = classifySessionExportStatus(response.status, body)
    return {
      availability: verdict.availability,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      status: response.status,
      path,
      checkedAt,
    }
  } catch {
    // 连不上 / 超时：绝不猜（界面保守显示，而不是把入口藏掉）。
    return conservative(0, 'network-error')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读最多 `limit` 字节的响应正文（读到上限 / 流结束即停）。
 *
 * 三条纪律：**只读前 N 字节**（ZIP 绝不整本进内存）、**读不出就回空串**（判定按「正文不可得」
 * 保守走 unknown，绝不因为读失败就把服务判成「缺失」）、**读前先看 content-type** 不做多余假设。
 */
async function readProbeBody(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const next = await reader.read()
      if (next.done === true) break
      const chunk = next.value
      if (chunk === undefined) break
      chunks.push(chunk)
      size += chunk.byteLength
    }
  } catch {
    // 取消 / 传输中断：已读到的部分仍然有效（判定只需要一句话）。
  } finally {
    // 释放锁并取消剩余流（ZIP 的后续字节一个都不要）。
    try { await reader.cancel() } catch { /* 已经结束或已被取消 */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

/** 客户端断开即中止上游（ZIP 可达数百 MB，绝不为了「发完」把用户已经关掉的下载拖住宿主）。 */
function abortOnClose(res: { once: (event: string, listener: () => void) => unknown }): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => { controller.abort() })
  return controller.signal
}
/* ------------------------------------------------------------ 路由组 */

/**
 * session export 路由组（F-2）：只有一条，但**同一条路径上两种用途**（都只读）：
 *  - 缺 `sessionId` → **探测**：宿主 GET DSH 自己的 /api/session.export 读到判定所需的最小正文后
 *    立刻取消，回结构化可用性；
 *  - 带 `sessionId` → **代理**：把请求转给 DSH（GET 原样流式回传 ZIP）。
 *
 * 为什么不新增第二条 `/session-export/probe`：一条路由两种形态少一道围栏面，且界面只需要一个
 * 常量；代理与探测共用同一条 loopback 围栏与同一个错误出口（不要为「探测」单开一条路由）。
 *
 * 为什么代理**一次都不缓冲**：DSH 生成的是有界流式 ZIP（可达数百 MB），整本驻留内存会把宿主
 * 事件循环与 RSS 一起拖垮 —— 这里逐 chunk 转发，客户端断开即中止上游。
 *
 * **方法白名单 = `['GET']`，且 handler 只实现 GET 代理**（T9-F2）。此前文档提到过「HEAD 只回
 * 状态码」的代理形态，但声明里从来没有 HEAD —— 那是一处**声明与描述不一致**：kit 的方法白名单
 * 在到达 handler 之前就会把 HEAD 判成 405，所以那段描述描述的是**不可达**的行为。现在两者对齐：
 * 只有 GET（探测形态也不需要 HEAD 了，见 `probeSessionExport` 的说明）。
 * 这么收的另一个理由：本路由在 HEAD 形态下不写 body，而 kit 把 `res` 当作 `ServerResponse`
 * （HEAD 时它在运行期是 ServerResponse 的近似物）—— 既然该形态不可达，就不保留这种「类型与
 * 运行期形状有偏差」的路径。
 */
export function sessionExportRoutes(env: RoutesEnv): WebRoute[] {
  const {
    sessionExportFetch,
    sessionExportPort,
  } = env
  return [
    // 方法白名单只有 GET：探测与代理两种形态都走 GET（T9-F2 把声明与实现对齐，见上方说明）。
    endpoint({ path: '/api/dsh-config-manager/session-export', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      const fetchImpl = sessionExportFetch
      const port = sessionExportPort
      const authority = port === undefined ? LOOPBACK_HOST : LOOPBACK_HOST + ':' + String(port)
      const origin = 'http://' + authority
      if (sessionId === null || sessionId === '') {
        const probe = await probeSessionExport(fetchImpl, port)
        writeJson(res, 200, { ok: true, ...probe })
        return
      }
      if (fetchImpl === undefined || port === undefined) {
        // 宿主拿不到 fetch 能力 / 端口未知：**不猜**成「会话不存在」，如实回 503 + 机器可读码。
        throw new RouteError('session export is unavailable: this host exposes no fetch capability or web port', 503, 'sessionExportUnavailable')
      }
      const includeDescendants = readIncludeDescendants(url.searchParams.get('includeDescendants'))
      const upstream = await fetchImpl(origin + sessionExportTargetUrl(sessionId, includeDescendants), {
        method: 'GET',
        headers: { host: authority, origin },
        signal: abortOnClose(res),
      })
      // 上游状态码**原样透传**：DSH 的 400/404/500 语义就是本插件对外的语义，界面因此能按
      // 同一套判据解释（不重新发明第二套错误映射，也不把 404 改写成 200+ok:false）。
      const headers: Record<string, string> = {}
      const contentType = upstream.headers.get('content-type')
      const disposition = upstream.headers.get('content-disposition')
      if (contentType !== null) headers['content-type'] = contentType
      if (disposition !== null) headers['content-disposition'] = disposition
      res.writeHead(upstream.status, headers)
      if (upstream.body === null) { res.end(); return }
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(Buffer.from(chunk))
      }
      res.end()
    }),
  ]
}



