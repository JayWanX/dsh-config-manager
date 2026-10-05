/**
 * 「下载原始日志 (ZIP)」入口的三态判定测试（F-2）。
 *
 * 为什么必须有：这条入口的失败模式是**判据错**而不是功能错 ——
 *  - 竞品用 `status !== 501` 探测，本机 DSH 服务缺失返的是 **500**，照抄 → 入口**几乎恒显示**；
 *  - 反过来更糟的镜像错误是**恒隐藏**（把「拿不到状态码」当成「不支持」）。
 * 这里把三态、原因映射与「何时才打扰用户」逐条钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionExportEntryState,
  sessionExportHintKey,
  sessionExportReasonText,
  type SessionExportProbe,
} from './session-export-view.ts';

function probe(patch: Partial<SessionExportProbe> = {}): SessionExportProbe {
  return { availability: 'available', status: 200, path: '/api/session.export', checkedAt: '2026-10-05T00:00:00.000Z', ...patch };
}

test('pending（探测未回）≠ unavailable：不误判禁用，也不弹原因', () => {
  const state = sessionExportEntryState(null);
  assert.equal(state.pending, true);
  assert.equal(state.enabled, false);
  assert.equal(state.visible, true, '入口始终渲染：消失会让用户以为插件没做这个功能');
  assert.equal(state.reasonKey, null, '还没问出来就不该给原因');
});

test('available → 可用且不给原因（不打扰）', () => {
  for (const status of [200, 400, 404]) {
    const state = sessionExportEntryState(probe({ availability: 'available', status }));
    assert.equal(state.enabled, true);
    assert.equal(state.pending, false);
    assert.equal(state.reasonKey, null);
    assert.equal(sessionExportHintKey(state), null);
  }
});

test('unavailable → **禁用**并给出可读原因（绝不静默）', () => {
  const state = sessionExportEntryState(probe({ availability: 'unavailable', reason: 'service-missing', status: 500 }));
  assert.equal(state.enabled, false, '缺服务必须禁用而不是继续显示可用');
  assert.equal(state.visible, true);
  assert.equal(state.reasonKey, 'sessions.zip.reason.serviceMissing');
  assert.equal(state.reasonParams?.['status'], '500', '状态码作为诊断信息附在原因里');
  assert.equal(sessionExportHintKey(state), 'sessions.zip.reason.serviceMissing');
});

test('unknown → **保守显示为可用**（拿不到状态码绝不猜成不支持）', () => {
  for (const reason of ['network-error', 'auth-required', 'read-failed', 'unexpected-status'] as const) {
    const state = sessionExportEntryState(probe({ availability: 'unknown', reason, status: 0 }));
    assert.equal(state.enabled, true, 'unknown 必须可用（reason=' + reason + '）');
    assert.equal(state.reasonKey, null);
    assert.equal(sessionExportHintKey(state), null, 'unknown 不打扰用户（点了也没问题）');
  }
});

test('反例护栏：竞品的 `status !== 501` 判据在 500 下会判成「可用」—— 我们不得这样', () => {
  // 这条断言把「为什么不能照抄」变成可执行的证据：
  // 同一个 500（缺服务）输入，竞品判据给 true（显示），我们给 unavailable（禁用 + 说明）。
  const competitorVerdict = (status: number): boolean => status !== 501;
  assert.equal(competitorVerdict(500), true, '竞品在 500 下会显示 —— 正是它过时的原因');
  const ours = sessionExportEntryState(probe({ availability: 'unavailable', reason: 'service-missing', status: 500 }));
  assert.equal(ours.enabled, false, '正确判据必须禁用');
});

test('原因映射：五类成因各自映射到独立字典键（不漏、不串）', () => {
  const cases = [
    ['service-missing', 'sessions.zip.reason.serviceMissing'],
    ['auth-required', 'sessions.zip.reason.authRequired'],
    ['read-failed', 'sessions.zip.reason.readFailed'],
    ['network-error', 'sessions.zip.reason.networkError'],
    ['unexpected-status', 'sessions.zip.reason.unexpectedStatus'],
  ] as const;
  const seen = new Set<string>();
  for (const [reason, key] of cases) {
    // 只有 unavailable 才会真的渲染原因；其它成因在 unknown 下不打扰 —— 所以直接测映射本身。
    const state = sessionExportEntryState(probe({ availability: 'unavailable', reason, status: 500 }));
    assert.equal(state.reasonKey, key, reason + ' 应映射到 ' + key);
    assert.ok(!seen.has(key), '字典键不得重复：' + key);
    seen.add(key);
  }
});

test('原因渲染：走注入的翻译函数，插值带上状态码', () => {
  const state = sessionExportEntryState(probe({ availability: 'unavailable', reason: 'service-missing', status: 500 }));
  const calls: { key: string; params?: Record<string, string | number> }[] = [];
  const text = sessionExportReasonText(state, (key, params) => { calls.push({ key, ...(params === undefined ? {} : { params }) }); return 'T:' + key });
  assert.equal(text, 'T:sessions.zip.reason.serviceMissing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params?.['status'], '500');
  // 可用时**不**调用翻译函数（不给用户看任何东西）
  calls.length = 0;
  assert.equal(sessionExportReasonText(sessionExportEntryState(probe()), (key) => { calls.push({ key }); return key }), null);
  assert.equal(calls.length, 0, '可用时不得产生任何文案调用');
});

test('缺省原因：unavailable 但不带 reason 时按 service-missing 处理（绝不落成空文案）', () => {
  const state = sessionExportEntryState(probe({ availability: 'unavailable', status: 500 }));
  assert.equal(state.reasonKey, 'sessions.zip.reason.serviceMissing');
  assert.equal(state.enabled, false);
});
