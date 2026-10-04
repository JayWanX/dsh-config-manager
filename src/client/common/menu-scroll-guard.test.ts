/**
 * 浮层菜单滚动守卫（Select / MoreMenu 共用一条教训，2026-10-03 真机 bug：同步页「选历史快照」时整页跳走）。
 *
 * 为什么必须钉住：菜单虽然 portal / 留在插件根容器（`.section`，position: relative），但该容器的
 * `overflow: hidden` **同样是一个可滚动盒**，它之上还有宿主的滚动容器与浏览器窗口。headless Chromium
 * 实测：对一个靠下的选项调用 `scrollIntoView({block:'nearest'})` 会同时把插件根容器（scrollTop 0 → 121）
 * 与窗口（scrollY 0 → 259）滚走 —— 用户看到的就是「页面跳了」。修法 = 只改菜单自己的 scrollTop。
 *
 * 两个组件的高亮滚动实现**逐字同源**（同一种自绘弹层不能有两套行为），所以本守卫对两者跑同一组断言。
 * 源码级（本仓库没有 React 组件测试框架），只锚真实代码结构：先剥注释再断言 ——
 * 注释里的 `scrollIntoView` 字样不得让守卫变红或假绿。复现：`node --test src/client/common/menu-scroll-guard.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stripJsComments } from '../../utils/bundle-scan.ts';

/** 会按高亮项滚动的浮层菜单（新增同类组件请加进来）。 */
const FLOATING_MENUS: readonly string[] = [
  'src/client/common/Select.tsx',
  'src/client/common/MoreMenu.tsx',
];

/** 剥注释后的源码（按 `\n` 归一，避免 CRLF 让跨行断言静默失真）。 */
function codeOf(rel: string): string {
  const file = fileURLToPath(new URL('./' + (rel.split('/').pop() ?? ''), import.meta.url));
  return stripJsComments(fs.readFileSync(file, 'utf8').split('\r\n').join('\n'), true, false);
}

/** 违规扫描（独立函数 = 可以被合成片段做负向自检，避免「扫不到即假绿」）。 */
function findScrollViolations(code: string): string[] {
  const out: string[] = [];
  if (/scrollIntoView/.test(code)) {
    out.push('不得使用 scrollIntoView：它会连带滚动所有可滚动祖先（插件根容器 / 窗口），真机表现就是「整页跳走」');
  }
  if (!/const list = listRef\.current/.test(code)) out.push('必须取到菜单自身（listRef）再滚动');
  if (!/list\.scrollTop = top/.test(code)) out.push('高亮项在可视区上方 → 把菜单滚到该项');
  if (!/list\.scrollTop = bottom - list\.clientHeight/.test(code)) {
    out.push('高亮项在可视区下方 → 只滚到刚好露出该项（不整页滚动）');
  }
  return out;
}

for (const rel of FLOATING_MENUS) {
  test(rel + '：高亮项滚动只动菜单自身，禁止 scrollIntoView（会连带滚动祖先与窗口）', () => {
    const violations = findScrollViolations(codeOf(rel));
    assert.deepEqual(violations, [], rel + ' 的高亮滚动实现不合规：\n' + violations.join('\n'));
  });
}

test('负向自检：合成片段用 scrollIntoView / 删掉本地滚动时必须变红', () => {
  const bad = findScrollViolations('const node = listRef.current; node.scrollIntoView({ block: "nearest" });');
  assert.ok(bad.length >= 3, '用 scrollIntoView 且没有本地滚动时必须至少命中 3 条（实际 ' + String(bad.length) + '：' + bad.join(' | ') + '）');
  assert.ok(bad.some((v) => v.includes('scrollIntoView')), '必须点名 scrollIntoView 这一条');
  const good = findScrollViolations(
    'const list = listRef.current; if (top < list.scrollTop) list.scrollTop = top; else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;',
  );
  assert.deepEqual(good, [], '合法形态（只改菜单 scrollTop）必须放行');
});
