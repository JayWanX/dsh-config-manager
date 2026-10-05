/**
 * R-7：recovery prefix 下 7 条 checkpoint 子路径的**接口守卫**（把 t14 的人工探针搬成正式测试）。
 *
 * 为什么必须有：引擎有 18 条单测，但接口面此前只有 outputs/ 下的人工探针 ——
 * 409 确认门 / 404 / 405 / 503 / unitId 解析一旦在重构中丢失，没有任何红灯。
 *
 * 纪律：
 *  - **真 http server + 真 fetch**（照 t19 的教训：涉及真实字节行为的断言不用替身）。
 *  - 起服只挂 recovery 组的 handler（与生产同一份 recoveryRoutes 产物，只经 kit 的 endpoint 包装）。
 *  - 真实临时 home/dataDir/工作区目录，真读真写：断言「未确认 → 零写入」必须落在**字节**上。
 *  - 本组仍是**一条** endpoint 声明（checkpoint 子路径靠 prefix 内部分发）→
 *    这里直接钉住 routes.length === 1，route-parity / route-fence 的计数因此不该变化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { recoveryRoutes } from '../../src/routes/recovery.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'

const BASE = '/api/dsh-config-manager/recovery'
const PROJECT_KEY = '--p--'
const SESSION_ID = 'session-abc'
const LOG_NAME = 'session.v4.jsonl.zstd'
const UNIT_ID = PROJECT_KEY + '/' + SESSION_ID

interface HistoryEntry {
  kind?: string
  result?: string
  summary?: string
  error?: string
}

interface Harness {
  root: string
  homeDir: string
  dataDir: string
  workspaceDir: string
  configFile: string
  logFile: string
  history: HistoryEntry[]
  safeMode: { blocked: boolean }
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-checkpoint-route-'))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const workspaceDir = path.join(root, 'proj')
  const logDir = path.join(homeDir, 'sessions', PROJECT_KEY, SESSION_ID)
  const logFile = path.join(logDir, LOG_NAME)
  const configFile = path.join(dataDir, 'sync', 'sync-config.json')
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.mkdir(logDir, { recursive: true })
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.writeFile(path.join(workspaceDir, 'x.txt'), 'X1')
  await fs.writeFile(configFile, '{"schemaVersion":1}')
  await fs.writeFile(logFile, 'LOGBYTES')
  // 会话静止期门（缺省 30s）在路由层是**真实生效**的：本测试用一条 10 分钟前就已存在的日志，
  // 使「回滚到该游标」这条路在缺省配置下也能走通（静止期门本身另有单测 T8 覆盖）。
  const old = new Date(Date.now() - 600_000)
  await fs.utimes(logFile, old, old)
  return {
    root, homeDir, dataDir, workspaceDir, configFile, logFile,
    history: [], safeMode: { blocked: false },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** 锁端口替身：恒 ACQUIRED（锁机制本身由 env-lock 自测覆盖；这里只让写路径能走通）。 */
function lockPort(): unknown {
  return {
    acquire: async () => ({
      state: 'ACQUIRED' as const,
      token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() },
    }),
    validate: () => true,
    release: async () => {},
  }
}

function envFor(h: Harness): never {
  const env = {
    dataDir: h.dataDir,
    host: {
      homeDir: h.homeDir,
      profile: 'web',
      mutationLock: lockPort(),
      safeModeIsBlocked: () => h.safeMode.blocked,
      log: { warn: () => {} },
    },
    sessionHealth: {
      homeDir: h.homeDir,
      targetFormatVersion: () => 4,
      workspaceKeys: async () => new Set<string>(),
      knownSessionIds: async () => new Set<string>(),
    },
    tryAppendHistory: async (raw: HistoryEntry) => { h.history.push(raw); return undefined },
    recoveryOrchestrator: {},
    makeRecoveryExecutors: () => ({}),
  }
  return env as never
}

