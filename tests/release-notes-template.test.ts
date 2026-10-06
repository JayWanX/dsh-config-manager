/**
 * release 描述模板渲染器（.github/scripts/render-release-notes.mjs）的行为门禁。
 * 它跑在发布流水线里，且**在 npm publish 之前**做 dry-run，所以这些断言等于发布契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'render-release-notes.mjs')
const TEMPLATE = path.join(ROOT, '.github', 'release-notes-template.md')

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcm-release-notes-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function fixture(dir: string, name: string, text: string): string {
  const p = path.join(dir, name)
  writeFileSync(p, text, 'utf8')
  return p
}

test('F-1 真实模板渲染：亮点 + 精确版本安装命令 + 自动变更记录，且不残留占位符/注释', () => {
  withTmp((dir) => {
    const highlights = fixture(dir, 'highlights.md', '> **亮点**：中文段\n>\n> **Theme**: english part.')
    const auto = fixture(dir, 'auto.md', '## New Contributors\n* @someone made their first contribution')
    const r = run(['v0.1.70', TEMPLATE, highlights, auto])
    assert.equal(r.status, 0, r.stderr)
    const out = r.stdout
    assert.ok(out.includes('> **亮点**：中文段'), '亮点段必须进描述')
    assert.ok(out.includes('dsh-config-manager@0.1.70'), '安装命令用精确版本（tag 去 v）')
    assert.ok(!out.includes('dsh-config-manager@v0.1.70'), '版本号不带 v 前缀')
    assert.ok(out.includes('@someone'), '自动变更记录必须进描述')
    assert.ok(!out.includes('{{'), '不得残留占位符：' + out.slice(0, 120))
    assert.ok(!out.includes('<!--'), '模板注释不得进描述')
    assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), '结尾只允许一个换行')
  })
})

test('F-2 模板缺 {{highlights}} / {{autoNotes}} → 退出码 1（发布门禁的一部分）', () => {
  withTmp((dir) => {
    const highlights = fixture(dir, 'highlights.md', '> 亮点')
    const auto = fixture(dir, 'auto.md', 'auto')
    for (const [missing, tplText] of [
      ['highlights', '# 标题\n\n{{autoNotes}}\n'],
      ['autoNotes', '# 标题\n\n{{highlights}}\n'],
      ['both', '# 标题\n\n无占位符\n'],
    ] as const) {
      const tpl = fixture(dir, 'tpl-' + missing + '.md', tplText)
      const r = run(['v0.1.70', tpl, highlights, auto])
      assert.equal(r.status, 1, '缺 ' + missing + ' 必须失败')
      assert.match(r.stderr, /占位符/)
      assert.equal(r.stdout, '', '失败时不得往 stdout 写半截描述')
    }
  })
})

test('F-3 未知占位符原样保留（前向兼容），{{version}}/{{tag}} 语义正确', () => {
  withTmp((dir) => {
    const tpl = fixture(dir, 'tpl.md', '{{highlights}}\n{{autoNotes}}\n未知：{{nope}} | tag={{tag}} | version={{version}}\n')
    const r = run(['v0.1.70', tpl, fixture(dir, 'h.md', 'H'), fixture(dir, 'a.md', 'A')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes('{{nope}}'), '未知占位符必须原样保留')
    assert.ok(r.stdout.includes('tag=v0.1.70'), 'tag 保留 v')
    assert.ok(r.stdout.includes('version=0.1.70'), 'version 去 v')
  })
})

test('F-4 亮点里的 $& / $" 不被当成替换模式解释（split/join 而非 replace）', () => {
  withTmp((dir) => {
    const tricky = "价格 $& 与 $' 与 $` 与 \\$1 都必须逐字保留"
    const r = run(['v0.1.70', TEMPLATE, fixture(dir, 'h.md', tricky), fixture(dir, 'a.md', 'A')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes(tricky), '必须逐字保留：' + r.stdout.slice(0, 200))
  })
})

test('F-5 参数不足 → 退出码 2 并给出用法', () => {
  const r = run(['v0.1.70', TEMPLATE])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: render-release-notes\.mjs/)
})

test('F-6 文件读不到（模板 / 亮点 / 自动记录）→ 退出码 1', () => {
  withTmp((dir) => {
    const h = fixture(dir, 'h.md', 'H')
    const a = fixture(dir, 'a.md', 'A')
    assert.equal(run(['v0.1.70', path.join(dir, 'missing.md'), h, a]).status, 1)
    assert.equal(run(['v0.1.70', TEMPLATE, path.join(dir, 'missing.md'), a]).status, 1)
    assert.equal(run(['v0.1.70', TEMPLATE, h, path.join(dir, 'missing.md')]).status, 1)
  })
})

test('F-7 亮点段为空 → 退出码 1（发布门禁要求当前版本段非空）', () => {
  withTmp((dir) => {
    const r = run(['v0.1.70', TEMPLATE, fixture(dir, 'empty.md', '\n\n'), fixture(dir, 'a.md', 'A')])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /亮点段为空/)
  })
})

test('F-8 空行折叠：空自动记录不会留下连续 3 个换行', () => {
  withTmp((dir) => {
    const tpl = fixture(dir, 'tpl.md', '{{highlights}}\n\n## 变更记录\n\n{{autoNotes}}\n')
    const r = run(['v0.1.70', tpl, fixture(dir, 'h.md', 'H'), fixture(dir, 'a.md', '\n\n')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!/\n{3,}/.test(r.stdout), '不得有连续 3 个换行：' + JSON.stringify(r.stdout))
  })
})

test('F-9 workflow 契约：publish.yml 在 publish 之前 dry-run 渲染、并在 release 步骤用渲染器', () => {
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
  assert.match(wf, /render-release-notes\.mjs "\$VERSION" \.github\/release-notes-template\.md \/tmp\/highlights\.md \/tmp\/auto-notes\.stub\.md/, '门禁步骤必须 dry-run 渲染模板')
  assert.match(wf, /render-release-notes\.mjs \\\n?\s*"\$GITHUB_REF_NAME"/, 'release 步骤必须用渲染器拼装描述')
  const guardAt = wf.indexOf('render-release-notes.mjs "$VERSION"')
  const publishAt = wf.indexOf('npm publish --access public')
  assert.ok(guardAt > 0 && publishAt > guardAt, 'dry-run 必须在 npm publish 之前')
})

test('F-10 真实形状：autoNotes 自带 provenance 注释 + 模板注释含占位符说明 → 不泄漏、顺序正确', () => {
  withTmp((dir) => {
    const highlights = fixture(dir, 'h.md', '> **亮点**：中文段\n> **Theme**: english part.')
    // 与 gh release create --generate-notes 的真实输出同形：首行是 HTML provenance 注释
    const auto = fixture(
      dir,
      'a.md',
      '<!-- Release notes generated using configuration in .github/release.yml at main -->\n\n' +
        '## What\'s Changed\n### 📦 其它变更 / Other Changes\n* fix: 某修复 by @someone in https://example.com/pull/1',
    )
    const r = run(['v0.1.70', TEMPLATE, highlights, auto])
    assert.equal(r.status, 0, r.stderr)
    const out = r.stdout
    assert.ok(out.trimStart().startsWith('> **亮点**'), '亮点段必须在最前，实际开头：' + out.slice(0, 80))
    assert.ok(!out.includes('可用占位符'), '模板注释不得泄漏进描述')
    assert.ok(!out.includes('纯版本号，如'), '模板注释不得泄漏进描述')
    assert.ok(out.indexOf('## 🔄 变更记录') < out.indexOf("## What's Changed"), '自动变更记录必须在标题之后')
    assert.ok(out.includes('<!-- Release notes generated'), 'GitHub 写的 provenance 注释原样保留（渲染时不可见）')
  })
})

test('F-11 占位符只写在模板注释里 → 视为缺失（必填检查基于剥离注释后的模板）', () => {
  withTmp((dir) => {
    const tpl = fixture(dir, 'tpl.md', '<!-- 说明：{{highlights}} 与 {{autoNotes}} -->\n\n正文没有占位符\n')
    const r = run(['v0.1.70', tpl, fixture(dir, 'h.md', 'H'), fixture(dir, 'a.md', 'A')])
    assert.equal(r.status, 1, '注释里的占位符不算数')
    assert.match(r.stderr, /占位符/)
  })
})
