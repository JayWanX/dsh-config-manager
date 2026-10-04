/**
 * 离线只读动作层单测（阶段 0）。
 *
 * 钉住的语义：
 *  - 心跳按**候选控制根**读取（旧实现把快照目录当 dataDir 用 → 缺省路径下永远找不到心跳）；
 *  - 死 pid / 过期心跳不算「正在运行」；
 *  - 备份自检与 CLI 同源：坏 ZIP 必须给出非 OK 判定，而不是抛错或假装通过；
 *  - 磁盘体检覆盖全部子区，读不到的标 unreadable（绝不显示 0）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  checkWriteGates, cleanupDisk, collectVerifyResults, diskUsageDirsOf, exportOfflineBackup, isProcessAlive,
  planSnapshotRestore, readBackups, readDiskUsage, readLockState, readProfiles, readRescueStatus,
  readRunningInstances, readSnapshots, recoverStaleEnvironmentLock, repairSessions, stopProfile,
  unlockEncryptedBackup,
} from './actions.ts'

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-actions-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function existsAt(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function writeHeartbeat(root: string, name: string, pid: number, ageMs: number): Promise<void> {
  const dir = path.join(root, 'running')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify({
    schemaVersion: 1, name, pid, port: 3099,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: Date.now() - ageMs,
  }))
}

test('A-01 心跳：本进程 pid + 新鲜心跳 = 在跑；死 pid / 过期心跳都不算', async () => {
  await withTmp(async (tmp) => {
    await writeHeartbeat(tmp, 'web', process.pid, 0)
    await writeHeartbeat(tmp, 'dead', 999_999_999, 0)
    await writeHeartbeat(tmp, 'stale', process.pid, 10 * 60_000)

    const alive = await readRunningInstances([tmp])
    assert.deepEqual(alive.map((entry) => entry.name), ['web'], '只有「pid 存活且心跳未过期」的算在跑')
    assert.equal(alive[0]!.port, 3099)
  })
})

test('A-02 候选根：心跳只在候选根下被找到（不再写死快照目录）', async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, 'dsh-config-manager')
    await writeHeartbeat(root, 'web', process.pid, 0)
    const missing = await readRunningInstances([path.join(tmp, 'nowhere')])
    assert.deepEqual(missing, [], '候选根里没有心跳目录 → 视为没有实例在跑')
    const found = await readRunningInstances([root])
    assert.equal(found.length, 1)
  })
})

test('A-03 isProcessAlive：本进程存活；不存在的 pid 不存活', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999_999_999), false)
})

test('A-04 备份自检：坏 ZIP 得到非 OK 判定（不抛错、不假装通过）', async () => {
  await withTmp(async (tmp) => {
    await fs.writeFile(path.join(tmp, 'broken.zip'), Buffer.from('definitely not a zip'))
    const outcome = await collectVerifyResults(tmp)
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.results.length, 1)
    assert.notEqual(outcome.results[0]!.verdict, 'OK')
  })
})

test('A-05 备份自检：空目录 / 不存在的目录 → 如实报错（不是「全部通过」）', async () => {
  await withTmp(async (tmp) => {
    const empty = path.join(tmp, 'empty')
    await fs.mkdir(empty)
    const none = await collectVerifyResults(empty)
    assert.equal(none.ok, false)

    const missing = await collectVerifyResults(path.join(tmp, 'missing'))
    assert.equal(missing.ok, false)
  })
})

test('A-06 快照 / 备份产物列表：目录不存在时返回空数组（不抛错）', async () => {
  await withTmp(async (tmp) => {
    assert.deepEqual(await readSnapshots(path.join(tmp, 'snapshots')), [])
    assert.deepEqual(await readBackups(path.join(tmp, 'exports')), [])
  })
})

test('A-07 磁盘体检：覆盖全部子区；读不到的子区标 unreadable，不显示为 0', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    await fs.mkdir(path.join(dataDir, 'exports'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'exports', 'a.zip'), Buffer.alloc(2048))
    const report = await readDiskUsage(dataDir)
    assert.equal(report.totalBytes >= 2048, true, '统计到导出目录的体积')
    assert.equal(report.areas.exports.unreadable, false)
    assert.equal(report.areas.snapshots.unreadable, true, '不存在的子区必须如实标未统计')
    assert.equal(report.areas.exports.policy, 'retained')
    assert.equal(diskUsageDirsOf('/x').exportsDir, path.join('/x', 'exports'))
  })
})

test('A-08 环境锁：没有 ownership 文件时是 NONE（只读，不创建任何东西）', async () => {
  await withTmp(async (tmp) => {
    const locksDir = path.join(tmp, 'locks')
    const report = await readLockState(locksDir)
    assert.equal(report.present, false)
    assert.equal(report.state, 'NONE')
    await assert.rejects(fs.stat(locksDir), '只读检查不得创建锁目录')
  })
})

test('A-09 首页聚合：缺目录不是错误，逐项读失败要在 errors 里可见', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    const status = await readRescueStatus({
      homeDir: tmp,
      dataDir,
      snapshotsDir: path.join(dataDir, 'snapshots'),
      exportsDir: path.join(dataDir, 'exports'),
      locksDir: path.join(dataDir, 'locks'),
      controlRoots: [dataDir],
      profile: 'web',
    })
    assert.deepEqual(status.snapshots, [])
    assert.deepEqual(status.backups, [])
    assert.deepEqual(status.instances, [])
    assert.equal(status.lock.state, 'NONE')
    assert.equal(status.safeMode.length, 1)
    assert.equal(status.safeMode[0]!.state, 'clear', '没有标记 = clear（不得把正常路径当成阻断）')
    assert.deepEqual(status.errors, [])
    assert.equal(Number.isNaN(Date.parse(status.generatedAt)), false)
  })
})

/* ------------------------------------------------------------ 写动作用例（阶段 2） */

