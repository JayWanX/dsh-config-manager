/**
 * self-update 测试：自更新计划（版本 / 档案 / 来源校验）与执行器（成功 / 失败 / 超时 / 中止）。
 * 全部纯逻辑 + 注入式 runner —— 不真起子进程、不碰 registry。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSelfUpdate, runSelfUpdate, selfUpdateSpec } from './self-update.ts';
import type { SelfUpdateRunner } from './self-update.ts';

test('planSelfUpdate：合法请求产出钉住精确版本的 argv 与可复制命令', () => {
  const plan = planSelfUpdate({ current: '0.1.69', target: '0.1.70', profile: 'web' });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.version, '0.1.70');
  assert.deepEqual(plan.argv, ['add', 'dsh-config-manager@0.1.70']);
  assert.equal(plan.command, 'dsh plugin --profile web add dsh-config-manager@0.1.70');
  assert.equal(selfUpdateSpec('0.1.70'), 'dsh-config-manager@0.1.70');
});

test('planSelfUpdate：版本 / 档案 / 安装来源逐条拒绝，各带专属码', () => {
  const cases: Array<{ input: Parameters<typeof planSelfUpdate>[0]; code: string }> = [
    { input: { current: '0.1.69', target: '0.1.69', profile: 'web' }, code: 'not-newer' },
    { input: { current: '0.1.69', target: '0.1.68', profile: 'web' }, code: 'not-newer' },
    { input: { current: '1.0.0', target: 'not-a-version', profile: 'web' }, code: 'invalid-version' },
    { input: { current: '0.1.69', target: '', profile: 'web' }, code: 'invalid-version' },
    { input: { current: '0.1.69', target: '0.1.70', profile: '   ' }, code: 'profile-unknown' },
    { input: { current: '0.1.69', target: '0.1.70', profile: 'desktop' }, code: 'unsupported-profile' },
    { input: { current: '0.1.69', target: '0.1.70', profile: 'web', installedSpec: 'link:D:/repo' }, code: 'non-registry-install' },
    { input: { current: '0.1.69', target: '0.1.70', profile: 'web', installedSpec: 'file:../dsh-config-manager' }, code: 'non-registry-install' },
    { input: { current: '0.1.69', target: '0.1.70', profile: 'web', installedSpec: 'git+https://github.com/a/b.git' }, code: 'non-registry-install' },
  ];
  for (const { input, code } of cases) {
    const plan = planSelfUpdate(input);
    assert.equal(plan.ok, false, JSON.stringify(input));
    if (plan.ok) continue;
    assert.equal(plan.code, code, JSON.stringify(input));
    assert.ok(plan.error.length > 0, '拒绝必须带可读原因');
  }
});

test('planSelfUpdate：registry 形态的 spec（精确版 / 区间）不算非 registry 来源', () => {
  for (const spec of ['0.1.60', '^0.1.60', '~0.1.60', '>=0.1.60']) {
    const plan = planSelfUpdate({ current: '0.1.69', target: '0.1.70', profile: 'web', installedSpec: spec });
    assert.equal(plan.ok, true, spec);
  }
});

test('planSelfUpdate：目标必须是严格更新（预发布不构成降级）', () => {
  const higher = planSelfUpdate({ current: '0.1.69', target: '0.1.70-rc.1', profile: 'web' });
  assert.equal(higher.ok, true);
  const lower = planSelfUpdate({ current: '0.1.70', target: '0.1.70-rc.1', profile: 'web' });
  assert.equal(lower.ok, false);
  if (!lower.ok) assert.equal(lower.code, 'not-newer');
});

/** 记录调用参数的 runner 桩。 */
function stubRunner(result: Awaited<ReturnType<SelfUpdateRunner>>): { runner: SelfUpdateRunner; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const runner: SelfUpdateRunner = async (profileDir, profile, pluginArgs, timeoutMs, signal) => {
    calls.push([profileDir, profile, pluginArgs, timeoutMs, signal]);
    return result;
  };
  return { runner, calls };
}

test('runSelfUpdate：成功 → needsRestart，argv 原样交给官方通道', async () => {
  const plan = planSelfUpdate({ current: '0.1.69', target: '0.1.70', profile: 'web' });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const { runner, calls } = stubRunner({ exitCode: 0, timedOut: false, stdout: '', stderr: '' });
  const out = await runSelfUpdate(plan, { runner, profileDir: 'P', profile: 'web' });
  assert.deepEqual(out, {
    ok: true,
    version: '0.1.70',
    command: 'dsh plugin --profile web add dsh-config-manager@0.1.70',
    needsRestart: true,
  });
  assert.deepEqual(calls[0], ['P', 'web', ['add', 'dsh-config-manager@0.1.70'], undefined, undefined]);
});

test('runSelfUpdate：安装失败 / 超时 / 中止一律如实失败（绝不当成功）', async () => {
  const plan = planSelfUpdate({ current: '0.1.69', target: '0.1.70', profile: 'web' });
  if (!plan.ok) throw new Error('plan must be ok');

  const failed = await runSelfUpdate(plan, {
    runner: stubRunner({ exitCode: 1, timedOut: false, stdout: '', stderr: 'boom: something went wrong' }).runner,
    profileDir: 'P',
    profile: 'web',
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, 'install-failed');
    assert.match(failed.error, /boom/);
  }

  const timedOut = await runSelfUpdate(plan, {
    runner: stubRunner({ exitCode: null, timedOut: true, stdout: '', stderr: '' }).runner,
    profileDir: 'P',
    profile: 'web',
  });
  assert.equal(timedOut.ok, false);

  const aborted = await runSelfUpdate(plan, {
    runner: stubRunner({ exitCode: null, timedOut: false, aborted: true, stdout: '', stderr: '' }).runner,
    profileDir: 'P',
    profile: 'web',
  });
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.code, 'install-failed');
});
