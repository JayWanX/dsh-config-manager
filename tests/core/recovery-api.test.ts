/**
 * Phase 5 Recovery Orchestration 测试（§9）。
 * 覆盖：status/preview/confirm/execute/verify/retry/dismiss 编排；confirmation 强制；
 * authority（snapshotId 只来自 journal）；snapshot trust（wrong env/op/legacy/corrupt/unsafe）；
 * 并发（409 + RunKind）；状态机（NEEDS_ATTENTION→RECOVERING→terminal）；原子 verification+terminal；
 * 无 double-journal；retry 重算+重验；preview 只读；dismiss 不销毁证据。
 * 使用真实 snapshot fixture（FileSnapshotStore.save 全链路）+ 真实 JournalStore + mock executors。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FileSnapshotStore } from '../../src/core/backup.ts';
import { JournalStore, createJournalEntry, type OperationJournal } from '../../src/core/journal.ts';
import { RunRegistry } from '../../src/core/run-registry.ts';
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from '../../src/core/recovery-orchestrator.ts';
import { makeContext } from '../../src/adapters/test-helpers.ts';
import { zhMsg } from '../../src/core/messages.ts';
import type { HostFileBackup, Snapshot } from '../../src/core/types.ts';

const FP = 'fp';

/** 构造 op-bound READY 快照（save 全链路：manifest + READY）。 */
async function seedSnapshot(
  snapDir: string,
  opts: {
    hostFileBackups?: HostFileBackup[];
    environmentFingerprint?: string;
    operationId?: string;
    blobs?: Map<string, Uint8Array>;
  } = {},
): Promise<Snapshot> {
  const store = new FileSnapshotStore({ dir: snapDir });
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip: 'x.zip',
    entries: [],
    status: 'pending',
    beforePlugins: [],
    hostFileBackups: opts.hostFileBackups ?? [],
    operationId: opts.operationId ?? 'op-1',
    operationType: 'import-apply',
    environmentFingerprint: opts.environmentFingerprint ?? FP,
    ownerInstanceId: 'owner',
  };
  await store.save(snapshot, opts.blobs ?? new Map());
  return snapshot;
}

