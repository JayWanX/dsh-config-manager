/**
 * cross-F3 回归：**中断的档案复制留下的半截副本必须可被发现、可被清理**。
 *
 * 现场（outputs/bug-audit/cross-v3v8/findings.md，base sha 3f42a8b）：3002 文件的档案复制在
 * t+1048ms 被强杀 → 磁盘留下 107 个文件、**没有 package.json** 的半截副本，于是：
 *   - `GET /profiles`（= 本引擎的 list()）按「有 package.json 才算 profile」跳过它 → 界面看不见；
 *   - `POST /profiles/delete` → remove() → requireProfile 报 notFound → 删不掉；
 *   - 恢复面板的 incident 没有 snapshotId → 给不出回滚入口。
 * 结果是一个「查不到、删不掉、无回滚凭据」的孤儿目录。
 *
 * 修复口径（只动 src/profiles/**）：
 *   1) 复制**开始前**在目标目录写标记 `.dcm-copy-in-progress.json`（成功/回滚时移除）；
 *   2) list() 把它作为 `incomplete: true` 的条目列出（含目标绝对路径 dir / 来源 / 开始时间），
 *      形态恒为 generic（不可启动）；listIncompleteCopies() 给恢复面板/CLI 一份同源清单；
 *   3) remove()/detail() 接受「有标记无 package.json」的目录（删得掉、看得到）；
 *   4) 既无 package.json 又无标记的目录仍按既有口径跳过、仍不可删（不为此放宽边界）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

import { DshProfileManager, DshProfileError } from './dsh-profile-manager.ts'
import { isLaunchableShape, type DshProfileIncompleteCopy } from './dsh-profile-shared.ts'

/** 磁盘契约字面量：改名即等于把旧版本留下的残留重新变成「查不到」（测试刻意钉死字符串）。 */
const MARKER = '.dcm-copy-in-progress.json'
const STARTED_AT = '2026-10-05T12:00:00.000Z'

function makeManager(): { mgr: DshProfileManager; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-incomplete-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const mgr = new DshProfileManager({ homeDir: home, currentProfile: () => 'web' })
  return { mgr, home, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** 造一个「被强杀」的半截副本：部分文件 + 标记，**没有 package.json**。 */
function writeHalfCopy(home: string, name: string, marker: unknown = { sourceName: 'work', newName: name, startedAt: STARTED_AT, includeNodeModules: true, pid: 4242 }): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'partial', 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), '# partial patch layer\n', 'utf8')
  if (marker !== null) {
    writeFileSync(join(dir, MARKER), typeof marker === 'string' ? marker : JSON.stringify(marker), 'utf8')
  }
  return dir
}

/** base 上没有 listIncompleteCopies ⇒ 运行时探测：让该用例在 base 上以**断言失败**变红，而非模块加载失败。 */
function hasIncompleteCopiesApi(mgr: DshProfileManager): boolean {
  return typeof (mgr as unknown as { listIncompleteCopies?: unknown }).listIncompleteCopies === 'function'
}

function incompleteCopiesOf(mgr: DshProfileManager): DshProfileIncompleteCopy[] {
  assert.equal(hasIncompleteCopiesApi(mgr), true, '引擎必须提供 listIncompleteCopies()（半截副本清单）')
  return (mgr as unknown as { listIncompleteCopies: () => DshProfileIncompleteCopy[] }).listIncompleteCopies()
}

test('cross-F3：中断的复制残留必须可被发现（列表含目标路径 + 来源 + 开始时间，且不可启动）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home, 'work-copy')
    const row = mgr.list().find((p) => p.name === 'work-copy')
    assert.ok(row !== undefined, '半截副本必须出现在 list() 里（base 上会因缺 package.json 被跳过 → 界面看不见）')
    assert.equal(row.incomplete, true, '必须显式标注它是未完成的副本')
    assert.equal(row.dir, dir, '必须给出目标绝对路径（用户据此定位目录）')
    assert.equal(row.copiedFrom, 'work', '必须给出源档案名')
    assert.equal(row.copyStartedAt, STARTED_AT, '必须给出复制开始时间')
    assert.equal(isLaunchableShape(row.shape), false, '半截副本绝不能显示启动入口（generic 不可启动）')
    assert.deepEqual(row.bundles, [], '没有 package.json ⇒ 没有任何 bundle 声明')
  } finally {
    cleanup()
  }
})

test('cross-F3：半截副本必须可被物理删除（remove 不再报 notFound）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home, 'work-copy')
    mgr.remove('work-copy', { allowCurrent: true })
    assert.equal(existsSync(dir), false, 'remove 之后目标目录必须消失（base 上抛 notFound 且目录原样留下）')
    assert.deepEqual(mgr.list().map((p) => p.name), [], '删除后不应再有残留条目')
  } finally {
    cleanup()
  }
})

