/**
 * 会话修复服务层（T8）单测 —— 真实临时 home + 真实 zstd 帧：
 *  - 目标解析必须**只在会话根内**（形状/穿越/不存在一律 undefined）；
 *  - 写入门：session.lock → locked；静止期内 → busy；预览/应用指纹不一致 → changed（零写入）；
 *  - 应用：执行器完整安全序列 + 台账（repairId / 备份名 / 修复后指纹）；
 *  - 回滚：只认台账 repairId，还原原文；重复回滚与「目标已被改过」都拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applySessionRepair,
  listSessionRepairs,
  previewSessionRepair,
  resolveSessionUnit,
  rollbackSessionRepair,
  SESSION_REPAIR_LEDGER_FILE,
  sessionRepairLedgerPath,
} from './session-repair-service.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';

const CAPABLE = zstdAvailable();
const PROJECT_KEY = '--p--';
const SESSION_ID = 'session-abc';
const LOG_NAME = 'session.v4.jsonl.zstd';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-repair-service-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 一份会话日志：首帧 header + 每行一帧（与 DSH 的拼接容器同形）。 */
function logBytes(rows: readonly unknown[]): Buffer {
  const header = { type: 'session', version: 4, id: SESSION_ID, cwd: 'C:/proj' };
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + '\n', 'utf8')));
  return Buffer.concat(parts);
}

const DUPLICATED = [{ type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'step/start', seq: 1 }, { type: 'turn/end', seq: 2 }];
const CLEAN = [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }];

/** 建一个会话单元；mtime 设为 10 分钟前（静止期之外）。 */
async function makeUnit(dir: string, rows: readonly unknown[] = DUPLICATED): Promise<{ homeDir: string; dataDir: string; file: string; unitDir: string }> {
  const homeDir = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data');
  const unitDir = path.join(homeDir, 'sessions', PROJECT_KEY, SESSION_ID);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(unitDir, LOG_NAME);
  await fs.writeFile(file, logBytes(rows));
  const old = new Date(Date.now() - 600_000);
  await fs.utimes(file, old, old);
  return { homeDir, dataDir, file, unitDir };
}

const later = (): Date => new Date(Date.now() + 120_000);

test('T8：resolveSessionUnit —— 只在会话根内解析；形状不对/不存在一律 undefined', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, file } = await makeUnit(dir);
    const sessionsDir = path.join(homeDir, 'sessions');
    const target = await resolveSessionUnit(sessionsDir, PROJECT_KEY + '/' + SESSION_ID);
    assert.equal(target?.file, file);
    assert.equal(target?.logName, LOG_NAME);
    for (const bad of ['', 'a', 'a/b/c', PROJECT_KEY + '/..', PROJECT_KEY + '/sub/deep', 'not-a-project-key/x', PROJECT_KEY + '/missing']) {
      assert.equal(await resolveSessionUnit(sessionsDir, bad), undefined, '不该解析出目标: ' + bad);
    }
  });
});

test('T8：preview —— 静止期内 busy / session.lock locked / 无重复行 nothing-to-fix', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, file, unitDir } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    // 刚写过 → 视为活跃使用
    const busy = await previewSessionRepair({ homeDir, unitId, now: () => new Date(Date.now() - 600_000 + 5_000) });
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'busy');
    assert.ok(typeof busy.mtimeMs === 'number', 'busy 时必须回传最近写入时间');
    // session.lock 存在 → locked
    await fs.writeFile(path.join(unitDir, 'session.lock'), 'lock');
    const locked = await previewSessionRepair({ homeDir, unitId, now: later });
    assert.equal(locked.reason, 'locked');
    await fs.rm(path.join(unitDir, 'session.lock'));
    // 正常 → 给出计划与指纹
    const plan = await previewSessionRepair({ homeDir, unitId, now: later });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.droppedRows, 1);
    assert.ok(plan.expect !== undefined && plan.expect.size > 0);
    assert.equal((await fs.readFile(file)).length, plan.bytesBefore, '预览必须零写入');
    // 没有可零损失修复的问题
    const clean = await makeUnit(dir, CLEAN);
    const nothing = await previewSessionRepair({ homeDir: clean.homeDir, unitId, now: later });
    assert.equal(nothing.reason, 'nothing-to-fix');
  });
});

