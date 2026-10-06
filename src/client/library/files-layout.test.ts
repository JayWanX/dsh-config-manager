/**
 * 备份页 files 子视图的**布局硬约束**（源码级守卫）—— 两条用户实测需求：
 *
 *  1. **磁盘占用卡与备份文件卡之间必须有间距**：两张卡是不同的组件、各自有自己的 `.viewBody`，
 *     所以它们是 **`.viewEnter` 包装层的兄弟**。间距只能由那一层提供 —— 组件内的 `.viewBody`
 *     够不到兄弟节点（用户实测：两卡紧贴）。
 *  2. **磁盘占用卡高度固定**：行数随分区数变化，自适应会让下方备份文件列表每次体检后上下跳动，
 *     内容一多还会把「清理与回收」按钮挤出卡片。
 *
 * 为什么用源码级守卫而不是渲染断言：本项目 React 层无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/），
 * 这两条是纯 CSS 布局契约，最贴近的自动化手段是钉住「规则存在且成对出现」——
 * 与既有的 route-fence / icon-layer-guard 同一类做法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 本文件位于 src/client/library/ → 仓库根是上三级（v3：随 DiskUsageCard 搬移一并从 snapshots/ 迁出）
const ROOT = path.resolve(import.meta.dirname, '../../..');
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8');
const DISK = fs.readFileSync(path.join(ROOT, 'src/client/environment/maintenance/DiskUsageCard.tsx'), 'utf8');
const LIBRARY = fs.readFileSync(path.join(ROOT, 'src/client/library/LibraryPanel.tsx'), 'utf8');

/** 取一条 CSS 规则的声明块（找不到 → null）。 */
function ruleBody(selector: string): string | null {
  const at = CSS.indexOf('\n' + selector + ' {');
  if (at < 0) return null;
  const end = CSS.indexOf('}', at);
  return end < 0 ? null : CSS.slice(at, end);
}

test('布局-01 磁盘占用卡固定高度：height / min-height / max-height 三者同值（缺一即被内容撑破）', () => {
  const body = ruleBody('.diskUsageCard');
  assert.ok(body !== null, '.diskUsageCard 规则必须存在');
  assert.match(body, /height:\s*var\(--cm-disk-card-h\)/, '必须有固定 height');
  assert.match(body, /min-height:\s*var\(--cm-disk-card-h\)/, 'flex 父容器的 min-height:auto 会让固定高度失效，必须锁住');
  assert.match(body, /max-height:\s*var\(--cm-disk-card-h\)/, '内容再多也不得撑破卡片');
  assert.match(CSS, /--cm-disk-card-h:\s*\d+px/, '高度令牌必须有具体值（本文件顶部的 :root 变量块）');
});

test('布局-02 固定高度卡内**只有明细表滚动**：操作区不被挤出视野', () => {
  const body = ruleBody('.diskUsageScroll');
  assert.ok(body !== null, '.diskUsageScroll 规则必须存在');
  assert.match(body, /flex:\s*1 1 auto/, '明细表占满卡片剩余高度');
  assert.match(body, /min-height:\s*0/, '可收缩（否则固定高度卡里它会溢出）');
  assert.match(body, /max-height:\s*none/, '覆写 .planScroll 的 380px 上限（否则固定高度形同虚设）');
  // 组件确实把两个类都用上了（规则存在但没接线 = 空守卫）
  assert.match(DISK, /css\.activityCard \+ ' ' \+ css\.diskUsageCard/, '卡片必须真的挂上 .diskUsageCard');
  assert.match(DISK, /css\.planScroll \+ ' ' \+ css\.diskUsageScroll/, '明细表必须真的挂上 .diskUsageScroll');
});

test('布局-03 产物库的纵向 flex 链：列表可伸展填充、工具栏与底栏固定', () => {
  // UI v2：原「files 子视图」两张卡已拆解（磁盘卡进维护页、备份文件进产物库），
  // 这条守卫改钉产物库自己的布局契约 —— 同样是最贴近的自动化手段（无组件测试框架）。
  const list = ruleBody('.artifactList');
  assert.ok(list !== null, '.artifactList 规则必须存在');
  // 2026-10-04 用户要求：列表高度**永远是最大状态**（哪怕只有一两行）+ 空态/加载态同契约
  assert.match(list, /flex:\s*1 1 auto/, '列表必须吃掉剩余高度（否则行数少时底栏吊在半空、下面一大片空洞）');
  assert.match(list, /overflow-y:\s*auto/, '列表自己滚动（页面不整页滚）');
  assert.match(list, /min-height:\s*0/, 'flex 子项必须可收缩，否则溢出而不是滚动');
  // 工具栏（筛选 + 搜索）与底栏是 flex:none，只有列表吃掉剩余高度
  for (const selector of ['.libraryFilters', '.librarySearch', '.libraryFooter']) {
    const body = ruleBody(selector);
    assert.ok(body !== null, `${selector} 规则必须存在`);
    assert.match(body, /flex:\s*none/, `${selector} 不得参与伸展（它们不该被列表挤扁）`);
  }
  // 组件确实把它们用上了（规则存在但没接线 = 空守卫）
  for (const cls of ['css.artifactList', 'css.libraryFilters', 'css.libraryFooter']) {
    assert.ok(LIBRARY.includes(cls), `LibraryPanel 必须真的挂上 ${cls}`);
  }
  // 空态 / 加载态与列表同一条高度契约（否则「没有数据」时页面塌成半截、底栏吊在半空）
  const state = ruleBody('.libraryListState');
  assert.ok(state !== null, '.libraryListState 规则必须存在');
  assert.match(state, /flex:\s*1 1 auto/, '空态 / 加载态同样吃掉剩余高度');
  assert.equal((LIBRARY.match(/css\.libraryListState/g) ?? []).length, 2, '加载态与空态各挂一次');
});

test('布局-04 市场导入审阅页不许被压扁：flex-shrink 恒为 0（否则末尾呼吸区被溢出内容盖住）', () => {
  // 用户实测：市场页「上一步 / 下一步」与底部状态栏零间距。
  // 根因 = shrink:1 把 .marketReviewPage 压得比内容矮，内容视觉溢出自己的盒子，
  // 最后一行按钮正好盖住 .viewBody 末尾那个 8px 呼吸区（与 ::after 同源的那块空白）。
  const page = ruleBody('.marketReviewPage');
  assert.ok(page !== null, '.marketReviewPage 规则必须存在');
  assert.match(page, /flex:\s*1 0 auto/, '只许长大、不许收缩（flex-shrink 必须为 0）');
  assert.doesNotMatch(page, /flex:\s*1 1 auto/, 'shrink:1 会把末尾呼吸区吃掉');
  const REVIEW = fs.readFileSync(path.join(ROOT, 'src/client/market/MarketImportReview.tsx'), 'utf8');
  assert.ok(REVIEW.includes('css.marketReviewPage'), 'MarketImportReview 必须真的挂上 .marketReviewPage');
  assert.ok(REVIEW.includes('css.actionRow'), '按钮行必须真的挂上 .actionRow（两处：上一步 / 下一步）');
});
