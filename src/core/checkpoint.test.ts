/**
 * C-1 Q4 三态同点检查点单测。
 *
 * 纪律（与本仓既有 core 测试同款）：**真实临时目录**（os.tmpdir + fs.mkdtemp）+ 真实读写，
 * 不 mock 文件系统 —— 本模块的正确性几乎全在「路径门 / 原子写 / 指纹 / 绝不删除」上，
 * 只有真盘能证明。
 *
 * 覆盖（对应验收条件）：
 *  - 三态各自可捕获 + 每态 capturedAt 与指纹 + 同点可核验（T1 / T11 / T13）
 *  - 单命令回滚可用（三态覆盖恢复）+ 覆盖恢复绝不删除（T2）
 *  - 安全门：fail-closed 确认（T3）、保护检查点不可回滚/不可删/不被清理（T4 / T14）、
 *    不完整记录缺省拒绝（T5）、记录不可成为写原语（T9）、会话静止期（T8）、
 *    逐段失败语义（T7）
 *  - 存储栈缺失仍可挂载并给结构化指引、不崩溃（T6 / T12）
 *  - 降级不静默：链接跳过与截断（T15）、分块不可用（T16）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CheckpointEngine,
  CHECKPOINT_DEFAULT_CONFIG_FILES,
  CHECKPOINT_DEFAULT_SAME_POINT_TOLERANCE_MS,
  isInsidePath,
  samePointVerdictOf,
  summarizeCheckpoint,
  type CheckpointEngineOptions,
  type CheckpointRecord,
} from './checkpoint.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { SELF_CONFIG_FILES } from '../adapters/self.ts'

/* --------------------------------------------------------------- fixture */

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  sessionsDir: string
  unitDir: string
  logFile: string
  workspaceDir: string
  configFile: string
  cleanup: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-checkpoint-'))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const sessionsDir = path.join(homeDir, 'sessions')
  const unitDir = path.join(sessionsDir, 'proj-key', 'session-1111')
  const workspaceDir = path.join(root, 'ws')
  const logFile = path.join(unitDir, 'session-1111.jsonl.zstd')
  const configFile = path.join(dataDir, 'sync', 'sync-config.json')
  await fs.mkdir(unitDir, { recursive: true })
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true })
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.writeFile(logFile, 'frame-one')
  await fs.writeFile(path.join(workspaceDir, 'a.txt'), 'A1')
  await fs.writeFile(path.join(workspaceDir, 'src', 'b.txt'), 'B1')
  await fs.writeFile(configFile, '{"schemaVersion":1,"channel":"git"}')
  return {
    root, homeDir, dataDir, sessionsDir, unitDir, logFile, workspaceDir, configFile,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
  }
}

function makeEngine(fx: Fixture, overrides: Partial<CheckpointEngineOptions> = {}): CheckpointEngine {
  return new CheckpointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0, ...overrides })
}

async function captureFull(engine: CheckpointEngine, fx: Fixture, extra: Record<string, unknown> = {}) {
  return await engine.capture({
    chunks: [fx.workspaceDir],
    sessionLogPath: fx.logFile,
    sessionId: 'session-1111',
    ...extra,
  })
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8')
}

async function objectExists(engine: CheckpointEngine, sha: string): Promise<boolean> {
  try {
    await fs.access(path.join(engine.storeDir, 'objects', sha))
    return true
  } catch {
    return false
  }
}

/** 递增时钟：让 capturedAt 三态可分辨（证明「同一次调用内顺序捕获」）。 */
function steppingClock(start: number, step: number): () => number {
  let value = start - step
  return () => { value += step; return value }
}

/* ------------------------------------------------- T1 三态捕获 + 同点 */

