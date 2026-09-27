/**
 * 启动关键文件清单单测。
 *
 * 用例迁自 config-lifecycle.test.ts（灾备线已下线删除），但清单本身仍被
 * boot-safety.ts 的导入安全审计使用 —— 断言逐字锁定，防止清理功能时被误删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOT_CRITICAL_RELS, profileCriticalRels } from './boot-paths.ts';

test('BOOT_CRITICAL_RELS：覆盖 DSH 启动关键文件', () => {
  assert.deepEqual([...BOOT_CRITICAL_RELS], [
    'settings.yaml',
    'settings.json',
    'cordis.patch.yml',
    '.env',
    'AGENTS.md',
  ]);
});

test('profileCriticalRels：按 profile 名生成 profile 内关键文件路径', () => {
  const rels = profileCriticalRels('mine');
  assert.deepEqual(rels, [
    'profiles/mine/cordis.patch.yml',
    'profiles/mine/package.json',
    'profiles/mine/cordis.yml',
    'profiles/mine/pnpm-workspace.yaml',
  ]);
});

test('profileCriticalRels：不同 profile 互不串味', () => {
  assert.ok(profileCriticalRels('a').every((r) => r.startsWith('profiles/a/')));
  assert.ok(!profileCriticalRels('a').some((r) => r.includes('profiles/b/')));
});
