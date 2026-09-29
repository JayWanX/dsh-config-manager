/**
 * Desktop CLI 载体探测（桌面端兼容）单测。
 *
 * 背景：Desktop 把 profile `desktop` 定为保留档案，普通 dsh CLI 对 `--profile desktop`
 * 一律报 'profile "desktop" is managed exclusively by the Electron application'；只有桌面端
 * 自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js` 放行。这里钉住「怎么认出那个载体」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { DESKTOP_PROFILE_NAME, isDesktopHostProcess, isDesktopProfile, resolveDesktopCarrier } from './desktop-carrier.ts'
import { DESKTOP_PROFILE_NAME as SHARED_DESKTOP_NAME, isManagedProfileName } from '../profiles/dsh-profile-shared.ts'

// 用 node:path 拼路径：实现里也是 join/dirname，这样用例在 Windows 与 Linux CI 上同义
// （写死反斜杠的 Windows 字面量在 POSIX 上 dirname 会退化成 '.'，是自欺欺人的断言）
const HOST_DIR = join('Apps', 'DSH', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib')
const HOST_ARGV1 = join(HOST_DIR, 'index.js')
const HOST_CLI = join(HOST_DIR, 'cli.js')
const ELECTRON_EXE = join('Apps', 'DSH', 'DeepSeek Harness.exe')

test('resolveDesktopCarrier：只认 dsh-desktop-host 主入口 + 同目录真实存在的 cli.js', () => {
  const carrier = resolveDesktopCarrier({ argv1: HOST_ARGV1, execPath: ELECTRON_EXE, exists: (p) => p === HOST_CLI })
  assert.equal(carrier?.cliPath, HOST_CLI)
  assert.equal(carrier?.execPath, ELECTRON_EXE, '载体用 Electron 主程序（Node 模式）启动')
  assert.deepEqual(carrier?.env, { ELECTRON_RUN_AS_NODE: '1' }, '必须带 ELECTRON_RUN_AS_NODE=1，否则会拉起 GUI')
  assert.equal(isDesktopHostProcess({ argv1: HOST_ARGV1, exists: () => true }), true)
  // POSIX 形态同样识别（cliPath 由 path.join 拼，断言用 join 保持跨平台）
  assert.equal(
    resolveDesktopCarrier({ argv1: '/opt/dsh/dsh-desktop-host/lib/index.mjs', exists: () => true })?.cliPath,
    join('/opt/dsh/dsh-desktop-host/lib', 'cli.js'),
  )
})

test('resolveDesktopCarrier：非桌面宿主 → null（不猜、不误伤普通 dsh web）', () => {
  const exists = (): boolean => true
  assert.equal(resolveDesktopCarrier({ argv1: join('n', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), exists }), null, '普通 dsh web 的 bin.js')
  assert.equal(resolveDesktopCarrier({ argv1: HOST_CLI, exists }), null, 'argv1 是 cli.js 而不是 index.js → 不认（只认宿主主入口）')
  assert.equal(resolveDesktopCarrier({ argv1: undefined, exists }), null)
  assert.equal(resolveDesktopCarrier({ argv1: '', exists }), null)
  assert.equal(resolveDesktopCarrier({ argv1: HOST_ARGV1, exists: () => false }), null, '同目录没有 cli.js → 不认（版本不含载体时不能假装有）')
})

test('desktop 保留档案名：shared（浏览器半）与 utils（宿主半）两份字面量互钉，且大小写口径一致', () => {
  assert.equal(DESKTOP_PROFILE_NAME, SHARED_DESKTOP_NAME, '两处字面量不得漂移')
  assert.equal(DESKTOP_PROFILE_NAME, 'desktop')
  for (const name of ['desktop', 'Desktop', ' DESKTOP ']) {
    assert.equal(isDesktopProfile(name), true, name)
    assert.equal(isManagedProfileName(name), true, name)
  }
  for (const name of ['web', 'cmtest', 'desktop-copy', '']) {
    assert.equal(isDesktopProfile(name), false, name)
    assert.equal(isManagedProfileName(name), false, name)
  }
})
