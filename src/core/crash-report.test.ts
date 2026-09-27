/**
 * Phase 1 P0-5 崩溃检测 / 归因 单测（src/core/crash-report.ts）。
 *
 * 覆盖（每条一个具名 test）：
 *  1. classifyCrashLog：四类日志签名分支 + unknown 回退（含大小写不敏感）；
 *  2. adviceFor：每种 crashReason 的建议动作 + crashed=false 恒为 none；
 *  3. computeBootAlert：首次启动 / prev.ok 决定崩溃 / crashReason 沿用或由 logTail 归因；
 *  4. readBootState：缺失 / 非法 JSON / 合法 JSON 但结构非法（缺字段、类型错）→ 一律 null；
 *  5. writeBootState + readBootState 往返（真实临时目录；原子写不留 tmp 残留文件）；
 *  6. adoptLegacyBootState：老位置（灾备快照库目录）状态的一次性搬迁（幂等 + best-effort）；
 *  7. readCrashLogTail：大文件取尾部（不是头部）/ 跳过空文件 / 无可读 → null；
 *  8. listCandidateLogs：<home>/logs/*.log + <home>/dsh.log；目录缺失 → []；
 *  9. beginBoot / markBootOk：ok:false→true、lastGoodAt 推进、beginBoot 保留 prev.lastGoodAt。
 *
 * 纪律：真实临时目录（fs.mkdtemp + t.after 清理），不 mock 文件系统 —— 本模块的
 * 价值恰在「读盘永不抛」的边界行为，必须用真实磁盘验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  adoptLegacyBootState,
  adviceFor,
  beginBoot,
  classifyCrashLog,
  computeBootAlert,
  listCandidateLogs,
  markBootOk,
  readBootState,
  readCrashLogTail,
  writeBootState,
  type BootState,
} from './crash-report.ts';

/** 建真实临时目录，并注册 t.after 清理（测试结束即删，避免残留）。 */
async function makeDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-crashreport-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 造一个完整的 BootState（未指定的字段取「上次正常」缺省）。 */
function makeState(patch: Partial<BootState> = {}): BootState {
  return {
    startedAt: '2026-09-13T00:00:00.000Z',
    pid: 1234,
    ok: false,
    okAt: null,
    lastGoodAt: null,
    crashReason: null,
    ...patch,
  };
}

/* ---------------------------------------------------------------- 1. 归因分类 */

test('classifyCrashLog：session-corrupt / bundle-check / patch-tree 三类签名命中，无匹配回退 unknown', () => {
  // session 日志损坏（Zstandard）
  assert.equal(
    classifyCrashLog('failed to read sessions/abc.jsonl: corrupt Zstandard session log (tail truncated)'),
    'session-corrupt',
  );
  // 大小写不敏感（/i）
  assert.equal(classifyCrashLog('CORRUPT ZSTANDARD SESSION LOG'), 'session-corrupt');

  // bundle 检查：两种签名各自命中同一类
  assert.equal(classifyCrashLog('profile "default" declares no dsh.bundle'), 'bundle-check');
  assert.equal(classifyCrashLog('cannot resolve profile bundle for profile default'), 'bundle-check');

  // patch 树：四种签名各自命中同一类
  assert.equal(classifyCrashLog('plugin dsh-config-manager already registered'), 'patch-tree');
  assert.equal(classifyCrashLog('duplicate loader entry: cordis.patch.yml#row-3'), 'patch-tree');
  assert.equal(classifyCrashLog('failed to load plugin dsh-config-manager'), 'patch-tree');
  assert.equal(classifyCrashLog("Cannot find module 'left-pad'"), 'patch-tree');
  assert.equal(classifyCrashLog('cannot find package @scope/missing'), 'patch-tree');

  // 无匹配 / 空文本 → unknown
  assert.equal(classifyCrashLog('dsh booted in 812ms, 12 plugins active'), 'unknown');
  assert.equal(classifyCrashLog(''), 'unknown');
});

/* ---------------------------------------------------------------- 2. 建议动作 */

test('adviceFor：四类原因各自映射，crashReason 为 null 时回退 restore-last-good；crashed=false 恒 none', () => {
  assert.equal(adviceFor('session-corrupt', true), 'repair-session');
  assert.equal(adviceFor('bundle-check', true), 'check-bundles');
  assert.equal(adviceFor('patch-tree', true), 'check-patch-tree');
  assert.equal(adviceFor('unknown', true), 'restore-last-good');
  // 崩溃但无归因证据 → 只有「恢复最后正常快照」这一条保守动作
  assert.equal(adviceFor(null, true), 'restore-last-good');

  // 未崩溃：无论原因是什么都不给建议（不打扰用户）
  assert.equal(adviceFor('session-corrupt', false), 'none');
  assert.equal(adviceFor('bundle-check', false), 'none');
  assert.equal(adviceFor('patch-tree', false), 'none');
  assert.equal(adviceFor('unknown', false), 'none');
  assert.equal(adviceFor(null, false), 'none');
});

