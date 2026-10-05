/**
 * F-2 路由行为测试：`GET /api/dsh-config-manager/session-export`（官方 session.export 通道）。
 *
 * 为什么必须有：这条路由是「会话在应用内读不出来」的答案，而它最容易犯的错**不是**功能错、
 * 而是**判据错** —— 生态竞品普遍用 `res.status !== 501` 探测可用性，而本机 DSH 0.2.0-rc.2 的
 * app.asar 全量搜 `status: 501` **零命中**：服务缺失实际返 **500**。照抄会让入口**几乎恒显示**
 * （「显示」是对的但判据是巧合），而更糟的镜像错误是**恒隐藏**。这里逐条钉住四态：
 *
 *  - 400 / 404 → `available`（路由活着且读会话所需的服务齐备；400/404 是**业务结果**，不是环境问题）
 *  - 500 + `unavailable: missing` → `unavailable`（后端缺服务：界面**禁用并说明原因**）
 *  - 500（读日志失败）→ `unknown`（**保守显示**，绝不混进「缺服务」而把入口藏掉）
 *  - 200 → `available`
 *  - 401 / 403 → `unknown`（**不据此隐藏**：那是「被认证挡在门外」，先修请求）
 *  - 连不上 / 超时 / 端口未知 → `unknown`（绝不猜成不可用）
 *
 * 另外钉住代理侧的两条硬边界：上游状态码**原样透传**（不把 404 改写成 200+ok:false）、
 * 上游 ZIP 字节**逐块转发**（不整本缓冲），以及「缺 sessionId 且没有 fetch/端口」时的诚实降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  classifySessionExportStatus,
  probeSessionExport,
  readIncludeDescendants,
  SESSION_EXPORT_PATH,
  SESSION_EXPORT_PROBE_ID,
  sessionExportRoutes,
  sessionExportTargetUrl,
} from '../../src/routes/session-export.ts';
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts';

const ROUTE = '/api/dsh-config-manager/session-export';

/* --------------------------------------------------------------- 夹具 */

function fakeRequest(url: string, method = 'GET'): IncomingMessage {
  const req = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> { /* 无 body */ },
  };
  return req as unknown as IncomingMessage;
}

interface FakeResponse {
  res: ServerResponse;
  status: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  ended: boolean;
  readBody: () => string;
}

function fakeResponse(): FakeResponse {
  const state = { status: 0, headers: {} as Record<string, string>, chunks: [] as Buffer[], ended: false };
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      if (headers !== undefined) for (const [k, v] of Object.entries(headers)) state.headers[k.toLowerCase()] = v;
      this.headersSent = true;
      return this;
    },
    write(chunk: Uint8Array) { state.chunks.push(Buffer.from(chunk)); return true; },
    end(payload?: string) {
      if (payload !== undefined) state.chunks.push(Buffer.from(payload, 'utf8'));
      state.ended = true;
      return this;
    },
    once() { /* 测试里不触发 close */ },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() { return state.status },
    get headers() { return state.headers },
    get chunks() { return state.chunks },
    get ended() { return state.ended },
    readBody: () => Buffer.concat(state.chunks).toString('utf8'),
  };
}

/** 造一组路由：fetch 能力与端口显式给（宿主生产的取值形状）。 */
function routesFor(fetchImpl: unknown, port: number | undefined): WebRoute[] {
  return sessionExportRoutes({
    sessionExportFetch: fetchImpl,
    sessionExportPort: port,
  } as never);
}

function routeFor(fetchImpl: unknown, port: number | undefined = 3080): WebRoute {
  const found = sessionExportRoutes({ sessionExportFetch: fetchImpl, sessionExportPort: port } as never)
    .find((r) => routeSpecOf(r)?.path === ROUTE);
  assert.ok(found !== undefined, '缺少路由: ' + ROUTE);
  return found;
}

/** 一次被记录的自请求。 */
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** 记录每一次自请求（url / method / headers），供断言。 */
function recorder(response: Response): { calls: RecordedCall[]; fetch: unknown } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string> });
      return response;
    },
  };
}

/* ------------------------------------------------- 1) 纯判定：四态 */

test('四态判定：400 / 404 → available（业务结果，不是环境问题）', () => {
  for (const status of [400, 404]) {
    const verdict = classifySessionExportStatus(status, '');
    assert.equal(verdict.availability, 'available', 'status ' + String(status) + ' 应判为可用');
    assert.equal(verdict.reason, undefined, 'available 不该带原因');
  }
  // 200 = 真的拿到了 ZIP：路由活着、服务齐备
  assert.equal(classifySessionExportStatus(200, '').availability, 'available');
});

