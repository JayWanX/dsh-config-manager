/**
 * `GET /api/dsh-config-manager/foreign-sources` 的行为护栏（t22）。
 *
 * 为什么单独一条测试：这条路由是 GUI 里「本机装了哪几个外部 agent」的唯一数据源，
 * 它的失败模式是**静默的**——少一条来源、回传绝对路径、把 projectDir 丢掉，界面上都看不出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { foreignRoutes } from './foreign.ts';
import { routeSpecOf } from './kit.ts';
import {
  foreignSourceContext,
  isInsideStaging,
} from './foreign-context.ts';

/**
 * 最小宿主 env 桩：只提供 foreign 路由真正消费的四个字段。
 *
 * 为什么显式给：真实 `RoutesEnv` 由 `src/index.ts` 的 `makeRouteEnv()` 推断，
 * 全量构造需要一个完整 DSH 宿主。这里只放本组用到的字段 —— 组文件在构建期只解构 env，
 * 其余依赖都在 handler 内，所以桩足够驱动真实行为（与 route-fence 的 stubEnv 同思路）。
 */
async function stubEnv(): Promise<Record<string, unknown>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-route-'));
  return {
    tmpDir,
    roots: [tmpDir],
    /**
     * **host.homeDir 刻意设成一个「像 \$DSH_HOME 但不是用户 home」的路径**。
     *
     * 这是防回归的关键：宿主 context 的 homeDir 是 \$DSH_HOME（≈ ~/.dsh），而来源真值表
     * 全部相对**用户 home**。此前 POST 用 host.homeDir 拼路径 → 去找 ~/.dsh/.claude（全读不到）→
     * 稳定回 400 nothing-to-import，而 GET 用 os.homedir() 显示 found=true —— **两个接口自相矛盾**。
     * 若测试桩把 host.homeDir 设成 os.homedir()，这个缺陷就会被**掩盖**（两边恰好同值）。
     * 故此处故意给一个不可能存在的目录：任何误用 host.homeDir 的实现都会立刻红。
     */
    host: {
      homeDir: path.join(tmpDir, 'dsh-home-NOT-user-home'),
      dshVersion: 'test',
      sessionFormatVersion: undefined,
    },
  };
}

function fakeRequest(url: string): IncomingMessage {
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      // GET 无体
    },
  };
  return req as unknown as IncomingMessage;
}

interface FakeResponse {
  res: ServerResponse;
  status: number;
  body: string;
}

function fakeResponse(): FakeResponse {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status;
      this.headersSent = true;
      return this;
    },
    end(payload?: string) {
      state.body = payload ?? '';
      return this;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() { return state.status; },
    get body() { return state.body; },
  };
}

interface ForeignSourcesBody {
  conflictPolicy: string;
  projectScoped: boolean;
  sources: { id: string; labelKey: string; found: boolean; paths: string[]; skipped: unknown[] }[];
}

async function callRoute(url: string): Promise<{ status: number; body: ForeignSourcesBody; raw: string }> {
  const routes = foreignRoutes({} as never);
  assert.equal(routes.length, 2, '本组应恰好两条路由（发现 + 产包）');
  const route = routes[0]!;
  assert.notEqual(routeSpecOf(route), undefined, '必须经 kit 的 endpoint() 声明（不得裸注册）');
  const res = fakeResponse();
  await route.handler(fakeRequest(url), res.res);
  return { status: res.status, body: JSON.parse(res.body) as ForeignSourcesBody, raw: res.body };
}

