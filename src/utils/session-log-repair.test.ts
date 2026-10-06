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
  SESSION_REPAIR_MAX_ROWS_PER_FRAME,
} from './session-log-repair.ts';
import { decodeZstdFrame, encodeZstdFrame, scanZstdFrames, zstdAvailable } from './zstd-frame.ts';
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

/** 一份会话日志：首帧 header + **每帧多行**（用于帧级最小写 / 分批的用例）。 */
function frameLogBytes(frames: readonly (readonly unknown[])[], header: Record<string, unknown> = { type: 'session', version: 3, id: 'session-a', cwd: 'C:/proj' }): Buffer {
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + NL, 'utf8'))];
  for (const frame of frames) parts.push(encodeZstdFrame(Buffer.from(frame.map((row) => JSON.stringify(row)).join(NL) + NL, 'utf8')));
  return Buffer.concat(parts);
}

/** 容器里**事件帧**各自承载的非空行数（帧 0 = header 不计）。 */
function eventFrameRowCounts(bytes: Buffer): number[] {
  const scan = scanZstdFrames(bytes);
  return scan.frames.slice(1).map((frame) => decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8').split(NL).filter((line) => line.trim() !== '').length);
}

/** 容器里的帧字节区间（用于断言「逐字节复用」）。 */
function frameRanges(bytes: Buffer): { start: number; end: number }[] {
  return scanZstdFrames(bytes).frames;
}

/** 官方 v0 released 打包行（无 seq；展开为 payload.length 个事件）。 */
function packedRow(seq0: number, texts: readonly string[], turn = 1): Record<string, unknown> {
  return {
    type: 'text-chunks',
    seq0,
    time0: 1000,
    data: { turn, step: 1, index: 0, dt: texts.slice(1).map(() => 1), texts: [...texts] },
  };
}

/** 显式 seq 的普通行（turn 放在 data.turn，与真机形状一致）。 */
function seqRow(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'step/start', seq, data: { turn: 1, step: 1 }, ...over };
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WS1-A packed 行跨度模型（真机 407/1194 份 v0 日志被误判有损的根因）
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** captain 定的 M8 负例：收尾块可丢，保留行带**先前就存在**的越界引用 [99]。 */
function m8Rows(): unknown[] {
  const J = (seq: number, over: Record<string, unknown>) => ({ time: 1, ...over, seq });
  return [
    J(0, { type: 'turn/start', data: { turn: 1 } }),
    J(1, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } } } }),
    J(2, { type: 'step/start', data: { turn: 1, step: 1 } }),
    J(3, { type: 'step/end', data: { turn: 1, step: 1 } }),
    J(4, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    J(3, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'real' } } }),
    J(4, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'more' } } }),
    J(5, { type: 'request/context', sourceEventSeqs: [99], data: { provider: 'p', model: 'm' } }),
  ];
}

test('WS1-A：packed 行按跨度覆盖区间 → 标量 0..16 + packed@17(三项) + 标量 20 = nothing-to-fix', { skip: !CAPABLE }, () => {
  const rows: unknown[] = [];
  for (let seq = 0; seq <= 16; seq += 1) rows.push(seqRow(seq));
  rows.push(packedRow(17, ['a', 'b', 'c']));
  rows.push(seqRow(20, { type: 'turn/end', data: { turn: 1 } }));
  const bytes = frameLogBytes([rows]);
  const strict = planSessionLogRepair(bytes, { allowLossy: false });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'nothing-to-fix', JSON.stringify({ reason: strict.reason, actions: strict.actions }));
  assert.deepEqual(strict.actions, []);
  const lossy = planSessionLogRepair(bytes, { allowLossy: true });
  assert.equal(lossy.reason, 'nothing-to-fix', 'packed 行不是有损修复对象');
  assert.equal(lossy.droppedRows, undefined);
});