test('四态判定：500 + unavailable: missing → unavailable（缺服务，界面禁用并说明原因）', () => {
  const body = 'session log export is unavailable: missing session-query, session-persistence, or attachments service';
  const verdict = classifySessionExportStatus(500, body);
  assert.equal(verdict.availability, 'unavailable');
  assert.equal(verdict.reason, 'service-missing');
});

test('四态判定：读日志失败的 500 → unknown（保守显示，绝不混进「缺服务」）', () => {
  const verdict = classifySessionExportStatus(500, 'session log export failed to read the stored log');
  assert.equal(verdict.availability, 'unknown', '「这一个会话读不出来」不等于「本机不支持」');
  assert.equal(verdict.reason, 'read-failed');
});

test('四态判定：401 / 403 → unknown（被认证挡在门外，不据此隐藏）', () => {
  for (const status of [401, 403]) {
    const verdict = classifySessionExportStatus(status, '');
    assert.equal(verdict.availability, 'unknown');
    assert.equal(verdict.reason, 'auth-required');
  }
});

test('四态判定：501（旧版兼容分支）→ unavailable，其它状态 → unknown', () => {
  assert.equal(classifySessionExportStatus(501, '').availability, 'unavailable');
  const odd = classifySessionExportStatus(418, '');
  assert.equal(odd.availability, 'unknown');
  assert.equal(odd.reason, 'unexpected-status');
});

test('反例护栏：**绝不**用 `status !== 501` 当判据（竞品的过时探测）', () => {
  // 竞品写法：res.status !== 501 → 显示。在 500（缺服务）下它会判成「显示」，
  // 而正确判据必须判成「不可用」。这条断言把两者的差异钉死，防止将来有人把判据改回去。
  const competitorVerdict = (status: number): boolean => status !== 501;
  assert.equal(competitorVerdict(500), true, '竞品判据在 500 下会显示（这正是它过时的原因）');
  assert.equal(competitorVerdict(403), true, '竞品判据在 403 下也会显示');
  assert.equal(classifySessionExportStatus(500, 'session log export is unavailable: missing x').availability, 'unavailable');
});

/* ---------------------------------- 2.1) T9-F1 核心：500 的两种成因必须可分 */

const SERVICE_MISSING_BODY = 'session log export is unavailable: missing session-query, session-persistence, or attachments service';
const READ_FAILED_BODY = 'session log export failed to read the stored log';

/** 真实 HTTP 探针：把一段「上游」放到真 node:http 服务上，走真 socket 探它。
 *
 * 为什么不能只用 fetch 替身：替身会**替我们决定**响应的形状 —— 而 T9-F1 恰恰是
 * 「响应有没有正文」这件事上的错觉（HEAD 的 body 被 DSH cancel 掉，我们却以为状态码够用）。
 * 只有真 HTTP 才能证明「我们确实读到了上游写的那句话」。 */
async function withUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (port: number) => Promise<void>,
  opts: { record?: { aborted?: boolean; bodiesSent?: string[] } } = {},
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(port)
  } finally {
    void opts
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

test('T9-F1 核心断言：缺服务（500 + unavailable: missing）→ unavailable / service-missing', async () => {
  // 这是本次修复的核心：修之前这里恒为 unknown/read-failed（判据永不触发 = 死代码）。
  await withUpstream(
    (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(SERVICE_MISSING_BODY)
    },
    async (port) => {
      // 用**真** fetch（不是替身）：它会把上游正文按流交给我们，正是运行期的形状。
      const probe = await probeSessionExport((input, init) => fetch(input, init), port)
      assert.equal(probe.availability, 'unavailable', '缺服务必须判为 unavailable（界面据此禁用并说明原因）')
      assert.equal(probe.reason, 'service-missing')
      assert.equal(probe.status, 500)
    },
  )
})

test('T9-F1 对称断言：读日志失败（500 但正文不同）→ **unknown / read-failed**（绝不混进缺服务）', async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(READ_FAILED_BODY)
    },
    async (port) => {
      const probe = await probeSessionExport((input, init) => fetch(input, init), port)
      assert.equal(probe.availability, 'unknown', '「这一个会话读不出来」不等于「本机不支持」')
      assert.equal(probe.reason, 'read-failed')
    },
  )
})

