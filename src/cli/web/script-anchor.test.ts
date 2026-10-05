/**
 * cli-F5 回归：CONSOLE_SCRIPT 的源码锚点抽取必须与检出形态无关。
 *
 * 现象（audit-cli cli-F5，issue #70 同类）：web.test.ts 就地用「只认 LF」的正则读
 * client-script.ts；Windows 上 core.autocrlf=true 的检出（CRLF）会让锚点失配 → R3-04 假红
 * （实测：LF 检出 40/40 绿 / CRLF 检出 39/40 红）。抽取逻辑现在收在 client-script.ts 的单一实现里。
 *
 * 动态 import + 存在性断言：这样「base + 只放测试」跑出来是**断言级红**，而不是整文件加载失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('cli-F5 CONSOLE_SCRIPT 锚点抽取必须同时吃 LF 与 CRLF 源码', async () => {
  const mod = await import('./client-script.ts') as unknown as {
    CONSOLE_SCRIPT: string
    extractConsoleScriptSource?: (source: string) => string | undefined
  }
  assert.equal(
    typeof mod.extractConsoleScriptSource, 'function',
    'client-script.ts 必须导出 extractConsoleScriptSource（换行归一化的唯一实现）',
  )
  const extract = mod.extractConsoleScriptSource as (source: string) => string | undefined
  const lf = readFileSync(new URL('./client-script.ts', import.meta.url), 'utf8')
  const crlf = lf.replace(/\r?\n/g, '\r\n')
  assert.ok(crlf.includes('\r\n'), '前置：CRLF 变体确实带 CR')
  const fromLf = extract(lf)
  const fromCrlf = extract(crlf)
  assert.ok(fromLf, 'LF 源码必须能抽出 CONSOLE_SCRIPT')
  assert.ok(fromCrlf, 'CRLF 源码必须能抽出 CONSOLE_SCRIPT（修复前这里失配 → R3-04 假红）')
  assert.equal(fromCrlf, fromLf, '两种检出形态抽出的脚本原文必须一致')
  assert.equal(fromLf, mod.CONSOLE_SCRIPT, '抽出的原文必须等于模块导出的脚本常量')
})
