/**
 * 会话格式处置开关（T1）的纯逻辑单测 —— 三种选择 × 命中/未命中，以及「绝不猜」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_FORMAT_DISPOSITION,
  SESSION_FORMAT_DISPOSITIONS,
  SESSION_FORMAT_DOCTOR_COMMAND,
  parseSessionFormatDisposition,
  sessionFormatBlocksPlan,
  sessionFormatFactsFromAnalysis,
  sessionFormatFactsFromPlan,
  sessionFormatNewest,
  sessionFormatSkipUnits,
  sessionFormatSkippedItems,
  sessionUnitId,
} from './session-format-disposition.ts';
import type { SessionFormatFacts } from './session-format-disposition.ts';
import { makePlan, makePlanItem } from './test-helpers.ts';
import type { ImportAnalysis } from '../core/types.ts';

const UNIT = 'sessions:--proj--/s1';

function facts(): SessionFormatFacts {
  return { target: 3, unreadable: [{ unitId: UNIT, version: 4 }], inspected: 1, unsampled: 0 };
}

function analysisWith(sessionFormats: ImportAnalysis['sessionFormats']): Pick<ImportAnalysis, 'sessionFormats'> {
  return { sessionFormats };
}

test('parseSessionFormatDisposition：只认三个合法值，其余一律 undefined（不猜）', () => {
  assert.deepEqual(SESSION_FORMAT_DISPOSITIONS, ['abort', 'skip', 'guide']);
  assert.equal(DEFAULT_SESSION_FORMAT_DISPOSITION, 'abort');
  for (const value of SESSION_FORMAT_DISPOSITIONS) {
    assert.equal(parseSessionFormatDisposition(value), value);
  }
  for (const bad of [undefined, null, '', 'ABORT', 'block', 0, {}, []]) {
    assert.equal(parseSessionFormatDisposition(bad), undefined, '非法值不得被当成缺省：' + JSON.stringify(bad));
  }
});

test('sessionUnitId：两种形态幂等归一（探针的裸键 ↔ 计划项的 sessions: 前缀）', () => {
  assert.equal(sessionUnitId('--proj--/s1'), UNIT);
  assert.equal(sessionUnitId(UNIT), UNIT);
});

test('sessionFormatFactsFromAnalysis：本机版本未知 / 没有读不了的单元 / 缺字段 → null（不渲染、不阻断）', () => {
  assert.equal(sessionFormatFactsFromAnalysis(null), null);
  assert.equal(sessionFormatFactsFromAnalysis(analysisWith(undefined)), null);
  assert.equal(sessionFormatFactsFromAnalysis(analysisWith({ target: 3, unreadable: [], sampled: 5, skipped: 0 })), null);
  assert.equal(
    sessionFormatFactsFromAnalysis(analysisWith({ target: null, unreadable: [{ unitId: UNIT, version: 4 }], sampled: 1, skipped: 0 })),
    null,
    '本机版本读不到 → 不得宣称「读不了」（宁可不报，也不谎报）',
  );
  // 单元 id 一律归一化到计划项形态（否则与前端的选择模型对不上）
  const facts = sessionFormatFactsFromAnalysis(analysisWith({ target: 3, unreadable: [{ unitId: '--proj--/s1', version: 4 }], sampled: 1, skipped: 2 }));
  assert.deepEqual(facts, { target: 3, unreadable: [{ unitId: UNIT, version: 4 }], inspected: 1, unsampled: 2 });
});

test('sessionFormatFactsFromPlan：只有被打上 formatUnsupported 的计划项才算数，且按单元去重', () => {
  assert.equal(sessionFormatFactsFromPlan([]), null);
  assert.equal(sessionFormatFactsFromPlan([makePlanItem({ id: 'settings:a', adapter: 'settings' })]), null);
  const items = [
    makePlanItem({ id: 'sessions:--p--/s1/session.jsonl.zstd', unitId: UNIT, adapter: 'sessions', formatUnsupported: { version: 4, target: 3 } }),
    // 同一会话的第二个 generation：同单元 → 只算一条
    makePlanItem({ id: 'sessions:--p--/s1/session.2.jsonl.zstd', unitId: UNIT, adapter: 'sessions' }),
    makePlanItem({ id: 'sessions:--p--/s2/session.jsonl.zstd', unitId: 'sessions:--p--/s2', adapter: 'sessions' }),
  ];
  assert.deepEqual(sessionFormatFactsFromPlan(items), {
    target: 3,
    unreadable: [{ unitId: UNIT, version: 4 }],
  });
  assert.equal(sessionFormatNewest(sessionFormatFactsFromPlan(items)), 4);
});

test('abort：命中读不了的会话即阻断（零写入），其余两种处置一律放行', () => {
  assert.equal(sessionFormatBlocksPlan(facts(), 'abort'), true);
  assert.equal(sessionFormatBlocksPlan(facts(), 'skip'), false);
  assert.equal(sessionFormatBlocksPlan(facts(), 'guide'), false);
  // 没有任何读不了的会话 → abort 也不阻断（正常导入不该被拦）
  assert.equal(sessionFormatBlocksPlan(null, 'abort'), false);
});

test('skip：只有 skip 才给出「默认不勾选」的单元；abort/guide 不动选择', () => {
  assert.deepEqual(sessionFormatSkipUnits(facts(), 'skip'), [UNIT]);
  assert.deepEqual(sessionFormatSkipUnits(facts(), 'abort'), []);
  assert.deepEqual(sessionFormatSkipUnits(facts(), 'guide'), []);
  assert.deepEqual(sessionFormatSkipUnits(null, 'skip'), []);
});

test('skip 的报告口径：被跳过的条数与选择模型同源（逐条一致）', () => {
  const plan = makePlan({
    items: [
      makePlanItem({ id: 'sessions:a', unitId: UNIT, adapter: 'sessions', kind: 'Create', formatUnsupported: { version: 4, target: 3 } }),
      makePlanItem({ id: 'sessions:b', unitId: 'sessions:--p--/s2', adapter: 'sessions', kind: 'Create', formatUnsupported: { version: 4, target: 3 } }),
      makePlanItem({ id: 'settings:a', adapter: 'settings', kind: 'Update' }),
    ],
  });
  const skipped = sessionFormatSkippedItems(plan, { sections: ['sessions', 'settings'], excluded: ['sessions:a'] });
  assert.deepEqual(skipped.map((item) => item.id), ['sessions:a'], '只有被排除且读不了的项才算「跳过」');
  // 全选 → 一条都没跳过（用户手动勾回来的也必须算「没跳过」）
  assert.deepEqual(sessionFormatSkippedItems(plan, { sections: ['sessions', 'settings'], excluded: [] }), []);
  // 没有选择（尚未生成计划）→ 不谎报
  assert.deepEqual(sessionFormatSkippedItems(plan, null), []);
});

test('引导文案：可复制命令是本插件自己的离线只读入口（绝不猜用户的 DSH 安装方式）', () => {
  assert.equal(SESSION_FORMAT_DOCTOR_COMMAND, 'dsh-config-manager sessions doctor');
  assert.equal(/(npm|pnpm|yarn|brew|dsh plugin)/.test(SESSION_FORMAT_DOCTOR_COMMAND), false, '不得给出猜出来的升级命令');
});