test('T9-F1 回归护栏：探测**不是** HEAD（HEAD 拿不到正文 ⇒ 缺服务分支会再次变成死代码）', async () => {
  // 把上游做成「只有 GET 才给正文、HEAD 一律空体」，模拟 DSH 的 HEAD 分支（它自己 cancel body）。
  const methods: string[] = []
  await withUpstream(
    (req, res) => {
      methods.push(String(req.method))
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(req.method === 'GET' ? SERVICE_MISSING_BODY : '')
    },
    async (port) => {
      const probe = await probeSessionExport((input, init) => fetch(input, init), port)
      assert.deepEqual(methods, ['GET'], '探测必须用 GET（HEAD 无正文，判据会恒落 read-failed）')
      assert.equal(probe.availability, 'unavailable', '用 GET 才读得到那句话，缺服务分支才活着')
      assert.equal(probe.reason, 'service-missing')
    },
  )
})

test('T9-F1：探测到响应头即止 —— 不把上游的 ZIP 流整本拉走（到判定所需的最小正文就取消）', async () => {
  // 上游模拟成功路径：先写头 + 一小段正文，再持续吐「ZIP」数据直到下游断开。
  // 关键断言：探测返回后，上游**没有**被读完整（否则等于为了探测生成了一遍 ZIP）。
  let upstreamWrote = 0
  let upstreamEnded = false
  await withUpstream(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' })
      const chunk = Buffer.alloc(64 * 1024, 7)
      const push = (): void => {
        if (res.writableEnded || res.destroyed) { upstreamEnded = true; return }
        // 一直写到下游断开（模拟几百 MB 的 ZIP）
        if (res.write(chunk)) { upstreamWrote += chunk.length; setImmediate(push) }
        else { res.once('drain', () => { upstreamWrote += chunk.length; setImmediate(push) }) }
      }
      push()
    },
    async (port) => {
      const probe = await probeSessionExport((input, init) => fetch(input, init), port)
      assert.equal(probe.availability, 'available', '200 = 路由活着且服务齐备')
      // 给上游一点时间真正观察到断开
      await new Promise((r) => { setTimeout(r, 150) })
      assert.ok(
        upstreamWrote < 8 * 1024 * 1024,
        '探测必须尽早取消：上游最多只应写了一小段（实际 ' + String(upstreamWrote) + ' 字节）；' +
        '若接近整本，说明我们把 ZIP 拉完了（原设计正是要避免这个）',
      )
    },
  )
  void upstreamEnded
})

test('T9-F1：401 / 403 → unknown（被认证挡在门外，不据此隐藏）', async () => {
  for (const status of [401, 403]) {
    await withUpstream(
      (_req, res) => { res.writeHead(status); res.end('unauthorized') },
      async (port) => {
        const probe = await probeSessionExport((input, init) => fetch(input, init), port)
        assert.equal(probe.availability, 'unknown', 'status ' + String(status) + ' 必须保守显示')
        assert.equal(probe.reason, 'auth-required')
      },
    )
  }
})

test('T9-F1：连不上（真端口拒连）→ unknown，绝不猜', async () => {
  // 先占一个端口再关掉，拿到一个「几乎肯定没人听」的端口号。
  const probe = await probeSessionExport((input, init) => fetch(input, init), await closedPort())
  assert.equal(probe.availability, 'unknown')
  assert.equal(probe.reason, 'network-error')
  assert.equal(probe.status, 0)
})

/** 一个刚被释放、几乎肯定无人监听的端口（真拒连，而不是替身造出来的异常）。 */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}
/* --------------------------------------------- 2) 探测：真实请求形状 */

test('探测：GET 打对端点，Host/Origin 带 web 端口（DSH 的围栏按 Host 判本机）', async () => {
  const { calls, fetch } = recorder(new Response('', { status: 404 }));
  const probe = await probeSessionExport(fetch as never, 3080);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET', '探测必须走 GET —— HEAD 没有正文，500 的两种成因无法区分（T9-F1）');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:3080' + SESSION_EXPORT_PATH + '?sessionId=' + encodeURIComponent(SESSION_EXPORT_PROBE_ID) + '&includeDescendants=false');
  assert.equal(calls[0]?.headers['host'], '127.0.0.1:3080');
  assert.equal(calls[0]?.headers['origin'], 'http://127.0.0.1:3080');
  assert.equal(probe.availability, 'available');
  assert.equal(probe.status, 404);
  assert.equal(probe.path, SESSION_EXPORT_PATH + '?sessionId=' + encodeURIComponent(SESSION_EXPORT_PROBE_ID) + '&includeDescendants=false');
  assert.ok(probe.checkedAt.length > 0, '必须带探测时刻');
});

