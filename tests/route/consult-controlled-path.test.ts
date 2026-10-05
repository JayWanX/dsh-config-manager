/**
 * routes-F3 回归：/consult 的 export-zip \`id\` 必须落在受控暂存区（isControlledPath），
 * 与 /analyze、/plan、/execute、/decrypt-archive、/market/prepare、/me/upload、/me/update、/download
 * 同一口径 —— 此前它把请求体里的 id 直接当路径交给 fs.readFile，任意绝对路径都会被打开。
 *
 * 判定基准：base 3f42a8b（暂存区外的真实文件 → 200 报告；暂存区外的不存在路径 → 500 + ENOENT）；
 * 修复后两者都是 400（读盘前前置拒绝），暂存区内的文件仍照常分析（正向控制，防误挡）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { consultRoutes } from '../../src/routes/consult.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const CONSULT_PATH = '/api/dsh-config-manager/consult'

/** 只喂 export-zip 分支真正读到的依赖（其余成员在 handler 里不会被读到）。 */
function stubEnv(roots: string[]): never {
  return {
    host: { dshVersion: '0.0.0-test', platform: 'win32', homeDir: '/nonexistent-home', profile: 'web' },
    makeImporter: () => ({
      analyzeImport: async () => ({ valid: false, sectionsInZip: [], errors: ['stub'] }),
      createImportPlan: async () => ({ items: [] }),
    }),
    makeSyncEngine: () => ({ preview: async () => ({ ok: false, zipPath: '', message: 'stub' }) }),
    prepareSync: async () => ({}),
    snapshotsDir: '/nonexistent-snapshots',
    roots,
  } as never
}

function consultRoute(roots: string[]): WebRoute {
  const route = consultRoutes(stubEnv(roots)).find((r) => r.path === CONSULT_PATH)
  assert.ok(route !== undefined, '缺少 ' + CONSULT_PATH)
  return route
}

function fakeRequest(body: unknown): IncomingMessage {
  return {
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  } as unknown as IncomingMessage
}

interface FakeResponse { status: number; body: string }

function fakeResponse(): { res: ServerResponse; state: FakeResponse } {
  const state: FakeResponse = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  return { res: res as unknown as ServerResponse, state }
}

async function callConsult(route: WebRoute, body: unknown): Promise<FakeResponse> {
  const { res, state } = fakeResponse()
  await route.handler(fakeRequest(body), res)
  return state
}

test('routes-F3 回归：/consult 的 export-zip id 必须落在受控暂存区（暂存区外一律 400，绝不打开）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-consult-f3-'))
  const staging = path.join(work, 'staging')
  fs.mkdirSync(staging, { recursive: true })
  const outsideExisting = path.join(work, 'outside.txt')
  fs.writeFileSync(outsideExisting, 'not a zip', 'utf8')
  const outsideMissing = path.join(work, 'nope-xyz.zip')
  const inside = path.join(staging, 'staged.zip')
  fs.writeFileSync(inside, 'not a zip either', 'utf8')
  const route = consultRoute([staging])
  try {
    // ① 暂存区外的**真实存在**文件：base 上被 readFile + 解析并回 200；修复后必须 400（不打开它）
    const outside1 = await callConsult(route, { type: 'export-zip', id: outsideExisting })
    assert.equal(outside1.status, 400, '暂存区外的路径必须被前置拒绝（base 上这里是 200）：' + outside1.body)
    // ② 暂存区外的**不存在**路径：base 上 fs.readFile 抛 ENOENT → 500（并把绝对路径回给调用方）
    const outside2 = await callConsult(route, { type: 'export-zip', id: outsideMissing })
    assert.equal(outside2.status, 400, '暂存区外的路径必须在读盘前被拒绝（base 上这里是 500 ENOENT）：' + outside2.body)
    assert.doesNotMatch(outside2.body, /ENOENT/, '不得把 fs 错误回给调用方：' + outside2.body)
    // ③ 正向控制：暂存区内的文件仍照常分析（非 zip → zipSlipIssues 报告，不抛）
    const insideRes = await callConsult(route, { type: 'export-zip', id: inside })
    assert.equal(insideRes.status, 200, '暂存区内路径不得被误挡：' + insideRes.body)
    // ④ 反向控制：空 id 仍走原有 400 文案
    const empty = await callConsult(route, { type: 'export-zip', id: '' })
    assert.equal(empty.status, 400)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