test('WS1-A：畸形 packed 行（缺 seq0 / 载荷非数组 / 空载荷 / 多带 seq 键）→ refuse（undecidable），绝不 lossy-required、绝不截断', { skip: !CAPABLE }, () => {
  const cases: Record<string, unknown>[] = [
    { type: 'text-chunks', time0: 1, data: { turn: 1, texts: ['a'], dt: [] } },
    { type: 'reasoning-chunks', seq0: 1, time0: 1, data: { turn: 1, texts: 'abcdef', dt: [] } },
    { type: 'text-chunks', seq0: 1, time0: 1, data: { turn: 1, texts: [], dt: [] } },
    { type: 'text-chunks', seq: 2, seq0: 1, time0: 1, data: { turn: 1, texts: ['a', 'b'], dt: [1] } },
  ];
  for (const bad of cases) {
    const bytes = frameLogBytes([[seqRow(0), bad, seqRow(1, { type: 'turn/end', data: { turn: 1 } })]]);
    const strict = planSessionLogRepair(bytes, { allowLossy: false });
    assert.equal(strict.ok, false, JSON.stringify(bad));
    assert.equal(strict.reason, 'undecidable', JSON.stringify(bad));
    assert.deepEqual(strict.actions, [], '不可判定时不得给出任何动作（尤其不得截断）');
    const lossy = planSessionLogRepair(bytes, { allowLossy: true });
    assert.equal(lossy.reason, 'undecidable', 'allowLossy 也不许越过不可判定行：' + JSON.stringify(bad));
    assert.deepEqual(lossy.actions, []);
  }
});

test('WS1-A：packed seq0 不对齐 = 真空洞（ADV-2）→ 有损预览必须带**真实**截断规模（rows = allowLossy=true 的实际丢弃数）', { skip: !CAPABLE }, () => {
  const bytes = frameLogBytes([[seqRow(0), packedRow(3, ['a', 'b']), seqRow(5, { type: 'turn/end', data: { turn: 1 } })]]);
  const strict = planSessionLogRepair(bytes, { allowLossy: false });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'lossy-required');
  assert.deepEqual(strict.actions.map((a) => [a.code, a.rows]), [['truncate-tail', 2]], '预览必须带真实截断规模，不得为空');
  assert.equal(strict.lossy, true);
  const lossy = planSessionLogRepair(bytes, { allowLossy: true });
  assert.equal(lossy.ok, true, JSON.stringify(lossy));
  assert.equal(lossy.droppedRows, 2);
  assert.deepEqual(lossy.actions.map((a) => [a.code, a.rows]), [['truncate-tail', 2]], '预览口径必须与实际丢弃行数一致');
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WS1-B 引用完整性（前置条件 + fail-closed 后置断言）
 * ─────────────────────────────────────────────────────────────────────────────
 */

test('WS1-B 负例：先前就存在的悬空引用（seq 99）**只告警不 refuse**，closer-drop 照常执行', { skip: !CAPABLE }, async () => {
  const bytes = frameLogBytes([m8Rows()]);
  const plan = planSessionLogRepair(bytes, { allowLossy: false });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.actions.map((a) => a.code), ['drop-synthetic-closer']);
  assert.equal(plan.keptRows, 6);
  assert.equal(plan.warnings?.some((w) => w.includes('99')), true, '先前悬空引用必须可见：' + JSON.stringify(plan.warnings));
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    await fs.writeFile(file, bytes);
    const outcome = await repairSessionLogFile(file, { apply: true });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 2);
    assert.equal(outcome.warnings?.some((w) => w.includes('99')), true, '应用期同样要如实回传告警');
    assert.equal(sessionLogSelfCheck(await fs.readFile(file)).ok, true);
  });
});

