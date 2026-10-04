/**
 * 回归：POST /sync/config + clear:true —— 「断开同步通道配置」的宿主出口（用户要求：配置过的
 * 通道必须能删掉，否则一条打不通的通道会永久占位，产物库远端源与自动同步只能一直报读取失败）。
 *
 * 四条钉住：
 *  ① 清空是**显式**动作：clear 不为 true 时请求照旧走保存分支（prepareSync），不得被清空分支截走；
 *  ② 缺 / 非法 transport → 400，且**一个凭据都不动**（挡在破坏性动作之前，而不是先删再报错）；
 *  ③ 清空 = sync-config 命名空间 + 该通道三个凭据槽（token / WebDAV 口令 + 加密·解密密码）
 *     + 该通道自动同步开关；**另一条通道的配置与自动同步原样保留**；
 *  ④ 「记住的通道」指向被删通道时改指剩下的那条 —— 否则产物库/页面回填会继续拿它去请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { readAutosyncConfig, writeAutosyncConfig } from '../../src/sync/autosync-config.ts'
import { readFullSyncConfig, writeSyncConfig } from '../../src/sync/sync-config.ts'
import { readUiPrefs, updateUiPrefs } from '../../src/sync/ui-prefs.ts'

interface Probes {
  unset: string[]
  prepared: number
  reloads: number
}

/** 本组路由需要的 env（其余成员在本次调用路径上不被读取）。 */
function envFor(p: Probes, syncDir: string): never {
  const env = {
    syncDir,
    msg: (key: string) => key,
    credentials: {
      unset: async (ref: unknown) => { p.unset.push(String(ref)) },
      describe: async () => ({ configured: false, writable: true }),
    },
    prepareSync: async () => {
      p.prepared += 1
      return { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://example.com/repo.git' } }
    },
    // 构造期就会调用（/sync/push 等路由在注册点包壳）；本组只调 config 路由，直通即可。
    withMutationGate: (_op: string, handler: unknown) => handler,
    scheduler: { reload: async () => { p.reloads += 1 } },
  }
  return env as never
}

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p)
  assert.ok(found !== undefined, '路由缺失: ' + p)
  return found
}

function fakeRequest(body: string): IncomingMessage {
  const req = {
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> { yield Buffer.from(body, 'utf8') },
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
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body) as unknown,
  }
}

const PATH = '/api/dsh-config-manager/sync/config'

async function seedBothChannels(dir: string): Promise<void> {
  await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } })
  await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav/' } })
  const base = await readAutosyncConfig(dir, 'webdav')
  await writeAutosyncConfig(dir, 'webdav', { ...base, enabled: true })
  await writeAutosyncConfig(dir, 'git', { ...base, enabled: true })
  await updateUiPrefs(dir, { lastSyncChannel: 'webdav' })
}

test('clear:true → 清命名空间 + 该通道三个凭据槽 + 该通道自动同步；另一条通道原样保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-clear-route-'))
  try {
    await seedBothChannels(dir)
    const probes: Probes = { unset: [], prepared: 0, reloads: 0 }
    const route = routeByPath(syncRoutes(envFor(probes, dir)), PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest('{"transport":"webdav","clear":true}'), res.res)

    assert.equal(res.status(), 200)
    assert.deepEqual(res.json(), { ok: true, cleared: 'webdav', removed: true, configured: true, transport: 'git' })
    assert.equal(probes.unset.length, 3, '必须清掉该通道的三个凭据槽（token/口令 + 加密·解密密码）')
    assert.equal(probes.prepared, 0, '清空分支不得走 prepareSync（清空请求不带地址）')
    assert.equal(probes.reloads, 1, '必须让调度器重载，丢掉该通道已排期的定时器')

    const full = await readFullSyncConfig(dir)
    assert.equal(full?.transport, 'git', '活动通道自动切到剩下的那条')
    assert.equal(full?.webdav, undefined)
    assert.equal(full?.git?.repoUrl, 'https://github.com/u/r.git', '另一条通道的地址必须原样保留')
    assert.equal((await readAutosyncConfig(dir, 'webdav')).enabled, false, '被删通道的自动同步必须关掉')
    assert.equal((await readAutosyncConfig(dir, 'git')).enabled, true, '另一条通道的自动同步不得被牵连')
    assert.equal((await readUiPrefs(dir)).lastSyncChannel, 'git', '记住的通道不得继续指向已删通道')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('clear:true 缺 / 非法 transport → 400，且一个凭据都不动（挡在破坏性动作之前）', async () => {
  for (const body of ['{"clear":true}', '{"transport":"ftp","clear":true}', '{"transport":"","clear":true}']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-clear-bad-'))
    try {
      await seedBothChannels(dir)
      const probes: Probes = { unset: [], prepared: 0, reloads: 0 }
      const route = routeByPath(syncRoutes(envFor(probes, dir)), PATH)
      const res = fakeResponse()
      await route.handler(fakeRequest(body), res.res)
      assert.equal(res.status(), 400, '必须挡在写动作之前: ' + body)
      assert.deepEqual(probes.unset, [], '不得先删凭据再报错: ' + body)
      assert.equal(probes.reloads, 0, '400 分支不得动调度器: ' + body)
      assert.equal((await readFullSyncConfig(dir))?.webdav?.url, 'https://dav.example.com/dav/', '配置不得被动过: ' + body)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  }
})

test('clear 不为 true → 照旧走保存分支（清空分支不得截走普通保存）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-clear-save-'))
  try {
    const probes: Probes = { unset: [], prepared: 0, reloads: 0 }
    const route = routeByPath(syncRoutes(envFor(probes, dir)), PATH)
    const res = fakeResponse()
    await route.handler(fakeRequest('{"transport":"git","repoUrl":"https://example.com/repo.git"}'), res.res)
    assert.equal(res.status(), 200)
    assert.equal(probes.prepared, 1, '普通保存必须仍走 prepareSync')
    assert.deepEqual(probes.unset, [], '保存分支不得顺带删任何凭据')
    assert.equal((await readFullSyncConfig(dir))?.git?.repoUrl, 'https://example.com/repo.git')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
