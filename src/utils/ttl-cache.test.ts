/**
 * ttl-cache 测试：命中 / 过期 / 并发去重 / 失败不缓存 / 容量淘汰 / clear。
 * 全程注入时钟（不靠 sleep）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTtlAsyncCache } from './ttl-cache.ts';

/** 可控时钟 */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms } };
}

test('ttl-cache：TTL 内命中缓存（load 只调一次），过期后重算', async () => {
  const c = clock();
  const cache = createTtlAsyncCache<number>({ ttlMs: 5000, now: c.now });
  let calls = 0;
  const load = async (): Promise<number> => { calls += 1; return calls };

  assert.equal(await cache.resolve('k', load), 1);
  assert.equal(await cache.resolve('k', load), 1, 'TTL 内不再调用 load');
  assert.equal(calls, 1);

  c.advance(4999);
  assert.equal(await cache.resolve('k', load), 1, '差 1 ms 仍命中');
  c.advance(1);
  assert.equal(await cache.resolve('k', load), 2, '到点即失效（>= ttlMs 重算）');
  assert.equal(calls, 2);
});

test('ttl-cache：ttlMs <= 0 等价于关闭缓存', async () => {
  const cache = createTtlAsyncCache<number>({ ttlMs: 0 });
  let calls = 0;
  const load = async (): Promise<number> => { calls += 1; return calls };
  assert.equal(await cache.resolve('k', load), 1);
  assert.equal(await cache.resolve('k', load), 2);
  assert.equal(calls, 2);
});

test('ttl-cache：同 key 的并发调用合并成一次 load（in-flight 去重）', async () => {
  const cache = createTtlAsyncCache<string>({ ttlMs: 5000 });
  let calls = 0;
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((resolve) => { release = resolve });
  const load = (): Promise<string> => { calls += 1; return gate };

  const [a, b, cPromise] = [cache.resolve('k', load), cache.resolve('k', load), cache.resolve('k', load)];
  assert.equal(calls, 1, '三个并发调用只 load 一次');
  release('v');
  assert.deepEqual(await Promise.all([a, b, cPromise]), ['v', 'v', 'v']);
  assert.equal(await cache.resolve('k', load), 'v', '完成后进入 TTL 缓存，不再 load');
  assert.equal(calls, 1);
});

test('ttl-cache：失败不缓存（同 key 下一次调用重新 load，且并发者共享同一个失败）', async () => {
  const cache = createTtlAsyncCache<number>({ ttlMs: 5000 });
  let calls = 0;
  const failing = async (): Promise<number> => { calls += 1; throw new Error('boom') };

  await assert.rejects(() => cache.resolve('k', failing), /boom/);
  assert.equal(cache.size(), 0, '失败不写入缓存');
  await assert.rejects(() => cache.resolve('k', failing), /boom/);
  assert.equal(calls, 2, '第二次调用重新 load（没有被缓存成失败）');

  const ok = async (): Promise<number> => { calls += 1; return 42 };
  assert.equal(await cache.resolve('k', ok), 42, '恢复后立即成功');
  assert.equal(await cache.resolve('k', ok), 42);
  assert.equal(calls, 3);
});

test('ttl-cache：并发失败共享同一个 reject，且不污染后续调用', async () => {
  const cache = createTtlAsyncCache<number>({ ttlMs: 5000 });
  let calls = 0;
  const load = async (): Promise<number> => { calls += 1; throw new Error('x') };
  const results = await Promise.allSettled([cache.resolve('k', load), cache.resolve('k', load)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 1, '并发只 load 一次');
  assert.equal(cache.size(), 0);
});

test('ttl-cache：容量上限淘汰最早写入的条目；clear 清空（含在途）', async () => {
  const cache = createTtlAsyncCache<number>({ ttlMs: 5000, maxEntries: 2 });
  let calls = 0;
  const load = async (): Promise<number> => { calls += 1; return calls };
  await cache.resolve('a', load);
  await cache.resolve('b', load);
  assert.equal(cache.size(), 2);
  await cache.resolve('c', load);
  assert.equal(cache.size(), 2, '超过上限会淘汰，不会无界增长');
  assert.equal(await cache.resolve('a', load), 4, 'a 已被淘汰 → 重新 load');

  cache.clear();
  assert.equal(cache.size(), 0);
});