test('探测：缺 fetch 能力 / 端口未知 → unknown 且**不发请求**（绝不猜成不可用）', async () => {
  const { calls, fetch } = recorder(new Response('', { status: 200 }));
  for (const probe of [await probeSessionExport(undefined, 3080), await probeSessionExport(fetch as never, undefined)]) {
    assert.equal(probe.availability, 'unknown');
    assert.equal(probe.reason, 'network-error');
    assert.equal(probe.status, 0);
  }
  assert.equal(calls.length, 0, '拿不到端口时必须一个请求都不发（注定 403 的请求不是真话）');
});

test('探测：fetch 抛错（连不上 / 超时）→ unknown，绝不猜', async () => {
  const probe = await probeSessionExport((() => { throw new Error('ECONNREFUSED') }) as never, 3080);
  assert.equal(probe.availability, 'unknown');
  assert.equal(probe.reason, 'network-error');
  assert.equal(probe.status, 0);
});

/* --------------------------------------------- 3) 路由：探测与代理 */

test('路由：缺 sessionId = 探测，回结构化三态（HTTP 200 + ok:true）', async () => {
  const { fetch } = recorder(new Response(null, { status: 500 }));
  const route = routeFor(fetch);
  const res = fakeResponse();
  await route.handler(fakeRequest(ROUTE), res.res);
  assert.equal(res.status, 200, '探测本身永远 200（离线/缺服务是环境事实，不是路由故障）');
  const body = JSON.parse(res.readBody()) as { ok: boolean; availability: string; status: number };
  assert.equal(body.ok, true);
  // HEAD 拿不到正文 → 500 一律按「读失败」保守处理（正文判据在浏览器侧不可达）。
  assert.equal(body.availability, 'unknown');
  assert.equal(body.status, 500);
});

test('路由：带 sessionId = 代理，上游状态码**原样透传**（不把 404 改写成 200）', async () => {
  const { calls, fetch } = recorder(new Response(null, { status: 404 }));
  const route = routeFor(fetch);
  const res = fakeResponse();
  await route.handler(fakeRequest(ROUTE + '?sessionId=abc'), res.res);
  assert.equal(res.status, 404, '上游 404 必须原样透传（DSH 的语义就是本插件对外的语义）');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:3080' + SESSION_EXPORT_PATH + '?sessionId=abc&includeDescendants=true');
  assert.equal(calls[0]?.method, 'GET');
});

test('路由：代理 ZIP 字节逐块转发（不整本缓冲），并透传 content-type / content-disposition', async () => {
  const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const upstream = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-abc.zip"' },
  });
  const { fetch } = recorder(upstream);
  const route = routeFor(fetch);
  const res = fakeResponse();
  await route.handler(fakeRequest(ROUTE + '?sessionId=abc'), res.res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="dsh-session-abc.zip"');
  assert.equal(res.chunks.length, 2, '必须逐块转发（2 个上游 chunk → 2 次 write），不整本缓冲');
  assert.deepEqual(Array.from(Buffer.concat(res.chunks)), [1, 2, 3, 4, 5]);
  assert.equal(res.ended, true);
});

test('路由：代理时缺 fetch/端口 → 503（如实拒绝，不猜成「会话不存在」）', async () => {
  const route = routeFor(undefined, undefined);
  const res = fakeResponse();
  await route.handler(fakeRequest(ROUTE + '?sessionId=abc'), res.res);
  assert.equal(res.status, 503);
  const body = JSON.parse(res.readBody()) as { code?: string };
  assert.equal(body.code, 'sessionExportUnavailable');
});

test('路由：includeDescendants 只认字面 false（其余一律按 true，不猜）', () => {
  assert.equal(readIncludeDescendants('false'), false);
  assert.equal(readIncludeDescendants('true'), true);
  assert.equal(readIncludeDescendants(null), true);
  assert.equal(readIncludeDescendants('1'), true, '非字面值不猜：按缺省 true');
  assert.equal(sessionExportTargetUrl('a b', true), SESSION_EXPORT_PATH + '?sessionId=a%20b&includeDescendants=true');
});

/* --------------------------------------------- 4) 结构不变量 */

test('结构不变量：只声明一条路由（GET），且经 endpoint() 注册', () => {
  const routes = routesFor(async () => new Response(null, { status: 404 }), 3080);
  assert.equal(routes.length, 1, '探测与代理共用同一条路由（少一道围栏面）');
  const spec = routeSpecOf(routes[0]!);
  assert.ok(spec !== undefined, '必须出自 kit 的 endpoint()');
  assert.equal(spec.path, ROUTE);
  assert.deepEqual([...spec.methods], ['GET']);
  assert.equal(spec.kind, 'exact');
});