test('T1 三态各自可捕获：每态 capturedAt + 指纹 + 同点可核验', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 10) })

  const res = await captureFull(engine, fx)
  assert.equal(res.ok, true, res.detail ?? res.code)
  const record = res.record
  assert.ok(record !== undefined)
  assert.equal(res.spreadMs, 20)

  // 三态都捕上、都有指纹
  for (const track of [record.session, record.workspace, record.config]) {
    assert.equal(track.ok, true, track.kind)
    assert.equal(typeof track.fingerprint, 'string', track.kind)
    assert.ok((track.fingerprint ?? '').length >= 32, track.kind)
    assert.equal(track.capturedAt > 0, true, track.kind)
  }
  // 捕获顺序 = W5 建议（会话 → 工作区 → 配置），capturedAt 非回退
  assert.ok(record.session.capturedAt <= record.workspace.capturedAt)
  assert.ok(record.workspace.capturedAt <= record.config.capturedAt)

  // 工作区：两个文件都进仓，指纹 = 内容 SHA-256
  const wsPayload = record.workspace.payload
  assert.ok(wsPayload !== null)
  assert.equal(wsPayload.files.length, 2)
  const aFile = wsPayload.files.find((f) => f.path.endsWith('a.txt'))
  assert.ok(aFile !== undefined)
  assert.equal(aFile.sha256, sha256Hex('A1'))
  assert.equal(aFile.chunk, path.resolve(fx.workspaceDir))
  assert.equal(await objectExists(engine, aFile.object), true)

  // 配置：白名单里存在的那个有 fingerprintKind=content，其余 existed=false（不静默）
  const cfgPayload = record.config.payload
  assert.ok(cfgPayload !== null)
  const cfg = cfgPayload.files.find((f) => f.relPath === 'sync/sync-config.json')
  assert.ok(cfg !== undefined)
  assert.equal(cfg.existed, true)
  assert.equal(cfg.sha256, sha256Hex('{"schemaVersion":1,"channel":"git"}'))
  assert.equal(cfgPayload.files.length, CHECKPOINT_DEFAULT_CONFIG_FILES.length)

  // 会话游标 = 日志字节长度
  const sessionPayload = record.session.payload
  assert.ok(sessionPayload !== null)
  assert.equal(sessionPayload.cursorBytes, 9)
  assert.equal(sessionPayload.fingerprint, sha256Hex('frame-one'))

  // 同点 = 可核验事实
  const verdict = samePointVerdictOf(record)
  assert.equal(verdict.samePoint, true)
  assert.equal(verdict.reason, 'ok')
  assert.ok(verdict.spreadMs <= CHECKPOINT_DEFAULT_SAME_POINT_TOLERANCE_MS)

  // 列表：只回摘要（含三态指纹），不回大载荷
  const list = await engine.list()
  assert.equal(list.records.length, 1)
  const summary = list.records[0]
  assert.ok(summary !== undefined)
  assert.equal(summary.tracks.length, 3)
  const wsTrack = summary.tracks.find((x) => x.state === 'workspace')
  assert.equal(wsTrack?.entries, 2)
  const sessionTrack = summary.tracks.find((x) => x.state === 'session')
  assert.equal(sessionTrack?.cursorBytes, 9)
  assert.equal(sessionTrack?.restorable, true)
})

/* ------------------------------------------------- T2 三态回滚 + 不删 */