test('foreign-sources：30 条来源的检测结果齐全、冲突策略可见、绝不回传绝对路径', async () => {
  const { status, body, raw } = await callRoute('/api/dsh-config-manager/foreign-sources');
  assert.equal(status, 200);
  assert.equal(body.conflictPolicy, 'skip-no-overwrite');
  assert.equal(body.projectScoped, false, '未显式给 projectDir 时绝不猜「项目 = 宿主 cwd」');
  assert.deepEqual(
    body.sources.map((s) => s.id),
    [
      'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
      'gemini', 'reasonix', 'opencode', 'mimocode', 'zcode', 'grokbuild', 'openclaw', 'pi',
      'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline',
      'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
    ],
    '30 个来源一个都不能少、顺序稳定',
  );
  for (const source of body.sources) {
    assert.equal(typeof source.found, 'boolean', source.id + ' 的 found 必须是布尔');
    assert.ok(Array.isArray(source.paths), source.id + ' 的 paths 必须是数组');
    assert.ok(Array.isArray(source.skipped), source.id + ' 的 skipped 必须是数组');
    for (const p of source.paths) {
      assert.ok(!path.isAbsolute(p), source.id + ' 的路径必须是相对位置，实际: ' + p);
    }
  }
  assert.ok(!raw.includes(os.homedir().replace(/\\/g, '\\\\')), '响应体绝不包含用户 home 绝对路径');
});

test('foreign-sources：?projectDir= 被真正传给来源（项目级真值位置进入检测面）', async () => {
  const project = path.join(import.meta.dirname, '..', 'foreign', 'fixtures', 'cursor', 'basic', 'project');
  const { status, body } = await callRoute(
    '/api/dsh-config-manager/foreign-sources?projectDir=' + encodeURIComponent(project),
  );
  assert.equal(status, 200);
  assert.equal(body.projectScoped, true, '显式给了 projectDir 必须如实标注');
  const cursor = body.sources.find((s) => s.id === 'cursor');
  assert.ok(cursor !== undefined);
  assert.ok(cursor.paths.includes('project/.cursor/mcp.json'), '项目级 mcp.json 必须出现在检测面里');
  assert.ok(cursor.paths.includes('project/.cursor/rules'), '项目级 rules 必须出现在检测面里');
});

/* ---------------- foreign-context（纯函数：三处调用点共用同一份构造） ----------------

   两个缺陷的防回归护栏（都由 captain 复验确认）：
    ① 缺陷 1（严重）：POST 曾用 \`host.homeDir\`（= \$DSH_HOME ≈ ~/.dsh）当来源基准，
       而来源真值表相对**用户 home** → POST 恒读不到 → 400 nothing-to-import，
       与 GET（用 os.homedir()）显示 found=true **自相矛盾**；
    ② 缺陷 2：路由模块曾 \`import { PLUGIN_VERSION } from '../index.ts'\` → 任何直接
       import 本模块的单测都会连带加载 @deepseek-ai/* 而 ERR_MODULE_NOT_FOUND。
       本文件现在能跑起来，本身就是缺陷 2 已修的证明（import 链里已无 src/index.ts）。 */

test('foreign-context：来源上下文恒以**用户 home** 为基准，绝不取宿主 homeDir（缺陷 1 防回归）', () => {
  const ctx = foreignSourceContext()
  // 不传 userHome → 回退 os.homedir()（= 来源真值表的基准）
  assert.equal(ctx.homeDir, os.homedir(), '缺省必须是用户 home，不是 $DSH_HOME')
  // 显式传入优先
  assert.equal(foreignSourceContext({ userHome: 'C:/users/x' }).homeDir, 'C:/users/x')
  // 空串视为未给（不产生空 home → 不拼出相对路径）
  assert.equal(foreignSourceContext({ userHome: '' }).homeDir, os.homedir(), '空串必须回退，不得产出空 homeDir')
})

test('foreign-context：projectDir / targetSessionFormatVersion 缺省时**该键不出现**（绝不猜）', () => {
  const bare = foreignSourceContext()
  assert.equal('projectDir' in bare, false, '未给 projectDir → 键不出现（内核据此不扫项目级，而不是拿空串拼路径）')
  assert.equal('targetSessionFormatVersion' in bare, false, '未给版本 → 键不出现（内核逐条报码，绝不擅自填默认版本）')
  assert.equal(foreignSourceContext({ projectDir: '' }).projectDir, undefined, '空串 = 未给')
  const full = foreignSourceContext({ projectDir: '/proj', targetSessionFormatVersion: 4 })
  assert.equal(full.projectDir, '/proj')
  assert.equal(full.targetSessionFormatVersion, 4)
})