test('T8：apply —— 备份 + 台账 + 目标被换；expect 指纹不一致 → changed 且零写入', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const plan = await previewSessionRepair({ homeDir, unitId, now: later });
    assert.equal(plan.ok, true);
    const before = await fs.readFile(file);

    const applied = await applySessionRepair({ homeDir, dataDir, unitId, expect: plan.expect, now: later });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.droppedRows, 1);
    assert.equal(applied.ledgerRecorded, true);
    assert.ok(applied.repairId !== undefined && applied.backupName !== undefined);
    assert.equal((await fs.readFile(file)).equals(before), false, '目标已被换成修复后内容');
    const ledger = await listSessionRepairs(dataDir);
    assert.equal(ledger.repairs.length, 1);
    assert.equal(ledger.repairs[0]?.repairId, applied.repairId);
    assert.equal(ledger.repairs[0]?.backupName, applied.backupName);

    // 指纹不一致（文件被改过、但 mtime 被改回旧值）→ changed，且这次零写入
    const other = await makeUnit(dir);
    const snapshot = await fs.readFile(other.file);
    await fs.utimes(other.file, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    const changed = await applySessionRepair({
      homeDir: other.homeDir, dataDir: other.dataDir, unitId,
      expect: { size: snapshot.length + 1, mtimeMs: Date.now() - 600_000 },
      now: later,
    });
    assert.equal(changed.reason, 'changed');
    assert.equal((await fs.readFile(other.file)).equals(snapshot), true, 'changed 路径必须零写入');
  });
});

test('T8：rollback —— 按 repairId 还原原文；重复回滚 / 目标被改过均拒绝', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const before = await fs.readFile(file);
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later });
    assert.equal(applied.ok, true);
    const repaired = await fs.readFile(file);
    assert.equal(repaired.equals(before), false);

    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: applied.repairId! });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await fs.readFile(file)).equals(before), true, '回滚后必须与修复前逐字节相同');
    const again = await rollbackSessionRepair({ homeDir, dataDir, repairId: applied.repairId! });
    assert.equal(again.reason, 'already-rolled-back');

    assert.equal((await rollbackSessionRepair({ homeDir, dataDir, repairId: 'repair-nope' })).reason, 'repair-not-found');

    // 目标在修复之后又被改过 → 拒绝回滚（绝不覆盖别人的内容）
    const second = await applySessionRepair({ homeDir, dataDir, unitId, now: later });
    assert.equal(second.ok, true);
    await fs.writeFile(file, Buffer.concat([await fs.readFile(file), Buffer.from('xx')]));
    const changed = await rollbackSessionRepair({ homeDir, dataDir, repairId: second.repairId! });
    assert.equal(changed.reason, 'changed');
  });
});

test('T8：台账损坏 → 先留档 .corrupt-* 再写新账（不静默丢弃证据）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, unitId } = { ...(await makeUnit(dir)), unitId: PROJECT_KEY + '/' + SESSION_ID };
    await fs.writeFile(sessionRepairLedgerPath(dataDir), '{ not json', 'utf8');
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later });
    assert.equal(applied.ok, true);
    assert.equal(applied.ledgerRecorded, true, '损坏台账必须被替换为新账');
    const names = await fs.readdir(dataDir);
    assert.ok(names.some((n) => n.startsWith(SESSION_REPAIR_LEDGER_FILE + '.corrupt-')), '损坏台账必须留档: ' + JSON.stringify(names));
    const ledger = await listSessionRepairs(dataDir);
    assert.equal(ledger.repairs.length, 1);
  });
});
