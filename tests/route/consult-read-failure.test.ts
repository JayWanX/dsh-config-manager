/**
 * routes-R1（t47）回归：/consult 在**受控区内**的读失败必须回结构化码，且不回显 fs 原文/服务端绝对路径。
 *
 * 判定基准：base 3f42a8b —— 受控区内的 5 种形态都走顶层 catch → 500 + fs 原文
 * （\`{"error":"ENOENT: no such file or directory, open 'C:\\…\\staging\\staged.zip '"}\` /
 *  \`{"error":"EISDIR: illegal operation on a directory, read"}\`，见 outputs/bug-audit/verify-routes/attacks-base.log L30-39）。
 * 修复后：不存在类 → 404 \`consult-source-not-found\`、目录自身（EISDIR）→ 400 \`consult-source-unreadable\`，
 * 与 /snapshots/pin（e2e-F4）同口径（机器可读码 + 固定文案，永不回显原始 message）。
 * 正向控制：受控区内**可读**的文件仍照常分析 → 200（修复不得误挡）。
 *
 * routes-R2（t47，**不在此文件建测试**）：\`isDecryptedPlaintextArtifact(非字符串)\` 在路由层**不可达**，
 * 理由与证据见 t47 的 output（该纯函数属 src/routes/import.ts —— 不在本任务 inScope；唯一调用点前置了
 * \`typeof body?.['zipPath'] === 'string'\` 收窄 + \`isControlledPath\` 校验）。若日后把该守卫加进 import.ts，
 * 应同时在 t29 的 tests/route/decrypt-plaintext-cleanup.test.ts 侧补「非字符串入参」用例。
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

test('routes-R1（t47）：受控区内的 5 种读失败必须结构化且不回显 fs 原文/绝对路径', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-consult-r1-'))
  const staging = path.join(work, 'staging')
  fs.mkdirSync(staging, { recursive: true })
  const inside = path.join(staging, 'staged.zip')
  fs.writeFileSync(inside, 'not a zip either', 'utf8')
  const route = consultRoute([staging])
  try {
    // 5 种形态（与 t30 的 attacks.mjs L123-126 逐字同源）：期望状态码 + 机器码
    const shapes: Array<[string, string, number, string]> = [
      ['尾随空格 staged.zip ', inside + ' ', 404, 'consult-source-not-found'],
      ['尾随点 staged.zip.', inside + '.', 404, 'consult-source-not-found'],
      ['ADS staged.zip:evil', inside + ':evil', 404, 'consult-source-not-found'],
      ['目标目录本身（EISDIR）', staging, 400, 'consult-source-unreadable'],
      ['受控区内不存在的文件', path.join(staging, 'nope-in-root.zip'), 404, 'consult-source-not-found'],
    ]
    for (const [label, id, status, code] of shapes) {
      const r = await callConsult(route, { type: 'export-zip', id })
      assert.equal(r.status, status, label + ' 必须是 ' + status + '（base 上是 500 + fs 原文）：' + r.body)
      const parsed = JSON.parse(r.body) as { error?: unknown; code?: unknown }
      assert.equal(parsed.code, code, label + ' 必须带机器可读码（base 上无 code）：' + r.body)
      // 反解析后的文本再查泄漏（body 里反斜杠是 JSON 转义形态，直接 includes 会漏判）
      const text = JSON.stringify(parsed)
      assert.doesNotMatch(text, /ENOENT|ENOTDIR|EACCES|EPERM|EISDIR|EBADF|EINVAL/, label + ' 不得回显 fs 原文：' + r.body)
      assert.ok(!text.toLowerCase().includes(staging.toLowerCase()), label + ' 不得回显服务端绝对路径：' + r.body)
      assert.ok(text.length < 200, label + ' 响应体必须是短结构化载荷：' + r.body)
    }
    // 正向控制：受控区内可读文件（不是 ZIP）仍照常分析 → 200（修复不得误挡；base/fixed 同）
    const ok = await callConsult(route, { type: 'export-zip', id: inside })
    assert.equal(ok.status, 200, '受控区内可读文件不得被误挡：' + ok.body)
    // 反向控制：非字符串 id 仍在读盘前被拒（不进 fs）
    const bad = await callConsult(route, { type: 'export-zip', id: 5 })
    assert.equal(bad.status, 400, '非字符串 id 必须 400：' + bad.body)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