function recoveryRoute(h: Harness): WebRoute {
  const routes = recoveryRoutes(envFor(h))
  // 本组只有一条 endpoint 声明（checkpoint 子路径在 prefix 内部分发）→ 计数不该变化
  assert.equal(routes.length, 1, 'recovery 组必须仍只有一条 endpoint 声明')
  const found = routes.find((r) => routeSpecOf(r)?.path === BASE)
  assert.ok(found !== undefined, 'recovery prefix 路由缺失')
  assert.equal(routeSpecOf(found)?.kind, 'prefix')
  return found
}

interface Server {
  base: string
  call: (sub: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: unknown }>
  close: () => Promise<void>
}

/** 起真 http server，只挂 recovery 组的 handler（handler 与生产同一份 endpoint() 包装）。 */
async function startServer(h: Harness): Promise<Server> {
  const route = recoveryRoute(h)
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'server 必须拿到端口')
  const base = 'http://127.0.0.1:' + String(address.port) + BASE
  return {
    base,
    call: async (sub: string, init?: { method?: string; body?: unknown }) => {
      const request: { method: string; headers?: Record<string, string>; body?: string } = { method: init?.method ?? 'GET' }
      if (init?.body !== undefined) {
        request.headers = { 'content-type': 'application/json' }
        request.body = JSON.stringify(init.body)
      }
      const res = await fetch(base + sub, request)
      let json: unknown = null
      try { json = await res.json() } catch { /* 无体 */ }
      return { status: res.status, json }
    },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()) }) },
  }
}

/* ------------------------------------------------------------- 取值助手 */

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function segmentsOf(json: unknown): { state: string; status: string; reasonCode?: string }[] {
  return arr(obj(json)['segments']).map((item) => {
    const s = obj(item)
    return { state: String(s['state']), status: String(s['status']), ...(s['reasonCode'] !== undefined ? { reasonCode: String(s['reasonCode']) } : {}) }
  })
}
async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8')
}
async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true } catch { return false }
}

/* ============================================================ R7-1 主链 */