function mkJournal(id: string, state: OperationJournal['state'], snapshotId: string | null): OperationJournal {
  const j = createJournalEntry('import-apply', { operationId: id, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.54', environmentFingerprint: FP }, '2026-01-01T00:00:00.000Z');
  j.state = state;
  j.snapshotId = snapshotId;
  return j;
}

interface Harness {
  store: JournalStore;
  runs: RunRegistry;
  snapshotsDir: string;
  homeDir: string;
  transactionsDir: string;
  host: ReturnType<typeof makeContext>;
  orch: ReturnType<typeof createRecoveryOrchestrator>;
  snap: Snapshot;
  opId: string;
  /** 模拟宿主启动分类：内存标志 + durable 标记一起进入阻断态 */
  enterSafeMode: () => Promise<void>;
  /** 当前内存阻断标志（宿主 isBlocked 同源） */
  safeModeActive: () => boolean;
}

async function setup(t: test.TestContext, opts: { state?: OperationJournal['state']; env?: string; opId?: string; createJournal?: boolean } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rec-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snapshotsDir = path.join(dir, 'snapshots');
  const homeDir = path.join(dir, 'home');
  const transactionsDir = path.join(dir, 'transactions');
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  const host = makeContext('win32', homeDir, 'web');
  const store = new JournalStore({ transactionsDir });
  await store.ensureDirs();
  const runs = new RunRegistry();
  const opId = opts.opId ?? '00000000-0000-4000-8000-0000000000aa';
  // snapshot.operationId 必须与 journal.operationId 一致（双向绑定），否则 verify 判 WRONG_OPERATION
  const snap = await seedSnapshot(snapshotsDir, { environmentFingerprint: opts.env ?? FP, operationId: opId });
  if (opts.createJournal !== false) {
    await store.create(mkJournal(opId, opts.state ?? 'NEEDS_ATTENTION', snap.id));
  }
  // SAFE MODE 内存标志（宿主侧由 phase3Recovery.safeModeActive 提供；此处等价模拟）
  let safeModeActive = false;
  const orch = createRecoveryOrchestrator({
    store, runs, snapshotsDir, host, msg: zhMsg,
    snapshotExists: async (id) => id !== null && id !== '',
    getEnvironmentFingerprint: () => FP,
    clearSafeMode: async () => { safeModeActive = false; await store.writeSafeMode(false); },
    // 与宿主同源：内存标志 ⇄ durable 标记一并反映（生产实现见 src/index.ts 的注入点）
    safeModeBlocked: () => safeModeActive,
    // 本用例不注入环境锁端口：按 src/index.ts 的无锁端口分支如实回答（FREE / 无可回收对象），
    // 既让依赖齐全，也不谎称回收成功。
    inspectLockState: async () => ({ state: 'FREE' }),
    recoverStaleLock: async () => ({ ok: false, removed: false, state: 'FREE', detail: 'no lock port configured' }),
  });
  return {
    store, runs, snapshotsDir, homeDir, transactionsDir, host, orch, snap, opId,
    /** 置位 SAFE MODE（模拟「启动分类判定需保护」：内存标志 + durable 标记同时生效） */
    enterSafeMode: async (): Promise<void> => { safeModeActive = true; await store.writeSafeMode(true); },
    safeModeActive: (): boolean => safeModeActive,
  };
}

/** mock 执行器的「是否真的执行了破坏性动作」证据位（由回调写入，用例据此断言） */
type ExecutorFlags = { restoreRan?: boolean; rollbackRan?: boolean };

function mockExecutors(flags: ExecutorFlags = {}): (runId: string) => RecoveryExecutorFns {
  return () => ({
    performRestore: async () => { flags.restoreRan = true; return { full: true, failed: [] }; },
    performRollback: async () => { flags.rollbackRan = true; return { full: true, failed: [] }; },
  });
}

// ---------- status / preview ----------

test('status：无 incident → 空列表', async (t) => {
  const h = await setup(t, { createJournal: false });
  const r = await h.orch.status();
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { incidents: unknown[] }).incidents, []);
});

test('invalid operationId → 400（全部路由）', async (t) => {
  const h = await setup(t);
  const bad = 'not-a-uuid';
  assert.equal((await h.orch.preview(bad)).status, 400);
  assert.equal((await h.orch.confirm(bad, true)).status, 400);
  assert.equal((await h.orch.execute(bad, true, mockExecutors())).status, 400);
  assert.equal((await h.orch.verify(bad)).status, 400);
  assert.equal((await h.orch.retry(bad, true, mockExecutors())).status, 400);
  assert.equal((await h.orch.dismiss(bad, true)).status, 400);
});

test('operation not found → 404（全部路由）', async (t) => {
  const h = await setup(t, { createJournal: false });
  const missing = '00000000-0000-4000-8000-0000000000ff';
  assert.equal((await h.orch.preview(missing)).status, 404);
  assert.equal((await h.orch.confirm(missing, true)).status, 404);
  assert.equal((await h.orch.execute(missing, true, mockExecutors())).status, 404);
  assert.equal((await h.orch.verify(missing)).status, 404);
  assert.equal((await h.orch.retry(missing, true, mockExecutors())).status, 404);
  assert.equal((await h.orch.dismiss(missing, true)).status, 404);
});

test('missing snapshot（journal.snapshotId 为空）→ 400（无法恢复）', async (t) => {
  const h = await setup(t, { state: 'NEEDS_ATTENTION' });
  await h.store.update(h.opId, (j) => ({ ...j, snapshotId: null }));
  assert.equal((await h.orch.confirm(h.opId, true)).status, 400, '无 trusted snapshot 无法 confirm');
  assert.equal((await h.orch.execute(h.opId, true, mockExecutors())).status, 400, '无 trusted snapshot 无法 execute');
});

test('status：NEEDS_ATTENTION + trusted snapshot → rollback-recommended', async (t) => {
  const h = await setup(t);
  const r = await h.orch.status();
  assert.equal(r.status, 200);
  const incidents = (r.body as { incidents: Array<{ operationId: string; decision: string }> }).incidents;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.operationId, h.opId);
  assert.equal(incidents[0]!.decision, 'rollback-recommended');
});