async function writeHeartbeatFor(root: string, name: string, pid: number): Promise<void> {
  const dir = path.join(root, 'running')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify({
    schemaVersion: 1, name, pid, port: null, startedAt: new Date().toISOString(), updatedAt: Date.now(),
  }))
}

/** 造一个「位置与 header cwd 不一致」的会话（修复计划里会出现 move）。 */
async function seedMisplacedSession(home: string): Promise<void> {
  const { encodeZstdFrame } = await import('../utils/zstd-frame.ts')
  const dir = path.join(home, 'sessions', '--D-Ghost-proj--', 'session-x')
  await fs.mkdir(dir, { recursive: true })
  const log = Buffer.concat([
    encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-x', cwd: 'D:/Real/proj' }) + '\n', 'utf8')),
    encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
  ])
  await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), log)
}

test('W2-01 写门：SAFE MODE 激活时拒绝（且不进任何写路径）', async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, 'root')
    await fs.mkdir(path.join(root, 'transactions'), { recursive: true })
    await fs.writeFile(path.join(root, 'transactions', 'safe-mode'), 'blocked')
    const gate = await checkWriteGates([root])
    assert.equal(gate.ok, false)
    if (gate.ok) return
    assert.equal(gate.code, 'safe-mode')
    assert.match(gate.reason, /SAFE MODE/)
  })
})

test('W2-02 写门：SAFE MODE 状态不可判定（布局被挡）→ 同样拒绝（fail-closed）', async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, 'root')
    await fs.mkdir(root, { recursive: true })
    // transactions 被占成普通文件：无法判定 → 必须拒绝，绝不「读不到就放行」
    await fs.writeFile(path.join(root, 'transactions'), 'not a directory')
    const gate = await checkWriteGates([root])
    assert.equal(gate.ok, false)
    if (gate.ok) return
    assert.match(gate.reason, /无法判定/)
  })
})

