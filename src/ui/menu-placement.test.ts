/**
 * 浮层放置模型单测（src/ui/menu-placement.ts）。
 *
 * 为什么必须钉住：2026-10-04 用户反馈「所有弹窗里的下拉都被裁掉一截」——
 * 翻转 / 夹紧 / 限高这三条判据一旦回归，界面上的表现就是「被裁」，而单元测试是
 * 唯一能在没有组件测试框架的前提下把几何口径固定下来的地方。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MENU_EDGE, MENU_GAP, MENU_MAX_HEIGHT, MENU_MIN_HEIGHT, placeMenu,
} from './menu-placement.ts'

/** 夹紧矩形（视口坐标）：一屏 700×750 里的插件画布。 */
const BOUNDS = { left: 100, top: 50, right: 700, bottom: 750 }
/** 菜单量测后的尺寸（不超过 CSS 的 max-height 220）。 */
const SIZE = { width: 200, height: 220 }

test('下方空间充足：贴触发器左下，限高取 CSS 上限', () => {
  const anchor = { left: 150, top: 170, right: 350, bottom: 200 }
  const got = placeMenu(anchor, BOUNDS, SIZE)
  assert.equal(got.side, 'bottom')
  assert.equal(got.top, anchor.bottom + MENU_GAP)
  assert.equal(got.left, anchor.left)
  assert.equal(got.maxHeight, MENU_MAX_HEIGHT)
})

test('下方放不下且上方更宽裕：向上翻转（菜单底边贴触发器上缘）', () => {
  const anchor = { left: 150, top: 600, right: 350, bottom: 630 }
  const got = placeMenu(anchor, BOUNDS, SIZE)
  assert.equal(got.side, 'top')
  assert.equal(got.top, anchor.top - MENU_GAP - SIZE.height)
  assert.equal(got.maxHeight, MENU_MAX_HEIGHT)
})

test('上下都放不下：取可用空间较大的一侧，并按该侧限高内滚', () => {
  // 上方只剩 8px、下方剩 148px → 仍放下方，且限高 = 148（绝不溢出被裁）
  const anchor = { left: 50, top: 20, right: 250, bottom: 40 }
  const bounds = { left: 0, top: 0, right: 400, bottom: 200 }
  const got = placeMenu(anchor, bounds, SIZE)
  assert.equal(got.side, 'bottom')
  assert.equal(got.maxHeight, 200 - anchor.bottom - MENU_GAP - MENU_EDGE)
})

test('右侧越界：改为右对齐（不再是「一律贴左缘」）', () => {
  const anchor = { left: 600, top: 100, right: 640, bottom: 130 }
  const got = placeMenu(anchor, BOUNDS, SIZE)
  assert.equal(got.left, anchor.right - SIZE.width)
})

test('左缘越界：夹进夹紧矩形（留出 MENU_EDGE 气口）', () => {
  const bounds = { left: 0, top: 0, right: 300, bottom: 400 }
  const got = placeMenu({ left: -50, top: 100, right: 50, bottom: 130 }, bounds, SIZE)
  assert.equal(got.left, MENU_EDGE)
})

test('右对齐后仍越界：夹到右边界内侧', () => {
  // 触发器比夹紧矩形还宽（窄画布 + 长标签）：右对齐（360-200=160）后仍越界 → 夹到右边界内侧
  const bounds = { left: 0, top: 0, right: 220, bottom: 400 }
  const got = placeMenu({ left: 150, top: 100, right: 360, bottom: 130 }, bounds, SIZE)
  assert.equal(got.left, bounds.right - MENU_EDGE - SIZE.width)
})

test('右对齐即可放下：落在边界内侧、不被无谓推动', () => {
  const bounds = { left: 0, top: 0, right: 220, bottom: 400 }
  const got = placeMenu({ left: 150, top: 100, right: 210, bottom: 130 }, bounds, SIZE)
  assert.equal(got.left, 10)
})

test('上下空间都极小：限高不压成一条缝（保底 MENU_MIN_HEIGHT）', () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 60 }
  const got = placeMenu({ left: 50, top: 40, right: 250, bottom: 50 }, bounds, SIZE)
  assert.equal(got.maxHeight, MENU_MIN_HEIGHT)
  assert.ok(MENU_MIN_HEIGHT < MENU_MAX_HEIGHT)
})

test('夹紧矩形退化（right < left / bottom < top）：仍返回有限数值，不抛错', () => {
  const got = placeMenu(
    { left: 200, top: 300, right: 260, bottom: 330 },
    { left: 100, top: 100, right: 40, bottom: 40 },
    SIZE,
  )
  assert.ok(Number.isFinite(got.top) && Number.isFinite(got.left) && Number.isFinite(got.maxHeight))
})