/* ---------------------------------------------------------------- 3. boot alert */

test('computeBootAlert：prev=null（首次启动）不判崩溃、无 lastGood、advice=none', () => {
  const alert = computeBootAlert(null, 'corrupt Zstandard session log');
  assert.equal(alert.crashed, false);
  assert.equal(alert.lastGoodAt, null);
  assert.equal(alert.crashReason, null);
  assert.equal(alert.advice, 'none');
});

test('computeBootAlert：prev.ok 决定 crashed（true 不崩、false 崩），lastGoodAt 原样带出', () => {
  const good = makeState({ ok: true, okAt: '2026-09-12T23:59:00.000Z', lastGoodAt: '2026-09-12T23:59:00.000Z' });
  const alertGood = computeBootAlert(good, null);
  assert.equal(alertGood.crashed, false);
  assert.equal(alertGood.lastGoodAt, '2026-09-12T23:59:00.000Z');
  assert.equal(alertGood.crashReason, null);
  assert.equal(alertGood.advice, 'none');

  // 上次没走到「确认成功」（ok:false）→ 判崩溃
  const bad = makeState({ ok: false, lastGoodAt: '2026-09-11T08:00:00.000Z' });
  const alertBad = computeBootAlert(bad, null);
  assert.equal(alertBad.crashed, true);
  assert.equal(alertBad.lastGoodAt, '2026-09-11T08:00:00.000Z');
  assert.equal(alertBad.crashReason, null); // 无 prev 归因也无日志 → 无证据，不硬编 unknown
  assert.equal(alertBad.advice, 'restore-last-good');
});

test('computeBootAlert：crashReason 沿用 prev（上次已算过），prev 无归因时用 logTail 归类', () => {
  // 1) 沿用 prev.crashReason（即使本次日志尾部看不出原因，也不重新归因）
  const carried = computeBootAlert(makeState({ ok: false, crashReason: 'patch-tree' }), 'dsh booted fine');
  assert.equal(carried.crashed, true);
  assert.equal(carried.crashReason, 'patch-tree');
  assert.equal(carried.advice, 'check-patch-tree');

  // 2) prev 无归因 + 给了 logTail → classifyCrashLog
  const derived = computeBootAlert(makeState({ ok: false }), '... corrupt Zstandard session log ...');
  assert.equal(derived.crashReason, 'session-corrupt');
  assert.equal(derived.advice, 'repair-session');

  // 无签名日志 → unknown（有日志但没命中任何签名）
  const unknown = computeBootAlert(makeState({ ok: false }), 'random crash text without signature');
  assert.equal(unknown.crashReason, 'unknown');
  assert.equal(unknown.advice, 'restore-last-good');
});

/* ---------------------------------------------------------------- 4. 读盘容错 */

test('readBootState：文件缺失 / 非法 JSON / 合法 JSON 但非 BootState → 一律 null（绝不抛）', async (t) => {
  const dir = await makeDir(t);

  // 文件缺失
  assert.equal(await readBootState(dir), null);

  // 非法 JSON
  await fs.writeFile(path.join(dir, 'boot-state.json'), '{ this is not json', 'utf8');
  assert.equal(await readBootState(dir), null);

  // 合法 JSON 但不是 BootState：空对象（缺 ok 等全部字段）
  await fs.writeFile(path.join(dir, 'boot-state.json'), '{}', 'utf8');
  assert.equal(await readBootState(dir), null);

  // 合法 JSON 但缺 ok
  await fs.writeFile(
    path.join(dir, 'boot-state.json'),
    JSON.stringify({ startedAt: '2026-09-13T00:00:00.000Z', pid: 1, okAt: null, lastGoodAt: null, crashReason: null }),
    'utf8',
  );
  assert.equal(await readBootState(dir), null);

  // 合法 JSON 但类型错：ok 是字符串、pid 是字符串、crashReason 是未知枚举
  await fs.writeFile(
    path.join(dir, 'boot-state.json'),
    JSON.stringify({
      startedAt: '2026-09-13T00:00:00.000Z',
      pid: '1234',
      ok: 'yes',
      okAt: null,
      lastGoodAt: null,
      crashReason: null,
    }),
    'utf8',
  );
  assert.equal(await readBootState(dir), null);

  await fs.writeFile(
    path.join(dir, 'boot-state.json'),
    JSON.stringify(makeState({ crashReason: 'boom' as never })),
    'utf8',
  );
  assert.equal(await readBootState(dir), null);

  // 数组（合法 JSON，非对象）
  await fs.writeFile(path.join(dir, 'boot-state.json'), '[1,2,3]', 'utf8');
  assert.equal(await readBootState(dir), null);

  // 目录本身不存在也不抛
  assert.equal(await readBootState(path.join(dir, 'nope', 'deeper')), null);
});

