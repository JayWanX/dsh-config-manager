/**
 * compatibilityReasons 测试（2026-09）：把「为什么是这个评分」变成结构化原因。
 *
 * 与 smoke.test.ts 的「兼容性评分规则」互补：
 *  - 那边钉**评分**（行为契约，改造前后必须一致）；
 *  - 这边钉**原因**（评分由原因派生 —— 界面解释与评分不可能漂移）与顺序，
 *    并把「更旧的备份即使跨平台也算 good」这条**历史行为**显式写下来（改它需要单独决策）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compatibilityReasons, computeCompatibility } from './validator.ts';
import type { CompatibilityInput } from './types.ts';
import type { SectionId } from '../schema/types.ts';

const base: CompatibilityInput = {
  sourceDsh: '0.1.0-rc.6',
  targetDsh: '0.1.0-rc.6',
  sourcePlatform: 'win32',
  targetPlatform: 'win32',
  schemaVersion: 1,
  missingSections: [],
};

test('compatibilityReasons：全同 → 无原因（评分 excellent）', () => {
  assert.deepEqual(compatibilityReasons(base), []);
  assert.equal(computeCompatibility(base), 'excellent');
});

test('compatibilityReasons：跨平台带两侧平台事实（评分 partial）', () => {
  const input = { ...base, targetPlatform: 'darwin' };
  assert.deepEqual(compatibilityReasons(input), [
    { kind: 'crossPlatform', sourcePlatform: 'win32', targetPlatform: 'darwin' },
  ]);
  assert.equal(computeCompatibility(input), 'partial');
});

test('compatibilityReasons：分区缺失带 id 列表（评分 partial）', () => {
  const input = { ...base, missingSections: ['plugins', 'mcp'] as SectionId[] };
  assert.deepEqual(compatibilityReasons(input), [
    { kind: 'missingSections', sections: ['plugins', 'mcp'] },
  ]);
  assert.equal(computeCompatibility(input), 'partial');
});

test('compatibilityReasons：来源更新 / 更旧各带两版本号', () => {
  const newer = compatibilityReasons({ ...base, sourceDsh: '0.2.0', targetDsh: '0.1.0' });
  assert.deepEqual(newer, [{ kind: 'sourceNewer', sourceDsh: '0.2.0', targetDsh: '0.1.0' }]);
  assert.equal(computeCompatibility({ ...base, sourceDsh: '0.2.0', targetDsh: '0.1.0' }), 'partial');

  const older = compatibilityReasons({ ...base, sourceDsh: '0.0.9', targetDsh: '0.1.0' });
  assert.deepEqual(older, [{ kind: 'sourceOlder', sourceDsh: '0.0.9', targetDsh: '0.1.0' }]);
  assert.equal(computeCompatibility({ ...base, sourceDsh: '0.0.9', targetDsh: '0.1.0' }), 'good');
});

test('compatibilityReasons：原因顺序固定为 跨平台 → 分区缺失 → 版本方向', () => {
  const reasons = compatibilityReasons({
    ...base,
    sourceDsh: '0.2.0',
    targetDsh: '0.1.0',
    targetPlatform: 'darwin',
    missingSections: ['plugins'] as SectionId[],
  });
  assert.deepEqual(reasons.map((r) => r.kind), ['crossPlatform', 'missingSections', 'sourceNewer']);
});

test('历史行为（冻结）：来源更旧 + 跨平台 → 评分 good（原因仍如实列出两条）', () => {
  const input = { ...base, sourceDsh: '0.0.9', targetDsh: '0.1.0', targetPlatform: 'darwin' };
  const reasons = compatibilityReasons(input);
  assert.deepEqual(reasons.map((r) => r.kind), ['crossPlatform', 'sourceOlder']);
  // 「更旧」在评分上覆盖了「跨平台」的 partial —— 这是改造前就有的口径，本次刻意不改；
  // 界面据 reasons 会把两条都显示出来（分数 good 但确实跨平台，用户仍需要重映射路径）。
  assert.equal(computeCompatibility(input), 'good');
});

test('compatibilityReasons：schema 超范围 → 只此一条（其余原因不再有意义）', () => {
  const reasons = compatibilityReasons({ ...base, schemaVersion: 999, targetPlatform: 'darwin', missingSections: ['plugins'] as SectionId[] });
  assert.deepEqual(reasons, [{ kind: 'schemaUnsupported', schemaVersion: 999 }]);
  assert.equal(computeCompatibility({ ...base, schemaVersion: 999 }), 'unsupported');
});

test('评分 = 原因的函数（同一输入两侧永不漂移）', () => {
  const cases: CompatibilityInput[] = [
    base,
    { ...base, targetPlatform: 'linux' },
    { ...base, missingSections: ['plugins'] as SectionId[] },
    { ...base, sourceDsh: '9.9.9' },
    { ...base, sourceDsh: '0.0.1' },
    { ...base, sourceDsh: '0.0.1', targetPlatform: 'linux', missingSections: ['mcp'] as SectionId[] },
    { ...base, schemaVersion: 999 },
  ];
  for (const input of cases) {
    const kinds = compatibilityReasons(input).map((r) => r.kind);
    const expected = kinds.includes('schemaUnsupported') ? 'unsupported'
      : kinds.includes('sourceOlder') ? 'good'
        : kinds.length > 0 ? 'partial'
          : 'excellent';
    assert.equal(computeCompatibility(input), expected, JSON.stringify(input));
  }
});
