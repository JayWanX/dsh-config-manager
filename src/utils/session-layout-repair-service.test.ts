/**
 * E1 宿主服务单测：面板侧「布局归位 / 重复 id 隔离」。
 *
 * 全部用**真实临时 home + 真实字节**（合成会话日志），不 mock 规划器与写入原语：
 *  · 计划只读（零写入）；重复 id 未点名 keep → 拒绝执行；keep 指向非候选副本 → 拒绝执行；
 *  · 应用：真搬目录、首帧逐字节不变、每次移动后**必须**刷新索引；
 *  · 隔离命名与 CLI 逐字一致（`.cm-repair-quarantine-<stamp>/<fromProjectKey>/<sessionId>`）；
 *  · 失败逐条回滚（刷新失败 / 搬不动 → 目录与字节都回到原状）；
 *  · 逐目标门前置（session.lock / 30s 静止期）；
 *  · 结果不含任何绝对路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-meta.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';
import { readLogFileCwd } from './session-log.ts';
import {
  applySessionLayoutRepair,
  planSessionLayoutRepair,
} from './session-layout-repair-service.ts';

const CAPABLE = zstdAvailable();
const LOG_NAME = 'session.v4.jsonl.zstd';

async function withTmp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-layout-repair-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function logBytes(sessionId: string, cwd: string): Buffer {
  const header = { type: 'session', version: 4, id: sessionId, cwd };
  return Buffer.concat([
    encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8')),
    encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 0 }) + '\n', 'utf8')),
  ]);
}

/** 造一个会话单元：<home>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd。 */
async function makeUnit(
  homeDir: string,
  projectKey: string,
  sessionId: string,
  cwd: string,
  opts: { fresh?: boolean; lock?: boolean } = {},
): Promise<string> {
  const dir = path.join(homeDir, 'sessions', projectKey, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOG_NAME);
  await fs.writeFile(file, logBytes(sessionId, cwd));
  const stamp = opts.fresh === true ? new Date() : new Date(Date.now() - 600_000);
  await fs.utimes(file, stamp, stamp);
  if (opts.lock === true) await fs.writeFile(path.join(dir, 'session.lock'), 'locked');
  return dir;
}

/** 目录树快照（相对路径 → 文件 sha 无关的内容长度 + mtime 秒级），用来证明「零写入 / 已回滚」。 */
async function treeOf(root: string): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel + ':' + String((await fs.stat(path.join(dir, entry.name))).size));
    }
  }
  await walk(root, '');
  return out.join('|');
}

function reindexRecorder(fail = false): { calls: string[]; fn: (sessionId: string) => Promise<boolean> } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (sessionId: string) => {
      calls.push(sessionId);
      return !fail;
    },
  };
}

const MISPLACED = '--D-Ghost-proj--';
const REAL_CWD = 'D:/Real/proj';

test('E1 计划：位置错位 → move/applies；已就位 → ok；重复 id 未点名 keep → quarantine/applies:false + needsKeep', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const placedKey = projectKeyOf(REAL_CWD);
    await makeUnit(homeDir, placedKey, 'session-placed', REAL_CWD);
    await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);

    const before = await treeOf(homeDir);
    const plan = await planSessionLayoutRepair({ homeDir });
    assert.equal(plan.ok, true);
    assert.equal(plan.readOnly, true);
    const byId = new Map(plan.actions.map((a) => [a.unitId, a]));
    const move = byId.get(MISPLACED + '/session-move');
    assert.equal(move?.kind, 'move');
    assert.equal(move?.toProjectKey, placedKey);
    assert.equal(move?.reason, 'needs-move');
    assert.equal(move?.applies, true);
    assert.equal(byId.get(placedKey + '/session-placed')?.kind, 'ok');
    assert.equal(byId.get('--a--/session-dup')?.kind, 'quarantine');
    assert.equal(byId.get('--a--/session-dup')?.applies, false, '未点名 keep 的副本绝不落盘');
    assert.equal(byId.get('--b--/session-dup')?.applies, false);
    assert.deepEqual(plan.needsKeep, ['session-dup']);
    assert.equal(plan.summary.duplicates, 1);
    assert.equal(plan.needsAttention, true);
    assert.deepEqual(await treeOf(homeDir), before, '计划必须零写入');

    // 计划里只有相对身份：不含绝对路径
    const text = JSON.stringify(plan);
    assert.equal(text.includes(homeDir), false, '计划不得含 home 绝对路径');
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, '计划不得含盘符路径: ' + text.slice(0, 200));
  });
});

