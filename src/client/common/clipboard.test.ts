/**
 * 剪贴板原语测试：没有 clipboard / 写入被拒都必须返回 `false` ——
 * 调用方据此给失败提示，绝不给「看起来成功了」的假信号（与 CopyButton 的既有约定一致）。
 *
 * Node 24 的 `navigator` 没有 `clipboard`，正好覆盖真实降级路径；成功路径用
 * Object.defineProperty 在实例上打桩（不碰系统剪贴板，测完删除还原）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { copyTextToClipboard } from './clipboard.ts'

/** 打桩 navigator.clipboard 并在结束后还原（恢复「本来没有」或原值）。 */
async function withClipboard<T>(value: unknown, fn: () => Promise<T>): Promise<T> {
  const nav = globalThis.navigator as unknown as Record<string, unknown>
  const had = Object.prototype.hasOwnProperty.call(nav, 'clipboard')
  const prev = nav['clipboard']
  Object.defineProperty(nav, 'clipboard', { value, configurable: true, writable: true })
  try {
    return await fn()
  } finally {
    if (had) Object.defineProperty(nav, 'clipboard', { value: prev, configurable: true, writable: true })
    else delete nav['clipboard']
  }
}

test('clipboard: 无 navigator.clipboard（Node / 不安全上下文）→ false，且不抛错', async () => {
  assert.equal(await copyTextToClipboard('A0D3-DE3F'), false)
})

test('clipboard: writeText 成功 → true；被拒 / 无 writeText / 同步抛错 → false', async () => {
  assert.equal(await withClipboard({ writeText: async () => {} }, () => copyTextToClipboard('A0D3-DE3F')), true)
  assert.equal(
    await withClipboard({ writeText: async () => { throw new Error('denied') } }, () => copyTextToClipboard('x')),
    false,
  )
  assert.equal(await withClipboard({}, () => copyTextToClipboard('x')), false, '有 clipboard 但无 writeText → false')
  assert.equal(
    await withClipboard({ writeText: () => { throw new Error('boom') } }, () => copyTextToClipboard('x')),
    false,
  )
})
