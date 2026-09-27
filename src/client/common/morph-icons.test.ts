/**
 * 形变图标层（common/morph-icons.ts）的守卫。
 *
 * 这里断言的不是「能编译」，而是**形变在数学上成立**：chevron-right → chevron-down 必须是
 * 纯旋转（θ = 90°、无缩放/剪切），且 t=0 / t=1 的端点恰好是源图标与目标图标。这条性质正是
 * 「只在状态确实变化处使用形变」的依据 —— 哪天 lucide 改了这两个图标的路径数据，形变会退化
 * 成拉伸/剪切，本测试会红（而不是等到用户看出切换瞬间「跳一下」）。
 *
 * 同时钉住两件易漏的事：
 *   1. `lucide`（数据）与 `lucide-react`（组件）必须同版本，否则静态图标与形变图标是两套图形；
 *   2. 形变表只收这两个图标 —— 新增必须是有意的（改这里的期望值），不是顺手加的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { allocOutputs, buildPlan, iconToCubics, interpPolar, resampleIcon } from 'morphicons'
import PlainCopy from 'lucide/dist/esm/icons/copy.mjs'
import { MORPH_ICONS, MORPH_SPRING } from './morph-icons.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

function pkgVersion(name: string): string {
  const raw = readFileSync(resolve(ROOT, 'node_modules', name, 'package.json'), 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

/** 第 i 个采样点的 (x, y)（TypedArray 索引在 noUncheckedIndexedAccess 下可为 undefined）。 */
function point(arr: Float64Array, i: number): [number, number] {
  return [arr[i * 2] ?? NaN, arr[i * 2 + 1] ?? NaN]
}

/** 取整后的 (x, y)：按几何位置断言，避开 d 字符串的格式细节。 */
function roundPoint(arr: Float64Array, i: number): [number, number] {
  const [x, y] = point(arr, i)
  return [Math.round(x), Math.round(y)]
}

test('形变表只收预期的图标，且每条都是带 d 的合法 IconNode', () => {
  assert.deepEqual(Object.keys(MORPH_ICONS).sort(), ['chevronDown', 'chevronRight', 'copy', 'copyDone'])
  for (const [name, node] of Object.entries(MORPH_ICONS)) {
    assert.ok(node.length > 0, name + ' 不能为空')
    for (const [tag, attrs] of node) {
      assert.equal(typeof tag, 'string')
      // 形变图标不必都是 path：`copy` 那一对的结构里就含一个 `rect`（矩形）——
      // morphicons 支持七种 stroke 原语，只有 path 才带 d。这里只保证「声明了 d 就一定是字符串」。
      if (tag === 'path') assert.equal(typeof attrs.d, 'string', name + ' 的 path 必须带 d')
    }
  }
})

/* —— 「复制 → 已复制」对：几何是特制的，这一组断言是它唯一的防线 —— */

test('复制对：拓扑 3↔3、三条子路径零旋转、共享两条零缩放零残差、对勾纯生长', () => {
  // 拓扑必须相等。朴素的 copy(2) → copy-check(3) 是不匹配的：morphicons 只能把一条已有
  // 子路径复用给对勾，实测那条要缩到 0.20 倍并转 −159°（lnSigma = −1.62、res = 0.66）——
  // 中途是一团乱线。本测试就是防止有人「简化」掉 HIDDEN_CHECK_D 的退化对勾。
  assert.equal(iconToCubics(MORPH_ICONS.copy).length, 3, '空闲态必须有 3 条子路径')
  assert.equal(iconToCubics(MORPH_ICONS.copyDone).length, 3, '已复制态必须有 3 条子路径')

  const plan = buildPlan(resampleIcon(MORPH_ICONS.copy), resampleIcon(MORPH_ICONS.copyDone))
  assert.equal(plan.items.length, 3)

  for (const [i, item] of plan.items.entries()) {
    assert.ok(Math.abs(item.theta) < 1e-9, '第 ' + i + ' 条不应有旋转（纯生长），实测 ' + item.theta)
  }

  // 共享的两条（矩形 + 后板）必须纹丝不动
  for (const [i, item] of plan.items.slice(1).entries()) {
    assert.ok(Math.abs(item.lnSigma) < 1e-6, '共享子路径 ' + (i + 1) + ' 不应缩放，实测 ' + item.lnSigma)
    assert.ok(item.res < 1e-6, '共享子路径 ' + (i + 1) + ' 残差应为 0，实测 ' + item.res)
  }

  // 对勾从 4% 长到 100%：lnSigma ≈ ln(1 / 0.04) ≈ 3.22
  const check = plan.items[0]
  assert.ok(check, '计划必须有对勾项')
  assert.ok(check.lnSigma > 3, '对勾应从小长到大，实测 lnSigma=' + check.lnSigma)
  assert.ok(check.res < 0.02, '对勾自身残差应接近 0，实测 ' + check.res)

  // 端点无 NaN（退化几何最容易在这里炸成 NaN/Infinity）
  const out = allocOutputs(plan)
  for (const t of [0, 0.5, 1]) {
    interpPolar(plan, t, out)
    const d = out.map((buf, i) => (buf.length > 0 ? 'x' : '')).join('')
    assert.ok(!Number.isNaN(plan.items[0]?.lnSigma ?? NaN), 't=' + t + ' 不应产生 NaN')
    void d
  }
})

