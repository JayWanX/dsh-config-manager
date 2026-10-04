/**
 * m-disk-usage 路由行为测试：GET /disk-usage 只读体检 + POST /disk-usage/cleanup 的清理边界。
 *
 * 为什么必须有：清理是**写操作**，最危险的失败模式是「用户以为只清了缓存，实际删掉了备份/快照」。
 * 这里用真实临时目录 + 真实路由 handler，逐条钉住：
 *  - 缺省（categories=['tmp']）只清可重建区，**导出产物与快照必须原样存在**；
 *  - 显式 'expired-exports' 只删**已超保留期**的导出 zip（新导出保留）；
 *  - categories 为空/非法 → 400，且什么都不删；
 *  - 返回的报告是清理后重新体检的结果（界面据此刷新，不必再发一次 GET）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { backupRoutes } from '../../src/routes/backup.ts';
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts';

const DAY = 24 * 60 * 60 * 1000;

interface Harness {
  root: string;
  exportsDir: string;
  snapshotsDir: string;
  tmpDir: string;
  marketDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-diskusage-route-'));
  const exportsDir = path.join(root, 'exports');
  const snapshotsDir = path.join(root, 'snapshots');
  const tmpDir = path.join(root, 'tmp');
  const marketDir = path.join(root, 'market');
  const syncDir = path.join(root, 'sync');
  for (const dir of [exportsDir, snapshotsDir, tmpDir, marketDir, syncDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.mkdir(path.join(marketDir, 'cache'), { recursive: true });
  await fs.mkdir(path.join(marketDir, 'work'), { recursive: true });
  return { root, exportsDir, snapshotsDir, tmpDir, marketDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** 用真实目录构造这组路由需要的 env（其余成员在构建期不被读取） */
function envFor(h: Harness): never {
  const env = {
    dataDir: h.root,
    exportsDir: h.exportsDir,
    snapshotsDir: h.snapshotsDir,
    tmpDir: h.tmpDir,
    marketDir: h.marketDir,
    syncDir: path.join(h.root, 'sync'),
    // 与生产同语义的「直通」包壳（本组 handler 只用它包裹写路由）
    withMutationGate: (_op: string, handler: unknown) => handler,
  };
  return env as never;
}

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p);
  assert.ok(found !== undefined, '路由缺失: ' + p);
  return found;
}

function fakeRequest(opts: { method?: string; body?: string } = {}): IncomingMessage {
  const req = {
    method: opts.method ?? 'GET',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body) as unknown,
  };
}

async function writeAt(file: string, bytes: number, mtimeMs?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 1));
  if (mtimeMs !== undefined) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

/** 建立场景：一份新导出、一份过期导出、一个导入前快照、一个 tmp 暂存 */
async function seed(h: Harness): Promise<void> {
  const now = Date.now();
  await writeAt(path.join(h.exportsDir, 'dsh-config-new.zip'), 100, now);
  await writeAt(path.join(h.exportsDir, 'dsh-config-old.zip'), 50, now - 8 * DAY);
  await writeAt(path.join(h.snapshotsDir, 'snap-1', 'config.json'), 20, now);
  await writeAt(path.join(h.tmpDir, 'upload-staged.zip'), 30, now);
  await writeAt(path.join(h.marketDir, 'cache', 'hash', 'index.json'), 10, now);
  await writeAt(path.join(h.marketDir, 'work', 'hash', 'HEAD'), 5, now);
}

test('GET /disk-usage：只读返回报告（临时区/备份/快照都被分别统计）', async () => {
  const h = await makeHarness();
  try {
    await seed(h);
    const routes = backupRoutes(envFor(h));
    const route = routeByPath(routes, '/api/dsh-config-manager/disk-usage');
    const res = fakeResponse();
    await route.handler(fakeRequest({ method: 'GET' }), res.res);
    assert.equal(res.status(), 200);
    const body = res.json() as { ok: boolean; report: { areas: Record<string, { sizeBytes: number; policy: string }>; totalBytes: number; backupRetention: { keepLast: number } } };
    assert.equal(body.ok, true);
    assert.equal(body.report.areas['tmp']?.policy, 'regenerable');
    assert.equal(body.report.areas['snapshots']?.policy, 'protected');
    assert.equal(body.report.areas['exports']?.policy, 'retained');
    assert.equal(body.report.totalBytes, 100 + 50 + 20 + 30 + 10 + 5);
    assert.ok(body.report.backupRetention.keepLast >= 1);
    // 只读：文件原样
    assert.equal((await fs.stat(path.join(h.tmpDir, 'upload-staged.zip'))).size, 30);
  } finally {
    await h.cleanup();
  }
});