test('cross-F3：半截副本的 detail 可用（manifest=null，不报 notFound）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    writeHalfCopy(home, 'work-copy')
    const detail = mgr.detail('work-copy')
    assert.equal(detail.incomplete, true)
    assert.equal(detail.manifest, null, '没有 package.json ⇒ manifest 为 null（不臆造）')
    assert.equal(detail.patch, '# partial patch layer\n', '已拷过去的 patch 层原样可见')
  } finally {
    cleanup()
  }
})

test('cross-F3：listIncompleteCopies 给出目标绝对路径与来源（恢复面板/CLI 的唯一入口）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dirB = writeHalfCopy(home, 'b-copy', { sourceName: 'bbb', newName: 'b-copy', startedAt: STARTED_AT, includeNodeModules: false, pid: 7 })
    const dirA = writeHalfCopy(home, 'a-copy')
    const copies = incompleteCopiesOf(mgr)
    assert.deepEqual(copies.map((c) => c.name), ['a-copy', 'b-copy'], '按名字排序')
    assert.equal(copies[1]!.dir, dirB)
    assert.equal(copies[1]!.sourceName, 'bbb')
    assert.equal(copies[1]!.markerReadable, true)
    assert.equal(isAbsolute(copies[0]!.dir), true, 'dir 必须是绝对路径')
    assert.equal(copies[0]!.dir, dirA)
  } finally {
    cleanup()
  }
})

test('cross-F3：标记内容损坏也必须被发现且可删（绝不当成不存在）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home, 'broken-marker', 'this is not json')
    const row = mgr.list().find((p) => p.name === 'broken-marker')
    assert.ok(row !== undefined, '标记存在即为残留：内容坏掉不得让它重新隐身')
    assert.equal(row.incomplete, true)
    assert.equal(row.copiedFrom, undefined, '读不出源名就不写该字段（不臆造）')
    const copy = incompleteCopiesOf(mgr).find((c) => c.name === 'broken-marker')
    assert.equal(copy?.markerReadable, false, '如实标记「标记不可解析」')
    assert.equal(copy?.sourceName, null)
    mgr.remove('broken-marker')
    assert.equal(existsSync(dir), false)
  } finally {
    cleanup()
  }
})

test('cross-F3 边界：既无 package.json 又无标记的目录仍被跳过、仍不可删（不为修这条放宽边界）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = join(home, 'profiles', 'plain-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'random.txt'), 'x', 'utf8')
    assert.deepEqual(mgr.list().map((p) => p.name), [], '无 package.json 且无标记 ⇒ 仍不是 profile')
    assert.deepEqual(incompleteCopiesOf(mgr), [], '也不得进入半截副本清单')
    assert.throws(() => mgr.remove('plain-dir'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound', '不得因此放开任意目录的删除')
    assert.equal(existsSync(dir), true, '目录必须原样保留')
    assert.throws(() => mgr.detail('plain-dir'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound')
  } finally {
    cleanup()
  }
})

test('cross-F3 边界：标记与 package.json 同时存在 → 按正常档案处理（成功复制不留脏标记）', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    const { meta } = await mgr.copy('work', 'work-copy')
    assert.equal(meta.name, 'work-copy')
    const dir = join(home, 'profiles', 'work-copy')
    assert.equal(existsSync(join(dir, MARKER)), false, '复制成功后必须移除进行中标记')
    assert.equal(mgr.list().find((p) => p.name === 'work-copy')?.incomplete, undefined, '正常档案不得被标成半截副本')
    assert.deepEqual(incompleteCopiesOf(mgr), [], '成功复制不产生任何残留')

    // 手工留下一条脏标记：有 package.json 时仍按正常档案处理（不误报、也不删用户数据）
    writeFileSync(join(dir, MARKER), JSON.stringify({ sourceName: 'work', newName: 'work-copy', startedAt: STARTED_AT, includeNodeModules: true, pid: 1 }), 'utf8')
    assert.equal(mgr.list().find((p) => p.name === 'work-copy')?.incomplete, undefined)
    assert.deepEqual(incompleteCopiesOf(mgr), [])
  } finally {
    cleanup()
  }
})

test('cross-F3 契约：标记文件名必须与磁盘上的既有残留一致（改名会让旧残留重新隐身）', async () => {
  const mod = await import('./dsh-profile-shared.ts') as Record<string, unknown>
  assert.equal(mod['PROFILE_COPY_MARKER_FILENAME'], MARKER)
})