/* ---------------------------------------------------------------- 5. 往返 */

test('writeBootState + readBootState：往返一致（真实临时目录，原子写不留 tmp 残留文件）', async (t) => {
  const dir = await makeDir(t);
  const state = makeState({
    startedAt: '2026-09-13T10:00:00.000Z',
    pid: 4321,
    ok: false,
    lastGoodAt: '2026-09-12T10:00:00.000Z',
    crashReason: 'patch-tree',
  });

  await writeBootState(dir, state);
  assert.deepEqual(await readBootState(dir), state);

  // 覆盖写（原子替换）：读到新值，且目录里只有唯一的 boot-state.json（无 .dshcm.*.tmp 残留）
  const next = makeState({ ok: true, okAt: '2026-09-13T10:00:30.000Z', lastGoodAt: '2026-09-13T10:00:30.000Z' });
  await writeBootState(dir, next);
  assert.deepEqual(await readBootState(dir), next);
  assert.deepEqual(await fs.readdir(dir), ['boot-state.json']);
});

/* ---------------------------------------------------------------- 6. 旧位置搬迁 */

test('adoptLegacyBootState：新目录为空时从旧目录搬一次，之后幂等', async (t) => {
  const legacy = await makeDir(t);
  const dir = await makeDir(t);
  const state = makeState({ ok: true, okAt: '2026-09-13T10:00:00.000Z', lastGoodAt: '2026-09-13T10:00:00.000Z' });
  await writeBootState(legacy, state);

  assert.equal(await adoptLegacyBootState(legacy, dir), true);
  assert.deepEqual(await readBootState(dir), state);
  // 幂等：新目录已有状态 → 不动（旧目录后来变脏也不覆盖）
  await writeBootState(legacy, makeState({ ok: false }));
  assert.equal(await adoptLegacyBootState(legacy, dir), false);
  assert.deepEqual(await readBootState(dir), state);
});

test('adoptLegacyBootState：旧目录无状态 / 同目录 / 旧目录缺失 → false 且不抛', async (t) => {
  const legacy = await makeDir(t);
  const dir = await makeDir(t);
  assert.equal(await adoptLegacyBootState(legacy, dir), false);
  assert.equal(await adoptLegacyBootState(dir, dir), false);
  assert.equal(await adoptLegacyBootState(path.join(legacy, 'missing'), dir), false);
});

/* ---------------------------------------------------------------- 7. 日志尾部 */

test('readCrashLogTail：大文件只读尾部（返回最后字节而非头部），跳过空文件，无可读 → null', async (t) => {
  const dir = await makeDir(t);

  // 大文件：头部 4 KiB 噪声 + 尾部崩溃签名；maxBytes=128 时只应拿到尾部窗口
  const head = 'HEAD-NOISE\n'.repeat(400);
  const tail = 'Error: cannot find module "left-pad"';
  const big = path.join(dir, 'big.log');
  await fs.writeFile(big, head + tail, 'utf8');

  const text = await readCrashLogTail([big], 128);
  assert.ok(text !== null, '大文件应返回尾部文本');
  assert.ok(text.endsWith(tail), `应包含最后字节（末尾 = 崩溃签名），实际末尾: ${text.slice(-60)}`);
  assert.ok(text.length <= 128, `不得超过 maxBytes，实际 ${text.length}`);
  assert.ok(!text.startsWith('HEAD-NOISE'), '不得从头读（返回的应是尾部窗口）');
  // 尾部窗口本身能被归因
  assert.equal(classifyCrashLog(text), 'patch-tree');

  // 缺省 maxBytes：整个文件都在窗口内 → 全文（仍以尾部结束）
  const whole = await readCrashLogTail([big]);
  assert.ok(whole !== null && whole.endsWith(tail));
  assert.equal(whole.length, head.length + tail.length);

  // 空文件被跳过 → 取下一个非空文件
  const empty = path.join(dir, 'empty.log');
  const second = path.join(dir, 'second.log');
  await fs.writeFile(empty, '', 'utf8');
  await fs.writeFile(second, 'second-log-content\n', 'utf8');
  assert.equal(await readCrashLogTail([empty, second], 64), 'second-log-content\n');

  // 空文件 + 不存在的路径 + 目录 → 无可读内容 → null
  const asDir = path.join(dir, 'logs-dir.log');
  await fs.mkdir(asDir, { recursive: true });
  assert.equal(await readCrashLogTail([path.join(dir, 'missing.log'), empty, asDir]), null);
  assert.equal(await readCrashLogTail([]), null);
  assert.equal(await readCrashLogTail([empty], 64), null);
});

