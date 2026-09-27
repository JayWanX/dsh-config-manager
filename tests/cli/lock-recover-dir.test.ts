/**
 * `recover-stale-lock` 的锁目录解析（issue #36 的兜底路径：残留锁必须在**正确的根**下被找到）。
 *
 * 背景：宿主 `dataDir` 可被配置成非缺省值，而该命令此前写死 `$DSH_HOME/dsh-config-manager/locks` ——
 * 于是用户的残留锁「明明在磁盘上，CLI 却说没有」，只能手工删锁文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRecoverLocksDir } from '../../src/cli/index.ts';
import { OWNERSHIP_FILE } from '../../src/utils/env-lock.ts';

function makeHome(t: test.TestContext): { home: string; env: Record<string, string | undefined> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcm-lockdir-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ } });
  return { home, env: { DSH_HOME: home } };
}

function seedOwnership(locksDir: string): void {
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, OWNERSHIP_FILE), JSON.stringify({ schemaVersion: 1, owner: { instanceId: 'x' } }));
}

test('R-01 --data-dir 为快照目录时：命中其派生控制面根下的 locks（而不是写死的缺省根）', (t) => {
  const { home, env } = makeHome(t);
  const customRoot = path.join(home, 'custom');
  seedOwnership(path.join(customRoot, 'locks'));
  const resolved = resolveRecoverLocksDir({ dataDir: path.join(customRoot, 'snapshots') }, env);
  assert.equal(resolved, path.join(customRoot, 'locks'), '用户显式给出数据目录时必须以它为准');
});

test('R-02 --data-dir 直接给数据根时同样命中；候选逐个探测，不依赖固定层级', (t) => {
  const { home, env } = makeHome(t);
  const customRoot = path.join(home, 'custom');
  seedOwnership(path.join(customRoot, 'locks'));
  assert.equal(resolveRecoverLocksDir({ dataDir: customRoot }, env), path.join(customRoot, 'locks'));
});

test('R-03 --data-root 显式给出时为权威判定（不再叠加推断候选）', (t) => {
  const { home, env } = makeHome(t);
  const customRoot = path.join(home, 'custom');
  seedOwnership(path.join(customRoot, 'locks'));
  assert.equal(resolveRecoverLocksDir({ dataRoot: customRoot }, env), path.join(customRoot, 'locks'));
});

test('R-04 所有候选都没有 ownership（含缺省根）→ 退回缺省根，保持「无锁」时的既有诊断语义', (t) => {
  const { home, env } = makeHome(t);
  const resolved = resolveRecoverLocksDir({ dataDir: path.join(home, 'nowhere') }, env);
  assert.equal(resolved, path.join(home, 'dsh-config-manager', 'locks'));
});

test('R-05 缺省根就是宿主默认 dataDir 时无需 --data-dir（既有行为不变）', (t) => {
  const { home, env } = makeHome(t);
  const defaultLocks = path.join(home, 'dsh-config-manager', 'locks');
  seedOwnership(defaultLocks);
  assert.equal(resolveRecoverLocksDir({}, env), defaultLocks);
});

test('R-06 崩溃残留的 0 字节 ownership 也算「这个根下有锁」（损坏锁同样必须能被回收）', (t) => {
  const { home, env } = makeHome(t);
  const customRoot = path.join(home, 'custom');
  fs.mkdirSync(path.join(customRoot, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(customRoot, 'locks', OWNERSHIP_FILE), '');
  assert.equal(resolveRecoverLocksDir({ dataDir: customRoot }, env), path.join(customRoot, 'locks'));
});
