/**
 * routes-R2b（t53）回归：/consult 的 **remote-snapshot** 分支失败时不得把上游原始 message 回给调用方。
 *
 * 判定基准：base 3f42a8b = \`writeJson(res, 400, { error: preview.message ?? '远端快照不可用' })\`
 * → 上游（git/webdav）的错误文本（可能含远端 URL / 路径）原样进响应体（canary 命中）。
 * 修复后：400 \`{error:'remote snapshot unavailable', code:'consult-remote-unavailable'}\`；
 * 原始 message **只进日志**，且日志文本过 \`redact()\`（secret 形状的值被掩码）。与 t47 的
 * consultSourceFailure 同一口径（失败响应永不回显原始 message）。
 *
 * 用**可辨识 canary** 注入上游错误文本：断言它不出现在响应体里、但出现在日志里。
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

function stubEnv(roots: string[], preview: { ok: boolean; zipPath: string; message: string }): never {
  return {
    host: { dshVersion: '0.0.0-test', platform: 'win32', homeDir: '/nonexistent-home', profile: 'web' },
    makeImporter: () => ({
      analyzeImport: async () => ({ valid: false, sectionsInZip: [], errors: ['stub'] }),
      createImportPlan: async () => ({ items: [] }),
    }),
    makeSyncEngine: () => ({ preview: async () => preview }),
    prepareSync: async () => ({}),
    snapshotsDir: '/nonexistent-snapshots',
    roots,
  } as never
}

function consultRoute(env: never): WebRoute {
  const route = consultRoutes(env).find((r) => r.path === CONSULT_PATH)
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

test('routes-R2b（t53）：remote-snapshot 失败不得回显上游原始 message（canary 不进响应体，只进日志且过 redact）', async () => {
  const CANARY = 'CANARY-T53-' + Math.random().toString(16).slice(2, 10)
  const GITHUB_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwx'
  const upstream = CANARY + ' https://example.invalid/repo.git?token=' + GITHUB_TOKEN + ' path=D:\\secret\\staged.zip'
  const route = consultRoute(stubEnv([path.join(os.tmpdir(), 'no-roots')], { ok: false, zipPath: '', message: upstream }))

  const logged: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => { logged.push(args.map((a) => String(a)).join(' ')) }
  try {
    const r = await callConsult(route, {
      type: 'remote-snapshot',
      id: 'snap-1',
      snapshotId: 'snap-1',
      transport: 'git',
      repoUrl: 'https://example.invalid/repo.git',
    })
    // ① 响应体：结构化码 + 固定文案，canary / 远端 URL / secret 形状值一律不得出现
    assert.equal(r.status, 400, 'remote-snapshot 失败必须是 400：' + r.body)
    const parsed = JSON.parse(r.body) as { error?: unknown; code?: unknown }
    assert.equal(parsed.code, 'consult-remote-unavailable', '必须带机器可读码：' + r.body)
    assert.ok(!r.body.includes(CANARY), '响应体不得含上游 canary：' + r.body)
    assert.ok(!r.body.includes('example.invalid'), '响应体不得含远端 URL：' + r.body)
    assert.ok(!r.body.includes('ghp_'), '响应体不得含凭据形状的值：' + r.body)
    assert.ok(!r.body.includes('secret'), '响应体不得含路径片段：' + r.body)
    assert.ok(r.body.length < 200, '响应体必须是短结构化载荷：' + r.body)
    // ② 日志：原始 message 必须在（供定位），但 secret 形状的值被 redact() 掩码
    const logText = logged.join('\n')
    assert.ok(logText.includes(CANARY), '原始 message 必须进日志（否则无法定位）：' + logText)
    assert.ok(logText.includes('example.invalid'), '日志保留远端 URL 供定位：' + logText)
    assert.ok(!logText.includes(GITHUB_TOKEN), '日志里的凭据形状值必须被 redact() 掩码：' + logText)
    assert.ok(logText.includes('***REDACTED***'), 'redact() 必须留下掩码标记：' + logText)
  } finally {
    console.warn = origWarn
  }
})

test('routes-R2b（t53）正向控制：remote-snapshot 成功路径仍照常分析并清理临时目录', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-consult-remote-ok-'))
  const tmpZip = path.join(work, 'staged.zip')
  fs.writeFileSync(tmpZip, 'not a zip either', 'utf8')
  const route = consultRoute(stubEnv([path.join(os.tmpdir(), 'no-roots')], { ok: true, zipPath: tmpZip, message: '' }))
  const r = await callConsult(route, { type: 'remote-snapshot', id: 'snap-2', transport: 'git', repoUrl: 'https://example.invalid/repo.git' })
  assert.equal(r.status, 200, '成功路径不得被误挡：' + r.body.slice(0, 200))
  assert.equal(fs.existsSync(work), false, '临时 ZIP 目录必须被 try/finally 清理（dir=' + work + '）')
})
