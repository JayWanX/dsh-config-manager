/**
 * e2e-F4 回归：POST /snapshots/pin 对不存在的快照必须回**结构化 404**，
 * 不得把 fs 原始错误（含服务端绝对路径）回给浏览器。
 *
 * 证据：outputs/bug-audit/e2e/findings.md §1 F4 —— 真机回 404 + 裸 ENOENT + 绝对路径
 * （{"error":"ENOENT: no such file or directory, open 'D:\\...\\snapshots\\<id>\\snapshot.json'"}）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { snapshotRoutes } from '../../src/routes/snapshots.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const PIN_PATH = '/api/dsh-config-manager/snapshots/pin'

/** pin 分支只读 env.snapshotsDir 与 env.withMutationGate（其余成员不会被读到）。 */
function stubEnv(snapshotsDir: string): never {
  return {
    host: {}, msg: (key: string) => key, runs: {},
    snapshotEntrySections: async () => [],
    snapshotsDir,
    tryAppendHistory: async () => undefined,
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

function pinRoute(snapshotsDir: string): WebRoute {
  const route = snapshotRoutes(stubEnv(snapshotsDir)).find((r) => r.path === PIN_PATH)
  assert.ok(route !== undefined, '缺少 ' + PIN_PATH)
  return route
}

interface FakeResponse { status: number; body: string }

async function callPin(route: WebRoute, body: unknown): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const req = {
    method: 'POST', url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  } as unknown as IncomingMessage
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return state
}

test('e2e-F4 回归：不存在的快照 → 结构化 404（无 ENOENT、无服务端绝对路径）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-pin-f4-'))
  const snapshotsDir = path.join(work, 'snapshots')
  fs.mkdirSync(snapshotsDir, { recursive: true })
  const route = pinRoute(snapshotsDir)
  try {
    const r = await callPin(route, { snapshotId: '2026-01-01-aaaaaaaa', pinned: true })
    assert.equal(r.status, 404, '不存在的快照应为 404：' + r.body)
    const body = JSON.parse(r.body) as { error?: unknown; code?: unknown }
    assert.equal(body.code, 'snapshot-not-found', '必须有机器可读码（界面按码映射文案）：' + r.body)
    assert.equal(typeof body.error, 'string')
    assert.doesNotMatch(String(body.error), /ENOENT|no such file/i, '不得回传 fs 原始错误：' + r.body)
    assert.equal(r.body.includes(work), false, '不得回显服务端绝对路径：' + r.body)
    // 反向控制：非法 id 仍走原有 400（不受本次修改影响）
    const bad = await callPin(route, { snapshotId: '../evil', pinned: true })
    assert.equal(bad.status, 400, '非法 id 应为 400：' + bad.body)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