/* ---------------------------------------------------------------- 8. 候选日志 */

test('listCandidateLogs：<home>/logs/*.log + <home>/dsh.log；目录缺失 → []', async (t) => {
  const home = await makeDir(t);

  // logs 目录不存在 → 空数组（不抛）
  assert.deepEqual(await listCandidateLogs(home), []);
  assert.deepEqual(await listCandidateLogs(path.join(home, 'no-such-home')), []);

  // logs 目录存在但无 .log、且无 dsh.log → 空数组
  const logsDir = path.join(home, 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, 'notes.txt'), 'x', 'utf8');
  assert.deepEqual(await listCandidateLogs(home), []);

  // logs/*.log（字典序）+ <home>/dsh.log；非 .log 与同名目录被忽略
  await fs.writeFile(path.join(logsDir, 'b.log'), 'b', 'utf8');
  await fs.writeFile(path.join(logsDir, 'a.log'), 'a', 'utf8');
  await fs.mkdir(path.join(logsDir, 'nested.log'), { recursive: true });
  await fs.writeFile(path.join(home, 'dsh.log'), 'dsh', 'utf8');
  assert.deepEqual(await listCandidateLogs(home), [
    path.join(logsDir, 'a.log'),
    path.join(logsDir, 'b.log'),
    path.join(home, 'dsh.log'),
  ]);

  // dsh.log 不存在时不编造路径（候选只含真实存在的文件）
  const home2 = await makeDir(t);
  await fs.mkdir(path.join(home2, 'logs'), { recursive: true });
  await fs.writeFile(path.join(home2, 'logs', 'only.log'), 'only', 'utf8');
  assert.deepEqual(await listCandidateLogs(home2), [path.join(home2, 'logs', 'only.log')]);
});

/* ---------------------------------------------------------------- 9. 启动生命周期 */

test('beginBoot / markBootOk：ok false→true、lastGoodAt 推进，beginBoot 保留 prev.lastGoodAt', () => {
  const prev = makeState({
    startedAt: '2026-09-12T20:00:00.000Z',
    pid: 111,
    ok: false,
    lastGoodAt: '2026-09-12T07:00:00.000Z',
    crashReason: 'patch-tree',
  });

  const started = beginBoot(999, prev, () => new Date('2026-09-13T00:00:00.000Z'));
  assert.equal(started.ok, false);
  assert.equal(started.okAt, null);
  assert.equal(started.pid, 999);
  assert.equal(started.startedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(started.lastGoodAt, prev.lastGoodAt, 'beginBoot 必须保留上次的「最近正常」时刻');
  assert.equal(started.crashReason, 'patch-tree', '未确认成功前沿用上次归因（供本次崩溃判定复用）');

  const ok = markBootOk(started, () => new Date('2026-09-13T00:00:30.000Z'));
  assert.equal(ok.ok, true);
  assert.equal(ok.okAt, '2026-09-13T00:00:30.000Z');
  assert.equal(ok.lastGoodAt, '2026-09-13T00:00:30.000Z');
  assert.ok(
    Date.parse(ok.lastGoodAt) > Date.parse(prev.lastGoodAt ?? ''),
    'lastGoodAt 应推进到本次确认成功时刻',
  );
  assert.equal(ok.crashReason, null, '确认成功后清空归因，避免陈旧原因误传染下一次崩溃判定');
  assert.equal(ok.startedAt, started.startedAt);
  assert.equal(ok.pid, started.pid);

  // 首次启动（prev=null）
  const first = beginBoot(7, null, () => new Date('2026-09-13T01:00:00.000Z'));
  assert.equal(first.ok, false);
  assert.equal(first.lastGoodAt, null);
  assert.equal(first.crashReason, null);

  // 缺省 now：取当前时间（ISO）
  const implicit = beginBoot(8, null);
  assert.ok(!Number.isNaN(Date.parse(implicit.startedAt)), '缺省 now 应产出可解析的 ISO 时间戳');
  assert.equal(markBootOk(implicit).ok, true);
});
