/**
 * t26 新增回归（cli-F1 的机制侧 + 接线锚点）。
 *
 * 为什么单独放一个文件、且用动态 import：这些断言依赖**修复后才存在**的导出（page.ts 的
 * escCapability）。若混进 web.test.ts，「base + 只放测试」那一次运行会让整个文件加载失败，
 * 掩盖同一文件里其它 finding 的断言级红。动态 import 让缺导出只红这一条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { RescuePaths } from '../actions.ts'

test('cli-F1 能力 URL 的展示出口必须只转义不脱敏（结果页 + 接线锚点）', async () => {
  const page = await import('./page.ts')
  assert.equal(
    typeof page.escCapability, 'function',
    'page.ts 必须导出 escCapability（只转义不脱敏的「能力 URL」出口）',
  )
  const authUrl = 'http://127.0.0.1:3099/?token=probe-token-abc123'
  const paths: RescuePaths = {
    homeDir: 'H', dataDir: 'D', snapshotsDir: 'S', exportsDir: 'E', locksDir: 'L',
    controlRoots: ['R'], profile: 'web',
  }
  const html = page.renderResultPage(
    '实例已启动',
    ['实例已就绪。', { html: '认证 URL：<code>' + page.escCapability(authUrl) + '</code>' }],
    '0.0.0-test', paths, 'ok', '/profiles',
  )
  assert.match(html, /token=probe-token-abc123/, '能力 URL 必须原样可见（否则点开必然 401）')
  assert.doesNotMatch(html, /\*\*\*REDACTED\*\*\*/)
  // 接线点锁死：启动结果那条路径要 spawn 真 DSH，单测里跑不到 → 用源码锚点钉住它用的是能力出口
  const routesSrc = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8').split('\r\n').join('\n')
  assert.match(routesSrc, /escCapability\(result\.url\)/, '启动结果页必须用 escCapability')
  // 反向护栏：esc() 本身**仍须**脱敏（不得为了让 URL 通过而把全局口径放宽）
  assert.match(page.esc('?token=abc'), /\*\*\*REDACTED\*\*\*/, 'esc() 必须继续脱敏')
})