test('W2-03 写门：DSH 在跑 → 拒绝（改写会话字节的前提是它已停）', async () => {
  await withTmp(async (tmp) => {
    const root = path.join(tmp, 'root')
    await writeHeartbeatFor(root, 'web', process.pid)
    const gate = await checkWriteGates([root], { needsDshStopped: true })
    assert.equal(gate.ok, false)
    if (gate.ok) return
    assert.equal(gate.code, 'dsh-running')
    // 不需要停 DSH 的动作（清理缓存）不受这条影响
    const relaxed = await checkWriteGates([root], { needsDshStopped: false })
    assert.equal(relaxed.ok, true)
  })
})

test('W2-04 写门：干净环境放行', async () => {
  await withTmp(async (tmp) => {
    const gate = await checkWriteGates([path.join(tmp, 'nothing-here')])
    assert.equal(gate.ok, true)
  })
})

test('W2-05 会话修复：dry-run 零写入、给出可执行步骤；fix 但 DSH 在跑 → 拒绝且不写', async () => {
  await withTmp(async (tmp) => {
    const home = path.join(tmp, 'home')
    await seedMisplacedSession(home)
    const controlRoots = [path.join(tmp, 'root')]
    const planned = await repairSessions({ home, fix: false }, controlRoots)
    assert.equal(planned.dryRun, true)
    assert.equal(planned.needsAttention, true, '错位会话必须出现在计划里')
    assert.equal(planned.steps.some((s) => s.kind === 'move'), true)
    assert.equal(await existsAt(path.join(home, 'sessions', '--D-Ghost-proj--', 'session-x')), true, 'dry-run 不得搬任何目录')
    const movedDir = path.join(home, 'sessions', '--D-Real-proj--', 'session-x')
    assert.equal(await existsAt(movedDir), false, 'dry-run 不得产生目标目录')

    // 心跳落在候选根里 → fix 必须被拒绝
    await writeHeartbeatFor(controlRoots[0]!, 'web', process.pid)
    const refused = await repairSessions({ home, fix: true }, controlRoots)
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /DSH 正在运行/)
    assert.equal(await existsAt(path.join(home, 'sessions', '--D-Ghost-proj--', 'session-x')), true, '被拒绝时一个字节都不许动')
  })
})

test('W2-06 会话修复：无实例在跑时 fix 真的归位（与 CLI 同一实现）', async () => {
  await withTmp(async (tmp) => {
    const home = path.join(tmp, 'home')
    await seedMisplacedSession(home)
    const result = await repairSessions({ home, fix: true }, [path.join(tmp, 'root')])
    assert.equal(result.ok, true, result.error ?? '')
    assert.equal(await existsAt(path.join(home, 'sessions', '--D-Real-proj--', 'session-x')), true, '按 header cwd 归位')
    assert.equal(await existsAt(path.join(home, 'sessions', '--D-Ghost-proj--', 'session-x')), false)
    assert.equal(result.done.length > 0, true, '如实回执：做了什么要能读出来')
  })
})

test('W2-07 磁盘清理：只清勾选的分区；未勾选导出产物时一个导出文件都不碰', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'data')
    const exportsDir = path.join(dataDir, 'exports')
    await fs.mkdir(path.join(dataDir, 'tmp'), { recursive: true })
    await fs.mkdir(exportsDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'tmp', 'leftover.zip'), Buffer.alloc(1024))
    // 一个「早已过期」的导出产物：没勾 expiredExports 就不许动它
    const backup = path.join(exportsDir, 'dsh-config-cli-old.zip')
    await fs.writeFile(backup, Buffer.alloc(2048))
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await fs.utimes(backup, past, past)

    const onlyCaches = await cleanupDisk(dataDir, exportsDir, { caches: true, expiredExports: false })
    assert.equal(onlyCaches.removed > 0, true, '缓存区应被清掉')
    assert.equal(await existsAt(backup), true, '没勾导出产物 → 一个都不许删')
    assert.equal(await existsAt(path.join(dataDir, 'tmp', 'leftover.zip')), false)

    const nothing = await cleanupDisk(dataDir, exportsDir, { caches: false, expiredExports: false })
    assert.equal(nothing.ok, false)
    assert.match(nothing.error ?? '', /没有勾选/)
  })
})

