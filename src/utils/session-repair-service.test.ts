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
  readSessionRepairLedger,
  resolveSessionUnit,
  rollbackSessionRepair,
  SESSION_REPAIR_LEDGER_FILE,
  sessionRepairLedgerPath,
  writeSessionRepairLedger,
} from './session-repair-service.ts';
import { verifySessionLogBytes, type SessionVerifyCatalog } from './session-verify.ts';
import { sha256Hex } from './hashing.ts';
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
    // 台账里记着 targetSha256After（sha256 比 size+mtime 严），所以这里是新原因 target-changed
    const changed = await rollbackSessionRepair({ homeDir, dataDir, repairId: second.repairId! });
    assert.equal(changed.reason, 'target-changed');
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

/* --------------------------------------------- M1-WS2：真 codec 复验门 + sha256 前置 */

/** 恒在 decodeRow 抛错的假 catalog（代表「真 codec 判定这份字节读不完」）。 */
const decodeFailCatalog: SessionVerifyCatalog = {
  createRestore() {
    return {
      decodeRow() { throw new Error('official row refusal'); },
      finish() { return {}; },
    };
  },
};

test('M1-WS2：复验确定性失败 → 自动回滚（逐字节还原）且不写台账', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const before = await fs.readFile(file);
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: decodeFailCatalog } });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.reason, 'verify-failed');
    assert.equal(applied.rolledBack, true, '必须用本次备份自动还原');
    assert.equal(applied.verify?.verified, false);
    assert.equal((await fs.readFile(file)).equals(before), true, '确定性失败必须逐字节还原');
    assert.equal((await listSessionRepairs(dataDir)).repairs.length, 0, '确定性失败不得记录台账');
  });
});

test('M1-WS2：复验 unavailable → 不回滚、不宣称已验证，但台账照记（保住回滚入口）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file, unitDir } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const before = await fs.readFile(file);
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: null } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const verify = applied.verify;
    assert.equal(verify?.verified, false, '能力不可用时绝不宣称已验证');
    assert.equal(verify !== undefined && verify.verified === false ? verify.reason : '', 'unavailable');
    assert.equal((await fs.readFile(file)).equals(before), false, 'unavailable 不回滚：写入保持');
    assert.equal(applied.ledgerRecorded, true, 'unavailable 仍要写台账（否则这次写入失去回滚入口）');
    const repaired = await fs.readFile(file);
    const record = (await readSessionRepairLedger(dataDir)).repairs[0];
    assert.ok(record !== undefined);
    assert.equal(record.verify?.verified, false, '台账必须如实标注未验证');
    assert.equal(record.targetSha256After, sha256Hex(repaired), '台账必须记下修复后目标的 sha256');
    const backupBytes = await fs.readFile(path.join(unitDir, record.backupName));
    assert.equal(record.backupSha256, sha256Hex(backupBytes), '台账必须记下备份的 sha256');
    assert.equal(backupBytes.equals(before), true, '备份 = 修复前字节（保真，不要求合法）');
    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: record.repairId });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await fs.readFile(file)).equals(before), true);
  });
});

test('M1-WS2：回滚前置 —— 备份 sha256 与台账不一致 → 拒绝回滚（backup-invalid，零写入）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file, unitDir } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: null } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const repaired = await fs.readFile(file);
    const record = (await readSessionRepairLedger(dataDir)).repairs[0];
    assert.ok(record !== undefined);
    const backupPath = path.join(unitDir, record.backupName);
    await fs.writeFile(backupPath, Buffer.concat([await fs.readFile(backupPath), Buffer.from('tampered')]));
    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: record.repairId });
    assert.equal(back.ok, false);
    assert.equal(back.reason, 'backup-invalid');
    assert.equal((await fs.readFile(file)).equals(repaired), true, '拒绝回滚必须零写入');
  });
});

test('M1-WS2：回滚前置 —— 目标 sha256 与台账不一致 → 拒绝覆盖（target-changed，零写入）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: null } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const tampered = Buffer.concat([await fs.readFile(file), Buffer.from('xx')]);
    await fs.writeFile(file, tampered);
    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: applied.repairId! });
    assert.equal(back.ok, false);
    assert.equal(back.reason, 'target-changed');
    assert.equal((await fs.readFile(file)).equals(tampered), true, '拒绝覆盖：目标保持别人的内容');
    const after = (await readSessionRepairLedger(dataDir)).repairs[0];
    assert.equal(after?.rolledBackAt, undefined, '拒绝的回滚不得标成已回滚');
  });
});

test('M1-WS2：旧台账记录（缺 sha256 / verify 新字段）仍可读且仍可回滚', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const before = await fs.readFile(file);
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: null } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const record = (await readSessionRepairLedger(dataDir)).repairs[0];
    assert.ok(record !== undefined);
    // 模拟更早版本写下的台账：只留 T8 老字段（没有 backupSha256 / targetSha256After / verify）
    const legacy = {
      repairId: record.repairId,
      unitId: record.unitId,
      sessionId: record.sessionId,
      projectKey: record.projectKey,
      logName: record.logName,
      backupName: record.backupName,
      at: record.at,
      droppedRows: record.droppedRows,
      bytesBefore: record.bytesBefore,
      bytesAfter: record.bytesAfter,
      repairedSize: record.repairedSize,
      repairedMtimeMs: record.repairedMtimeMs,
    };
    await writeSessionRepairLedger(dataDir, [legacy]);
    const read = await readSessionRepairLedger(dataDir);
    assert.equal(read.repairs.length, 1, '缺新字段的旧记录必须仍被读出（否则历史修复再也回滚不了）');
    assert.equal(read.repairs[0]?.backupSha256, undefined);
    assert.equal(read.repairs[0]?.targetSha256After, undefined);
    assert.equal(read.repairs[0]?.verify, undefined);
    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: record.repairId });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await fs.readFile(file)).equals(before), true);
  });
});

test('M1-WS2：备份的职责是保真而不是合法 —— 备份过不了真 codec 门也照样能回滚', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const { homeDir, dataDir, file } = await makeUnit(dir);
    const unitId = PROJECT_KEY + '/' + SESSION_ID;
    const before = await fs.readFile(file);
    const gateOnBackup = await verifySessionLogBytes(before, { catalog: decodeFailCatalog });
    assert.equal(gateOnBackup.verified, false, '修复前的字节本来就过不了 codec 门');
    const applied = await applySessionRepair({ homeDir, dataDir, unitId, now: later, verify: { catalog: null } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const back = await rollbackSessionRepair({ homeDir, dataDir, repairId: applied.repairId! });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await fs.readFile(file)).equals(before), true);
  });
});
