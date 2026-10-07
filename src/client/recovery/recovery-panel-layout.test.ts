/**
 * 源码级布局守卫（M2 收尾，2026-10-07 用户实测）：面板小节的**容器类**必须用对。
 *
 * 实测缺陷（用户截图「都挤在一块了」）：`SessionLayoutSection` 外层用了 `.snapshotRow`
 * （横向 flex 行）当卡片容器，标题又用了 `.snapshotRowMain`（`flex:1` + `nowrap`），
 * 于是标题/说明/按钮/计划被排成一行、文字被挤成竖排。
 *
 * 为什么需要这条：类型检查、模型单测、bundle 自包含护栏**都抓不到**这类缺陷 —— 它只在真实渲染里可见。
 * 这条守卫把「容器类选错」变回红灯（口径：小节外层 = `.card`；小节标题 = `.groupLabel`；
 * 行列表 = `.snapshotList` + `.reportScroll`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_PATH = 'src/client/recovery/RecoveryPanel.tsx';

/** 截出某个顶层函数的函数体（到下一个顶层 `function ` 为止）。 */
function functionBody(name: string): string {
  const src = readFileSync(SOURCE_PATH, 'utf8');
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, SOURCE_PATH + ' 里找不到函数 ' + name);
  const end = src.indexOf('\nfunction ', at + 1);
  return src.slice(at, end < 0 ? undefined : end);
}

test('布局守卫：小节用卡片容器 + groupLabel 标题 + snapshotList/reportScroll 列表', () => {
  const body = functionBody('SessionLayoutSection');

  assert.match(
    body,
    /return \(\s*<div className=\{css\.card\}>/,
    '小节外层必须是 .card（纵向卡片）—— 用 .snapshotRow（横向行）会把标题/说明/按钮挤成一行',
  );
  assert.equal(
    /<div className=\{css\.snapshotRowMain\}>\{t\(/.test(body),
    false,
    '小节标题不得用 .snapshotRowMain（flex:1 + nowrap ⇒ 标题被拉成一行、文字竖排）',
  );
  assert.ok(
    (body.match(/css\.groupLabel/g) ?? []).length >= 4,
    '小节标题必须走 .groupLabel（至少 4 处：入口标题 / 计划 / keep / 结果）',
  );
  assert.ok(
    (body.match(/css\.snapshotList/g) ?? []).length >= 3,
    '行列表必须包在 .snapshotList 里（纵向 flex + 行间呼吸感）',
  );
  assert.ok(
    (body.match(/css\.reportScroll/g) ?? []).length >= 3,
    '长列表必须限高内滚（.snapshotList + .reportScroll）',
  );
});
