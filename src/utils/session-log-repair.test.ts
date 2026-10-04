/**
 * 会话安全修复执行器（T6/T9）单测 —— 真实 zstd 帧 + 真实临时文件，跑完整安全序列：
 *  - 写前严格校验不过 / 计划不连续 → **拒绝修复**（零写入）；
 *  - 零损失两类：重放重复行、**可证明撞上真实续写**的合成收尾块；
 *  - 有损一类：首个异常处截断 —— **必须显式 allowLossy** 才做；
 *  - 备份必须存在且是修复前原件；写后复验；拒绝路径原件逐字节不变；回滚只认本模块的备份名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  duplicateRowIndexes,
  parseSessionRepairBackupName,
  planSessionLogRepair,
  repairSessionLogFile,
  rollbackSessionLogFile,
  sessionLogSelfCheck,
  SESSION_REPAIR_BACKUP_SUFFIX,
} from './session-log-repair.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';
import { findSyntheticCloserRun } from './session-row-facts.ts';

const CAPABLE = zstdAvailable();
const NL = String.fromCharCode(10);

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-repair-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 一份会话日志：首帧 header + 每行一帧（与 DSH 的拼接容器同形）。 */
function logBytes(rows: readonly unknown[], header: Record<string, unknown> = { type: 'session', version: 3, id: 'session-a', cwd: 'C:/proj' }): Buffer {
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + NL, 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + NL, 'utf8')));
  return Buffer.concat(parts);
}

test('T6：自我校验（严格档）—— 合法日志通过；撕裂尾帧 / 非法容器 / 坏 header / seq 回退一律拒绝', { skip: !CAPABLE }, () => {
  const ok = sessionLogSelfCheck(logBytes([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }]));
  assert.equal(ok.ok, true);
  assert.equal(ok.rows?.length, 2);

  const torn = Buffer.concat([logBytes([{ type: 'turn/start', seq: 0 }]), encodeZstdFrame(Buffer.from('{}', 'utf8')).subarray(0, 8)]);
  assert.deepEqual(sessionLogSelfCheck(torn), { ok: false, reason: 'torn-tail' }, '撕裂尾帧 DSH 自愈 —— 拒绝修复（无事可做）');

  assert.equal(sessionLogSelfCheck(Buffer.from('not zstd')).reason, 'corrupt-container');
  assert.equal(sessionLogSelfCheck(encodeZstdFrame(Buffer.from('这不是 JSON' + NL, 'utf8'))).reason, 'invalid-header');

  const regressed = sessionLogSelfCheck(logBytes([{ type: 'a', seq: 5 }, { type: 'b', seq: 2 }]));
  assert.equal(regressed.ok, false);
  assert.equal(regressed.reason, 'corrupt-container');
});

test('T6：重复行判定只认「seq 相同 + 字节相同」', { skip: !CAPABLE }, () => {
  const rows = [
    { raw: '{"a":1}', seq: 1 },
    { raw: '{"a":1}', seq: 1 },
    { raw: '{"a":2}', seq: 2 },
    { raw: '{"a":2}', seq: 3 },
    { raw: '{"b":9}', seq: 3 },
  ];
  assert.deepEqual(duplicateRowIndexes(rows), [1]);
});

test('T6：apply=false（预览）→ 零写入，只报「将丢弃 N 行」+ 动作清单', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const bytes = logBytes([{ type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'step/start', seq: 1 }]);
    await fs.writeFile(file, bytes);
    const outcome = await repairSessionLogFile(file, { apply: false });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 1);
    assert.equal(outcome.lossy, false);
    assert.deepEqual(outcome.actions?.map((a) => a.code), ['drop-duplicate-rows']);
    assert.equal(outcome.backupPath, undefined, '预览绝不产备份文件');
    assert.equal((await fs.readFile(file)).equals(bytes), true, '预览必须零写入');
  });
});

test('T6：无重复行 / 不可读文件 → nothing-to-fix / unreadable（都不是错误）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const clean = path.join(dir, 'clean.jsonl.zstd');
    await fs.writeFile(clean, logBytes([{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }]));
    assert.equal((await repairSessionLogFile(clean, { apply: true })).reason, 'nothing-to-fix');
    assert.equal((await repairSessionLogFile(path.join(dir, 'missing.zstd'), { apply: true })).reason, 'unreadable');
  });
});

test('T6：apply=true → 备份存在且等于修复前原件；原文件被原子换成修复后内容；写后复验通过', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const before = logBytes([
      { type: 'turn/start', seq: 0 },
      { type: 'step/start', seq: 1 },
      { type: 'step/start', seq: 1 },
      { type: 'turn/end', seq: 2 },
    ]);
    await fs.writeFile(file, before);
    const outcome = await repairSessionLogFile(file, { apply: true, now: () => new Date('2026-10-01T00:00:00.000Z') });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 1);
    assert.equal(outcome.keptRows, 3);
    assert.ok(outcome.backupPath !== undefined);
    assert.match(outcome.backupPath!, /\.cm-backup-2026-10-01T00-00-00-000Z$/, '备份名带时间戳');
    const backup = await fs.readFile(outcome.backupPath!);
    assert.equal(backup.equals(before), true, '备份必须是**修复前**的原件');
    const after = await fs.readFile(file);
    assert.equal(after.equals(before), false, '原文件已被换入新内容');
    const check = sessionLogSelfCheck(after);
    assert.equal(check.ok, true);
    assert.equal(check.rows?.length, 3, '4 行 → 3 行（只丢掉重复的那一行）');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.startsWith('.cm-repair-'));
    assert.deepEqual(leftovers, [], '临时文件必须清理干净');
  });
});