test('T2 单命令回滚：三态覆盖恢复 + 检查点之后新建的内容绝不删除', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)

  const captured = await captureFull(engine, fx)
  assert.equal(captured.ok, true)
  const id = captured.record?.id ?? ''
  assert.notEqual(id, '')

  // 检查点之后：改内容、加新文件、改配置、追加会话日志
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  await fs.writeFile(path.join(fx.workspaceDir, 'src', 'b.txt'), 'B2')
  await fs.writeFile(path.join(fx.workspaceDir, 'new.txt'), 'NEW')
  await fs.writeFile(fx.configFile, '{"schemaVersion":2,"channel":"webdav"}')
  await fs.appendFile(fx.logFile, 'frame-two')

  const rewind = await engine.rewind({ id, confirm: true })
  assert.equal(rewind.outcome, 'restored', JSON.stringify(rewind.segments))
  assert.equal(rewind.ok, true)
  assert.equal(rewind.code, 'ok')

  // 覆盖恢复：三态都回到捕获时
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
  assert.equal(await readText(path.join(fx.workspaceDir, 'src', 'b.txt')), 'B1')
  assert.equal(await readText(fx.configFile), '{"schemaVersion":1,"channel":"git"}')
  assert.equal(await readText(fx.logFile), 'frame-one')

  const wsSegment = rewind.segments.find((s) => s.state === 'workspace')
  const cfgSegment = rewind.segments.find((s) => s.state === 'config')
  const sessionSegment = rewind.segments.find((s) => s.state === 'session')
  assert.equal(wsSegment?.status, 'restored')
  assert.equal(wsSegment?.restored, 2)
  assert.equal(cfgSegment?.status, 'restored')
  assert.equal(sessionSegment?.status, 'restored')

  // 绝不删除：检查点之后新建的文件仍在，且被如实报告
  assert.equal(await readText(path.join(fx.workspaceDir, 'new.txt')), 'NEW')
  assert.ok((wsSegment?.leftovers ?? []).some((p) => p.endsWith('new.txt')))

  // guard 保护点自动产生（回滚前拍当前状态）
  const guardId = rewind.guardCheckpointId
  assert.ok(guardId !== undefined)
  const list = await engine.list()
  assert.equal(list.records.length, 2)
  const guard = list.records.find((r) => r.id === guardId)
  assert.equal(guard?.kind, 'guard')
})

/* ------------------------------------------------- T3 fail-closed 确认 */

test('T3 确认门 fail-closed：confirm 不恰好为 true 一律拒绝且零写入', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const id = captured.record?.id ?? ''
  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')

  const badInputs: unknown[] = [undefined, null, false, 'true', 1, 0]
  for (const bad of badInputs) {
    const rewind = await engine.rewind({ id, confirm: bad as boolean, guardPolicy: 'off' })
    assert.equal(rewind.outcome, 'denied', String(bad))
    assert.equal(rewind.code, 'confirmation-required', String(bad))
    assert.equal(rewind.segments.length, 0, String(bad))
  }
  // 零写入：文件没被恢复，也没有产生 guard 点
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')
  const list = await engine.list()
  assert.equal(list.records.length, 1)
})

/* ------------------------------------------------- T4 保护检查点 */

test('T4 保护检查点：不可回滚 + 不可删除 + 不被自动清理', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { maxRecords: 1 })
  const captured = await captureFull(engine, fx, { protect: true })
  const record = captured.record
  assert.ok(record !== undefined)
  assert.equal(record.protected, true)

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const rewind = await engine.rewind({ id: record.id, confirm: true, guardPolicy: 'off' })
  assert.equal(rewind.outcome, 'denied')
  assert.equal(rewind.code, 'protected-checkpoint')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  const remove = await engine.remove(record.id)
  assert.equal(remove.ok, false)
  assert.equal(remove.code, 'protected-checkpoint')

  // 自动清理绝不淘汰保护点（maxRecords=1，两个普通点都被挤掉）
  const second = await captureFull(engine, fx, { note: 'plain-1' })
  const third = await captureFull(engine, fx, { note: 'plain-2' })
  assert.equal(second.ok, true)
  assert.equal(third.ok, true)
  const list = await engine.list()
  const ids = list.records.map((r) => r.id)
  assert.ok(ids.includes(record.id))
  assert.equal(ids.length, 1)
})

/* ------------------------------------------------- T5 不完整记录 */

test('T5 三态不全（缺会话输入）→ 缺省拒绝回滚；allowPartial 才放行', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await engine.capture({ chunks: [fx.workspaceDir] })
  const record = captured.record
  assert.ok(record !== undefined)
  assert.equal(record.incomplete, true)
  assert.equal(record.session.ok, false)
  assert.equal(record.session.reasonCode, 'no-session-input')
  assert.equal(samePointVerdictOf(record).reason, 'incomplete')

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const denied = await engine.rewind({ id: record.id, confirm: true, guardPolicy: 'off' })
  assert.equal(denied.outcome, 'denied')
  assert.equal(denied.code, 'record-incomplete')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  const partial = await engine.rewind({ id: record.id, confirm: true, allowPartial: true, segments: ['workspace'], guardPolicy: 'off' })
  assert.equal(partial.outcome, 'restored')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
})