test('E1 计划：给了 keep → 保留者 keep/applies:false、其余 quarantine/applies:true；keep 指向非候选副本 → 该 id 进 needsKeep', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);
    const keepUnit = '--a--/session-dup';

    const plan = await planSessionLayoutRepair({ homeDir, keep: { 'session-dup': keepUnit } });
    const byId = new Map(plan.actions.map((a) => [a.unitId, a]));
    assert.equal(byId.get(keepUnit)?.kind, 'keep');
    assert.equal(byId.get(keepUnit)?.applies, false, '被点名保留的那一份本轮不动（与 CLI 同）');
    assert.equal(byId.get('--b--/session-dup')?.kind, 'quarantine');
    assert.equal(byId.get('--b--/session-dup')?.applies, true);
    assert.deepEqual(plan.needsKeep, []);

    const bad = await planSessionLayoutRepair({ homeDir, keep: { 'session-dup': '--zzz--/session-dup' } });
    assert.deepEqual(bad.needsKeep, ['session-dup'], 'keep 指向非候选副本 → 该 id 必须重新要求用户点名');
    assert.equal(bad.actions.every((a) => a.applies === false), true, '无法确认保留对象时一条都不许落盘');
  });
});

test('E1 应用：位置错位 → 真搬目录 + 首帧逐字节不变 + 索引刷新被调用（参数 = sessionId）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const from = await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const beforeBytes = await fs.readFile(path.join(from, LOG_NAME));
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied, 1);
    assert.equal(result.results[0]?.reason, undefined);
    assert.deepEqual(rec.calls, ['session-move'], '每次移动后必须刷新索引');

    const placedKey = projectKeyOf(REAL_CWD);
    const to = path.join(homeDir, 'sessions', placedKey, 'session-move');
    assert.equal(await fs.stat(to).then(() => true, () => false), true, '目录必须真搬到正确 projectKey 段');
    assert.equal(await fs.stat(from).then(() => true, () => false), false, '原目录必须消失');
    assert.equal((await fs.readFile(path.join(to, LOG_NAME))).equals(beforeBytes), true, '纯搬目录：字节逐字节不变');
    assert.equal(await readLogFileCwd(path.join(to, LOG_NAME)), REAL_CWD, '无映射时不改写首帧 cwd');
    assert.equal(result.results[0]?.movedUnitId, placedKey + '/session-move');
    assert.equal(JSON.stringify(result).includes(homeDir), false, '结果不得含绝对路径');
  });
});

test('E1 应用：重复 id 给 keep → 保留者不动、其余进 .cm-repair-quarantine-<stamp>/<from>/<id>（与 CLI 逐字一致）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const keptDir = await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    const dupDir = await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, keep: { 'session-dup': '--a--/session-dup' }, reindex: rec.fn, stamp: 'test-stamp' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied, 1);
    const item = result.results.find((r) => r.action === 'quarantine');
    assert.equal(item?.ok, true);
    assert.equal(item?.quarantineDir, '.cm-repair-quarantine-test-stamp/--b--/session-dup');
    assert.equal(await fs.stat(keptDir).then(() => true, () => false), true, '保留者必须原地不动');
    assert.equal(await fs.stat(dupDir).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(homeDir, 'sessions', '.cm-repair-quarantine-test-stamp', '--b--', 'session-dup')).then(() => true, () => false), true);
    assert.deepEqual(rec.calls, ['session-dup'], '隔离后也必须刷新该会话的索引');
  });
});

