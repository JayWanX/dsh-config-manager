/**
 * t54 回归（路由层）：GET /recovery/status 必须带上「中断的档案复制残留」。
 *
 * 三条硬要求：
 *  ① 字段**只**来自 t39 的 `profiles.listIncompleteCopies()`（这里用替身注入，证明数据来源单一）；
 *  ② 只回传界面需要的四个字段（内部字段 markerReadable 这类不得外泄）；
 *  ③ 枚举失败时 `/recovery/status` 仍 200 且 `incompleteCopies=[]` —— 恢复面板的首要职责是把
 *     incident 说清楚，绝不因为残留枚举失败整页 500。
 *
 * 同目录约定：本用例与被测文件 src/routes/recovery.ts 同目录（仓库既有先例：kit/foreign/session-format）。
 * base sha 3f42a8b 上无此字段 ⇒ 本文件在 base 上是红的（见 t54 修前红证据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { recoveryRoutes } from './recovery.ts';
import { routeSpecOf, type WebRoute } from './kit.ts';
import { DshProfileManager } from '../profiles/dsh-profile-manager.ts';

const BASE = '/api/dsh-config-manager/recovery';

/** 只挂 recovery 组、只经 kit 的 endpoint 包装（与生产同一份产物）。 */
function routeOf(env: unknown): WebRoute {
  const routes = recoveryRoutes(env as never);
  assert.equal(routes.length, 1, 'recovery 组仍是**一条** prefix 路由（本任务不新增注册条目）');
  const found = routes.find((r) => routeSpecOf(r)?.path === BASE);
  assert.ok(found !== undefined, '必须能找到 recovery prefix 路由');
  return found;
}

function envWith(copies: () => unknown[]): unknown {
  return {
    dataDir: '/tmp/dcm-t54-data',
    host: { homeDir: '/tmp/dcm-t54-home', profile: 'web', log: { warn: () => {} } },
    profiles: { listIncompleteCopies: copies },
    recoveryOrchestrator: { status: async () => ({ status: 200, body: { incidents: [], running: [] } }) },
    sessionHealth: {},
    makeRecoveryExecutors: () => ({}),
    tryAppendHistory: async () => undefined,
  };
}

async function withServer(route: WebRoute, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = http.createServer((req, res) => { void route.handler(req, res) });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn('http://127.0.0.1:' + String(port) + BASE);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()) });
  }
}

test('t54：/recovery/status 回传 incompleteCopies（只 4 个字段，内部字段不外泄）', async () => {
  const route = routeOf(envWith(() => [
    { name: 'work-copy', dir: '/home/bob/profiles/work-copy', sourceName: 'work', startedAt: '2026-10-05T10:00:00.000Z', markerReadable: true },
  ]));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200);
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, [
      { name: 'work-copy', dir: '/home/bob/profiles/work-copy', sourceName: 'work', startedAt: '2026-10-05T10:00:00.000Z' },
    ], '只回传界面需要的四个字段（markerReadable 这类内部字段不得外泄）');
  });
});

test('t54：残留枚举抛错 → /recovery/status 仍 200 且 incompleteCopies=[]（绝不整页 500）', async () => {
  const route = routeOf(envWith(() => { throw new Error('EACCES: profiles 目录读不动'); }));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200, '枚举失败不得让恢复面板整页失败');
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
  });
});

test('t54：没有残留时字段恒在（空数组），客户端无需判 undefined 分支', async () => {
  const route = routeOf(envWith(() => []));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200);
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
  });
});

/* ------------------------------------------------------------------ t89（S2-3）：枚举失败 ≠ 没有残留 */

/** 用**真实** DshProfileManager 构造 env（不是替身）：证明失败事实来自引擎而非路由层猜测。 */
function envWithProfiles(profiles: unknown): unknown {
  return {
    dataDir: '/tmp/dcm-t89-data',
    host: { homeDir: '/tmp/dcm-t89-home', profile: 'web', log: { warn: () => {} } },
    profiles,
    recoveryOrchestrator: { status: async () => ({ status: 200, body: { incidents: [], running: [] } }) },
    sessionHealth: {},
    makeRecoveryExecutors: () => ({}),
    tryAppendHistory: async () => undefined,
  };
}

/** 临时 DSH home；返回 home 与清理函数。 */
function tmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dcm-t89-'));
  return { home, cleanup: () => { rmSync(home, { recursive: true, force: true }) } };
}

test('t89：残留枚举失败（profiles 根不是目录）→ 仍 200 且 incompleteCopiesUnreadable=true', async () => {
  const { home, cleanup } = tmpHome();
  try {
    // 让 profilesRoot() 指向一个**文件**：existsSync 为真、readdirSync 抛 ENOTDIR —— 与「读不动的目录」同类
    writeFileSync(join(home, 'profiles'), 'not-a-directory');
    const profiles = new DshProfileManager({ homeDir: home });
    const route = routeOf(envWithProfiles(profiles));
    await withServer(route, async (base) => {
      const res = await fetch(base + '/status');
      assert.equal(res.status, 200, 't54 口径不变：枚举失败绝不整页 500');
      const body = await res.json() as { incompleteCopies?: unknown; incompleteCopiesUnreadable?: unknown };
      assert.deepEqual(body.incompleteCopies, []);
      assert.equal(body.incompleteCopiesUnreadable, true, '失败必须与「没有残留」可区分');
    });
  } finally { cleanup() }
});

test('t89：确实没有残留（空 profiles 目录）→ 200 且不含 incompleteCopiesUnreadable 键', async () => {
  const { home, cleanup } = tmpHome();
  try {
    mkdirSync(join(home, 'profiles'));
    const profiles = new DshProfileManager({ homeDir: home });
    const route = routeOf(envWithProfiles(profiles));
    await withServer(route, async (base) => {
      const res = await fetch(base + '/status');
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body.incompleteCopies, []);
      assert.equal('incompleteCopiesUnreadable' in body, false, '读到了就是读到了：不得新增键（响应与 t54 逐字相同）');
    });
  } finally { cleanup() }
});

test('t89：旧宿主/替身（只有 listIncompleteCopies 且抛错）→ 仍 200、空数组、且置 unreadable=true', async () => {
  const route = routeOf(envWith(() => { throw new Error('EACCES: profiles 目录读不动'); }));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200, '抛错路径仍是 200（不得变成 500）');
    const body = await res.json() as { incompleteCopies?: unknown; incompleteCopiesUnreadable?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
    assert.equal(body.incompleteCopiesUnreadable, true, '拿不到 scan 时的抛错同样必须可见');
  });
});

test('t89：旧宿主不抛错 → 不得凭空声称失败（unreadable 键缺省）', async () => {
  const route = routeOf(envWith(() => []));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    const body = await res.json() as Record<string, unknown>;
    assert.equal('incompleteCopiesUnreadable' in body, false);
    assert.deepEqual(body.incompleteCopies, []);
  });
});
