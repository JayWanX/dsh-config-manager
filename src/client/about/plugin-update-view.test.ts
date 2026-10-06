/**
 * plugin-update-view 测试：失败码 → 文案键的映射必须覆盖共享失败码清单，
 * 且这些键在 zh/en 两本字典里都存在（穷尽映射的运行时兜底 —— 编译期由 Record 类型保证）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_FAILURE_KEYS, updateFailureKey } from './plugin-update-view.ts';
import { SELF_UPDATE_FAILURE_CODES } from '../../utils/shared-constants.ts';
import { en, zh } from '../locales.ts';

test('每个失败码都有专属文案键，且 zh/en 字典都有该键', () => {
  for (const code of SELF_UPDATE_FAILURE_CODES) {
    const key = UPDATE_FAILURE_KEYS[code];
    assert.ok(typeof key === 'string' && key.length > 0, '缺少映射: ' + code);
    assert.equal(typeof zh[key], 'string', 'zh 缺键: ' + key);
    assert.equal(typeof en[key], 'string', 'en 缺键: ' + key);
  }
});

test('updateFailureKey：已知码查表，未知码回 null（调用方回落宿主原始文本）', () => {
  assert.equal(updateFailureKey('install-failed'), 'about.update.code.installFailed');
  assert.equal(updateFailureKey('non-registry-install'), 'about.update.code.nonRegistryInstall');
  assert.equal(updateFailureKey('boom'), null);
  assert.equal(updateFailureKey(''), null);
});