test('preview：只读，不修改 journal', async (t) => {
  const h = await setup(t);
  const before = await h.store.load(h.opId);
  const r = await h.orch.preview(h.opId);
  assert.equal(r.status, 200);
  const body = r.body as { decision: string; snapshotId: string | null; snapshotVerdict: string | null };
  assert.equal(body.decision, 'rollback-recommended');
  assert.equal(body.snapshotId, h.snap.id);
  assert.equal(body.snapshotVerdict, 'TRUSTED_OPERATION_SNAPSHOT');
  const after = await h.store.load(h.opId);
  assert.deepEqual(after, before, 'preview 不得修改 journal');
});

// ---------- confirm ----------

test('confirm：缺 userConfirmed → 400', async (t) => {
  const h = await setup(t);
  const r = await h.orch.confirm(h.opId, false);
  assert.equal(r.status, 400);
});

test('confirm：journal 非 NEEDS_ATTENTION → 409', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const r = await h.orch.confirm(h.opId, true);
  assert.equal(r.status, 409);
});

test('confirm：trusted snapshot → 200，journal 保持 NEEDS_ATTENTION', async (t) => {
  const h = await setup(t);
  const r = await h.orch.confirm(h.opId, true);
  assert.equal(r.status, 200);
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', 'confirm 不转 RECOVERING');
});

test('confirm：corrupt snapshot → 400（拒绝）', async (t) => {
  const h = await setup(t);
  // 篡改 snapshot.json 使 manifest 校验失败
  const sp = path.join(h.snapshotsDir, h.snap.id, 'snapshot.json');
  const s = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
  s.entries = [{ kind: 'file', adapter: 'skills', ref: 'x', before: null, existed: false }];
  await fs.writeFile(sp, JSON.stringify(s));
  const r = await h.orch.confirm(h.opId, true);
  assert.equal(r.status, 400, 'corrupt snapshot 拒绝 confirm');
});

test('confirm：wrong environment → 400（拒绝）', async (t) => {
  const h = await setup(t, { env: 'FP-OTHER' });
  const r = await h.orch.confirm(h.opId, true);
  assert.equal(r.status, 400, 'wrong environment 拒绝 confirm');
});

// ---------- execute ----------

test('execute：缺 userConfirmed → 400（零副作用）', async (t) => {
  const h = await setup(t);
  const flags: ExecutorFlags = {};
  const r = await h.orch.execute(h.opId, false, mockExecutors(flags));
  assert.equal(r.status, 400);
  assert.equal(flags.restoreRan, undefined, '无确认不得执行');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION');
});

test('execute：NEEDS_ATTENTION → RECOVERING，调 restore executor（rollback-recommended）', async (t) => {
  const h = await setup(t);
  const flags: ExecutorFlags = {};
  const r = await h.orch.execute(h.opId, true, mockExecutors(flags));
  assert.equal(r.status, 200);
  assert.equal(flags.restoreRan, true, 'rollback-recommended 调 restore executor');
  assert.equal((await h.store.load(h.opId))?.state, 'RECOVERING', 'NEEDS_ATTENTION → RECOVERING');
});

test('execute：RECOVERING 无验证 → decision needs-attention → 400（不执行）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const flags: ExecutorFlags = {};
  const r = await h.orch.execute(h.opId, true, mockExecutors(flags));
  assert.equal(r.status, 400, 'RECOVERING 无 verification → needs-attention，不得执行');
  assert.equal(flags.restoreRan, undefined, '不得执行破坏性动作');
  assert.equal((await h.store.load(h.opId))?.state, 'RECOVERING', '保持 RECOVERING（待 verify）');
});

test('execute：无 double-journal（scanActive 仍 1 个）', async (t) => {
  const h = await setup(t);
  await h.orch.execute(h.opId, true, mockExecutors());
  const active = await h.store.scanActive();
  assert.equal(active.length, 1, 'execute 不得新建第二个 journal');
  assert.equal(active[0], h.opId);
});

