/**
 * routes-F4 回归：/market/prepare 的响应**不得**回传已删除的发布中间目录。
 *
 * 背景：handler 先把中间目录打包成 publish-*.zip，再 fs.rm(dir) 清掉它（防 publish-* 在 tmp
 * 无限累积），却在响应里保留 dir 字段 —— 类型注释还写着「含 items/<id>/manifest.json + config.zip」。
 * 回传一个不存在的路径等于契约说谎。该字段全仓零消费者（客户端只用 zipPath），故直接删除。
 *
 * 判定基准：base 3f42a8b（响应含 dir 字段）；修复后响应只有真实存在的 zipPath。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { marketRoutes } from '../../src/routes/market.ts'
import { MANIFEST_FILE } from '../../src/schema/manifest.ts'
import { SECTION_JSON_PATHS } from '../../src/schema/config.ts'
import { zipToBuffer } from '../../src/utils/zip.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const PREPARE_PATH = '/api/dsh-config-manager/market/prepare'

/** 造一份能让 prepareMarketItem 过关的最小 bundle（内部 manifest + settings 分区 JSON）。 */
function minimalBundleZip(): Uint8Array {
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: '0.0.0-test' },
    source: { dshVersion: '0.0.0-test', platform: 'win32', arch: 'x64' },
    exportedAt: '2026-01-01T00:00:00.000Z',
    sections: { settings: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  }
  const settingsPath = SECTION_JSON_PATHS.settings
  assert.ok(settingsPath !== undefined, '注册表必须给出 settings 的 ZIP 内路径')
  return zipToBuffer([
    { name: MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: settingsPath, data: Buffer.from(JSON.stringify({ version: 1, namespaces: {} }), 'utf8') },
  ])
}

/** /market/prepare 只读 env.roots 与 env.tmpDir（其余成员在 handler 里不会被读到）。 */
function stubEnv(roots: string[], tmpDir: string): never {
  return { roots, tmpDir } as never
}

function prepareRoute(roots: string[], tmpDir: string): WebRoute {
  const route = marketRoutes(stubEnv(roots, tmpDir)).find((r) => r.path === PREPARE_PATH)
  assert.ok(route !== undefined, '缺少 ' + PREPARE_PATH)
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

test('routes-F4 回归：/market/prepare 不得回传已删除的发布目录（响应只有真实存在的 zipPath）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-market-f4-'))
  const staging = path.join(work, 'staging')
  const tmpDir = path.join(work, 'tmp')
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  const bundlePath = path.join(staging, 'bundle.zip')
  fs.writeFileSync(bundlePath, Buffer.from(minimalBundleZip()))
  const route = prepareRoute([staging], tmpDir)
  try {
    const { res, state } = fakeResponse()
    await route.handler(fakeRequest({ zipPath: bundlePath, itemId: 'cfg-a', name: 'Cfg A' }), res)
    assert.equal(state.status, 200, '最小合法 bundle 应当准备好发布条目：' + state.body)
    const body = JSON.parse(state.body) as Record<string, unknown>
    assert.equal(body['ok'], true)
    // 核心断言：不得再有说谎的 dir 字段（base 上这里存在）
    assert.equal('dir' in body, false, '响应不得回传已删除的发布中间目录 dir（base 上存在）: ' + state.body)
    // zipPath 必须是真实存在的产物（响应里的路径都要能读）
    const zipPath = body['zipPath']
    assert.equal(typeof zipPath, 'string')
    assert.equal(fs.existsSync(zipPath as string), true, 'zipPath 必须真实存在: ' + String(zipPath))
    // 发布清单自洽：manifestText 的 checksums.zip 必须等于回传的 sha256
    const manifestText = body['manifestText']
    assert.equal(typeof manifestText, 'string')
    const manifest = JSON.parse(manifestText as string) as { checksums: { zip: string }; sections: string[] }
    assert.equal(manifest.checksums.zip, body['sha256'])
    assert.deepEqual(manifest.sections, ['settings'])
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