/* ------------------------------------------------- T6 存储栈缺失 */

test('T6 存储栈缺失：不抛错、结构化组合指引、各接口都能给结论', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { storage: async () => ({ ok: false, detail: 'EACCES: permission denied' }) })

  const status = await engine.storageStatus()
  assert.equal(status.available, false)
  assert.equal(status.detail, 'EACCES: permission denied')
  assert.ok(status.requirements.includes('@deepseek-ai/dsh-storage'))
  const codes = status.guidance.map((g) => g.code)
  assert.ok(codes.includes('checkpoint.guidance.mountStorage'))
  assert.ok(codes.includes('checkpoint.guidance.fixDataDir'))
  assert.ok(codes.includes('checkpoint.guidance.readOnlyFallback'))

  const captured = await captureFull(engine, fx)
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'storage-unavailable')
  assert.ok(captured.guidance.length > 0)

  const rewind = await engine.rewind({ id: 'cp-x', confirm: true })
  assert.equal(rewind.outcome, 'failed')
  assert.equal(rewind.code, 'storage-unavailable')

  const list = await engine.list()
  assert.equal(list.storage.available, false)
  assert.equal(list.records.length, 0)

  const preview = await engine.preview('cp-x')
  assert.equal(preview.ok, false)
  assert.equal(preview.code, 'storage-unavailable')

  const remove = await engine.remove('cp-x')
  assert.equal(remove.ok, false)

  // 探针自己抛异常也不能把调用方炸掉
  const throwing = makeEngine(fx, { storage: async () => { throw new Error('probe exploded') } })
  const thrown = await throwing.storageStatus()
  assert.equal(thrown.available, false)
  assert.equal(thrown.detail, 'probe exploded')
})

/* ------------------------------------------------- T7 逐段失败语义 */

test('T7 工作区失败 → 中止后续段（不写配置、不动会话）+ 失败可诊断', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const record = captured.record
  assert.ok(record !== undefined)
  const aFile = record.workspace.payload?.files.find((f) => f.path.endsWith('a.txt'))
  assert.ok(aFile !== undefined)

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  await fs.writeFile(fx.configFile, '{"schemaVersion":2}')
  await fs.appendFile(fx.logFile, 'frame-two')

  // 破坏对象仓里的那条内容 → 该条写回必然失败
  await fs.rm(path.join(engine.storeDir, 'objects', aFile.object), { force: true })

  const rewind = await engine.rewind({ id: record.id, confirm: true })
  assert.equal(rewind.outcome, 'failed')
  assert.equal(rewind.code, 'restore-failed')
  const wsSegment = rewind.segments.find((s) => s.state === 'workspace')
  assert.equal(wsSegment?.status, 'failed')
  assert.ok((wsSegment?.detail ?? []).some((line) => line.includes('a.txt')))
  assert.deepEqual(rewind.skippedSegments, ['config', 'session'])
  assert.ok(rewind.guidance.some((g) => g.code === 'checkpoint.guidance.workspacePartial'))

  // 中止的段确实没被写
  assert.equal(await readText(fx.configFile), '{"schemaVersion":2}')
  assert.equal(await readText(fx.logFile), 'frame-oneframe-two')
})

/* ------------------------------------------------- T8 会话静止期 */

test('T8 会话静止期门：正在写的会话拒绝覆盖（fail-closed）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 真实时钟 + 缺省 30s 静止期
  const engine = new CheckpointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir })
  const captured = await captureFull(engine, fx)
  const record = captured.record
  assert.ok(record !== undefined)

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  await fs.appendFile(fx.logFile, 'frame-two')

  const rewind = await engine.rewind({ id: record.id, confirm: true })
  const sessionSegment = rewind.segments.find((s) => s.state === 'session')
  assert.equal(sessionSegment?.status, 'failed')
  assert.equal(sessionSegment?.reasonCode, 'session-active')
  assert.equal(rewind.outcome, 'partial')
  assert.equal(await readText(fx.logFile), 'frame-oneframe-two')
  // 工作区仍然恢复了（逐段独立）
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A1')
})