test('execute：authority — 执行器收到 j.snapshotId（不接受客户端覆盖）', async (t) => {
  const h = await setup(t);
  let received: string | null = null;
  const r = await h.orch.execute(h.opId, true, () => ({
    performRestore: async (sid) => { received = sid; return { full: true, failed: [] }; },
    performRollback: async () => ({ full: true, failed: [] }),
  }));
  assert.equal(r.status, 200);
  assert.equal(received, h.snap.id, '执行器必须收到 journal 引用的 snapshotId');
});

test('execute：并发 recovery → 409（RunKind 冲突）', async (t) => {
  const h = await setup(t);
  h.runs.register('recovery'); // 已有 recovery run
  const r = await h.orch.execute(h.opId, true, mockExecutors());
  assert.equal(r.status, 409, '同 kind running → 409');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION', '被拒不得迁移状态');
});

test('execute：legacy snapshot（非 op-bound）→ 400（拒绝）', async (t) => {
  const h = await setup(t);
  const sp = path.join(h.snapshotsDir, h.snap.id, 'snapshot.json');
  const s = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
  delete s.operationId; delete s.operationType; delete s.ownerInstanceId; delete s.environmentFingerprint;
  await fs.writeFile(sp, JSON.stringify(s));
  const r = await h.orch.execute(h.opId, true, mockExecutors());
  assert.equal(r.status, 400, '非 op-bound snapshot 拒绝 execute');
});

// ---------- verify ----------

test('verify：journal 非 RECOVERING → 409', async (t) => {
  const h = await setup(t, { state: 'NEEDS_ATTENTION' });
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 409);
});

test('verify：MATCH → ROLLED_BACK（原子：recoveryVerification + terminal 同一次 update）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  const body = r.body as { verdict: string; terminal: string };
  assert.equal(body.verdict, 'MATCH');
  assert.equal(body.terminal, 'ROLLED_BACK');
  const j = await h.store.load(h.opId);
  assert.equal(j?.state, 'ROLLED_BACK');
  assert.ok(j?.recoveryVerification, 'recoveryVerification 已写入');
  assert.equal(j?.recoveryVerification?.verdict, 'MATCH');
  // 已规整到 completed
  assert.deepEqual(await h.store.scanActive(), []);
});

test('verify：MISMATCH → NEEDS_ATTENTION（不 COMMITTED）', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  // 制造 MISMATCH：快照记录 settings.yaml 应存在，但当前缺失
  const blobPath = 'blobs/settings.yaml';
  const content = Buffer.from('general:\n  theme: dark\n', 'utf8');
  await h.host.fs.writeFile('settings.yaml', content);
  // 重建快照带 hostFileBackup，然后删除文件 → MISMATCH
  const snap2 = await seedSnapshot(h.snapshotsDir, {
    hostFileBackups: [{ relPath: 'settings.yaml', blobPath, existed: true }],
    blobs: new Map([[blobPath, content]]),
    environmentFingerprint: FP,
    operationId: h.opId,
  });
  await h.store.update(h.opId, (j) => ({ ...j, snapshotId: snap2.id }));
  await h.host.fs.remove('settings.yaml');
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  const body = r.body as { verdict: string; terminal: string };
  assert.equal(body.verdict, 'MISMATCH');
  assert.equal(body.terminal, 'NEEDS_ATTENTION');
  const j = await h.store.load(h.opId);
  assert.equal(j?.state, 'NEEDS_ATTENTION', 'MISMATCH 不得 COMMITTED');
  assert.equal(j?.recoveryVerification?.verdict, 'MISMATCH');
});

