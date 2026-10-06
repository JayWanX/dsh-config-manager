/**
 * css-scale-guard — 视觉 scale 的**源级执行者**（UI v3 §4.2/§4.3、§12）。
 *
 * 为什么需要它：`DESIGN.md` 从 v1 起就写着「唯一允许的 scale」，但实测文件里同时存在
 * 10 档字号 / 11 档圆角 / 5 档行高 / 10 档 gap（见 docs/design/2026-10-05-ui-redesign-v3.md §0）——
 * 散文规范拦不住新增值。本守卫把 scale 变成红灯：越界值直接失败。
 *
 * 覆盖：font-size / border-radius / line-height / z-index / padding / margin / gap。
 * 不覆盖：宽高、定位、媒体查询断点（布局尺寸，不属节奏 scale）。
 * 豁免：见 SPACING_EXEMPT —— 每条例外都带「为什么」与「最多几处」，防止例外无声增长。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8')

/** 去注释但保留行结构（`/* *\/` 内的非换行字符替换为空格）。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

const ALLOWED_FONT_SIZE = new Set(['11px', '12px', '12.5px', '13px'])
const ALLOWED_RADIUS = new Set(['0', '4px', '6px', '8px', '999px', '50%'])
const ALLOWED_LINE_HEIGHT = new Set(['1.25', '1.5'])
/** 间距节奏档（--cm-sp-1..9）；1px 是发丝线/描边，单列。 */
const ALLOWED_SPACING = new Set(['0', '1', '2', '4', '6', '8', '10', '12', '14', '16', '24'])
const SPACING_EXEMPT: { value: string; max: number; why: string }[] = [
  { value: '38px', max: 2, why: '恢复计划/差异行的深层缩进（布局偏移，非节奏间距）' },
  { value: '22px', max: 1, why: '同类深层缩进（布局偏移）' },
  { value: '-4px', max: 1, why: '图标与文字的负外边距对齐（布局偏移）' },
]
const SPACING_PROPS = /^(padding|margin(-top|-bottom|-left|-right)?|gap|row-gap|column-gap)$/

/** 收集全部声明：同一行可含多条（单行规则 `.x { a: 1; b: 2; }`）。 */
function declarations(css: string): { prop: string; value: string; line: number }[] {
  const out: { prop: string; value: string; line: number }[] = []
  css.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      const prop = m[1]
      const value = m[2]
      if (prop !== undefined && value !== undefined) out.push({ prop, value: value.trim(), line: i + 1 })
    }
  })
  return out
}

const STRIPPED = stripComments(CSS)
const DECLS = declarations(STRIPPED)

function collect(prop: string, pick: (value: string) => string[]): Map<string, number[]> {
  const seen = new Map<string, number[]>()
  for (const d of DECLS) {
    if (d.prop !== prop) continue
    for (const v of pick(d.value)) {
      const arr = seen.get(v) ?? []
      arr.push(d.line)
      seen.set(v, arr)
    }
  }
  return seen
}

test('scale-01 字号只有 4 档（11 / 12 / 12.5 / 13px），且不得出现 var(--cm-fs-*) 之外的写法', () => {
  const seen = collect('font-size', (v) => (/^[\d.]+px$/.test(v) ? [v] : v.startsWith('var(--cm-fs-') ? [] : [v]))
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_FONT_SIZE.has(v))
  assert.deepEqual(bad, [], 'font-size 越界值（新档位必须先改本文档与 DESIGN.md §4）：' + JSON.stringify(bad))
  assert.ok(seen.size >= 3, '字号档位数量异常，疑似扫描失效')
})

test('scale-02 圆角只有 4 档（4 / 6 / 8px + 药丸 999），另有 0 与 50% 两个结构性豁免', () => {
  const seen = collect('border-radius', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_RADIUS.has(v) && !v.startsWith('var(--cm-r-'))
  assert.deepEqual(bad, [], 'border-radius 越界值：' + JSON.stringify(bad))
})

test('scale-03 行高只有 2 档（1.25 标题 / 1.5 正文）', () => {
  const seen = collect('line-height', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !ALLOWED_LINE_HEIGHT.has(v) && !v.startsWith('var('))
  assert.deepEqual(bad, [], 'line-height 越界值：' + JSON.stringify(bad))
})

test('scale-04 z-index 一律走 --cm-z-* 语义 token（不得写字面量）', () => {
  const seen = collect('z-index', (v) => [v])
  const bad = [...seen.entries()].filter(([v]) => !/^var\(--cm-z-(raise|sticky|task|mask|modal|pop|toast)\)$/.test(v))
  assert.deepEqual(bad, [], 'z-index 必须用 --cm-z-* token：' + JSON.stringify(bad))
  assert.ok(seen.size >= 6, 'z-index 层级数量异常（应 ≥6 档）')
})

test('scale-05 间距（padding/margin/gap）只用 9 档 + 显式豁免，且豁免数量不得增长', () => {
  const exemptCount = new Map<string, number>()
  const bad: string[] = []
  for (const d of DECLS) {
    if (!SPACING_PROPS.test(d.prop)) continue
    for (const m of d.value.matchAll(/(-?[\d.]+)px/g)) {
      const v = m[1] + 'px'
      if (ALLOWED_SPACING.has(m[1]!)) continue
      const ex = SPACING_EXEMPT.find((e) => e.value === v)
      if (ex !== undefined) {
        exemptCount.set(v, (exemptCount.get(v) ?? 0) + 1)
        continue
      }
      bad.push('L' + String(d.line) + ' ' + d.prop + ': ' + d.value)
    }
  }
  assert.deepEqual(bad, [], '间距越界值（改到 9 档，或把例外登记进 SPACING_EXEMPT 并说明理由）：' + JSON.stringify(bad))
  for (const ex of SPACING_EXEMPT) {
    const n = exemptCount.get(ex.value) ?? 0
    assert.ok(n <= ex.max, '豁免 ' + ex.value + ' 出现 ' + String(n) + ' 次，超过登记上限 ' + String(ex.max) + '（' + ex.why + '）')
  }
})

test('scale-06 反自检：注入越界值必须被抓到（防止守卫因解析失效而永远绿灯）', () => {
  const mutated = STRIPPED.replace('.section {', '.section {\n  font-size: 10.5px;\n  gap: 5px;\n  z-index: 9000;')
  const decls = declarations(mutated)
  const fs10 = decls.filter((d) => d.prop === 'font-size' && !ALLOWED_FONT_SIZE.has(d.value))
  const gap5 = decls.filter((d) => d.prop === 'gap' && !ALLOWED_SPACING.has(d.value.replace('px', '')))
  const zLit = decls.filter((d) => d.prop === 'z-index' && !d.value.startsWith('var(--cm-z-'))
  assert.ok(fs10.length > 0 && gap5.length > 0 && zLit.length > 0, '注入的越界值必须被三个检查分别命中')
})