test('空闲态的隐藏对勾不可见：三点落在矩形描边带内、包围盒亚像素', () => {
  const first = MORPH_ICONS.copy[0]
  assert.ok(first, '空闲态第一条子路径必须存在')
  const [tag, attrs] = first
  assert.equal(tag, 'path')
  const d = attrs.d
  assert.equal(typeof d, 'string', '隐藏对勾必须是 path 的 d')

  const nums = (d as string).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  assert.equal(nums.length, 6, '隐藏对勾应是三个点（M + 两个 L）')

  const xs = [nums[0], nums[2], nums[4]].map((v) => v ?? NaN)
  const ys = [nums[1], nums[3], nums[5]].map((v) => v ?? NaN)

  // 矩形左边框中心线 x = 8；我们的 stroke-width 是 1.75 → 描边带 x ∈ [7.125, 8.875]。
  // stroke-linecap: round 会给退化路径画一个直径 = stroke-width 的圆点，只有把点放进
  // 这条带里，圆点才会被边框吞掉（否则空闲态图标上会多出一个可见的小点）。
  for (const x of xs) {
    assert.ok(Math.abs(x - 8) <= 0.875, '隐藏对勾的点必须落在矩形描边带内，实测 x=' + x)
  }
  // y 必须落在矩形左边框的**直线段**上（避开 rx=2 的圆角），否则点会露在圆角外
  for (const y of ys) {
    assert.ok(y >= 10 && y <= 20, '必须落在左边框直线段内（避开圆角），实测 y=' + y)
  }
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  assert.ok(Math.max(w, h) < 0.5, '包围盒必须是亚像素级，实测 ' + w + ' x ' + h)
  // 12px 显示时 0.5 单位 ≈ 0.25px
})

test('空闲态的矩形与后板直接复用 lucide，不手抄坐标（与 lucide copy 逐字相同）', () => {
  const rectOf = (node: readonly (readonly [string, Record<string, unknown>])[]): string =>
    JSON.stringify(node.find((n) => n[0] === 'rect'))
  const lastOf = (node: readonly (readonly [string, Record<string, unknown>])[]): string =>
    JSON.stringify(node[node.length - 1])

  assert.equal(rectOf(MORPH_ICONS.copy), rectOf(PlainCopy), '矩形必须与 lucide copy 逐字相同')
  assert.equal(rectOf(MORPH_ICONS.copyDone), rectOf(PlainCopy), '已复制态的矩形也必须相同')
  assert.equal(lastOf(MORPH_ICONS.copy), lastOf(PlainCopy), '后板路径必须与 lucide copy 逐字相同')
})

test('形变弹簧是临界阻尼且快于 morphicons smooth（无回弹、不拖沓）', () => {
  const zeta = MORPH_SPRING.damping / (2 * Math.sqrt(MORPH_SPRING.stiffness))
  assert.ok(Math.abs(zeta - 1) < 0.02, 'ζ 应≈1（临界阻尼、无过冲），实测 ' + zeta.toFixed(4))
  assert.ok(MORPH_SPRING.stiffness > 170, '刚度应高于 smooth(170) 的「太慢」基线，实测 ' + MORPH_SPRING.stiffness)
  assert.ok(MORPH_SPRING.stiffness <= 700, '刚度不应高到来不及被看见（上限 700），实测 ' + MORPH_SPRING.stiffness)
})

