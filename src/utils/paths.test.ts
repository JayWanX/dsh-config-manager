/**
 * core-F4 回归：Windows 形状路径的前缀映射必须**折叠大小写**比较。
 *
 * 现象（audit-core core-F4）：手工路径映射里 oldPrefix 与真实值只差大小写时，逐字比较静默失配 →
 * 目标机保留源机绝对路径（workspace.path 与会话 cwd 对不上）。根因 = src/utils/paths.ts 的
 * applyPrefixMappings（core 侧调用点 analyzer 不变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPrefixMappings } from './paths.ts';
import type { PathMapping } from '../core/types.ts';

/** 测试用映射（appliesTo 与语义无关，任选一个合法分区） */
function mapping(oldPrefix: string, newPrefix: string): PathMapping {
  return { oldPrefix, newPrefix, appliesTo: ['workspaces'] };
}

function pathOf(value: unknown): string {
  return (value as { workspace: { path: string } }).workspace.path;
}

test('core-F4：Windows 路径大小写不一致的前缀映射必须照样生效（不得静默保留源机路径）', () => {
  // ① 子路径命中（反斜杠形态，大小写全不一致）
  const backslash = applyPrefixMappings(
    { workspace: { path: 'C:\\Users\\Alice\\Proj\\sub\\a.ts' } },
    [mapping('c:\\users\\alice\\proj', 'D:\\Data\\Proj')],
  );
  assert.equal(pathOf(backslash), 'D:/Data/Proj/sub/a.ts');

  // ② 整串相等（只差大小写）
  const exact = applyPrefixMappings(
    { workspace: { path: 'C:/Users/Alice/Proj' } },
    [mapping('c:/users/alice/proj', 'E:/moved')],
  );
  assert.equal(pathOf(exact), 'E:/moved');

  // ③ 正斜杠形态（归一化后同一判据）
  const forward = applyPrefixMappings(
    { workspace: { path: 'c:/Users/ALICE/proj/sub' } },
    [mapping('C:/users/alice/PROJ', 'F:/x')],
  );
  assert.equal(pathOf(forward), 'F:/x/sub');

  // ④ UNC 形态同样折叠
  const unc = applyPrefixMappings(
    { workspace: { path: '//Server/Share/Proj/x.ts' } },
    [mapping('//server/share/proj', '//Other/Share')],
  );
  assert.equal(pathOf(unc), '//Other/Share/x.ts');
});

test('core-F4：POSIX 路径**不得**折叠大小写（不同目录不许误匹配），逐字匹配行为不变', () => {
  const mappings: PathMapping[] = [mapping('/home/Alice/proj', '/srv/proj')];
  // 大小写不同 = 不同目录 → 原样保留
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/alice/proj/x' } }, mappings)), '/home/alice/proj/x');
  // 一致 → 照常映射（既有行为）
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj/x' } }, mappings)), '/srv/proj/x');
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj' } }, mappings)), '/srv/proj');
  // 段边界仍然生效（/home/Alice/project 不得被 /home/Alice/proj 命中）
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/project/x' } }, mappings)), '/home/Alice/project/x');
  // 空映射 = 恒等
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj/x' } }, [])), '/home/Alice/proj/x');
});