test('POST /disk-usage/cleanup：categories 为空 → 400 且什么都不删', async () => {
  const h = await makeHarness();
  try {
    await seed(h);
    const route = routeByPath(backupRoutes(envFor(h)), '/api/dsh-config-manager/disk-usage/cleanup');
    for (const body of ['{}', '{"categories":[]}', '{"categories":["nope"]}']) {
      const res = fakeResponse();
      await route.handler(fakeRequest({ method: 'POST', body }), res.res);
      assert.equal(res.status(), 400, '非法请求必须 400: ' + body);
    }
    assert.equal((await fs.stat(path.join(h.tmpDir, 'upload-staged.zip'))).size, 30, '非法请求不得产生任何删除');
    assert.equal((await fs.stat(path.join(h.exportsDir, 'dsh-config-old.zip'))).size, 50);
  } finally {
    await h.cleanup();
  }
});

test('POST /disk-usage/cleanup：categories=["tmp"] 只清可重建区，备份/快照原样保留', async () => {
  const h = await makeHarness();
  try {
    await seed(h);
    const route = routeByPath(backupRoutes(envFor(h)), '/api/dsh-config-manager/disk-usage/cleanup');
    const res = fakeResponse();
    await route.handler(fakeRequest({ method: 'POST', body: '{"categories":["tmp"]}' }), res.res);
    assert.equal(res.status(), 200);
    const body = res.json() as {
      ok: boolean; freedBytes: number; removed: number; excluded: string[];
      report: { areas: Record<string, { sizeBytes: number }>; reclaimableBytes: number };
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.excluded, ['expired-exports']);
    // 可重建区被清空
    await assert.rejects(() => fs.stat(path.join(h.tmpDir, 'upload-staged.zip')));
    await assert.rejects(() => fs.stat(path.join(h.marketDir, 'cache', 'hash')));
    await assert.rejects(() => fs.stat(path.join(h.marketDir, 'work', 'hash')));
    // 导出产物与快照**必须**原样存在（含过期的那一个 —— 未显式请求回收）
    assert.equal((await fs.stat(path.join(h.exportsDir, 'dsh-config-new.zip'))).size, 100);
    assert.equal((await fs.stat(path.join(h.exportsDir, 'dsh-config-old.zip'))).size, 50);
    assert.equal((await fs.stat(path.join(h.snapshotsDir, 'snap-1', 'config.json'))).size, 20);
    assert.equal(body.report.reclaimableBytes, 0, '报告是清理后重新体检的结果');
    assert.ok(body.freedBytes >= 45, '释放量按删除前递归统计');
  } finally {
    await h.cleanup();
  }
});

test('POST /disk-usage/cleanup：显式 expired-exports 只删过期导出，新导出与快照不动', async () => {
  const h = await makeHarness();
  try {
    await seed(h);
    const route = routeByPath(backupRoutes(envFor(h)), '/api/dsh-config-manager/disk-usage/cleanup');
    const res = fakeResponse();
    await route.handler(fakeRequest({ method: 'POST', body: '{"categories":["expired-exports"]}' }), res.res);
    assert.equal(res.status(), 200);
    const body = res.json() as { removed: number; report: { areas: Record<string, { sizeBytes: number }> } };
    await assert.rejects(() => fs.stat(path.join(h.exportsDir, 'dsh-config-old.zip')), '过期导出被回收');
    assert.equal((await fs.stat(path.join(h.exportsDir, 'dsh-config-new.zip'))).size, 100, '新导出保留');
    assert.equal((await fs.stat(path.join(h.snapshotsDir, 'snap-1', 'config.json'))).size, 20, '快照永不被清');
    // 只请求了 exports → 可重建区一个都没动
    assert.equal((await fs.stat(path.join(h.tmpDir, 'upload-staged.zip'))).size, 30);
    assert.equal(body.report.areas['exports']?.sizeBytes, 100);
  } finally {
    await h.cleanup();
  }
});