test('foreign-context：受控目录自检用段边界，/tmp-evil 不得通过 /tmp（防前缀误判）', () => {
  const root = path.resolve('/tmp/dcm-staging')
  assert.equal(isInsideStaging(path.join(root, 'a.zip'), [root]), true)
  assert.equal(isInsideStaging(root, [root]), true, '根目录自身算在内')
  assert.equal(isInsideStaging(root + '-evil/a.zip', [root]), false, '同前缀的另一目录不得通过')
  assert.equal(isInsideStaging(path.resolve('/elsewhere/a.zip'), [root]), false)
  assert.equal(isInsideStaging(path.join(root, '..', 'escape.zip'), [root]), false, '上跳后不在根内')
})

test('foreign-context：模块 import 链里不得出现 src/index.ts（缺陷 2 防回归）', async () => {
  // 直接断言「本测试文件能 import 成功」还不够 —— 要钉住**成因**：
  // 路由实现模块不得把宿主入口拉进 import 链。
  const src = await fs.readFile(path.join(import.meta.dirname, 'foreign.ts'), 'utf8')
  assert.ok(
    !/from '\.\.\/index\.ts'/.test(src),
    'src/routes/foreign.ts 不得 import ../index.ts（会把 @deepseek-ai/* 拉进纯单测环境）',
  )
  assert.ok(
    src.includes("from './foreign-context.ts'"),
    '必须经纯函数模块构造来源上下文（三处调用点同源的唯一实现）',
  )
})

/* ---------------- POST /foreign-import（t17：GUI 侧的产包端点） ----------------

   为什么必须真跑：这条端点是「GUI 从选来源到拿到 zipPath」之间**唯一**的一环，
   它坏了的表现是「点导入没反应 / 报一句看不懂的错」。以下断言各自对应一种真实失败模式。 */

interface ForeignImportBody {
  zipPath?: string
  name?: string
  source?: string
  sections?: string[]
  counts?: Record<string, number>
  skipped?: { code: string }[]
  credentialRefs?: string[]
  detectedPaths?: string[]
  conflictPolicy?: string
  code?: string
}

/** 构造 POST 请求（带 JSON 体）。 */
function fakePost(url: string, payload: unknown): IncomingMessage {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-length': String(body.length) },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      yield body
    },
  }
  return req as unknown as IncomingMessage
}

/** 取本组的 foreign-import 路由。 */
function importRoute(env: Record<string, unknown>) {
  const routes = foreignRoutes(env as never)
  const route = routes.find((r) => r.path === '/api/dsh-config-manager/foreign-import')
  assert.ok(route !== undefined, '必须存在 POST /foreign-import（否则 GUI 拿不到 zipPath）')
  assert.notEqual(routeSpecOf(route), undefined, '必须经 kit 的 endpoint() 声明（不得裸注册）')
  return route
}

/**
 * 调一次 POST /foreign-import。
 *
 * `opts.userHome` 通过覆盖 `USERPROFILE`/`HOME` 生效 —— 路由走 `foreignSourceContext()` 的缺省
 * 分支（`os.homedir()`），而 `os.homedir()` 正是读这两个环境变量。这样测试能用**受控的临时 userHome**
 * 驱动真实代码路径，而不必在实现里开测试专用口子（也就不必为测试放宽生产语义）。
 */