test('W2-08 残留锁回收：没有锁文件时如实失败（不谎报成功）', async () => {
  await withTmp(async (tmp) => {
    const locksDir = path.join(tmp, 'locks')
    const result = await recoverStaleEnvironmentLock(locksDir, path.join(tmp, 'data'))
    assert.equal(result.ok, false)
    assert.equal(result.removed, false)
  })
})

test('W3-01 停止：心跳指向本进程时必须拒绝（绝不能自己把自己杀掉）', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    await fs.mkdir(path.join(dataDir, 'running'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'running', 'web.json'), JSON.stringify({
      schemaVersion: 1, name: 'web', pid: process.pid, port: 3000,
      startedAt: new Date().toISOString(), updatedAt: Date.now(),
    }))
    const result = await stopProfile({
      homeDir: tmp,
      dataDir,
      snapshotsDir: path.join(dataDir, 'snapshots'),
      exportsDir: path.join(dataDir, 'exports'),
      locksDir: path.join(dataDir, 'locks'),
      controlRoots: [dataDir],
      profile: 'web',
    }, 'web')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'currentProfile')
  })
})

test('W3-02 档案列表：死心跳不算「在跑」，且每个不可启动档案都带原因', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    const profilesDir = path.join(tmp, 'profiles')
    for (const [name, bundles] of [['cmweb', ['@deepseek-ai/dsh-web-app']], ['cmbase', []], ['desktop', ['@deepseek-ai/dsh-web-app']]] as const) {
      await fs.mkdir(path.join(profilesDir, name), { recursive: true })
      await fs.writeFile(path.join(profilesDir, name, 'package.json'), JSON.stringify({
        name: 'p-' + name, version: '0.0.0', dependencies: {}, dsh: { profile: { bundles } },
      }))
    }
    await fs.mkdir(path.join(dataDir, 'running'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'running', 'cmweb.json'), JSON.stringify({
      schemaVersion: 1, name: 'cmweb', pid: 999999999, port: 3000, startedAt: '', updatedAt: Date.now(),
    }))
    const outcome = readProfiles({
      homeDir: tmp, dataDir,
      snapshotsDir: path.join(dataDir, 'snapshots'),
      exportsDir: path.join(dataDir, 'exports'),
      locksDir: path.join(dataDir, 'locks'),
      controlRoots: [dataDir],
      profile: 'web',
    })
    const byName = new Map(outcome.rows.map((row) => [row.name, row]))
    assert.equal(byName.get('cmweb')!.running, false, '死 pid 不算在跑')
    assert.equal(byName.get('cmweb')!.launchable, true)
    assert.equal(byName.get('cmbase')!.launchable, false)
    assert.match(byName.get('cmbase')!.launchBlockedReason!, /不是 web 形态/)
    assert.equal(byName.get('desktop')!.launchable, false, 'desktop 是 Electron 独占档案')
    assert.match(byName.get('desktop')!.launchBlockedReason!, /桌面端/)
  })
})

test('V-F4 磁盘体检：路径存在但不是目录 → 未统计（不是 0 字节）', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    await fs.mkdir(dataDir, { recursive: true })
    // exports 被普通文件占住（ENOTDIR），snapshots 真不存在 —— 两者都必须是「未统计」
    await fs.writeFile(path.join(dataDir, 'exports'), 'not a directory')
    const report = await readDiskUsage(dataDir)
    assert.equal(report.areas.exports.unreadable, true, '被占住 ≠ 0 字节')
    assert.equal(report.areas.snapshots.unreadable, true, '不存在同样是未统计')
  })
})

