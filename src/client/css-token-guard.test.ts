/**
 * css-token-guard — 语义 token 层的**源级执行者**（UI v3 §4.1）。
 *
 * 规则：四态与主色**只能**在 \`--cm-*\` 定义行里引用 \`--dsw-*\`；组件规则一律消费 \`--cm-*\`。
 * 为什么需要它：v2 里 140 处 \`--dsw-alias-state-*\` / \`--dsw-alias-button-info-*\` 直接散落在
 * 4957 行样式里，四态语义各写各的（Badge / Banner / StatusDot / kindTag / choiceCard 五份实现）——
 * 改一次语义要扫全文件。中间层建立后必须有人守着它不被绕过。
 *
 * 结构类 token（label / border / bg / hover / input / font）**不受约束**：它们语义稳定、直用更短。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CSS = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8')

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 必须**只在定义行**出现的 \`--dsw-*\` 语义 token（值 = 出现次数上限 1）。 */
const GUARDED_DSW = [
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-info-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
]

/** token 定义行：\`--cm-xxx: var(--dsw-...)\`。 */
const DEF_LINE = /^\s*--cm-[\w-]+\s*:\s*var\(--dsw-/

/** \`--cm-*\` 层必须存在的语义 token（删掉任何一个都说明层被拆了）。 */
const REQUIRED_CM = [
  '--cm-accent', '--cm-accent-hover', '--cm-ok', '--cm-info', '--cm-warn', '--cm-error',
  '--cm-fs-meta', '--cm-fs-table', '--cm-fs-base', '--cm-fs-title',
  '--cm-r-1', '--cm-r-2', '--cm-r-3',
  '--cm-z-task', '--cm-z-modal', '--cm-z-pop', '--cm-z-toast',
]

const STRIPPED = stripComments(CSS)

test('token-01 四态/主色 token 只能出现在 --cm-* 定义行里', () => {
  const violations: string[] = []
  STRIPPED.split('\n').forEach((line, i) => {
    for (const tok of GUARDED_DSW) {
      if (!line.includes(tok)) continue
      if (!DEF_LINE.test(line)) violations.push('L' + String(i + 1) + ' 裸用 ' + tok + '：' + line.trim().slice(0, 90))
    }
  })
  assert.deepEqual(violations, [], '这些行必须改为消费 --cm-*（或把新 token 加进 §1 TOKENS）：\n' + violations.join('\n'))
})

test('token-02 每个受约束的 --dsw-* 语义 token 恰好定义一次（不得重复定义/漂移）', () => {
  for (const tok of GUARDED_DSW) {
    const n = (STRIPPED.match(new RegExp(tok.replace(/[-]/g, '\\-'), 'g')) ?? []).length
    assert.equal(n, 1, tok + ' 应恰好出现 1 次（在 --cm-* 定义行），实际 ' + String(n))
  }
})

test('token-03 --cm-* 层必须完整（语义 + 字号 + 圆角 + 层级）', () => {
  for (const tok of REQUIRED_CM) {
    assert.ok(new RegExp('\\s' + tok.replace(/[-]/g, '\\-') + '\\s*:').test(STRIPPED), tok + ' 定义缺失')
  }
})

test('token-04 四态 token 必须真被消费（定义而不接线 = 死 token）', () => {
  const body = STRIPPED.replace(/^\s*--cm-[\w-]+\s*:.*$/gm, '')
  for (const tok of ['--cm-accent', '--cm-ok', '--cm-info', '--cm-warn', '--cm-error']) {
    assert.ok(body.includes('var(' + tok + ')'), tok + ' 在规则里没有任何消费点')
  }
})

test('token-05 反自检：定义行之外的裸用必须被抓到', () => {
  const mutated = STRIPPED.replace('.section {', '.section {\n  color: var(--dsw-alias-state-error-primary);')
  const hit = mutated.split('\n').some((line) => line.includes('--dsw-alias-state-error-primary') && !DEF_LINE.test(line))
  assert.ok(hit, '注入的裸用必须被 token-01 的判据命中')
})