async function callImport(
  payload: unknown,
  opts: { userHome?: string } = {},
): Promise<{ status: number; body: ForeignImportBody; raw: string }> {
  const env = await stubEnv()
  const prevProfile = process.env['USERPROFILE']
  const prevHome = process.env['HOME']
  if (opts.userHome !== undefined) {
    process.env['USERPROFILE'] = opts.userHome
    process.env['HOME'] = opts.userHome
  }
  try {
    const res = fakeResponse()
    await importRoute(env).handler(fakePost('/api/dsh-config-manager/foreign-import', payload), res.res)
    return { status: res.status, body: JSON.parse(res.body) as ForeignImportBody, raw: res.body }
  } finally {
    if (prevProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = prevProfile
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
  }
}

test('GET 与 POST 对同一来源必须给同一结论（缺陷 1 的另一面：两接口自相矛盾）', async () => {
  /**
   * 缺陷 1 的可见症状不是「读不到」，而是 **GET 说 found=true、POST 说 nothing-to-import**。
   * 根因是两处用了不同的 home（GET os.homedir() / POST host.homeDir）。
   * 这里直接把两个接口对同一受控 userHome 的结论钉在一起 —— 任何一处改回错 home，本用例立刻红。
   */
  const fixtureHome = path.join(import.meta.dirname, '..', 'foreign', 'fixtures', 'hermes', 'basic')
  const userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-consistency-'))
  const target = process.platform === 'win32'
    ? path.join(userHome, 'AppData', 'Local', 'Hermes')
    : path.join(userHome, '.hermes')
  await fs.mkdir(target, { recursive: true })
  await fs.cp(fixtureHome, target, { recursive: true })
  const prev = { profile: process.env['USERPROFILE'], home: process.env['HOME'], local: process.env['LOCALAPPDATA'], hermes: process.env['HERMES_HOME'] }
  process.env['USERPROFILE'] = userHome
  process.env['HOME'] = userHome
  delete process.env['LOCALAPPDATA']
  delete process.env['HERMES_HOME']
  const env2 = await stubEnv()
  try {
    // GET：检测面
    const getRes = fakeResponse()
    await foreignRoutes(env2 as never)[0]!.handler(fakeRequest('/api/dsh-config-manager/foreign-sources'), getRes.res)
    const detected = (JSON.parse(getRes.body) as { sources: { id: string; found: boolean }[] })
      .sources.find((s) => s.id === 'hermes')
    assert.equal(detected?.found, true, 'GET 必须检测到受控 userHome 下的 Hermes')

    // POST：产包面
    const post = await callImport({ source: 'hermes' }, { userHome })
    assert.equal(
      post.status,
      200,
      'GET 说 found=true 而 POST 说读不到 —— 两个接口自相矛盾（正是缺陷 1 的症状）：' + post.raw,
    )
  } finally {
    if (prev.profile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = prev.profile
    if (prev.home === undefined) delete process.env['HOME']; else process.env['HOME'] = prev.home
    if (prev.local === undefined) delete process.env['LOCALAPPDATA']; else process.env['LOCALAPPDATA'] = prev.local
    if (prev.hermes === undefined) delete process.env['HERMES_HOME']; else process.env['HERMES_HOME'] = prev.hermes
    await fs.rm(userHome, { recursive: true, force: true })
  }
})

test('foreign-import：未知来源 → 400 + 可用清单，绝不回退到默认来源', async () => {
  const { status, body, raw } = await callImport({ source: 'nonexistent-source' })
  assert.equal(status, 400)
  assert.ok(raw.includes('nonexistent-source'), '错误里必须点名用户给的那个 id')
  assert.ok(raw.includes('hermes'), '必须给出可用来源清单（否则用户不知道能填什么）')
  assert.equal(body.code, 'unknown-source', '稳定机器码供客户端判别')
})

test('foreign-import：缺 source → 400 + 稳定码（不是 500）', async () => {
  const { status, body } = await callImport({})
  assert.equal(status, 400)
  assert.equal(body.code, 'missing-source')
})

test('foreign-import：空来源 → 400 + nothing-to-import（绝不静默产空包）', async () => {
  // 本机没有 Antigravity 真盘 → 走「一个分区都产不出来」的分支；
  // 若开发机恰好装了，则走 200 —— 两种都是正确行为，这里只钉住「不许静默空包」。
  const { status, body, raw } = await callImport({ source: 'antigravity' })
  if (status === 400) {
    assert.ok(raw.includes('nothing-to-import'), '空结果必须给稳定码，而不是 200 + 空分区')
  } else {
    assert.ok((body.sections ?? []).length > 0, '200 必须伴随非空分区')
  }
})

test('foreign-import：真实 fixture 产包 → 分区非空、路径受控、响应不含凭据值（缺陷 1 的端到端护栏）', async () => {
  /**
   * 用仓库内的跨平台 fixture 驱动 Hermes。
   *
   * **为什么这里不再用「HERMES_HOME 环境覆盖」**：那条路径会**掩盖缺陷 1** ——
   * HERMES_HOME 优先于任何 home 拼接，所以即使路由把 homeDir 传成了 \$DSH_HOME 也照样能读到 fixture，
   * 测试于是恒绿（这正是本机「看起来是好的」的原因，也是我第一版护栏的假绿来源）。
   *
   * 现在改为把它当**用户 home** 使用（~/.hermes 形态）：路由必须用用户 home 才能找到它，
   * 一旦退回 host.homeDir（stub 里是一个不存在的路径）→ 立刻 400 nothing-to-import → 本用例红。
   * 因此这条用例同时是「产包正确」与「homeDir 用对了」的端到端证据。
   */
  const fixtureHome = path.join(import.meta.dirname, '..', 'foreign', 'fixtures', 'hermes', 'basic')
  /**
   * 把 fixture 摆到「受控 userHome 之下的真实 Hermes 位置」——**按平台**：
   *  - win32：\`%LOCALAPPDATA%\Hermes\`（LOCALAPPDATA 缺省 = <userHome>/AppData/Local，见 resolveHermesHome）
   *  - 其它：\`~/.hermes\`
   * 刻意**不设 HERMES_HOME**：它会短路掉 homeDir 拼接，从而掩盖缺陷 1（本机就是这样「看起来是好的」）。
   */
  const userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-userhome-'))
  const target = process.platform === 'win32'
    ? path.join(userHome, 'AppData', 'Local', 'Hermes')
    : path.join(userHome, '.hermes')
  await fs.mkdir(target, { recursive: true })
  await fs.cp(fixtureHome, target, { recursive: true })
  const prev = { local: process.env['LOCALAPPDATA'], hermes: process.env['HERMES_HOME'] }
  // 清掉这两个：让解析真正走 userHome（而不是被环境变量短路）
  delete process.env['LOCALAPPDATA']
  delete process.env['HERMES_HOME']
  try {
    const { status, body, raw } = await callImport({ source: 'hermes' }, { userHome })
    // **不再静默跳过**：fixture 就在这个 userHome 里，读不到就是真失败（不得写成 return 变成假绿）
    assert.equal(status, 200, 'fixture 位于传入的 userHome 下，必须能读到；若为 400 说明 homeDir 用错了：' + raw)
    assert.ok((body.sections ?? []).length > 0, '必须产出至少一个分区')
    assert.equal(body.conflictPolicy, 'skip-no-overwrite')
    assert.ok((body.zipPath ?? '').endsWith('.zip'), 'zipPath 必须指向 ZIP')
    assert.ok(!raw.includes('_DO_NOT_SHIP'), '响应体泄露了 fixture 哨兵值（凭据铁律）')
    for (const p of body.detectedPaths ?? []) {
      assert.ok(!path.isAbsolute(p), 'detectedPaths 必须是相对位置，实际: ' + p)
    }
  } finally {
    if (prev.local === undefined) delete process.env['LOCALAPPDATA']
    else process.env['LOCALAPPDATA'] = prev.local
    if (prev.hermes === undefined) delete process.env['HERMES_HOME']
    else process.env['HERMES_HOME'] = prev.hermes
    await fs.rm(userHome, { recursive: true, force: true })
  }
})