test('E1 应用：重复 id **未给 keep** → 拒绝执行并说明（missing-keep），零写入', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);
    const before = await treeOf(homeDir);
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 2);
    assert.equal(result.applied, 0);
    assert.deepEqual(result.results.map((r) => r.reason), ['missing-keep', 'missing-keep']);
    assert.deepEqual(rec.calls, [], '被拒绝时不得刷新索引（什么都没发生）');
    assert.deepEqual(await treeOf(homeDir), before, '拒绝执行必须零写入');
  });
});

test('E1 应用：keep 指向非候选副本 → keep-not-a-candidate 拒绝执行，零写入', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);
    const before = await treeOf(homeDir);
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, keep: { 'session-dup': '--zzz--/session-dup' }, reindex: rec.fn });
    assert.equal(result.ok, false);
    assert.equal(result.results.some((r) => r.reason === 'keep-not-a-candidate'), true, JSON.stringify(result.results));
    assert.equal(result.applied, 0);
    assert.deepEqual(rec.calls, []);
    assert.deepEqual(await treeOf(homeDir), before);
  });
});

test('E1 应用：索引刷新失败 → 该条回滚（目录回原位 + 字节不变 + rolledBack:true）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const from = await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const bytes = await fs.readFile(path.join(from, LOG_NAME));
    const before = await treeOf(homeDir);
    const rec = reindexRecorder(true);
    const result = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0]?.reason, 'reindex-failed');
    assert.equal(result.results[0]?.rolledBack, true, '刷新失败必须回滚该条');
    assert.deepEqual(await treeOf(homeDir), before, '回滚后目录树与原来一致');
    assert.equal((await fs.readFile(path.join(from, LOG_NAME))).equals(bytes), true);
    assert.deepEqual(rec.calls, ['session-move'], '刷新失败也要如实记录调用过（失败原因来自返回值）');
  });
});

test('E1 应用：session.lock → 门前置拒绝（locked，skipped）；30s 内有写入 → busy（failed）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, MISPLACED, 'session-locked', REAL_CWD, { lock: true });
    await makeUnit(homeDir, MISPLACED, 'session-busy', REAL_CWD, { fresh: true });
    const before = await treeOf(homeDir);
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    const byReason = new Map(result.results.map((r) => [r.reason, r]));
    assert.equal(byReason.get('locked')?.needsAttention, true);
    assert.equal(byReason.get('busy')?.needsAttention, true);
    assert.equal(result.skipped, 1, 'locked 由规划器判为「只报告」');
    assert.equal(result.failed, 1, 'busy 由运行时门拒绝（该条没做成）');
    assert.equal(result.applied, 0);
    assert.deepEqual(rec.calls, []);
    assert.deepEqual(await treeOf(homeDir), before, '被门拒绝时零写入');
  });
});

test('E1 应用：目标目录已存在 → target-exists（源目录保持原位）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const from = await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    // 目标位置已有**同名目录**（放一个非会话日志文件：否则它会被扫描成重复 id，走 quarantine 而不是 move）
    const targetDir = path.join(homeDir, 'sessions', projectKeyOf(REAL_CWD), 'session-move');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'notes.txt'), 'occupied');
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.reason, 'target-exists');
    assert.equal(await fs.stat(from).then(() => true, () => false), true, '拒绝覆盖：源目录保持原位');
    assert.deepEqual(rec.calls, []);
  });
});

test('E1 应用：宿主未提供索引刷新端口 → 一条也不执行（reindex-unavailable，零写入）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const before = await treeOf(homeDir);
    const result = await applySessionLayoutRepair({ homeDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reindex-unavailable');
    assert.deepEqual(result.results, []);
    assert.deepEqual(await treeOf(homeDir), before, '没有刷新能力就不许动盘');
  });
});

