/**
 * issue #27 回归：残留（stale）环境锁的**可识别性**。
 *
 * 缺陷：STALE（持有者已确证死亡）与 LOCKED（另一任务运行中）共用
 * 「操作暂时无法执行，请稍后重试；若持续失败请查看日志」文案，误导用户一直重试；
 * 而 stale 锁**不会自愈**，唯一出路是显式回收（GUI 事故恢复 / CLI recover-stale-lock），
 * 该命令此前也未出现在 --help 中。
 *
 * 契约（本文件锁定）：
 *  - STALE 单独分类为 'stale'（不再混入 'unavailable'）；
 *  - LOCKED 仍是 'locked'，UNKNOWN/IO/权限仍是 'unavailable'（分类不互相污染）；
 *  - stale 文案必须点明「重试/重启无效」并给出 recover-stale-lock 指引；
 *  - 分类**不改变**「STALE 绝不自动回收」的既有不变量（env-lock.test.ts §11.1-c12 继续把关）；
 *  - recover-stale-lock 必须出现在 CLI --help 中。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCK_BLOCK_MESSAGE,
  withMutationLock,
  type MutationLockPort,
} from '../../src/utils/env-lock.ts';
import { printUsage } from '../../src/cli/index.ts';

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

/** 只注入 acquire 结果的极简 port（分类只看 state，不依赖真实文件）。 */
function portOf(state: string, detail?: string): MutationLockPort {
  return {
    acquire: async () => ({ state, token: null, ...(detail !== undefined ? { detail } : {}) }),
    validate: () => false,
    release: async () => {},
  } as unknown as MutationLockPort;
}

test('L1 STALE → reason=stale（与 unavailable 区分），detail 透传', async () => {
  const res = await withMutationLock(portOf('STALE_LOCK_DETECTED', 'owner pid=19020 确证不存在'), { op: 'autosync' });
  assert.equal(res.context, null, 'stale 不放行');
  assert.equal(res.reason, 'stale', 'STALE 必须单独成类（issue #27 根因）');
  assert.equal(res.detail, 'owner pid=19020 确证不存在', 'stale 判定依据应透传（供日志诊断）');
});

test('L2 其余 state 分类不被污染：LOCKED→locked，UNKNOWN/IO/PERM→unavailable', async () => {
  assert.equal((await withMutationLock(portOf('LOCKED'), { op: 'restore' })).reason, 'locked');
  for (const state of ['UNKNOWN_STATE', 'LOCK_IO_ERROR', 'PERMISSION_ERROR']) {
    assert.equal(
      (await withMutationLock(portOf(state), { op: 'restore' })).reason,
      'unavailable',
      `${state} 仍应归为 unavailable`,
    );
  }
});

test('L3 stale 文案：点明重试/重启无效 + 给出 recover-stale-lock 指引（用户可操作）', () => {
  const msg = LOCK_BLOCK_MESSAGE.stale;
  assert.match(msg, /recover-stale-lock/, '必须给出可执行的恢复命令');
  assert.match(msg, /重试|重启/, '必须说明重试/重启都不会好');
  assert.notEqual(msg, LOCK_BLOCK_MESSAGE.unavailable, '不得与笼统的 unavailable 文案相同');
  // 用户文案不暴露内部细节：op/路径/主机名/进程号
  assert.ok(!/op=|pid=|locks|\.json/i.test(msg), `用户文案不得含内部诊断细节: ${msg}`);
});

test('L4 CLI --help 必须列出 recover-stale-lock（此前是隐藏命令）', () => {
  const lines: string[] = [];
  printUsage({ log: (s) => lines.push(s), error: (s) => lines.push(s) });
  const usage = lines.join('\n');
  assert.match(usage, /recover-stale-lock/, '--help 必须说明该命令');
  assert.match(usage, /stale|残留/, '--help 应说明它用于回收残留锁');
});

test('L5 分类不得改变「STALE 绝不自动回收」不变量（源码级守卫）', async () => {
  const src = await fs.readFile(path.resolve(here, '../../src/utils/env-lock.ts'), 'utf8');
  // acquire 侧遇到非 ACQUIRED 一律不放行；不得出现「stale → 自动删除/接管」的分支
  assert.ok(
    !/reason === 'stale'[^]*?unlink/s.test(src),
    'stale 分类不得引入自动 unlink（自动回收由显式 recoverStaleLock 独占）',
  );
  assert.ok(src.includes("res.state === 'STALE_LOCK_DETECTED'"), 'stale 分类基于 inspect 结论，不新增判定路径');
});
