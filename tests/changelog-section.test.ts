/**
 * CHANGELOG 版本段模板（.github/changelog-template.md）与脚本（.github/scripts/changelog-section.mjs）
 * 的行为门禁。
 *
 * 为什么要测：check 跑在发布流水线的 npm publish **之前**，这些断言就是「版本段格式」的契约；
 * release 决定下一轮骨架长什么样 —— 格式一致性全靠它。
 *
 * 夹具注意：[Unreleased] 与已发布段的文案**故意不同**，这样 String.replace 改的是目标段，
 * 不会误改另一处（第一版夹具两段同文案，导致 G-6/7/8 改错位置而假绿 —— 已修）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'changelog-section.mjs')
const REPO_CHANGELOG = path.join(ROOT, 'CHANGELOG.md')

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcm-changelog-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function write(dir: string, name: string, text: string): string {
  const p = path.join(dir, name)
  writeFileSync(p, text, 'utf8')
  return p
}

/**
 * 合规的最小 CHANGELOG：[Unreleased] 与已发布的 1.2.3 段文案各不相同（便于定向改写），
 * 两段都符合模板（标题带日期 / 中英主题 / ### 小节非空 / 无占位符）。
 */
function filledChangelog(): string {
  return [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '> **待发布主题**：下一轮的中文主题。',
    '>',
    '> **Theme**: pending english theme.',
    '',
    '### 🧪 待发布小节 / Pending',
    '',
    '- **待发布要点**：说明。',
    '',
    '## [1.2.3] - 2026-01-01',
    '',
    '> **已发布主题**：已发布段的中文主题。',
    '>',
    '> **Theme**: released english theme.',
    '',
    '### 🧪 已发布小节 / Released',
    '',
    '- **已发布要点**：说明。',
    '',
  ].join('\n')
}

test('G-1 release：收起 [Unreleased] 成版本段，并在顶部开好下一轮骨架', () => {
  withTmp((dir) => {
    const file = write(dir, 'CHANGELOG.md', filledChangelog())
    const r = run(['release', '1.2.4', '--date', '2026-02-03', '--changelog', file])
    assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(file, 'utf8')
    assert.equal((out.match(/^## \[Unreleased\]$/gm) ?? []).length, 1, '必须恰好一个 [Unreleased]')
    assert.ok(out.includes('## [1.2.4] - 2026-02-03'), '版本段标题必须带 ISO 日期')
    assert.ok(out.includes('> **待发布主题**：下一轮的中文主题。'), '旧内容必须原样搬进版本段')
    assert.ok(out.includes('{{本版主题}}'), '新骨架必须有中文主题占位符')
    assert.ok(!out.includes('{{heading}}'), 'heading 占位符必须被替换')
    const at = out.indexOf('## [Unreleased]')
    assert.ok(at >= 0 && at < out.indexOf('## [1.2.4]'), '新骨架必须在版本段之前')
  })
})

test('G-2 release 幂等：版本段已存在 → 退出 1 且不改文件', () => {
  withTmp((dir) => {
    const file = write(dir, 'CHANGELOG.md', filledChangelog())
    assert.equal(run(['release', '1.2.4', '--changelog', file]).status, 0)
    const before = readFileSync(file, 'utf8')
    const again = run(['release', '1.2.4', '--changelog', file])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /已存在/)
    assert.equal(readFileSync(file, 'utf8'), before, '重复执行不得改动文件')
  })
})

test('G-3 release：找不到 [Unreleased] → 退出 1', () => {
  withTmp((dir) => {
    const file = write(dir, 'CHANGELOG.md', '# Changelog\n\n## [1.2.3] - 2026-01-01\n\n> **主题**：中文。\n>\n> **Theme**: english.\n')
    const r = run(['release', '1.2.4', '--changelog', file])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Unreleased/)
  })
})

test('G-4 check：release 收口后的版本段通过（格式与模板同源）', () => {
  withTmp((dir) => {
    const file = write(dir, 'CHANGELOG.md', filledChangelog())
    assert.equal(run(['release', '1.2.4', '--date', '2026-02-03', '--changelog', file]).status, 0)
    assert.equal(run(['check', '1.2.4', '--changelog', file]).status, 0)
  })
})

test('G-5 check：标题缺 ISO 日期 → 退出 1', () => {
  withTmp((dir) => {
    const broken = filledChangelog().replace('## [1.2.3] - 2026-01-01', '## [1.2.3]')
    const r = run(['check', '1.2.3', '--changelog', write(dir, 'CHANGELOG.md', broken)])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /ISO 日期|YYYY-MM-DD/)
  })
})

test('G-6 check：缺英文主题行 → 退出 1', () => {
  withTmp((dir) => {
    const broken = filledChangelog().replace('> **Theme**: released english theme.\n', '')
    const r = run(['check', '1.2.3', '--changelog', write(dir, 'CHANGELOG.md', broken)])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Theme/)
  })
})

test('G-7 check：### 小节是空标题 → 退出 1', () => {
  withTmp((dir) => {
    const broken = filledChangelog().replace('- **已发布要点**：说明。\n', '')
    const r = run(['check', '1.2.3', '--changelog', write(dir, 'CHANGELOG.md', broken)])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /空标题/)
  })
})

test('G-8 check：骨架没填完就发版（把 [Unreleased] 骨架直接改名成版本段）→ 退出 1', () => {
  withTmp((dir) => {
    const file = write(dir, 'CHANGELOG.md', filledChangelog())
    assert.equal(run(['release', '1.2.4', '--date', '2026-02-03', '--changelog', file]).status, 0)
    // 真实误操作：把刚开的骨架（含 {{...}} 占位符）直接当成一个版本段发出去
    const shipped = readFileSync(file, 'utf8').replace('## [Unreleased]', '## [1.2.5] - 2026-02-04')
    const r = run(['check', '1.2.5', '--changelog', write(dir, 'x.md', shipped)])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /占位符/)
  })
})

test('G-9 check：版本段不存在 → 退出 1 并提示先跑 release', () => {
  withTmp((dir) => {
    const r = run(['check', '9.9.9', '--changelog', write(dir, 'CHANGELOG.md', filledChangelog())])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /找不到/)
    assert.match(r.stderr, /release/)
  })
})

test('G-10 真实仓库回归：已发布的 0.1.69 段仍符合模板（防规则漂移）', () => {
  assert.equal(run(['check', '0.1.69', '--changelog', REPO_CHANGELOG]).status, 0)
})

test('G-11 workflow 契约：格式门禁在 npm publish 之前执行', () => {
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
  const guardAt = wf.indexOf('changelog-section.mjs check')
  const publishAt = wf.indexOf('npm publish --access public')
  assert.ok(guardAt > 0, 'publish.yml 必须调用 changelog-section.mjs check')
  assert.ok(publishAt > guardAt, '格式门禁必须在 npm publish 之前')
})

test('G-12 参数不合法：版本号 → 退出 2 并给出用法', () => {
  const r = run(['check', 'not-a-version'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: changelog-section\.mjs/)
})
