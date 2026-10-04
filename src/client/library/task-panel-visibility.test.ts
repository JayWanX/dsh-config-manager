/**
 * 流程面板可见性守卫（UI v2 §5.8）。
 *
 * 为什么需要它：真机出现过「点导入闪一下但不出面板，第二次点击才进去」。
 * 根因是 `activeTask = task.origin === panel` 这个等式被两侧分别破坏：
 *   - 调用方把 `panel` 改成一个**已不存在的页**（'import'，导航里没有它）；
 *   - 于是随后 `origin` 也记成了 'import'，等式凑巧成立但页面区是空的。
 * 这条守卫把等式两侧的**约束**钉死：origin 必须是真实页；写入方不得把 panel 改成非页值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SECTION = fs.readFileSync(path.join(ROOT, 'src', 'client', 'ConfigManagerSection.tsx'), 'utf8')
const ACTIONS = fs.readFileSync(path.join(ROOT, 'src', 'client', 'library', 'LibraryActions.tsx'), 'utf8')

/** PanelId 的取值必须与导航项一致（'import' 已随导入并入侧拉面板而移除）。 */
test('流程面板：origin 必须是真实存在的页面（不得记到已移除的 import）', () => {
  assert.doesNotMatch(
    SECTION,
    /task: \{ kind, origin: panel, /,
    'openTask 不得直接采用 panel 作为 origin —— 必须先归一到真实页（否则 origin 可能是已不存在的 import）',
  )
  assert.match(
    SECTION,
    /const origin: PanelId = panel === 'import' \? 'library' : panel/,
    'openTask 必须把已移除的 import 归一到 library',
  )
})

test('流程面板：写入备份载荷的一方不得把 panel 改成非页值', () => {
  const importPatch = ACTIONS.slice(ACTIONS.indexOf('function runStorePatchImport'), ACTIONS.indexOf('function runStorePatchImport') + 900)
  assert.ok(importPatch.includes('runStore.patch'), '找不到 runStorePatchImport 的 patch 调用')
  assert.doesNotMatch(
    importPatch,
    /panel: 'import'/,
    '导入载荷不得写 panel: import —— 导入不是页面，写它会切到空页（闪一下 + tab 高亮全灭）',
  )
})
