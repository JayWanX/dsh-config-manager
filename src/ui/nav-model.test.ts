/**
 * nav-model 单测：自适应导航布局的判定（纯函数，node:test）。
 *
 * 重点在**兜底分支**：v2 的第一原则是「宁可溢出，不可藏页签」，
 * 所以任何度量不可信都必须退化为「全部可见」。这几条比正常路径更重要。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NAV_OVERFLOW_EPSILON, navLayout } from './nav-model.ts'

/** 四个页签的实测宽度（中文：首页 / 产物库 / 同步 / 环境）。 */
const ZH = [63, 75, 63, 63]
/** 英文四项（Home / Library / Sync / Environment）。 */
const EN = [65, 85, 65, 111]

test('空清单 → 两边都空（不渲染「更多」）', () => {
  assert.deepEqual(navLayout([], 400, 60, 2), { visible: [], overflow: [] })
})

test('全放得下 → 全部可见，且不占用「更多」的宽度', () => {
  const layout = navLayout(ZH, 450, 60, 2)
  assert.deepEqual(layout.visible, [0, 1, 2, 3])
  assert.deepEqual(layout.overflow, [])
})

test('恰好放得下（差 0px）→ 全部可见', () => {
  const need = ZH.reduce((a, b) => a + b, 0) + 2 * 3
  assert.deepEqual(navLayout(ZH, need, 60, 2).overflow, [])
})

test('容差内（差 0.5px）仍视为放得下', () => {
  const need = ZH.reduce((a, b) => a + b, 0) + 2 * 3
  assert.deepEqual(navLayout(ZH, need - 0.5, 60, 2).overflow, [])
})

test('英文四项在 450px 放得下（v2 的容量前提）', () => {
  const need = EN.reduce((a, b) => a + b, 0) + 2 * 3
  assert.ok(need < 450, '英文四项应远小于可用宽')
  assert.deepEqual(navLayout(EN, 450, 60, 2).overflow, [])
})

test('放不下 → 从末项开始移入「更多」，且为它留出宽度与一个间隔', () => {
  // 7 个 80px 项 + 6 个 2px 间隔 = 572；容器 400。
  const widths = [80, 80, 80, 80, 80, 80, 80]
  const layout = navLayout(widths, 400, 60, 2)
  assert.ok(layout.overflow.length >= 1, '至少移出一项')
  assert.deepEqual(layout.overflow, layout.overflow.slice().sort((a, b) => a - b), 'overflow 按原顺序')
  assert.equal(layout.visible.length + layout.overflow.length, 7, '不丢项')
  // 可见部分 + 间隔 + 更多 必须真的放得下
  const visibleWidth = layout.visible.reduce((sum, i) => sum + (widths[i] ?? 0), 0)
  const gaps = (layout.visible.length - 1) + 1
  assert.ok(visibleWidth + gaps * 2 + 60 <= 400 + NAV_OVERFLOW_EPSILON, '算出来的布局必须自洽')
})

test('可见项越多越好：能放 5 项就不该只放 4 项', () => {
  const widths = [60, 60, 60, 60, 60, 60, 60]
  const layout = navLayout(widths, 400, 60, 2)
  assert.equal(layout.visible.length, 5, '5×60 + 4×2 = 308；加「更多」= 308+2+60 = 370 ≤ 400；6 项则 428 > 400')
})

test('连「一个页签 + 更多」都放不下 → 全部可见（隐藏没有收益）', () => {
  const layout = navLayout([120, 120, 120], 100, 60, 2)
  assert.deepEqual(layout.visible, [0, 1, 2])
  assert.deepEqual(layout.overflow, [])
})

test('容器宽不可信（0 / 负数 / NaN / Infinity）→ 全部可见', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(navLayout(ZH, bad, 60, 2), { visible: [0, 1, 2, 3], overflow: [] }, `availWidth=${bad}`)
  }
})

test('任一项宽度不可信（NaN / 负数）→ 全部可见', () => {
  assert.deepEqual(navLayout([60, Number.NaN, 60], 100, 60, 2).overflow, [])
  assert.deepEqual(navLayout([60, -1, 60], 100, 60, 2).overflow, [])
})

test('gap 不可信按 0 处理，不影响「全放得下」判定', () => {
  assert.deepEqual(navLayout(ZH, 450, 60, Number.NaN).overflow, [])
})

test('每项都超宽时不会把清单清空', () => {
  const layout = navLayout([500, 500], 300, 60, 2)
  assert.equal(layout.visible.length, 2)
  assert.deepEqual(layout.overflow, [])
})
