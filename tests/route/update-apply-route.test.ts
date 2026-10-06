/**
 * 回归：POST /update-apply —— 关于页「立即更新」的宿主出口（插件自更新）。
 *
 * 四条钉住：
 *  ① 请求体里的 version 原样交给 env.selfUpdate，路由自己不读盘、不起子进程；
 *  ② 非法 JSON 体 → 400，且**绝不调用** selfUpdate（挡在写动作之前）；
 *  ③ 过 mutation gate 且 **journaled:false**（要 SAFE MODE + 环境锁，但不把插件安装失败记成
 *     NEEDS_ATTENTION 事故）—— 用直通包壳记录参数，防止将来有人把 gate 摘掉或改成 journaled；
 *  ④ 方法白名单只有 POST（GET → 405，与 kit 口径一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { prefsRoutes } from '../../src/routes/prefs.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'

const PATH = '/api/dsh-config-manager/update-apply'

interface Probes {
  gateOps: Array<{ op: string; opts: unknown }>
  versions: string[]
}

/** 本组路由在构造期只解构 syncDir / selfUpdate / withMutationGate（其余成员不读）。 */
function envFor(p: Probes): never {
  const env = {
    syncDir: '/tmp/dsh-cm-update-apply',
    selfUpdate: async (version: string) => {
      p.versions.push(version)
      return { ok: true, version, command: 'dsh plugin --profile web add dsh-config-manager@' + version, needsRestart: true }
    },
    withMutationGate: (op: string, handler: unknown, opts?: unknown) => {
      p.gateOps.push({ op, opts })
      return handler
    },
  }
  return env as never
}

function routeFor(p: Probes): WebRoute {
  const found = prefsRoutes(envFor(p)).find((r) => routeSpecOf(r)?.path === PATH)
  assert.ok(found !== undefined, '路由缺失: ' + PATH)
  return found
}

function fakeRequest(opts: { method?: string; body?: string } = {}): IncomingMessage {
  const req = {
    method: opts.method ?? 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8')
    },
  }
  return req as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  return { res: res as unknown as ServerResponse, status: () => state.status, json: () => JSON.parse(state.body) as unknown }
}

test('POST /update-apply：version 原样交给 selfUpdate，结构化结果原样回传', async () => {
  const p: Probes = { gateOps: [], versions: [] }
  const res = fakeResponse()
  await routeFor(p).handler(fakeRequest({ body: JSON.stringify({ version: '0.1.70' }) }), res.res)
  assert.equal(res.status(), 200)
  assert.deepEqual(p.versions, ['0.1.70'])
  assert.deepEqual(res.json(), {
    ok: true,
    version: '0.1.70',
    command: 'dsh plugin --profile web add dsh-config-manager@0.1.70',
    needsRestart: true,
  })
})

test('POST /update-apply：非法 JSON 体 → 400，且绝不调用 selfUpdate', async () => {
  const p: Probes = { gateOps: [], versions: [] }
  const res = fakeResponse()
  await routeFor(p).handler(fakeRequest({ body: '{not json' }), res.res)
  assert.equal(res.status(), 400)
  assert.deepEqual(p.versions, [])
  assert.equal((res.json() as { error?: string }).error, 'invalid JSON body')
})

test('POST /update-apply：version 非字符串 → 传空串（由 core 判定 invalid-version，不在路由里猜）', async () => {
  const p: Probes = { gateOps: [], versions: [] }
  const res = fakeResponse()
  await routeFor(p).handler(fakeRequest({ body: JSON.stringify({ version: 42 }) }), res.res)
  assert.equal(res.status(), 200)
  assert.deepEqual(p.versions, [''])
})

test('POST /update-apply：过 mutation gate 且 journaled:false（不记 NEEDS_ATTENTION 事故）', () => {
  const p: Probes = { gateOps: [], versions: [] }
  routeFor(p)
  assert.equal(p.gateOps.length, 1)
  assert.equal(p.gateOps[0]?.op, 'plugin-update')
  assert.deepEqual(p.gateOps[0]?.opts, { journaled: false })
})

test('GET /update-apply：方法白名单只认 POST → 405', async () => {
  const p: Probes = { gateOps: [], versions: [] }
  const res = fakeResponse()
  await routeFor(p).handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 405)
  assert.deepEqual(p.versions, [])
})