test('WS1-B 正例：前向引用 + 截断使引用目标由存在变不存在 → refuse（dropped-ref，绝不返回有损预览）', { skip: !CAPABLE }, () => {
  const rows = [
    seqRow(0, { type: 'turn/start', data: { turn: 1 } }),
    { type: 'request/context', seq: 1, time: 1, sourceEventSeqs: [5], data: { provider: 'p', model: 'm' } },
    seqRow(3, { type: 'turn/start', data: { turn: 2 } }),
    seqRow(4, { type: 'turn/end', data: { turn: 2 } }),
    seqRow(5, { type: 'workspace/changes', data: { turn: 2 } }),
  ];
  const bytes = frameLogBytes([rows]);
  const strict = planSessionLogRepair(bytes, { allowLossy: false });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'dropped-ref', JSON.stringify(strict.warnings));
  assert.equal(strict.actions.length, 0, '拒绝时不得推销注定失败的有损计划');
  const lossy = planSessionLogRepair(bytes, { allowLossy: true });
  assert.equal(lossy.ok, false);
  assert.equal(lossy.reason, 'dropped-ref', 'allowLossy 也不得执行');
});

/** supplement-3 的等价状态：真实续写复用 seq，compaction 行引用被复用区间内的 seq。 */
function closerReferencedRows(continuationTurn: number): unknown[] {
  const J = (seq: number, over: Record<string, unknown>) => ({ time: 1, ...over, seq });
  return [
    J(0, { type: 'turn/start', data: { turn: 1 } }),
    J(1, { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } } } }),
    J(2, { type: 'step/start', data: { turn: 1, step: 1 } }),
    J(3, { type: 'step/end', data: { turn: 1, step: 1 } }),
    J(4, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    J(3, { type: 'assistant/chunk', data: { turn: continuationTurn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'real continuation' } } }),
    J(4, { type: 'assistant/chunk', data: { turn: continuationTurn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'more' } } }),
    J(5, { type: 'compaction/summary', sourceEventSeqs: [3], data: { compactionId: 'c1', summary: 's', shadowedRange: [3, 4], shadowedSeqs: [3, 4], shadowedTokenCount: 2, provider: 'p', model: 'm' } }),
  ];
}

test('WS1-B：跳过 closer-drop 之后管线不得降级成有损截断（等价状态 B → refuse，不是 lossy-required + truncate-tail）', { skip: !CAPABLE }, () => {
  for (const turn of [1, 2]) {
    const bytes = frameLogBytes([closerReferencedRows(turn)]);
    const strict = planSessionLogRepair(bytes, { allowLossy: false });
    assert.equal(strict.ok, false, 'turn=' + String(turn));
    assert.equal(strict.reason, 'dropped-ref', 'turn=' + String(turn) + ' ' + JSON.stringify({ reason: strict.reason, actions: strict.actions }));
    assert.notEqual(strict.reason, 'lossy-required');
    assert.equal(strict.actions.some((a) => a.code === 'truncate-tail'), false, '不得出现 truncate-tail 预览');
    const lossy = planSessionLogRepair(bytes, { allowLossy: true });
    assert.equal(lossy.reason, 'dropped-ref', 'allowLossy 同样 refuse：turn=' + String(turn));
  }
});

test('WS1-B 前置条件：closer 区间被保留行引用 → **不计划该动作**（nothing-to-fix + 告警，不静默丢弃）', { skip: !CAPABLE }, () => {
  const rows = [
    seqRow(0, { type: 'turn/start', data: { turn: 1 } }),
    seqRow(1, { type: 'assistant/message', data: { turn: 1, step: 1 } }),
    seqRow(2, { type: 'step/end', data: { turn: 1, step: 1 } }),
    seqRow(3, { type: 'turn/end', data: { turn: 1 } }),
    seqRow(4, { type: 'assistant/chunk', data: { turn: 1, step: 1 } }),
    { type: 'compaction/summary', seq: 5, time: 1, sourceEventSeqs: [2], data: { compactionId: 'c1' } },
  ];
  const bytes = frameLogBytes([rows]);
  const plan = planSessionLogRepair(bytes, { allowLossy: false });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'nothing-to-fix', JSON.stringify({ reason: plan.reason, actions: plan.actions }));
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.warnings?.some((w) => w.includes('收尾块')), true, '跳过动作必须可见：' + JSON.stringify(plan.warnings));
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WS1-C 帧级最小写
 * ─────────────────────────────────────────────────────────────────────────────
 */

