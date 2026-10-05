/**
 * 「档案」页 cross-F3 视图模型单测（t50）：**中断的档案复制残留**必须以独立形态呈现、只留删除。
 *
 * 为什么单独一个文件：这是 t50 新增的一类条目（API 由 t39 的 host 侧新增），
 * 单独成文可以让「base 上红」的信号精确落在这几条上，不牵连既有视图模型断言
 * （既有断言仍在 dsh-profiles-view.test.ts 里逐字运行）。
 *
 * 判据口径（与 t39 的 host 侧一致）：
 *  - 残留 = 宿主 list() 显式给的 `incomplete: true`；**绝不**从 shape/bundles 猜
 *    （generic + 空 bundles 也可能是用户手工建的空档案，猜错会把真档案的启动/改名入口藏掉）；
 *  - 残留行的动作集合 = { 删除 }；只读详情保留（目录/来源/时间在那里）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  countIncompleteProfileCopies, formatProfileTime, incompleteCopyFacts, incompleteCopyStartedAtText,
  isIncompleteProfileCopy, profileRowCapabilities, profileShapeLabelKey, summarizeProfiles,
} from './dsh-profiles-view.ts'
import type { DshProfileMeta } from '../profiles/dsh-profile-shared.ts'

function meta(name: string, over: Partial<DshProfileMeta> = {}): DshProfileMeta {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: {},
    shape: 'generic',
    patchReload: 'live',
    hasNodeModules: false,
    patchEntryCount: 0,
    patchBytes: 0,
    isCurrent: false,
    issues: [],
    updatedAtMs: null,
    ...over,
  }
}

/** 半截副本行：host 的 list() 给出的形态（无 package.json ⇒ bundles 空、shape generic）。 */
function halfCopy(over: Partial<DshProfileMeta> = {}): DshProfileMeta {
  return meta('work-copy', {
    bundles: [],
    shape: 'generic',
    incomplete: true,
    copiedFrom: 'work',
    copyStartedAt: '2026-10-05T12:00:00.000Z',
    dir: '/home/.dsh/profiles/work-copy',
    ...over,
  })
}

test('cross-F3：残留行的判据只有显式 incomplete 标记（不靠 shape/bundles 猜）', () => {
  assert.equal(isIncompleteProfileCopy(halfCopy()), true)
  assert.equal(isIncompleteProfileCopy(meta('empty', { bundles: [], shape: 'generic' })), false,
    'generic + 空 bundles 也可能是用户手工建的空档案：不得猜成残留')
  assert.equal(isIncompleteProfileCopy(meta('a', { incomplete: undefined })), false)
  assert.equal(isIncompleteProfileCopy(meta('a', { incomplete: false as unknown as true })), false, '只有字面 true 才算')
})

test('cross-F3：残留行必须给出「从哪来 / 何时开始 / 目录在哪」，读不到一律 null（不臆造）', () => {
  assert.deepEqual(incompleteCopyFacts(halfCopy()), {
    copiedFrom: 'work', startedAt: '2026-10-05T12:00:00.000Z', dir: '/home/.dsh/profiles/work-copy',
  })
  assert.deepEqual(
    incompleteCopyFacts(halfCopy({ copiedFrom: undefined, copyStartedAt: '', dir: undefined })),
    { copiedFrom: null, startedAt: null, dir: null },
    '标记损坏时（host 只回 incomplete）不得编来源/时间/路径',
  )
})

test('cross-F3：残留行只留删除动作（启动/停止/复制/改名一律不给）', () => {
  assert.deepEqual(profileRowCapabilities(halfCopy()), { detail: true, launchOrStop: false, duplicate: false, rename: false, delete: true })
})

test('cross-F3 对照：普通档案的动作逐字未变（含 canLaunch 的既有口径）', () => {
  assert.deepEqual(profileRowCapabilities(meta('web')), { detail: true, launchOrStop: true, duplicate: true, rename: true, delete: true })
  assert.deepEqual(profileRowCapabilities(meta('headless')), { detail: true, launchOrStop: true, duplicate: true, rename: true, delete: true },
    '非 web 形态仍显示启动（点了给终端命令）——这条既有行为不得被 t50 改掉')
})

test('cross-F3：残留行的形态徽章必须是「未完成的副本」，不是 generic', () => {
  assert.equal(profileShapeLabelKey(halfCopy()), 'profiles.shape.incomplete')
  assert.equal(profileShapeLabelKey(meta('a', { shape: 'generic' })), 'profiles.shape.generic', '普通空档案仍走原形态键')
  assert.equal(profileShapeLabelKey(meta('a', { shape: 'web' })), 'profiles.shape.web')
})

test('cross-F3：开始时刻可解析则格式化、不可解析则原样回显（绝不显示空）', () => {
  assert.equal(incompleteCopyStartedAtText('2026-10-05T12:00:00.000Z'), formatProfileTime(Date.parse('2026-10-05T12:00:00.000Z')))
  assert.equal(incompleteCopyStartedAtText('2026-10-05T12:00:00.000Z')?.includes('2026-10-05'), true)
  assert.equal(incompleteCopyStartedAtText('not-a-date'), 'not-a-date', '解析不了就原样给，不假装没有')
  assert.equal(incompleteCopyStartedAtText(null), null, 'host 没给该字段 → 不显示这一项')
})

test('cross-F3：残留计数与档案计数分开（普通档案的 summary 口径逐字未变）', () => {
  const list = [meta('web'), halfCopy(), halfCopy({ name: 'b-copy' })]
  assert.equal(countIncompleteProfileCopies(list), 2)
  assert.equal(countIncompleteProfileCopies([meta('web')]), 0)
  assert.deepEqual(summarizeProfiles([meta('web', { shape: 'web' }), meta('work')]), {
    total: 2, web: 1, headless: 0, generic: 1, broken: 0, withNodeModules: 0, patchEntries: 0,
  }, '既有 summary 结构不得被 t50 改动（新增计数走 countIncompleteProfileCopies）')
})
