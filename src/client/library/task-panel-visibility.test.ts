/**
 * 流程面板可见性守卫（UI v3 §3.3）。
 *
 * 为什么需要它：真机出现过「点导入闪一下但不出面板，第二次点击才进去」。
 * 根因是 `activeTask = task.origin === panel` 这个等式被两侧分别破坏：
 *   - 调用方把 `panel` 改成一个**已不存在的页**（v1 的 'import'，导航里没有它）；
 *   - 于是随后 `origin` 也记成了 'import'，等式凑巧成立但页面区是空的。
 * v3 把这类中间态**从类型里删掉**（PanelId 只剩四个真实页面），守卫随之改为钉住
 * 「页面枚举 = 导航项枚举」与「origin 直接取当前页」这两件事 —— 意图不变（origin 必须是真实页），
 * 判据换成不会再被合理重构误伤的形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SECTION = fs.readFileSync(path.join(ROOT, 'src', 'client', 'ConfigManagerSection.tsx'), 'utf8')
const ACTIONS = fs.readFileSync(path.join(ROOT, 'src', 'client', 'library', 'LibraryActions.tsx'), 'utf8')
const RUN_STORE = fs.readFileSync(path.join(ROOT, 'src', 'client', 'run-store.ts'), 'utf8')

test('流程面板：PanelId 与导航项集合一致（页面枚举里不得有「导航进不去」的中间态）', () => {
  const panelUnion = /export type PanelId = ([^\n]+)/.exec(RUN_STORE)?.[1] ?? ''
  assert.ok(panelUnion !== '', '找不到 PanelId 定义')
  const navIds = [...SECTION.matchAll(/\{ id: '([a-z-]+)', label: '/g)].map((m) => m[1])
  assert.equal(navIds.length, 4, 'v3 一级页面恒为 4 个（首页 / 产物库 / 同步 / 环境）')
  for (const id of navIds) {
    assert.ok(panelUnion.includes("'" + id + "'"), '导航项 ' + String(id) + ' 必须在 PanelId 里')
  }
  for (const stale of ["'import'", "'market'", "'overview'", "'profiles'"]) {
    assert.ok(!panelUnion.includes(stale), 'PanelId 不得再含已删值 ' + stale)
  }
})

test('流程面板：origin 直接取当前页（PanelId 已是真实页，不再需要归一特判）', () => {
  assert.match(SECTION, /const origin: PanelId = panel/, 'openTask 的 origin 必须来自当前 panel')
  assert.doesNotMatch(SECTION, /origin: PanelId = panel === 'import'/, 'v3 不应再保留 import 归一特判')
})

test('流程面板：写入备份载荷的一方不得把 panel 改成非页值', () => {
  const importPatch = ACTIONS.slice(ACTIONS.indexOf('function runStorePatchImport'), ACTIONS.indexOf('function runStorePatchImport') + 900)
  assert.ok(importPatch.includes('runStore.patch'), '找不到 runStorePatchImport 的 patch 调用')
  assert.doesNotMatch(
    importPatch,
    /panel: '/,
    '导入载荷不得写 panel —— 导入不是页面，写它会切页（闪一下 + tab 高亮全灭）',
  )
  assert.match(importPatch, /library: \{/, 'v3 起一键导入请求落在产物库切片（library.pendingZip）')
})