/* ------------------------------------------------- T9 记录不可成为写原语 */

test('T9 记录被篡改不能变成写原语：路径越界 / 指纹不符一律拒绝该条', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const record = captured.record
  assert.ok(record !== undefined)
  const ledgerPath = path.join(engine.storeDir, 'index.json')
  const ledger = JSON.parse(await readText(ledgerPath)) as { records: CheckpointRecord[] }

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2')
  const outside = path.join(fx.root, 'outside.txt')
  await fs.writeFile(outside, 'SAFE')

  // 篡改 1：把记录里的路径改成分块之外的文件（分块仍是 workspaceDir）
  const tampered = JSON.parse(JSON.stringify(ledger)) as { records: CheckpointRecord[] }
  const wsFiles = tampered.records[0]?.workspace.payload?.files ?? []
  const target = wsFiles.find((f) => f.path.endsWith('a.txt'))
  assert.ok(target !== undefined)
  target.path = outside
  await fs.writeFile(ledgerPath, JSON.stringify(tampered, null, 2))
  const rewind1 = await engine.rewind({ id: record.id, confirm: true, guardPolicy: 'off' })
  assert.equal(rewind1.outcome, 'failed')
  assert.equal(rewind1.segments[0]?.state, 'workspace')
  assert.ok((rewind1.segments[0]?.detail ?? []).some((line) => line.startsWith('invalid-path')))
  assert.equal(await readText(outside), 'SAFE')
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')

  // 篡改 2：路径合法但声明的内容指纹不符 → 拒绝写该条
  const tampered2 = JSON.parse(JSON.stringify(ledger)) as { records: CheckpointRecord[] }
  const wsFiles2 = tampered2.records[0]?.workspace.payload?.files ?? []
  const target2 = wsFiles2.find((f) => f.path.endsWith('a.txt'))
  assert.ok(target2 !== undefined)
  target2.sha256 = sha256Hex('NOT-THE-CAPTURED-CONTENT')
  await fs.writeFile(ledgerPath, JSON.stringify(tampered2, null, 2))
  const rewind2 = await engine.rewind({ id: record.id, confirm: true, guardPolicy: 'off' })
  assert.equal(rewind2.outcome, 'failed')
  assert.ok((rewind2.segments[0]?.detail ?? []).some((line) => line.includes('object-hash-mismatch')))
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2')
})

/* ------------------------------------------------- T10 预览零写入 */

test('T10 preview 零写入：只读影响面（改动 / 缺失 / 遗留）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const id = captured.record?.id ?? ''

  await fs.writeFile(path.join(fx.workspaceDir, 'a.txt'), 'A2-A-LONGER-CONTENT')
  await fs.writeFile(path.join(fx.workspaceDir, 'new.txt'), 'NEW')
  await fs.writeFile(fx.configFile, '{"schemaVersion":2}')
  await fs.appendFile(fx.logFile, 'frame-two')

  const preview = await engine.preview(id)
  assert.equal(preview.ok, true)
  assert.equal(preview.samePoint?.samePoint, true)
  assert.equal(preview.summary?.tracks.length, 3)
  const ws = preview.segments.find((s) => s.state === 'workspace')
  assert.equal(ws?.planned, 2)
  assert.equal(ws?.changed, 1)
  assert.equal(ws?.missing, 0)
  assert.ok((ws?.leftovers ?? []).some((p) => p.endsWith('new.txt')))
  const cfg = preview.segments.find((s) => s.state === 'config')
  assert.equal(cfg?.planned, 1)
  assert.equal(cfg?.changed, 1)
  const session = preview.segments.find((s) => s.state === 'session')
  assert.equal(session?.cursorTarget, 9)
  assert.equal(session?.cursorNow, 18)
  assert.equal(session?.changed, 1)

  // 零写入
  assert.equal(await readText(path.join(fx.workspaceDir, 'a.txt')), 'A2-A-LONGER-CONTENT')
  assert.equal(await readText(fx.configFile), '{"schemaVersion":2}')
  assert.equal(await readText(fx.logFile), 'frame-oneframe-two')
  const list = await engine.list()
  assert.equal(list.records.length, 1)
})