test('R7-1 七条子路径全部可达 + 未确认回滚 409/denied/零写入 + 确认后三态覆盖恢复 + 历史留痕', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    // ① GET /checkpoints/storage
    const storage = await server.call('/checkpoints/storage')
    assert.equal(storage.status, 200, JSON.stringify(storage.json))
    assert.equal(obj(storage.json)['available'], true)

    // ② GET /checkpoints（空列表）
    const empty = await server.call('/checkpoints')
    assert.equal(empty.status, 200)
    assert.deepEqual(obj(empty.json)['records'], [])

    // ③ POST /checkpoints/capture（unitId 解析 → 三态都捕上）
    const captured = await server.call('/checkpoints/capture', {
      method: 'POST',
      body: { chunks: [h.workspaceDir], unitId: UNIT_ID, note: 'r7' },
    })
    assert.equal(captured.status, 200, JSON.stringify(captured.json).slice(0, 500))
    const captureBody = obj(captured.json)
    assert.equal(captureBody['ok'], true)
    const record = obj(captureBody['record'])
    const id = String(record['id'])
    assert.notEqual(id, '')
    assert.equal(obj(record['session'])['ok'], true, '会话态必须捕获成功')
    assert.equal(obj(record['workspace'])['ok'], true, '工作态必须捕获成功')
    assert.equal(obj(record['config'])['ok'], true, '配置态必须捕获成功')
    assert.equal(obj(obj(record['session'])['payload'])['logPath'], h.logFile, 'unitId 必须解析到该会话日志')
    // 「同点」= 三态 capturedAt 的跨度（同一调用内顺序捕获）；真实时钟下应为毫秒级
    assert.equal(typeof captureBody['spreadMs'], 'number')
    assert.ok(Number(captureBody['spreadMs']) < 1000, '同点跨度必须很小：' + String(captureBody['spreadMs']))

    // ④ GET /checkpoints/<id>（详情 + 同点事实）
    const detail = await server.call('/checkpoints/' + id)
    assert.equal(detail.status, 200)
    assert.equal(obj(obj(detail.json)['samePoint'])['samePoint'], true)

    // 捕获之后破坏三态：工作区内容、插件配置、会话日志（追加）
    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')
    await fs.writeFile(h.configFile, '{"schemaVersion":2}')
    await fs.appendFile(h.logFile, '+MORE')
    const old = new Date(Date.now() - 600_000)
    await fs.utimes(h.logFile, old, old)   // 让静止期门放行（见 makeHarness 注释）
    await fs.writeFile(path.join(h.workspaceDir, 'later.txt'), 'LATER')

    // ⑤ GET /checkpoints/<id>/preview（零写入）
    const preview = await server.call('/checkpoints/' + id + '/preview')
    assert.equal(preview.status, 200)
    const wsPreview = arr(obj(preview.json)['segments']).map(obj).find((s) => s['state'] === 'workspace')
    assert.equal(wsPreview?.['changed'], 1, '预览必须算出工作区 1 处改动')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN', '预览必须零写入')
    assert.equal(await readText(h.configFile), '{"schemaVersion":2}', '预览必须零写入')
    assert.equal(await readText(h.logFile), 'LOGBYTES+MORE', '预览必须零写入')

    // ⑥ POST /checkpoints/<id>/rewind —— 未确认：409 denied 且零写入
    const denied = await server.call('/checkpoints/' + id + '/rewind', { method: 'POST', body: { userConfirmed: false } })
    assert.equal(denied.status, 409, JSON.stringify(denied.json))
    assert.equal(obj(denied.json)['outcome'], 'denied')
    assert.equal(obj(denied.json)['code'], 'confirmation-required')
    assert.deepEqual(obj(denied.json)['segments'], [], '拒绝路径不得执行任何段')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN')
    assert.equal(await readText(h.configFile), '{"schemaVersion":2}')
    assert.equal(await readText(h.logFile), 'LOGBYTES+MORE')
    const afterDenied = await server.call('/checkpoints')
    assert.equal(arr(obj(afterDenied.json)['records']).length, 1, '拒绝路径不得留下 guard 检查点（零写入）')

    // ⑦ POST /checkpoints/<id>/rewind —— 确认：三态覆盖恢复（逐字节）
    const rewound = await server.call('/checkpoints/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off' },
    })
    assert.equal(rewound.status, 200, JSON.stringify(rewound.json).slice(0, 600))
    assert.equal(obj(rewound.json)['outcome'], 'restored', JSON.stringify(segmentsOf(rewound.json)))
    const byState = new Map(segmentsOf(rewound.json).map((s) => [s.state, s]))
    assert.equal(byState.get('workspace')?.status, 'restored')
    assert.equal(byState.get('config')?.status, 'restored')
    assert.equal(byState.get('session')?.status, 'restored', JSON.stringify(segmentsOf(rewound.json)))
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1')
    assert.equal(await readText(h.configFile), '{"schemaVersion":1}')
    assert.equal(await readText(h.logFile), 'LOGBYTES')
    // 覆盖恢复绝不删除：检查点之后新建的文件仍在，并被如实报告
    assert.equal(await readText(path.join(h.workspaceDir, 'later.txt')), 'LATER')
    const wsSegmentRaw = arr(obj(rewound.json)['segments']).map(obj).find((s) => s['state'] === 'workspace')
    assert.deepEqual(wsSegmentRaw?.['leftovers'], [path.join(h.workspaceDir, 'later.txt')])

    // ⑧ POST /checkpoints/<id>/delete（确认后删普通检查点）
    const delNoConfirm = await server.call('/checkpoints/' + id + '/delete', { method: 'POST', body: {} })
    assert.equal(delNoConfirm.status, 409)
    assert.equal(obj(delNoConfirm.json)['code'], 'confirmation-required')
    const deleted = await server.call('/checkpoints/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
    assert.equal(obj(deleted.json)['ok'], true)
    assert.equal(await exists(path.join(h.dataDir, 'checkpoints', 'index.json')), true)

    // ⑨ 历史留痕：capture 与 rewind 各一条
    assert.ok(h.history.some((entry) => String(entry.summary ?? '').includes('检查点捕获')), 'capture 必须留痕')
    assert.ok(h.history.some((entry) => String(entry.summary ?? '').includes('检查点回滚')), 'rewind 必须留痕')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R7-2 404 / 405 / 400 */

test('R7-2 语义：未知 id → 404；未知子路径 → 404；方法不对 → 405；非法 unitId → 400', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    // 未知 id（详情 / 预览 / 回滚 / 删除四条都必须是 404，而不是 500 或 200）
    assert.equal((await server.call('/checkpoints/cp-nope')).status, 404)
    assert.equal((await server.call('/checkpoints/cp-nope/preview')).status, 404)
    const rewindMissing = await server.call('/checkpoints/cp-nope/rewind', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(rewindMissing.status, 404)
    assert.equal(obj(rewindMissing.json)['code'], 'record-not-found')
    assert.equal((await server.call('/checkpoints/cp-nope/delete', { method: 'POST', body: { userConfirmed: true } })).status, 404)
    // 未知子路径
    assert.equal((await server.call('/checkpoints/cp-nope/nope')).status, 404)
    assert.equal((await server.call('/checkpoints/nope/deep/deeper')).status, 404)

    // 方法不对（kit 的方法白名单放行 GET/POST，具体子路径各自再判一次）
    assert.equal((await server.call('/checkpoints', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/checkpoints/storage', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/checkpoints/capture')).status, 405)
    assert.equal((await server.call('/checkpoints/cp-nope', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/checkpoints/cp-nope/preview', { method: 'POST', body: {} })).status, 405)
    assert.equal((await server.call('/checkpoints/cp-nope/rewind')).status, 405)
    assert.equal((await server.call('/checkpoints/cp-nope/delete')).status, 405)

    // 非法 unitId（含路径穿越）→ 400（绝不猜、绝不写）
    const traversal = await server.call('/checkpoints/capture', { method: 'POST', body: { chunks: [h.workspaceDir], unitId: '../../etc/passwd' } })
    assert.equal(traversal.status, 400)
    assert.equal(obj(traversal.json)['code'], 'invalid-input')
    const unknownUnit = await server.call('/checkpoints/capture', { method: 'POST', body: { chunks: [h.workspaceDir], unitId: PROJECT_KEY + '/missing-session' } })
    assert.equal(unknownUnit.status, 400)
    assert.equal(await exists(path.join(h.dataDir, 'checkpoints', 'index.json')), false, '拒绝路径不得落任何检查点')

    // 请求体非法 JSON → 400（不是 500）
    const raw = await fetch(server.base + '/checkpoints/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    assert.equal(raw.status, 400)
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ========================================================= R7-3 存储不可用 */

test('R7-3 存储栈不可用：列表/状态/捕获/预览/回滚/删除都 503 + 结构化 guidance（不抛错、不崩）', async () => {
  const h = await makeHarness()
  // 让检查点库根路径被一个**普通文件**占住 → 引擎的缺省探针（mkdir + 写探针）必然失败
  await fs.mkdir(h.dataDir, { recursive: true })
  await fs.writeFile(path.join(h.dataDir, 'checkpoints'), 'not-a-dir')
  const server = await startServer(h)
  try {
    const list = await server.call('/checkpoints')
    assert.equal(list.status, 503, JSON.stringify(list.json))
    const listStorage = obj(obj(list.json)['storage'])
    assert.equal(listStorage['available'], false)
    const guidance = arr(listStorage['guidance']).map(obj)
    const codes = guidance.map((g) => String(g['code']))
    assert.ok(codes.includes('checkpoint.guidance.mountStorage'), JSON.stringify(codes))
    assert.ok(codes.includes('checkpoint.guidance.fixDataDir'))
    assert.ok(arr(listStorage['requirements']).map(String).includes('@deepseek-ai/dsh-storage'))

    const storage = await server.call('/checkpoints/storage')
    assert.equal(storage.status, 503)
    assert.equal(obj(storage.json)['available'], false)
    assert.equal(typeof obj(storage.json)['detail'], 'string')

    const capture = await server.call('/checkpoints/capture', { method: 'POST', body: { chunks: [h.workspaceDir], unitId: UNIT_ID } })
    assert.equal(capture.status, 503)
    assert.equal(obj(capture.json)['ok'], false)
    assert.equal(obj(capture.json)['code'], 'storage-unavailable')
    assert.ok(arr(obj(capture.json)['guidance']).length > 0, '失败必须带结构化指引')

    assert.equal((await server.call('/checkpoints/cp-any/preview')).status, 503)
    assert.equal((await server.call('/checkpoints/cp-any/rewind', { method: 'POST', body: { userConfirmed: true } })).status, 503)
    assert.equal((await server.call('/checkpoints/cp-any/delete', { method: 'POST', body: { userConfirmed: true } })).status, 503)
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X1', '存储不可用时绝不写工作区')

    // 服务没崩：后面还能正常回答（503 是结论，不是崩溃）
    assert.equal((await server.call('/checkpoints')).status, 503)
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R7-4 保护检查点（传输层） */

test('R7-4 保护检查点：即使确认了也不可回滚（409 protected-checkpoint）、不可删除（409）', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const captured = await server.call('/checkpoints/capture', {
      method: 'POST',
      body: { chunks: [h.workspaceDir], unitId: UNIT_ID, protect: true },
    })
    assert.equal(captured.status, 200)
    const id = String(obj(obj(captured.json)['record'])['id'])
    assert.equal(obj(obj(captured.json)['record'])['protected'], true)

    await fs.writeFile(path.join(h.workspaceDir, 'x.txt'), 'X-BROKEN')
    const rewind = await server.call('/checkpoints/' + id + '/rewind', {
      method: 'POST',
      body: { userConfirmed: true, preRewindGuard: 'off' },
    })
    assert.equal(rewind.status, 409, JSON.stringify(rewind.json))
    assert.equal(obj(rewind.json)['outcome'], 'denied')
    assert.equal(obj(rewind.json)['code'], 'protected-checkpoint')
    assert.equal(await readText(path.join(h.workspaceDir, 'x.txt')), 'X-BROKEN', '保护点绝不写任何字节')

    const del = await server.call('/checkpoints/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(del.status, 409)
    assert.equal(obj(del.json)['code'], 'protected-checkpoint')
    const list = await server.call('/checkpoints')
    assert.equal(arr(obj(list.json)['records']).length, 1, '保护点必须还在')
  } finally {
    await server.close()
    await h.cleanup()
  }
})

/* ==================================================== R7-5 SAFE MODE（写路径同口径） */

test('R7-5 SAFE MODE：回滚/删除被 423 拒绝；只读的列表与预览不受影响', async () => {
  const h = await makeHarness()
  const server = await startServer(h)
  try {
    const captured = await server.call('/checkpoints/capture', {
      method: 'POST',
      body: { chunks: [h.workspaceDir], unitId: UNIT_ID },
    })
    assert.equal(captured.status, 200, 'capture 是救援点：SAFE MODE 之前可用')
    const id = String(obj(obj(captured.json)['record'])['id'])

    h.safeMode.blocked = true
    const rewind = await server.call('/checkpoints/' + id + '/rewind', { method: 'POST', body: { userConfirmed: true } })
    assert.equal(rewind.status, 423, JSON.stringify(rewind.json))
    assert.equal(obj(rewind.json)['code'], 'mutation-locked')
    assert.equal((await server.call('/checkpoints/' + id + '/delete', { method: 'POST', body: { userConfirmed: true } })).status, 423)
    assert.equal((await server.call('/checkpoints')).status, 200, '只读列表不受 SAFE MODE 影响')
    assert.equal((await server.call('/checkpoints/' + id + '/preview')).status, 200, '只读预览不受 SAFE MODE 影响')
  } finally {
    await server.close()
    await h.cleanup()
  }
})