test('V-F5 修复计划：仅报告的步骤不算「可执行」（applies 由 planner 语义决定）', async () => {
  await withTmp(async (tmp) => {
    const home = path.join(tmp, 'home')
    // 造一个「加锁」的会话：planner 只会报告（skip/locked），不可执行
    const dir = path.join(home, 'sessions', '--D-Ghost-proj--', 'session-locked')
    await fs.mkdir(dir, { recursive: true })
    const { encodeZstdFrame } = await import('../utils/zstd-frame.ts')
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
      encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-locked', cwd: 'D:/Real/proj' }) + '\n', 'utf8')),
      encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
    ]))
    await fs.writeFile(path.join(dir, 'session.lock'), 'lock')
    const plan = await repairSessions({ home, fix: false }, [path.join(tmp, 'root')])
    assert.equal(plan.needsAttention, true, '锁住的会话仍需人工处理')
    assert.equal(plan.steps.some((step) => step.applies), false, '仅报告的步骤不得算作可执行')
  })
})

/* ------------------------------------------------------------ 阶段 4：解锁 / 恢复 / 导出 */

test('V4-01 离线导出：真的产出 ZIP 并自检通过；不可收集的分区如实列出', async () => {
  await withTmp(async (tmp) => {
    const home = path.join(tmp, 'home')
    // 造一个离线可收集的分区：skills
    await fs.mkdir(path.join(home, 'skills', 'demo'), { recursive: true })
    await fs.writeFile(path.join(home, 'skills', 'demo', 'SKILL.md'), '# demo\n')
    const dataDir = path.join(home, 'dsh-config-manager')
    const paths = {
      homeDir: home, dataDir,
      snapshotsDir: path.join(dataDir, 'snapshots'),
      exportsDir: path.join(dataDir, 'exports'),
      locksDir: path.join(dataDir, 'locks'),
      controlRoots: [dataDir],
      profile: 'web',
    }
    const result = await exportOfflineBackup(paths, ['skills'])
    assert.equal(result.ok, true, result.message)
    assert.ok(result.outPath !== undefined)
    assert.equal(await existsAt(result.outPath!), true, '产物必须落盘')
    assert.equal((result.entryCount ?? 0) > 0, true)
    assert.equal((result.unavailableSections ?? []).includes('settings'), true, '离线不可收集的分区必须如实列出')
  })
})

test('V4-02 解锁：非加密文件如实报 not-encrypted（绝不谎报解锁成功）', async () => {
  await withTmp(async (tmp) => {
    const exportsDir = path.join(tmp, 'exports')
    await fs.mkdir(exportsDir, { recursive: true })
    await fs.writeFile(path.join(exportsDir, 'plain.zip'), 'not a container')
    const result = await unlockEncryptedBackup(exportsDir, 'plain.zip', 'pw')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-encrypted')
    assert.match(result.message, /不是本插件产出的加密容器/)
    const missing = await unlockEncryptedBackup(exportsDir, 'nope.zip', 'pw')
    assert.equal(missing.code, 'not-found')
    const empty = await unlockEncryptedBackup(exportsDir, 'plain.zip', '')
    assert.equal(empty.code, 'bad-password')
  })
})

test('V4-03 恢复计划：不存在的快照 → 如实失败（不抛错、不假装有计划）', async () => {
  await withTmp(async (tmp) => {
    const dataDir = path.join(tmp, 'dsh-config-manager')
    const paths = {
      homeDir: tmp, dataDir,
      snapshotsDir: path.join(dataDir, 'snapshots'),
      exportsDir: path.join(dataDir, 'exports'),
      locksDir: path.join(dataDir, 'locks'),
      controlRoots: [dataDir],
      profile: 'web',
    }
    const plan = await planSnapshotRestore(paths, 'missing-snapshot')
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'plan-failed')
  })
})