/* ------------------------------------------------- T11 同点判定的跨度 */

test('T11 同点判定：跨度超容差不再算同点（诚实标注）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // createdAt / session / workspace 同刻，config 晚 10s（> 缺省容差 5s）
  let calls = 0
  const engine = makeEngine(fx, {
    now: () => { calls += 1; return calls < 4 ? 2_000_000 : 2_010_000 },
  })
  const captured = await captureFull(engine, fx)
  const record = captured.record
  assert.ok(record !== undefined)
  assert.equal(captured.spreadMs, 10_000)
  const verdict = samePointVerdictOf(record)
  assert.equal(verdict.samePoint, false)
  assert.equal(verdict.reason, 'spread')
  // 放宽容差即算同点
  assert.equal(samePointVerdictOf(record, 20_000).samePoint, true)
})

/* ------------------------------------------------- T12 台账损坏不崩 */

test('T12 台账损坏：list 如实报错、捕获仍可继续（不崩、不静默）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  await fs.mkdir(engine.storeDir, { recursive: true })
  await fs.writeFile(path.join(engine.storeDir, 'index.json'), '{ broken-json')

  const list = await engine.list()
  assert.equal(list.storage.available, true)
  assert.equal(list.records.length, 0)
  assert.ok((list.error ?? '').includes('ledger unreadable'))

  const captured = await captureFull(engine, fx)
  assert.equal(captured.ok, true)
  const after = await engine.list()
  assert.equal(after.records.length, 1)
  assert.equal(after.error, undefined)
})

/* ------------------------------------------------- T13 白名单不漏项 */

test('T13 配置白名单与 self 分区同口径（不漏项）', () => {
  for (const rel of SELF_CONFIG_FILES) {
    assert.ok(CHECKPOINT_DEFAULT_CONFIG_FILES.includes(rel), rel)
  }
})

/* ------------------------------------------------- T14 删除 + 对象回收 */

test('T14 删除普通检查点（对象回收）；guard 点不可删', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  await fs.writeFile(path.join(fx.workspaceDir, 'uniq.txt'), 'UNIQ-DOOMED')
  const uniqSha = sha256Hex('UNIQ-DOOMED')
  const captured = await captureFull(engine, fx)
  const id = captured.record?.id ?? ''
  assert.equal(await objectExists(engine, uniqSha), true)

  const removed = await engine.remove(id)
  assert.equal(removed.ok, true)
  assert.equal((await engine.list()).records.length, 0)
  // 无人引用的对象被回收
  assert.equal(await objectExists(engine, uniqSha), false)

  // guard 点（回滚前自动拍）不可删
  const again = await captureFull(engine, fx)
  const rewind = await engine.rewind({ id: again.record?.id ?? '', confirm: true })
  const guardId = rewind.guardCheckpointId
  assert.ok(guardId !== undefined)
  const guardRemove = await engine.remove(guardId)
  assert.equal(guardRemove.ok, false)
  assert.equal(guardRemove.code, 'protected-checkpoint')

  const missing = await engine.remove('cp-does-not-exist')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'record-not-found')
})

/* ------------------------------------------------- T15 降级不静默 */