test('T6：拒绝路径（首个 seq 不是 0）→ 零写入、无备份、原件逐字节不变', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const before = logBytes([{ type: 'a', seq: 5 }, { type: 'b', seq: 2 }, { type: 'b', seq: 2 }]);
    await fs.writeFile(file, before);
    const outcome = await repairSessionLogFile(file, { apply: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'verification-refused', '计划发布不出任何合法内容 → 拒绝');
    assert.equal((await fs.readFile(file)).equals(before), true, '拒绝路径必须零写入');
    const entries = await fs.readdir(dir);
    assert.equal(entries.length, 1, '不得留下备份或临时文件：' + JSON.stringify(entries));
  });
});

test('T6：备份名冲突时加序号后缀（绝不覆盖已有备份）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const bytes = logBytes([{ type: 'a', seq: 0 }, { type: 'a', seq: 0 }]);
    await fs.writeFile(file, bytes);
    const fixed = () => new Date('2026-10-01T00:00:00.000Z');
    const first = await repairSessionLogFile(file, { apply: true, now: fixed });
    assert.equal(first.ok, true, JSON.stringify(first));
    await fs.writeFile(file, bytes);
    const second = await repairSessionLogFile(file, { apply: true, now: fixed });
    assert.equal(second.ok, true);
    assert.notEqual(second.backupPath, first.backupPath);
    assert.match(second.backupPath!, /-1$/);
  });
});

test('T9：可证明的合成收尾块 → 零损失丢弃（丢完 seq 仍连续）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    // 真实形态：崩溃恢复补写了 step/end + turn/end（seq 1、2），仍活着的写者随后**复用同一段 seq** 继续写
    const before = logBytes([
      { type: 'step/start', seq: 0, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 2 },
      { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
    ]);
    await fs.writeFile(file, before);
    const plan = planSessionLogRepair(before);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.lossy, false, '合成收尾块是零损失类');
    assert.deepEqual(plan.actions.map((a) => a.code), ['drop-synthetic-closer']);
    assert.equal(plan.keptRows, 3);
    const outcome = await repairSessionLogFile(file, { apply: true });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 2);
    const after = await fs.readFile(file);
    assert.equal(sessionLogSelfCheck(after).ok, true);
    assert.equal(sessionLogSelfCheck(after).rows?.length, 3, '5 行 → 3 行（真实续写保留）');
  });
});

test('T9：丢掉收尾块后 seq 不连续 → 拒绝（verification-refused，绝不发布带空洞的日志）', { skip: !CAPABLE }, () => {
  const bytes = logBytes([
    { type: 'step/start', seq: 0, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 2 },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1 } },
  ]);
  const plan = planSessionLogRepair(bytes);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'verification-refused');
});

test('T9：正常的「回合结束 → 下个回合开始」不产生任何动作（nothing-to-fix）', { skip: !CAPABLE }, () => {
  const bytes = logBytes([
    { type: 'step/end', seq: 0, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 1 },
    { type: 'turn/start', seq: 2 },
    { type: 'assistant/chunk', seq: 3, data: { turn: 2, step: 1 } },
  ]);
  const plan = planSessionLogRepair(bytes);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'nothing-to-fix');
  assert.deepEqual(plan.actions, []);
});

test('T9：有损截断必须显式放行（lossy-required → allowLossy 才截断，且先备份）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const before = logBytes([
      { type: 'step/start', seq: 0 },
      { type: 'step/end', seq: 1 },
      { type: 'turn/end', seq: 2 },
      { type: 'assistant/chunk', seq: 9, data: { turn: 2, step: 1 } },
    ]);
    await fs.writeFile(file, before);
    const refused = await repairSessionLogFile(file, { apply: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'lossy-required', '有损动作绝不默认执行');
    assert.equal((await fs.readFile(file)).equals(before), true, '拒绝时零写入');
    const outcome = await repairSessionLogFile(file, { apply: true, allowLossy: true });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.lossy, true);
    assert.deepEqual(outcome.actions?.map((a) => a.code), ['truncate-tail']);
    assert.equal(outcome.keptRows, 3);
    assert.ok(outcome.backupPath !== undefined, '有损修复同样必须先备份');
    const after = await fs.readFile(file);
    assert.equal(sessionLogSelfCheck(after).rows?.length, 3);
  });
});