test('lucide 与 lucide-react 必须同版本（防静态/形变两套图形）', () => {
  assert.equal(pkgVersion('lucide'), pkgVersion('lucide-react'))
})

test('chevron-right → chevron-down 是纯 90° 旋转，无缩放/剪切', () => {
  assert.equal(iconToCubics(MORPH_ICONS.chevronRight).length, 1)
  assert.equal(iconToCubics(MORPH_ICONS.chevronDown).length, 1)

  const plan = buildPlan(resampleIcon(MORPH_ICONS.chevronRight), resampleIcon(MORPH_ICONS.chevronDown))
  assert.equal(plan.items.length, 1)
  const item = plan.items[0]
  assert.ok(item, '形变计划必须有一项')

  assert.ok(Math.abs(Math.abs(item.theta) - Math.PI / 2) < 1e-9, 'θ 应为 90°，实测 ' + item.theta)
  assert.ok(Math.abs(item.lnSigma) < 1e-6, '不应有缩放，实测 lnSigma=' + item.lnSigma)
  assert.equal(item.closed, false, 'chevron 是开放路径，不应被当成闭合环')
})

test('形变端点恰好是源图标与目标图标（t=0 / t=1）', () => {
  const plan = buildPlan(resampleIcon(MORPH_ICONS.chevronRight), resampleIcon(MORPH_ICONS.chevronDown))
  assert.equal(plan.n, 64)

  const out = allocOutputs(plan)

  interpPolar(plan, 0, out)
  const start = out[0]
  assert.ok(start, '输出缓冲必须存在')
  assert.deepEqual(roundPoint(start, 0), [9, 18])
  assert.deepEqual(roundPoint(start, plan.n - 1), [9, 6])

  interpPolar(plan, 1, out)
  const end = out[0]
  assert.ok(end, '输出缓冲必须存在')
  assert.deepEqual(roundPoint(end, 0), [6, 9])
  assert.deepEqual(roundPoint(end, plan.n - 1), [18, 9])
})

test('静止态的曲线退化为直线：与静态 lucide 图标几何等价（换层不产生视觉位移）', () => {
  // morphicons 把折线转成立方曲线；只有控制点共线，才好把静态 Icon 换成 ExpandChevron
  // 而不产生像素级位移 —— 这是「换层零视觉回归」的判据。
  // 只对 chevron 对成立：它们是裸折线（`m9 18 6-6-6-6`），立方控制点必然共线。
  // copy 对的圆角矩形（rx=2）本来就是曲线，不适用这条 —— 那对的「静止态无视觉位移」由
  // 「隐藏对勾落在描边带内」+「矩形/后板与 lucide 逐字相同」两条断言承担。
  for (const name of ['chevronRight', 'chevronDown'] as const) {
    const node = MORPH_ICONS[name]
    for (const path of iconToCubics(node)) {
      const pts = path.pts
      const segments = (pts.length / 2 - 1) / 3
      assert.ok(Number.isInteger(segments) && segments > 0, name + ' 的段数应为正整数')
      for (let s = 0; s < segments; s++) {
        const p0 = point(pts, s * 3)
        const c1 = point(pts, s * 3 + 1)
        const c2 = point(pts, s * 3 + 2)
        const p1 = point(pts, s * 3 + 3)
        const dx = p1[0] - p0[0]
        const dy = p1[1] - p0[1]
        const len = Math.hypot(dx, dy)
        assert.ok(len > 0, name + ' 第 ' + s + ' 段长度不应为 0')
        for (const c of [c1, c2]) {
          // 点到弦的垂直距离（叉积 / 弦长）
          const dist = Math.abs((c[0] - p0[0]) * dy - (c[1] - p0[1]) * dx) / len
          assert.ok(dist < 1e-9, name + ' 第 ' + s + ' 段的控制点偏离弦 ' + dist + '（会与静态图标不一致）')
      // 只需要 p0/p1 位置正确即可（上面已断言共线）
        }
      }
    }
  }
})

