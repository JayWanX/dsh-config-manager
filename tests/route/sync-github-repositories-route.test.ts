/**
 * 回归：GET/POST /sync/github/repositories（同步通道的「选择已有仓库 / 新建仓库」）。
 *
 * 这条路由是**唯一**把 GitHub 仓库枚举/创建能力暴露给前端的入口，因此这里钉住三件事：
 *  1. 两条分支都经宿主侧 GitHubAuthRest（token 只走 Authorization 头，绝不出现在响应里）；
 *  2. POST 的 private **恒为 true** —— 客户端就算传 private:false 也不生效
 *     （同步仓库必须私有，公开仓库会把配置内容公开；安全约束必须落在宿主侧，不能只靠 UI）；
 *  3. 401（未登录 / token 失效）与其余错误分开映射（与 /sync/github/validate、me 路由同一口径）。
 *
 * 假 rest 只记录调用参数、按需抛错，不发起任何网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { syncRoutes } from '../../src/routes/sync.ts'
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts'
import { GitHubApiError } from '../../src/market/github-repos.ts'

const TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz123456'
const REPO_PATH = '/api/dsh-config-manager/sync/github/repositories'

interface RestCall {
  kind: 'list' | 'create'
  name?: string
  options?: { private?: boolean; description?: string }
}

interface Harness {
  calls: RestCall[]
  setError: (error: unknown) => void
}

/** makeHarness 的返回：记录器 + 假 rest（rest 供 envFor 塞进 env 的 meGitHubRest）。 */
type RestHarness = Harness & { rest: unknown }

/** 假 GitHubAuthRest：只暴露本路由用到的两个方法，并把调用参数记下来。 */
function makeHarness(): RestHarness {
  const calls: RestCall[] = []
  const state: { error: unknown } = { error: undefined }
  const harness: Harness = {
    calls,
    setError: (error) => { state.error = error },
  }
  return Object.assign(harness, {
    rest: {
      async listRepos(): Promise<unknown[]> {
        calls.push({ kind: 'list' })
        if (state.error !== undefined) throw state.error
        return [
          {
            fullName: 'xiaojun/dsh-configs',
            htmlUrl: 'https://github.com/xiaojun/dsh-configs',
            cloneUrl: 'https://github.com/xiaojun/dsh-configs.git',
            defaultBranch: 'main',
            private: true,
            fork: false,
            pushedAt: '2026-09-30T10:00:00Z',
            updatedAt: '2026-09-30T11:00:00Z',
          },
        ]
      },
      async createRepo(name: string, options: { private?: boolean; description?: string } = {}): Promise<unknown> {
        calls.push({ kind: 'create', name, options })
        if (state.error !== undefined) throw state.error
        return {
          fullName: 'xiaojun/' + name,
          htmlUrl: 'https://github.com/xiaojun/' + name,
          cloneUrl: 'https://github.com/xiaojun/' + name + '.git',
          defaultBranch: 'main',
          private: options.private === true,
          fork: false,
        }
      },
    },
  })
}

function envFor(h: RestHarness): never {
  return {
    meGitHubRest: h.rest,
    meTokenProvider: async () => TOKEN,
    msg: (key: string) => key,
    // 与生产同语义的「直通」包壳（本组多条写路由在**构造期**就会调它包 handler）
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p)
  assert.ok(found !== undefined, '路由缺失: ' + p)
  return found
}

function fakeRequest(opts: { method?: string; body?: string } = {}): IncomingMessage {
  const req = {
    method: opts.method ?? 'GET',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8')
    },
  }
  return req as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; status: () => number; raw: () => string; json: () => unknown } {
  const state = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    raw: () => state.body,
    json: () => JSON.parse(state.body) as unknown,
  }
}

test('GET /sync/github/repositories：列举仓库（只读，直接回给 UI 选择）', async () => {
  const h = makeHarness()
  const route = routeByPath(syncRoutes(envFor(h)), REPO_PATH)
  assert.deepEqual(routeSpecOf(route)?.methods, ['GET', 'POST'], '同一路径两个方法（路径不得重复）')
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 200)
  const body = res.json() as { ok: boolean; repos: Array<{ fullName: string; cloneUrl: string }> }
  assert.equal(body.ok, true)
  assert.equal(body.repos.length, 1)
  assert.equal(body.repos[0]?.cloneUrl, 'https://github.com/xiaojun/dsh-configs.git')
  assert.deepEqual(h.calls, [{ kind: 'list' }])
  assert.ok(!res.raw().includes(TOKEN), 'token 绝不回传浏览器')
})

test('POST /sync/github/repositories：新建仓库时 private 恒为 true（客户端传 false 也不生效）', async () => {
  const h = makeHarness()
  const route = routeByPath(syncRoutes(envFor(h)), REPO_PATH)
  const res = fakeResponse()
  await route.handler(
    fakeRequest({ method: 'POST', body: '{"name":"dsh-sync","private":false,"description":"我的配置"}' }),
    res.res,
  )
  assert.equal(res.status(), 200)
  const body = res.json() as { ok: boolean; repo: { fullName: string; private: boolean } }
  assert.equal(body.ok, true)
  assert.equal(body.repo.fullName, 'xiaojun/dsh-sync')
  assert.equal(body.repo.private, true, '宿主必须强制私有：公开仓库会把配置内容公开')
  assert.deepEqual(h.calls, [{ kind: 'create', name: 'dsh-sync', options: { private: true, description: '我的配置' } }])
})

test('POST /sync/github/repositories：缺 name → 400，且绝不调 GitHub', async () => {
  const h = makeHarness()
  const route = routeByPath(syncRoutes(envFor(h)), REPO_PATH)
  for (const body of ['{}', '{"name":""}', '{"name":"   "}']) {
    const res = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', body }), res.res)
    assert.equal(res.status(), 400, '空名字必须挡回：' + body)
    assert.equal((res.json() as { error: string }).error, 'name is required')
  }
  assert.deepEqual(h.calls, [], '非法请求不得触达 GitHub API')
})

test('POST /sync/github/repositories：无 description 时不传该字段（不写空串）', async () => {
  const h = makeHarness()
  const route = routeByPath(syncRoutes(envFor(h)), REPO_PATH)
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', body: '{"name":"dsh-sync"}' }), res.res)
  assert.equal(res.status(), 200)
  assert.deepEqual(h.calls, [{ kind: 'create', name: 'dsh-sync', options: { private: true } }])
})

test('错误映射：未登录/token 失效 → 401；其余（网络/限流）→ 500；响应不含 token', async () => {
  const route = () => {
    const h = makeHarness()
    return { h, route: routeByPath(syncRoutes(envFor(h)), REPO_PATH) }
  }

  for (const code of ['no_token', 'unauthorized']) {
    const { h, route: r } = route()
    h.setError(new GitHubApiError('GitHub token 未配置（请先登录）', code))
    const res = fakeResponse()
    await r.handler(fakeRequest({ method: 'GET' }), res.res)
    assert.equal(res.status(), 401, '应映射成 401：' + code)
    assert.ok(!res.raw().includes(TOKEN), 'token 绝不回传浏览器')
  }

  const { h, route: r } = route()
  h.setError(new GitHubApiError('GitHub API 请求失败：network down', 'network_error'))
  const res = fakeResponse()
  await r.handler(fakeRequest({ method: 'GET' }), res.res)
  assert.equal(res.status(), 500, '网络/限流不得被误判成「未登录」')
  assert.ok(!res.raw().includes(TOKEN), 'token 绝不回传浏览器')
})