test('T15 降级不静默：截断 / 链接跳过都留痕（degraded + 原因码）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)

  // 1) maxFiles 截断
  const capped = makeEngine(fx, { maxFiles: 1 })
  const truncated = await captureFull(capped, fx)
  const truncatedTrack = truncated.record?.workspace
  assert.equal(truncatedTrack?.degraded, true)
  assert.equal(truncatedTrack?.reasonCode, 'capture-truncated')
  assert.equal(truncatedTrack?.payload?.files.length, 1)

  // 2) junction（Windows 无需管理员）不跟随但留痕
  const junction = path.join(fx.workspaceDir, 'link-in')
  try {
    await fs.symlink(path.join(fx.workspaceDir, 'src'), junction, 'junction')
  } catch {
    t.skip('本机不支持创建 junction')
    return
  }
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const track = captured.record?.workspace
  assert.equal(track?.ok, true)
  assert.equal(track?.degraded, true)
  assert.equal(track?.reasonCode, 'capture-degraded')
  assert.ok((track?.payload?.skipped ?? []).some((s) => s.reason === 'link' && s.path === junction))
  // 链接目标里的内容不被重复计入
  assert.equal((track?.payload?.files ?? []).some((f) => isInsidePath(f.path, junction)), false)
})

/* ------------------------------------------------- T16 分块不可用 */

test('T16 分块不可用 / 非绝对路径：该态结构化失败，其余态照常捕获', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)

  const missingChunk = await engine.capture({ chunks: [path.join(fx.root, 'nope')], sessionLogPath: fx.logFile })
  assert.equal(missingChunk.record?.workspace.ok, false)
  assert.equal(missingChunk.record?.workspace.reasonCode, 'chunk-not-found')
  assert.equal(missingChunk.record?.incomplete, true)
  assert.equal(missingChunk.ok, true) // 捕获动作本身成功（记录不完整由 incomplete 表达）

  const relative = await engine.capture({ chunks: ['relative/path'] })
  assert.equal(relative.record?.workspace.reasonCode, 'chunk-not-absolute')

  // 会话在会话根之外 → 拒绝（越界不猜）
  const outsideFile = path.join(fx.root, 'outside-log.jsonl.zstd')
  await fs.writeFile(outsideFile, 'x')
  const outOfRoot = await engine.capture({ chunks: [fx.workspaceDir], sessionLogPath: outsideFile })
  assert.equal(outOfRoot.record?.session.ok, false)
  assert.equal(outOfRoot.record?.session.reasonCode, 'session-out-of-root')

  // 不存在的会话日志 → session-missing
  const gone = await engine.capture({ chunks: [fx.workspaceDir], sessionLogPath: path.join(fx.unitDir, 'nope.jsonl.zstd') })
  assert.equal(gone.record?.session.reasonCode, 'session-missing')
})

/* ------------------------------------------------- T17 摘要纯函数 */

test('T17 summarizeCheckpoint：只回计数与指纹（不泄漏载荷）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const record = captured.record
  assert.ok(record !== undefined)
  const summary = summarizeCheckpoint(record)
  assert.equal(summary.id, record.id)
  assert.equal(summary.incomplete, false)
  assert.equal(summary.protected, false)
  assert.deepEqual(summary.tracks.map((x) => x.state), ['workspace', 'config', 'session'])
  assert.equal(JSON.stringify(summary).includes('A1'), false)
})

/* ------------------------------------------------- T18 会话分叉门 */

test('T18 会话分叉门：日志比捕获游标更短（被别的路径改写）→ 拒绝覆盖', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await captureFull(engine, fx)
  const id = captured.record?.id ?? ''

  // 不是「追加」而是被截断 / 换过内容（3 < 游标 9）
  await fs.writeFile(fx.logFile, 'fr')

  const rewind = await engine.rewind({ id, confirm: true, guardPolicy: 'off' })
  const sessionSegment = rewind.segments.find((s) => s.state === 'session')
  assert.equal(sessionSegment?.status, 'failed')
  assert.equal(sessionSegment?.reasonCode, 'session-diverged')
  assert.ok((sessionSegment?.detail ?? []).some((line) => line.includes('cursor=9')))
  assert.equal(rewind.outcome, 'partial')
  // 没写：短日志原样留着，绝不拿旧副本覆盖一段来历不明的历史
  assert.equal(await readText(fx.logFile), 'fr')
})