test('WS1-C 帧复用：只有第 2 帧含重复行 → 第 0/1/3 帧逐字节复用；备份=原件、写后复验、临时文件清理', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const before = frameLogBytes([[seqRow(0)], [seqRow(1), seqRow(1)], [seqRow(2)]]);
    await fs.writeFile(file, before);
    const beforeRanges = frameRanges(before);
    assert.equal(beforeRanges.length, 4, 'header + 3 个事件帧');
    const outcome = await repairSessionLogFile(file, { apply: true, now: () => new Date('2026-10-01T00:00:00.000Z') });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 1);
    assert.equal(outcome.keptRows, 3);
    const after = await fs.readFile(file);
    const afterRanges = frameRanges(after);
    assert.equal(afterRanges.length, 4, '第 2 帧重编码，帧数不变：' + JSON.stringify(afterRanges.length));
    for (const index of [0, 1, 3]) {
      const got = after.subarray(afterRanges[index]!.start, afterRanges[index]!.end);
      const want = before.subarray(beforeRanges[index]!.start, beforeRanges[index]!.end);
      assert.equal(got.equals(want), true, '帧 ' + String(index) + ' 必须逐字节复用原文');
    }
    assert.equal(sessionLogSelfCheck(after).rows?.length, 3);
    assert.equal((await fs.readFile(outcome.backupPath!)).equals(before), true, '备份必须等于修复前原件');
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith('.cm-repair-')), [], '临时文件必须清理干净');
  });
});

test('WS1-C 行数口径：重编码时**打包行按 1 行计**（帧内行数 = 非空行数）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    // seq 0、packed@1（1 个事件）、seq 2、seq 2（重放重复）→ 去重后 3 行（含 packed 1 行）
    const before = frameLogBytes([[seqRow(0), packedRow(1, ['a']), seqRow(2), seqRow(2)]]);
    await fs.writeFile(file, before);
    const outcome = await repairSessionLogFile(file, { apply: true });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 1);
    const after = await fs.readFile(file);
    assert.deepEqual(eventFrameRowCounts(after), [3], 'packed 行只算 1 行');
    assert.equal(sessionLogSelfCheck(after).rows?.length, 3);
  });
});

test('WS1-C 分批：>500 行的单帧需要重编码 → 没有任何事件帧承载超过 200 行', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.jsonl.zstd');
    const rows: unknown[] = [];
    for (let seq = 0; seq < 600; seq += 1) rows.push(seqRow(seq));
    rows.splice(300, 0, seqRow(299)); // 重放重复行（同一 seq + 同一字节）→ 601 行，去重后 600 行
    const before = frameLogBytes([rows]);
    await fs.writeFile(file, before);
    assert.deepEqual(eventFrameRowCounts(before), [601], '原文是一个 601 行的单帧');
    const outcome = await repairSessionLogFile(file, { apply: true });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.droppedRows, 1);
    const after = await fs.readFile(file);
    const counts = eventFrameRowCounts(after);
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 600, '保留 600 行：' + JSON.stringify(counts));
    for (const count of counts) {
      assert.ok(count <= SESSION_REPAIR_MAX_ROWS_PER_FRAME, '任一事件帧不得超过 ' + String(SESSION_REPAIR_MAX_ROWS_PER_FRAME) + ' 行：' + JSON.stringify(counts));
    }
    assert.ok(counts.length >= 2, '绝不能产生「单帧承载全量事件」：' + JSON.stringify(counts));
    assert.equal(sessionLogSelfCheck(after).rows?.length, 600);
  });
});

