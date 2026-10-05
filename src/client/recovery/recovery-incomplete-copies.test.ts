/**
 * t54 回归（纯函数层）：中断的档案复制残留（cross-F3）→ 渲染模型。
 *
 * base sha 3f42a8b 上这些能力都不存在（RecoveryStatus 无 incompleteCopies 字段、无映射函数），
 * 因此本文件在 base 上是红 —— 详见 t54 的修前红证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { incompleteCopiesNotice, incompleteCopyRows, incompleteDeleteErrorCode, toRecoveryView } from './recovery-view.ts';
import { en, zh } from './recovery-locales.ts';
import type { RecoveryStatus } from '../../ui/types.ts';

function mkStatus(overrides: Partial<RecoveryStatus> = {}): RecoveryStatus {
  return { incidents: [], running: [], ...overrides };
}

test('t54：残留目录 → 只能删除、不能启动，时间有本地化展示文本', () => {
  const rows = incompleteCopyRows(mkStatus({
    incompleteCopies: [{ name: 'work-copy', dir: '/home/bob/profiles/work-copy', sourceName: 'work', startedAt: '2026-10-05T10:00:00.000Z' }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, 'work-copy');
  assert.equal(rows[0]?.dir, '/home/bob/profiles/work-copy');
  assert.equal(rows[0]?.sourceName, 'work');
  assert.equal(rows[0]?.canDelete, true);
  assert.equal(rows[0]?.canLaunch, false, '没有 package.json 的残留绝不给启动入口');
  assert.notEqual(rows[0]?.startedAtText, '', '时间必须有展示文本');
});

test('t54：标记不可解析（sourceName/startedAt=null）→ 原样保留 null 不臆造；时间显示 em dash', () => {
  const rows = incompleteCopyRows(mkStatus({ incompleteCopies: [{ name: 'x', dir: '/d/x', sourceName: null, startedAt: null }] }));
  assert.equal(rows[0]?.sourceName, null);
  assert.equal(rows[0]?.startedAt, null);
  assert.equal(rows[0]?.startedAtText, '—');
});

test('t54：旧宿主不返回 incompleteCopies → 空数组且不得声称「需要处理」', () => {
  assert.deepEqual(incompleteCopyRows(mkStatus()), []);
  const v = toRecoveryView(mkStatus());
  assert.deepEqual(v.incompleteCopies, []);
  assert.equal(v.recoveryRequired, false);
});

test('t54：有残留 → recoveryRequired=true 且分类 NEEDS_ATTENTION（面板必须给出入口）', () => {
  const v = toRecoveryView(mkStatus({ incompleteCopies: [{ name: 'work-copy', dir: '/d/w', sourceName: null, startedAt: null }] }));
  assert.equal(v.recoveryRequired, true);
  assert.equal(v.state, 'NEEDS_ATTENTION');
});

test('t54：SAFE MODE 阻断（423 mutation-locked）必须能被识别 = 「有原因 + 有出口」的前提', () => {
  assert.equal(incompleteDeleteErrorCode({ code: 'mutation-locked' }), 'mutation-locked');
  assert.equal(
    incompleteDeleteErrorCode(new Error('HTTP 423: mutation locked (code: mutation-locked)')),
    'mutation-locked',
    '只把码写进文本的错误也要认出来（否则界面会退化成死胡同）',
  );
  assert.equal(incompleteDeleteErrorCode(new Error('boom')), '');
  assert.equal(incompleteDeleteErrorCode(null), '');
});

test('t54：新增文案 zh/en 两套字典键集完全相等（运行时钉住；编译期另有 Record<keyof zh> 约束）', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 键集必须逐项相等');
  const need = ['recovery.incomplete.title', 'recovery.incomplete.hint', 'recovery.incomplete.delete', 'recovery.incomplete.locked', 'recovery.incomplete.unlock'];
  for (const k of need) {
    assert.ok(zhKeys.includes(k), 'zh 缺键: ' + k);
    assert.notEqual(String(zh[k as keyof typeof zh]).trim(), '', 'zh 文案不得为空: ' + k);
    assert.notEqual(String(en[k as keyof typeof en]).trim(), '', 'en 文案不得为空: ' + k);
  }
});

test('t54：SAFE MODE 阻断必须呈现「原因 + 出口」—— 源码级守卫（审查可复核的原始文本）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./IncompleteCopiesSection.tsx', import.meta.url), 'utf8');
  assert.ok(
    src.includes("incompleteDeleteErrorCode(err) === 'mutation-locked'"),
    '必须识别 SAFE MODE 的机器码（否则界面会把阻断当成普通失败）',
  );
  assert.ok(src.includes("t('recovery.incomplete.locked'"), '必须渲染阻断原因文案');
  assert.ok(
    src.includes('recoveryApi.clearSafeMode(true)'),
    '必须给出出口：既有 POST /recovery/safe-mode/clear（不得呈现成没有出路的死胡同）',
  );
  assert.ok(src.includes('constraint') === false, 'noop');
});

test('t54：恢复面板必须真的渲染该区块（源码级守卫：接线在 RecoveryPanel.tsx 里）', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('./RecoveryPanel.tsx', import.meta.url), 'utf8');
  assert.ok(panel.includes('<IncompleteCopiesSection'), '面板必须渲染残留区块');
  assert.ok(
    panel.includes('rows={view.incompleteCopies}'),
    '数据必须来自 toRecoveryView 的映射结果（不在组件里重新判定）',
  );
  assert.ok(panel.includes('onChanged={load}'), '处置成功后必须重拉 /recovery/status');
  assert.ok(panel.includes('diskApi={props.diskApi}'), '删除必须走既有主 API（POST /profiles/delete）');
});

/* --------------------------------------- t89（S2-3）：枚举失败必须与「没有残留」不同形 */