test('verify：VERIFICATION_ERROR（wrong operation）→ NEEDS_ATTENTION', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  // 快照 operationId 与 journal 不一致 → verify 重验 WRONG_OPERATION → VERIFICATION_ERROR
  const snap2 = await seedSnapshot(h.snapshotsDir, { environmentFingerprint: FP, operationId: 'op-OTHER' });
  await h.store.update(h.opId, (j) => ({ ...j, snapshotId: snap2.id }));
  const r = await h.orch.verify(h.opId);
  assert.equal(r.status, 200);
  const body = r.body as { verdict: string; terminal: string };
  assert.equal(body.verdict, 'VERIFICATION_ERROR');
  assert.equal(body.terminal, 'NEEDS_ATTENTION');
  assert.equal((await h.store.load(h.opId))?.state, 'NEEDS_ATTENTION');
});

// ---------- retry ----------

test('retry：缺 userConfirmed → 400', async (t) => {
  const h = await setup(t);
  const r = await h.orch.retry(h.opId, false, mockExecutors());
  assert.equal(r.status, 400);
});

test('retry：journal 非 NEEDS_ATTENTION → 409', async (t) => {
  const h = await setup(t, { state: 'RECOVERING' });
  const r = await h.orch.retry(h.opId, true, mockExecutors());
  assert.equal(r.status, 409);
});

test('retry：重算 decision + 重验 trusted snapshot → 执行', async (t) => {
  const h = await setup(t);
  const flags: ExecutorFlags = {};
  const r = await h.orch.retry(h.opId, true, mockExecutors(flags));
  assert.equal(r.status, 200);
  assert.equal(flags.restoreRan, true, 'retry 重算 decision 后执行');
  assert.equal((await h.store.load(h.opId))?.state, 'RECOVERING');
});

test('retry：corrupt snapshot → 400（fail-closed，不绕过安全检查）', async (t) => {
  const h = await setup(t);
  const sp = path.join(h.snapshotsDir, h.snap.id, 'snapshot.json');
  const s = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
  s.entries = [{ kind: 'file', adapter: 'skills', ref: 'x', before: null, existed: false }];
  await fs.writeFile(sp, JSON.stringify(s));
  const r = await h.orch.retry(h.opId, true, mockExecutors());
  assert.equal(r.status, 400, 'corrupt snapshot 拒绝 retry');
});

// ---------- dismiss ----------

test('dismiss：缺 userConfirmed → 400', async (t) => {
  const h = await setup(t);
  const r = await h.orch.dismiss(h.opId, false);
  assert.equal(r.status, 400);
});

test('dismiss：quarantine，不销毁 snapshot/journal evidence', async (t) => {
  const h = await setup(t);
  const r = await h.orch.dismiss(h.opId, true);
  assert.equal(r.status, 200);
  // journal 移出 active（quarantine）
  assert.deepEqual(await h.store.scanActive(), []);
  // snapshot 仍存在（不删除）
  const snap = await new FileSnapshotStore({ dir: h.snapshotsDir }).load(h.snap.id).catch(() => null);
  assert.ok(snap !== null, 'dismiss 不得删除 snapshot');
  // journal evidence 仍在 quarantine
  const q = await fs.readdir(path.join(h.transactionsDir, 'quarantine')).catch(() => []);
  assert.ok(q.length > 0, 'dismiss 不得销毁 journal evidence');
});

/* ------------------------- issue #56：dismiss 之后必须解除 SAFE MODE -------------------------
 *
 * 真机（issue #56）：dismiss 只把事务移进 quarantine，不清 durable 标记 ⇒ 界面显示
 * 「暂无需要处理的恢复事项」，写操作却持续 423，重启也无效；唯一出路是手工删
 * transactions/safe-mode。下面三条钉住修复与它的两个边界。
 */

test('issue#56 dismiss：#56 场景（active 空、标记在）→ 一并解除 SAFE MODE', async (t) => {
  const h = await setup(t);
  await h.enterSafeMode();
  assert.equal(h.safeModeActive(), true, '前置：保护已开启');
  assert.equal(await h.store.readSafeModeState(), 'blocked', '前置：durable 标记在');

  const r = await h.orch.dismiss(h.opId, true);
  assert.equal(r.status, 200);
  assert.equal((r.body as { safeMode?: boolean }).safeMode, true, '响应如实回报已解除保护');

  // durable 标记删除 + 内存标志复位（宿主 isBlocked 读它 ⇒ 写操作恢复可用）
  assert.equal(await h.store.readSafeModeState(), 'clear', 'dismiss 后 durable 标记必须清掉');
  assert.equal(h.safeModeActive(), false, 'dismiss 后内存阻断标志必须复位');
  assert.deepEqual(await h.store.scanActive(), [], '事务仍按原语义移出 active（quarantine）');
});

