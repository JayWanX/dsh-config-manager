/**
 * 结构守卫：客户端源码里不得再出现「手写文本符号当图标」。
 *
 * 为什么需要它
 * ------------
 * DESIGN.md §9 反模式 #9 一直写着「手写文本符号图标（▣⇥⇤⟳◷⭳⌕✕⧉→ 等）——统一用 `common/Icon.tsx`」，
 * 但那条规则**没有任何防线**：2026-09 排查形变落点时发现 `snapshots/RestorePlanView.tsx` 里还留着两处
 * `▸/▾` 折叠符号（规则写了很久，却一直没被发现）。本测试把这条规则钉成可执行断言。
 *
 * 判定口径（刻意保守，避免假阳性）
 * ------------------------------
 * - 只扫 `src/client` 下全部 `.ts` / `.tsx` 的**字符串字面量内容**：注释里的符号是文档（本仓库大量注释在讲这条
 *   规则本身），不是图标。为此先做一遍「去注释、保留字符串」的状态扫描。
 * - 符号集**不含** `→` / `↓` / `↑` / `■□`：它们在正文文案与图标旁的文字说明里有合法用法
 *   （如「↓ 新输出」是按业务流程命名的按钮文案），收进来会产出假阳性。只收**只可能当图标用**的形状符号。
 * - **排除 `*.test.ts(x)`**：测试文件里合法地携带**宿主日志夹具**（如 `'▶ settings:general'` —— 那是宿主
 *   CLI 输出的原文，客户端只是原样显示，不是在用符号当图标）。守卫管的是 UI 源码。
 * - 本文件自己的符号表用**码点**写，所以不会扫到自己。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CLIENT_DIR = resolve(import.meta.dirname)

/** 反斜杠 / 换行 / 反引号的码点（用码点写，避免本文件出现需要转义的字符）。 */
const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
const BT = String.fromCharCode(96)

/** 反模式 #9 的形状符号（名称 → 码点）。码点写法让本文件自身不含这些字符。 */
const BANNED_SYMBOLS: ReadonlyArray<readonly [string, number]> = [
  ['右向小三角 (U+25B8)', 0x25b8],
  ['下向小三角 (U+25BE)', 0x25be],
  ['上向小三角 (U+25B4)', 0x25b4],
  ['左向小三角 (U+25C2)', 0x25c2],
  ['右向三角 (U+25B7)', 0x25b7],
  ['左向实心三角 (U+25C0)', 0x25c0],
  ['右向实心三角 (U+25B6)', 0x25b6],
  ['方框 (U+25A3)', 0x25a3],
  ['右制表符 (U+21E5)', 0x21e5],
  ['左制表符 (U+21E4)', 0x21e4],
  ['上下箭头 (U+21C5)', 0x21c5],
  ['顺时针箭头 (U+27F3)', 0x27f3],
  ['半圆钟 (U+25F7)', 0x25f7],
  ['下载箭头 (U+2B73)', 0x2b73],
  ['放大镜 (U+2315)', 0x2315],
  ['乘号 (U+2715)', 0x2715],
  ['复制双框 (U+29C9)', 0x29c9],
]

/**
 * 去掉注释、保留字符串字面量内容。
 *
 * 状态机显式处理单/双引号、模板串与转义 —— 本仓库有过「注释里的反引号让状态失衡、产生假阴性」的
 * 实测教训（见 `src/utils/bundle-scan.ts` 的多趟并集），所以不做正则剥离。
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < src.length) {
    const c = src[i] ?? ''
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === BT) state = 'tpl'
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === NL) { state = 'code'; out += c }
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue }
      i++
      continue
    }
    // 字符串状态：内容保留；转义成对跳过，避免 \\' 提前结束字符串
    if (c === BS && n !== undefined) { out += c + n; i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === BT)) state = 'code'
    out += c
    i++
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

test('客户端源码不得用手写文本符号当图标（注释除外）', () => {
  const hits: string[] = []
  for (const file of walk(CLIENT_DIR)) {
    // 测试文件携带宿主日志夹具（▶/✓ 是宿主 CLI 输出原文，不是图标）—— 见文件头注释
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const [name, point] of BANNED_SYMBOLS) {
      if (code.includes(String.fromCodePoint(point))) hits.push(file.slice(CLIENT_DIR.length + 1) + ' → ' + name)
    }
  }
  assert.deepEqual(
    hits,
    [],
    '发现手写文本符号图标（DESIGN.md §9 反模式 #9）：改用 common/Icon.tsx 的 Icon / ExpandChevron 出口' + NL + hits.join(NL),
  )
})

test('扫描器自检：注释要丢、字符串要留、注释里的反引号不能让状态失衡', () => {
  const TRI = String.fromCodePoint(0x25b8)
  const TRI2 = String.fromCodePoint(0x25be)
  // 行注释里的符号丢弃
  assert.equal(stripComments('const a = 1 // ' + TRI), 'const a = 1 ')
  // 块注释（含 JSX 注释形态）里的符号丢弃
  assert.equal(stripComments('{' + '/* ' + TRI2 + ' */' + '}'), '{}')
  // 字符串里的符号必须保留 —— 否则守卫永远绿（假阴性）
  assert.ok(stripComments("const a = '" + TRI + "'").includes(TRI))
  assert.ok(stripComments('const a = "' + TRI + '"').includes(TRI))
  // 模板串里的符号必须保留
  assert.ok(stripComments('const a = ' + BT + TRI2 + BT).includes(TRI2))
  // 字符串里的 // 不得被当成注释起点
  assert.ok(stripComments("const u = 'http://x'").includes('//'))
  // 注释里的反引号不得让状态失衡（本仓库实测过的假阴性来源）
  assert.equal(stripComments('// ' + BT + BT + BT + NL + 'const a = ' + TRI), NL + 'const a = ' + TRI)
})