test('t89：枚举失败 → notice=unreadable（失败优先于行数），且不得声称 recoveryRequired', () => {
  assert.equal(incompleteCopiesNotice(mkStatus({ incompleteCopiesUnreadable: true })), 'unreadable');
  // 关键反例：失败时 incompleteCopies 恒为空（服务端口径）——只看行数就会退化成 'empty'
  const v = toRecoveryView(mkStatus({ incompleteCopiesUnreadable: true, incompleteCopies: [] }));
  assert.equal(v.incompleteCopiesNotice, 'unreadable', '空数组 + 失败标志 ⇒ 失败，而不是「没有残留」');
  assert.deepEqual(v.incompleteCopies, []);
  assert.equal(v.recoveryRequired, false, '失败只是「不知道」，不是「有事项」——不凭未知声称需要处理');
  assert.equal(v.state, 'NORMAL');
});

test('t89：确实没有残留 → notice=empty（含旧宿主缺字段）', () => {
  assert.equal(incompleteCopiesNotice(mkStatus()), 'empty');
  assert.equal(incompleteCopiesNotice(mkStatus({ incompleteCopies: [] })), 'empty');
  assert.equal(_unreadableCases(), true);
});

test('t89：有残留 → notice=list（既有行为不变）', () => {
  const v = toRecoveryView(mkStatus({ incompleteCopies: [{ name: 'work-copy', dir: '/d/w', sourceName: null, startedAt: null }] }));
  assert.equal(v.incompleteCopiesNotice, 'list');
  assert.equal(v.recoveryRequired, true);
});

test('t89：新增文案键在 zh/en 都存在、非空，且两套键集仍逐项相等', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 键集必须逐项相等（新增键也必须两边都有）');
  for (const k of ['recovery.incomplete.unreadable.title', 'recovery.incomplete.unreadable.hint']) {
    assert.ok(zhKeys.includes(k), 'zh 缺键: ' + k);
    assert.notEqual(String(zh[k as keyof typeof zh]).trim(), '', 'zh 文案不得为空: ' + k);
    assert.notEqual(String(en[k as keyof typeof en]).trim(), '', 'en 文案不得为空: ' + k);
  }
});

test('t89：面板必须把「枚举失败」渲染成独立形态（源码级守卫，可复核）', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('./RecoveryPanel.tsx', import.meta.url), 'utf8');
  assert.ok(
    panel.includes("view.incompleteCopiesNotice === 'unreadable'"),
    '面板必须按纯函数的结论分支（不在组件里重新判定）',
  );
  assert.ok(panel.includes("t('recovery.incomplete.unreadable.hint')"), '必须给出可行动文案（读不到 ≠ 没有）');
  assert.ok(panel.includes('<Banner kind="warn">'), '失败提示必须是告警态，且不得与「暂无残留」同形');
});

/** 汇总辅助（保持测试可读）：把「缺字段 / 空数组」两种旧宿主形态放在一处断言。 */
function _unreadableCases(): boolean {
  return incompleteCopiesNotice(mkStatus({ incompleteCopies: undefined })) === 'empty'
    && incompleteCopiesNotice(mkStatus({ incompleteCopiesUnreadable: false })) === 'empty';
}
