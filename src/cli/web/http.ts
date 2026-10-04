/**
 * 救急台的 HTTP 响应写出点（唯一）。
 *
 * 页面是**服务端直出**的静态 HTML：没有任何外部资源，因此 CSP 收得很紧
 * （default-src 'none' + 只允许内联样式 + **只放行那一段内联脚本**）。
 * 脚本不用 `'unsafe-inline'`，而是按 client-script.ts 的原文算 sha256 hash-source —— 浏览器只执行
 * 哈希逐字节匹配的那一段；其余任何内联脚本（例如被人塞进页面的）一律拒绝。hash 与页面内联的
 * 脚本同源（同一常量），改了脚本就必须同时改到这里，否则 CSP 会静默拦下它。
 *
 * `referrer-policy` **必须是 same-origin，不能是 no-referrer**：Chromium 在表单提交时把 Origin 头
 * 与 referrer 策略绑定，`no-referrer` 会让同源 POST 带上 `Origin: null` —— kit 的围栏
 * （`new URL(origin).host === host`）会把它判成非法来源，**救急台的所有写动作在真实浏览器里
 * 全部 403**（实测 Chrome 154：no-referrer → null；same-origin/strict-origin/默认策略 → 正常）。
 * same-origin 的强度并不降低：跨源请求仍然一个字节的 Referer 都不带（第三方零泄漏），
 * 而带一次性 token 的启动地址走 server.ts 的 302，那一步单独保持 `no-referrer`。
 */
import type { ServerResponse } from 'node:http'
import { consoleScriptCspHash } from './client-script.ts'

/** HTML 响应（content-type + no-store + referrer-policy + CSP 只在这一处维护）。 */
export function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
      + "script-src " + consoleScriptCspHash() + "; base-uri 'none'; form-action 'self'",
  })
  res.end(html)
}