test('issue#56 dismiss：还有别的未解决 incident 时**保留**保护（绝不顺手放开）', async (t) => {
  const h = await setup(t);
  await h.enterSafeMode();
  // 第二个未解决事务（NEEDS_ATTENTION）——dismiss 一个不能让保护整体消失
  const other = '00000000-0000-4000-8000-0000000000bb';
  await h.store.create(mkJournal(other, 'NEEDS_ATTENTION', h.snap.id));

  const r = await h.orch.dismiss(h.opId, true);
  assert.equal(r.status, 200);
  assert.equal((r.body as { safeMode?: boolean }).safeMode, false, '仍有未解决事项 → 不解除');
  assert.equal(await h.store.readSafeModeState(), 'blocked', '保护必须保持');
  assert.equal(h.safeModeActive(), true);
  // 该事务本身仍被正常隔离（dismiss 语义不变）
  assert.deepEqual(await h.store.scanActive(), [other], '只移走被 dismiss 的那一个');
});

test('issue#56 status：如实回传 safeMode.blocked / clearable（结案但保护仍开着）', async (t) => {
  const h = await setup(t);
  await h.enterSafeMode();
  // dismiss 之前：有未解决 incident ⇒ blocked 且不可解除
  const before = await h.orch.status();
  assert.deepEqual(
    (before.body as { safeMode: { blocked: boolean; clearable: boolean } }).safeMode,
    { blocked: true, clearable: false },
    '还有待处理事项时 clearable 必须为 false（界面据此不渲染解除按钮）',
  );
  await h.orch.dismiss(h.opId, true);
  // 模拟「旧版本遗留 / 手工删过 journal」：没有 active、标记仍在（这正是 issue #56 的现场）
  await h.store.writeSafeMode(true);
  await h.enterSafeMode();
  const after = await h.orch.status();
  assert.deepEqual(
    (after.body as { safeMode: { blocked: boolean; clearable: boolean } }).safeMode,
    { blocked: true, clearable: true },
    '结案但保护仍开着 → clearable=true（界面必须给出解除入口）',
  );
  assert.deepEqual((after.body as { incidents: unknown[] }).incidents, [], '此时确实没有 incident 可处理');
});

test('issue#56 clearSafeModeBlock：确认 + 无未解决事项 → 解除；否则拒绝', async (t) => {
  const h = await setup(t);
  await h.enterSafeMode();

  // ① 缺 userConfirmed → 400，且不做任何改动
  assert.equal((await h.orch.clearSafeModeBlock(false)).status, 400);
  assert.equal(await h.store.readSafeModeState(), 'blocked', '未确认不得改标记');

  // ② 仍有未解决 incident（本 fixture 就是 NEEDS_ATTENTION）→ 400 + 明确原因，保护保持
  const refused = await h.orch.clearSafeModeBlock(true);
  assert.equal(refused.status, 400);
  assert.equal((refused.body as { reason?: string }).reason, 'unresolved-incidents');
  assert.equal(await h.store.readSafeModeState(), 'blocked', '有未解决事项时绝不解除（不是绕过恢复的后门）');

  // ③ 结案（quarantine 掉该事务）后再解除 → 成功，标记与内存标志都复位
  await h.orch.dismiss(h.opId, true);
  await h.store.writeSafeMode(true);
  await h.enterSafeMode();
  const ok = await h.orch.clearSafeModeBlock(true);
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { cleared?: boolean }).cleared, true);
  assert.equal(await h.store.readSafeModeState(), 'clear');
  assert.equal(h.safeModeActive(), false);

  // ④ 幂等：本来就没阻断 → ok 且不计为「已解除」（不是错误）
  const again = await h.orch.clearSafeModeBlock(true);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, cleared: false, reason: 'not-blocked' });
});
