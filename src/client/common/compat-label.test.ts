/**
 * compat-label 护栏（2026-09）。
 *
 * 两类断言：
 *  ① 映射本身四档齐全（等级 → 客户端字典键）；
 *  ② **源码级**：评分标签映射只能有一份实现 —— 导入向导与同步确认页都必须走
 *     `common/compat-label.ts`（`compatibilityScoreKey` / `COMPATIBILITY_SCORE_KEYS`），
 *     不得再出现裸枚举渲染（`{compatibility}`）或重复的键字面量。
 *     这一条是修「同步确认页显示 partial 这种机器 token」时的防回归护栏：
 *     React 无组件测试框架，只能按源码结构钉住（同 import-wizard-split.test.ts 的做法）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { COMPATIBILITY_SCORE_KEYS, compatibilityScoreKey } from './compat-label.ts'

/** 统一换行后读取（避免 CRLF 让跨行断言静默失真） */
const read = (rel: string): string =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').split('\r\n').join('\n')

test('compat-label: 四档等级各有一个客户端字典键', () => {
  assert.equal(compatibilityScoreKey('excellent'), 'import.compatibility.score.excellent')
  assert.equal(compatibilityScoreKey('good'), 'import.compatibility.score.good')
  assert.equal(compatibilityScoreKey('partial'), 'import.compatibility.score.partial')
  assert.equal(compatibilityScoreKey('unsupported'), 'import.compatibility.score.unsupported')
  assert.equal(Object.keys(COMPATIBILITY_SCORE_KEYS).length, 4, '恰好四档（等级域与 src/ui 的 CompatibilityLevel 同域）')
})

test('compat-label: 导入向导不得再自持一份评分键映射（必须走共享模块）', () => {
  const view = read('../import/ImportWizardView.tsx')
  assert.match(view, /compatibilityScoreKey/, '导入向导必须复用共享映射')
  assert.doesNotMatch(view, /import\.compatibility\.score\./, '评分键字面量只能出现在 compat-label.ts')
})

test('compat-label: 同步确认页不得渲染裸枚举，且复用 ui 层的等级/语义色判定', () => {
  const sync = read('../sync/SyncConfirmView.tsx')
  assert.doesNotMatch(sync, /\{compatibility\}/, '不得把裸枚举当文案渲染（界面显示 partial 这类机器 token 是回归）')
  assert.match(sync, /compatibilityLevel\(compatibility\)/, '等级判定必须走 src/ui 的纯函数')
  assert.match(sync, /compatibilityBadgeKind\(/, 'Badge 语义色必须走 src/ui 的纯函数（unsupported 不能画成中性色）')
  assert.match(sync, /SYNC_COMPAT_KEYS/, '文案必须走 sync 字典映射')
})
