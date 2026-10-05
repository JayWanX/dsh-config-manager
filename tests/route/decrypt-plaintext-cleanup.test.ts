/**
 * e2e-F2 回归：/decrypt-archive 解出的**明文备份副本**必须「用完即清」。
 *
 * 背景（outputs/bug-audit/e2e/findings.md §1 F2）：AGENTS.md 与 decrypt-archive 的注释都写
 * 「解密明文 ZIP 为临时文件用完即清」，但全仓 decrypted- 前缀只有一处创建
 * （src/routes/import.ts 的 decrypt-archive 分支），而删除点只在它的 catch 里 —— 成功解锁 →
 * 分析 → 计划 → 执行（含失败）之后明文包一直留在 tmp/，真机连续 6 次解锁留下 6 个 decrypted-*.zip。
 *
 * 修复口径：明文副本只在「**被成功导入**」之后删除（失败/取消保留给重试；从未执行的残留由 tmpDir
 * 的 24h 保留期清理兜底）。本测试同时钉住判据（isDecryptedPlaintextArtifact）与 /execute 的接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { importRoutes, isDecryptedPlaintextArtifact } from '../../src/routes/import.ts'
import type { WebRoute } from '../../src/routes/kit.ts'

const EXECUTE_PATH = '/api/dsh-config-manager/execute'

interface StubOptions {
  roots: string[]
  tmpDir: string
  syncDir: string
  /** stub importer 的执行结果（true = 导入成功） */
  ok: boolean
}

/** /execute 成功路径真正读到的依赖（其余成员不会被读到）。 */
function stubEnv(o: StubOptions): never {
  return {
    bootSafetyAudit: async () => undefined,
    cancelDecisionTimeoutMs: 1000,
    host: {
      homeDir: o.tmpDir, profile: 'web',
      log: { warn: () => undefined, error: () => undefined },
    },
    makeImporter: () => ({
      executeImportPlan: async () => ({
        ok: o.ok, executed: [], removedPlugins: [], manualHints: [], failed: [], skipped: [], snapshotId: undefined,
      }),
    }),
    msg: (key: string) => key,
    roots: o.roots,
    runAbortControllers: new Map(),
    runCancels: new Map(),
    runs: {
      register: () => ({ runId: 'run-1', kind: 'import', status: 'running', log: [] }),
      update: () => undefined, finish: () => undefined, fail: () => undefined,
      appendLog: () => undefined, setPendingDecision: () => undefined,
    },
    syncDir: o.syncDir,
    tmpDir: o.tmpDir,
    tryAppendHistory: async () => undefined,
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

function executeRoute(o: StubOptions): WebRoute {
  const route = importRoutes(stubEnv(o)).find((r) => r.path === EXECUTE_PATH)
  assert.ok(route !== undefined, '缺少 ' + EXECUTE_PATH)
  return route
}

function fakeRequest(body: unknown): IncomingMessage {
  return {
    method: 'POST', url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  } as unknown as IncomingMessage
}

interface FakeResponse { status: number; body: string }

async function callExecute(route: WebRoute, body: unknown): Promise<FakeResponse> {
  const state: FakeResponse = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  await route.handler(fakeRequest(body), res as unknown as ServerResponse)
  return state
}

test('e2e-F2 回归：明文副本判据 = tmpDir 内 + decrypted- 前缀（tmpDir 之外一律不删）', () => {
  const tmp = path.join(os.tmpdir(), 'x-tmp')
  assert.equal(isDecryptedPlaintextArtifact(path.join(tmp, 'decrypted-abc.zip'), tmp), true)
  assert.equal(isDecryptedPlaintextArtifact(path.join(tmp, 'nested', 'decrypted-abc.zip'), tmp), true)
  assert.equal(isDecryptedPlaintextArtifact(path.join(tmp, 'upload-abc.zip'), tmp), false, '暂存上传不是明文副本')
  assert.equal(isDecryptedPlaintextArtifact(path.join(tmp, 'market-abc.zip'), tmp), false)
  assert.equal(isDecryptedPlaintextArtifact(path.join(path.dirname(tmp), 'decrypted-abc.zip'), tmp), false, 'tmpDir 之外不得删')
  assert.equal(isDecryptedPlaintextArtifact(tmp, tmp), false, '目录本身不删')
})

test('e2e-F2 回归：/execute 成功后明文副本被删除；失败保留给重试；upload-* 不在清理范围', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-plaintext-f2-'))
  const tmpDir = path.join(work, 'tmp')
  const exportsDir = path.join(work, 'exports')
  const syncDir = path.join(work, 'sync')
  for (const d of [tmpDir, exportsDir, syncDir]) fs.mkdirSync(d, { recursive: true })
  const plain = path.join(tmpDir, 'decrypted-probe0001.zip')
  const upload = path.join(tmpDir, 'upload-probe0001.zip')
  fs.writeFileSync(plain, 'dummy plaintext archive bytes')
  fs.writeFileSync(upload, 'dummy staged upload bytes')
  try {
    const r = await callExecute(
      executeRoute({ roots: [tmpDir, exportsDir], tmpDir, syncDir, ok: true }),
      { zipPath: plain, plan: { items: [] }, opts: { confirm: true } },
    )
    assert.equal(r.status, 200, 'stub importer 成功时 /execute 应回 200：' + r.body)
    assert.equal(fs.existsSync(plain), false, '成功导入后明文副本必须被删除（e2e-F2）')
    assert.equal(fs.existsSync(upload), true, '暂存上传（upload-*）不在本清理范围（由 tmpDir 保留期清理兜底）')

    // 失败路径：明文保留，用户可用同一个 zipPath 重试
    const plain2 = path.join(tmpDir, 'decrypted-probe0002.zip')
    fs.writeFileSync(plain2, 'dummy plaintext archive bytes 2')
    const r2 = await callExecute(
      executeRoute({ roots: [tmpDir, exportsDir], tmpDir, syncDir, ok: false }),
      { zipPath: plain2, plan: { items: [] }, opts: { confirm: true } },
    )
    assert.equal(r2.status, 200, '失败结果仍是 200 + ok:false：' + r2.body)
    assert.equal(fs.existsSync(plain2), true, '失败时明文副本必须保留（可重试）')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