test('E1 应用：命中映射 → 先改写首帧；搬不动（目标已存在）→ **回滚改写**（字节回原值 + rolledBack:true）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const from = await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const bytes = await fs.readFile(path.join(from, LOG_NAME));
    const mappings = [{ oldPrefix: 'D:/Real', newPrefix: 'E:/Mapped' }];
    // 映射后的目标位置已有同名目录（同样只放非日志文件，避免被当成重复 id）
    const blocked = path.join(homeDir, 'sessions', projectKeyOf('E:/Mapped/proj'), 'session-move');
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, 'notes.txt'), 'occupied');
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, mappings, reindex: rec.fn });
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.reason, 'target-exists');
    assert.equal(result.results[0]?.rolledBack, true, '搬不动必须回滚改写（绝不留半套）');
    assert.equal((await fs.readFile(path.join(from, LOG_NAME))).equals(bytes), true, '首帧 cwd 必须回到原值');
    assert.equal(await readLogFileCwd(path.join(from, LOG_NAME)), REAL_CWD);
    assert.deepEqual(rec.calls, []);
  });
});

test('E1 应用：改写原语失败（注入）→ 不搬目录、不改字节、该条如实失败', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    const from = await makeUnit(homeDir, MISPLACED, 'session-move', REAL_CWD);
    const bytes = await fs.readFile(path.join(from, LOG_NAME));
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({
      homeDir,
      mappings: [{ oldPrefix: 'D:/Real', newPrefix: 'E:/Mapped' }],
      reindex: rec.fn,
      rewriteDir: async () => ({ ok: false, reason: 'injected' }),
    });
    assert.equal(result.results[0]?.reason, 'rewrite-failed');
    assert.equal(await fs.stat(from).then(() => true, () => false), true, '改写失败就不搬目录（与 CLI 同）');
    assert.equal((await fs.readFile(path.join(from, LOG_NAME))).equals(bytes), true);
    assert.deepEqual(rec.calls, []);
  });
});

test('E1：会话根读不出来 → 计划/应用都如实报 sessions-root-unreadable（不抛、不猜）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await fs.mkdir(homeDir, { recursive: true });
    const plan = await planSessionLayoutRepair({ homeDir });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'sessions-root-unreadable');
    const rec = reindexRecorder();
    const applied = await applySessionLayoutRepair({ homeDir, reindex: rec.fn });
    assert.equal(applied.reason, 'sessions-root-unreadable');
    assert.deepEqual(rec.calls, []);
  });
});

test('E1 应用：隔离目录用默认时间戳时命名与 CLI 同形（.cm-repair-quarantine-<ISO>/<from>/<id>）', { skip: !CAPABLE }, async () => {
  await withTmp(async (root) => {
    const homeDir = path.join(root, 'home');
    await makeUnit(homeDir, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(homeDir, '--b--', 'session-dup', REAL_CWD);
    const rec = reindexRecorder();
    const result = await applySessionLayoutRepair({ homeDir, keep: { 'session-dup': '--a--/session-dup' }, reindex: rec.fn });
    assert.equal(result.ok, true, JSON.stringify(result));
    const dirs = (await fs.readdir(path.join(homeDir, 'sessions'))).filter((n) => n.startsWith('.cm-repair-quarantine-'));
    assert.equal(dirs.length, 1);
    assert.match(dirs[0] ?? '', /^\.cm-repair-quarantine-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const inside = path.join(homeDir, 'sessions', dirs[0] as string, '--b--', 'session-dup');
    assert.equal(await fs.stat(inside).then(() => true, () => false), true);
    const item = result.results.find((r) => r.action === 'quarantine');
    assert.equal(item?.quarantineDir, dirs[0] + '/--b--/session-dup', '回传的隔离去向必须是相对路径');
  });
});