test('T7：备份名判据只认本模块产生的「同日志名 + .cm-backup-<stamp>」', () => {
  assert.deepEqual(
    parseSessionRepairBackupName('session.v4.jsonl.zstd' + SESSION_REPAIR_BACKUP_SUFFIX + '2026-10-01T00-00-00-000Z'),
    { logName: 'session.v4.jsonl.zstd', stamp: '2026-10-01T00-00-00-000Z' },
  );
  assert.deepEqual(
    parseSessionRepairBackupName('session.jsonl.zstd' + SESSION_REPAIR_BACKUP_SUFFIX + '2026-10-01T00-00-00-000Z-1'),
    { logName: 'session.jsonl.zstd', stamp: '2026-10-01T00-00-00-000Z-1' },
  );
  assert.equal(parseSessionRepairBackupName('notes.txt' + SESSION_REPAIR_BACKUP_SUFFIX + 'x'), undefined);
  assert.equal(parseSessionRepairBackupName('session.v4.jsonl.zstd' + SESSION_REPAIR_BACKUP_SUFFIX), undefined);
  assert.equal(parseSessionRepairBackupName('session.v4.jsonl.zstd' + SESSION_REPAIR_BACKUP_SUFFIX + 'has space'), undefined);
  assert.equal(parseSessionRepairBackupName(SESSION_REPAIR_BACKUP_SUFFIX + 'x'), undefined);
  assert.equal(parseSessionRepairBackupName('session.v4.jsonl.zstd'), undefined);
});

test('T7：回滚把备份内容换回原文件（备份保留；临时文件清理）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const original = logBytes([{ type: 'a', seq: 0 }, { type: 'a', seq: 0 }]);
    await fs.writeFile(file, original);
    const repaired = await repairSessionLogFile(file, { apply: true, now: () => new Date('2026-10-01T00:00:00.000Z') });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    const repairedBytes = await fs.readFile(file);
    assert.equal(repairedBytes.equals(original), false);
    const back = await rollbackSessionLogFile(file, repaired.backupPath!);
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await fs.readFile(file)).equals(original), true, '回滚后必须与修复前逐字节相同');
    assert.equal((await fs.readFile(repaired.backupPath!)).equals(original), true, '备份本身保留、内容不变');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.startsWith('.cm-rollback-'));
    assert.deepEqual(leftovers, [], '回滚临时文件必须清理干净');
  });
});

test('T7：回滚拒绝不合规备份（任意路径 / 伪造内容）→ 零写入', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const original = logBytes([{ type: 'a', seq: 0 }]);
    await fs.writeFile(file, original);
    const bogusName = path.join(dir, 'session.jsonl.zstd.bak');
    await fs.writeFile(bogusName, original);
    assert.equal((await rollbackSessionLogFile(file, bogusName)).reason, 'backup-invalid');
    const otherDir = path.join(dir, 'other');
    await fs.mkdir(otherDir);
    const otherBackup = path.join(otherDir, 'session.jsonl.zstd' + SESSION_REPAIR_BACKUP_SUFFIX + 'x');
    await fs.writeFile(otherBackup, original);
    assert.equal((await rollbackSessionLogFile(file, otherBackup)).reason, 'backup-invalid');
    const fakeBackup = file + SESSION_REPAIR_BACKUP_SUFFIX + 'x';
    await fs.writeFile(fakeBackup, Buffer.from('not zstd'));
    assert.equal((await rollbackSessionLogFile(file, fakeBackup)).reason, 'backup-invalid');
    assert.equal((await fs.readFile(file)).equals(original), true, '拒绝路径必须零写入');
  });
});

test('T14：turn/end 之后只有元数据行（workspace/changes）→ **不算**合成收尾块（真机误拒的形态）', { skip: !CAPABLE }, () => {
  const bytes = logBytes([
    { type: 'step/start', seq: 0, data: { turn: 17, step: 1 } },
    { type: 'assistant/message', seq: 1, data: { turn: 17 } },
    { type: 'step/end', seq: 2, data: { turn: 17, step: 1 } },
    { type: 'turn/end', seq: 3, data: { turn: 17 } },
    // 真机证据：回合结束后的收尾元数据（同属 turn 17），不是「还在继续对话」
    { type: 'workspace/changes', seq: 4, data: { turn: 17 } },
    { type: 'turn/start', seq: 5, data: { turn: 18 } },
    { type: 'assistant/chunk', seq: 6, data: { turn: 18, step: 1 } },
  ]);
  const plan = planSessionLogRepair(bytes);
  assert.equal(plan.ok, false, '正常回合结束不得被判成合成收尾块');
  assert.equal(plan.reason, 'nothing-to-fix', JSON.stringify(plan.actions));
});

test('T14：turn/end 之后同一 turn 又有**续写事件** → 仍判合成收尾块（阳性判断不受影响）', () => {
  const rows = [
    { type: 'step/start', seq: 0, turn: 1 },
    { type: 'step/end', seq: 1, turn: 1 },
    { type: 'turn/end', seq: 2, turn: 1 },
    { type: 'assistant/chunk', seq: 3, turn: 1 },
  ];
  const run = findSyntheticCloserRun(rows);
  assert.ok(run !== undefined, '续写事件必须能让收尾块被判为合成块');
  assert.equal(run.turn, 1);
});
