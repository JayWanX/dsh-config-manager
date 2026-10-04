/**
 * 会话体检采集器（T3）单测 —— 用**真实临时 home + 真实 zstd 帧**跑：
 *  - 结构档（首帧 header / 撕裂尾帧 / 非法帧 / 空目录）；
 *  - 行档（不可解析行 / 字节相同的重复已提交行 / seq 空洞 / 能证明撞上真实续写的合成 closer 块）；
 *  - 限额与「未检查如实计数」；
 *  - **只读**：整次扫描前后字节逐字节不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanSessionHealth, DEFAULT_MAX_UNITS } from './session-health-scan.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';

const CAPABLE = zstdAvailable();
const KEY = '--D-proj--';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-health-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 一份会话日志：首帧 header + 若干事件帧（每帧一行 JSON，与 DSH 的拼接容器同形）。 */
function logBytes(header: Record<string, unknown>, rows: readonly unknown[] = []): Buffer {
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + '\n', 'utf8')));
  return Buffer.concat(parts);
}

async function writeLog(home: string, projectKey: string, sessionId: string, name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(home, 'sessions', projectKey, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

test('T3 采集器：健康会话 → ok + 版本/cwd/体积如实回传', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const bytes = logBytes({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }, [{ type: 'turn/start', seq: 0 }]);
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', bytes);
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    assert.equal(result.sessionsDirExists, true);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.unitId, KEY + '/session-a');
    assert.equal(row.version, 3);
    assert.equal(row.cwd, 'D:\\proj');
    assert.equal(row.sizeBytes, bytes.length);
    assert.equal(row.severity, 'ok', JSON.stringify(row.issues));
    assert.equal(result.summary.deepVerified, 1, '限额内的会话必须跑行档');
    assert.equal(result.untested, 0);
    assert.equal(result.unreadableEntries, 0);
  });
});

test('T3 采集器：首帧读不出 → unloadable，且**如实区分**「非法帧」与「帧合法但 header 解析不了」', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    // ① 魔数都不对 → corrupt-frame（帧扫描阶段就失败，不猜成 header 问题）
    await writeLog(home, KEY, 'garbage', 'session.jsonl.zstd', Buffer.from('not zstd at all'));
    // ② 帧合法、但解出来的不是单行 JSON 对象 → header-unreadable
    await writeLog(home, KEY, 'badheader', 'session.jsonl.zstd', encodeZstdFrame(Buffer.from('这不是 JSON\n', 'utf8')));
    // ③ 0 字节文件 → header-unreadable（没有任何事实可判，绝不编造原因）
    await writeLog(home, KEY, 'empty', 'session.jsonl.zstd', Buffer.alloc(0));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const byId = new Map(result.rows.map((r) => [r.sessionId, r]));
    assert.deepEqual(byId.get('garbage')?.issues.map((i) => i.code), ['corrupt-frame']);
    // 「帧合法但不是 header」= header-unreadable；同一帧里那行也解不出事件 → 如实带上 unparsable-event
    assert.deepEqual(byId.get('badheader')?.issues.map((i) => i.code).sort(), ['header-unreadable', 'unparsable-event']);
    assert.deepEqual(byId.get('empty')?.issues.map((i) => i.code), ['header-unreadable']);
    for (const row of result.rows) assert.equal(row.severity, 'unloadable');
  });
});

test('T3 采集器：合法帧 + 尾部撕裂 → 只提示 self-healing（DSH 自愈）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const full = logBytes({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }, [{ type: 'turn/start', seq: 0 }]);
    // 尾部再拼半帧（模拟崩溃写入）：DSH 会自愈，体检只提示
    const torn = Buffer.concat([full, encodeZstdFrame(Buffer.from('{"type":"turn/end"}\n', 'utf8')).subarray(0, 12)]);
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', torn);
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const row = result.rows[0]!;
    assert.deepEqual(row.issues.map((i) => i.code), ['torn-tail']);
    assert.equal(row.severity, 'ok');
  });
});

test('T3 采集器 行档：字节相同的重复已提交行 / seq 空洞 / 不可解析行 都能被证明', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const rows = [
      { type: 'turn/start', seq: 0 },
      { type: 'step/start', seq: 1 },
      { type: 'step/start', seq: 1 },      // 字节相同 + seq 相同 = 重放族
      { type: 'step/end', seq: 4 },        // 1 → 4：一个真实空洞
    ];
    const parts: Buffer[] = [
      encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }) + '\n', 'utf8')),
      ...rows.map((r) => encodeZstdFrame(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))),
      encodeZstdFrame(Buffer.from('{ this is not json }\n', 'utf8')),
    ];
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', Buffer.concat(parts));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const codes = result.rows[0]!.issues.map((i) => i.code);
    assert.ok(codes.includes('replay-duplicate-rows'), JSON.stringify(result.rows[0]));
    assert.ok(codes.includes('seq-gap'));
    assert.ok(codes.includes('unparsable-event'));
    assert.equal(result.rows[0]!.severity, 'unloadable', '不可解析事件是最重的一档');
  });
});

test('T3 采集器 行档：收尾块之后**同一回合还在续写** → synthetic-closer（可证明的撞号）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const parts: Buffer[] = [
      encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }) + '\n', 'utf8')),
      ...[
        { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1 } },
        { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5 },
        // 崩溃恢复补写的 closer 撞上仍活着的写者：没有 turn/start，同一回合继续
        { type: 'assistant/chunk', seq: 6, data: { turn: 1, step: 1 } },
      ].map((r) => encodeZstdFrame(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))),
    ];
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', Buffer.concat(parts));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    assert.ok(result.rows[0]!.issues.some((i) => i.code === 'synthetic-closer'), JSON.stringify(result.rows[0]));
  });
});

test('T3 采集器 行档：正常的「回合结束 → 下个回合开始」不得误报 synthetic-closer（真机 86 条误报的形态）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const parts: Buffer[] = [
      encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }) + '\n', 'utf8')),
      ...[
        { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4 },
        { type: 'session/title', seq: 5 },
        { type: 'agent/inbox/spliced', seq: 6 },
        { type: 'turn/start', seq: 7 },
        { type: 'assistant/chunk', seq: 8, data: { turn: 2, step: 1 } },
      ].map((r) => encodeZstdFrame(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))),
    ];
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', Buffer.concat(parts));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const codes = result.rows[0]!.issues.map((i) => i.code);
    assert.equal(codes.includes('synthetic-closer'), false, JSON.stringify(result.rows[0]));
    assert.equal(result.rows[0]!.severity, 'ok', '健康会话不得标红: ' + JSON.stringify(codes));
  });
});

test('T3 采集器：deepLimit=0 → 只做结构档（如实计入「未验证」，绝不产出行档结论）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const rows = [
      { type: 'step/start', seq: 1 },
      { type: 'step/start', seq: 1 },
    ];
    const parts: Buffer[] = [
      encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' }) + '\n', 'utf8')),
      ...rows.map((r) => encodeZstdFrame(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))),
    ];
    await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', Buffer.concat(parts));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3, deepLimit: 0 });
    assert.equal(result.summary.deepVerified, 0);
    assert.equal(result.summary.deepUnverified, 1);
    assert.equal(
      result.rows[0]!.issues.some((i) => i.code === 'replay-duplicate-rows'),
      false,
      '没跑行档就不得下结论',
    );
  });
});

test('T3 采集器：单元数超限 → 未检查的如实计数（untested），已扫的照常出结果', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const bytes = logBytes({ type: 'session', version: 3, id: 'x', cwd: 'D:\\proj' });
    for (const id of ['s1', 's2', 's3']) await writeLog(home, KEY, id, 'session.jsonl.zstd', bytes);
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3, maxUnits: 1 });
    assert.equal(result.rows.length, 1);
    assert.equal(result.untested, 2, '未检查的必须如实计数（界面要写明「另有 N 条未检查」）');
    assert.equal(DEFAULT_MAX_UNITS >= 100, true);
  });
});

test('T3 采集器：非 projectKey 形状的目录被跳过（隔离目录不会污染结论）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    await writeLog(home, '.cm-repair-quarantine-2026', 'session-a', 'session.jsonl.zstd', logBytes({ version: 3, id: 'a', cwd: 'D:\\proj' }));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    assert.equal(result.rows.length, 0);
  });
});

test('T3 采集器：会话根不存在 → 空结果（不是错误、不抛错）', async () => {
  await withTmp(async (home) => {
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    assert.equal(result.sessionsDirExists, false);
    assert.deepEqual(result.rows, []);
    assert.equal(result.summary.total, 0);
  });
});

test('T3 采集器：只读 —— 扫描前后文件字节与 mtime 逐字节不变', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const file = await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', logBytes({ version: 3, id: 'session-a', cwd: 'D:\\proj' }, [{ type: 'turn/start', seq: 0 }]));
    const before = await fs.readFile(file);
    const beforeStat = await fs.stat(file);
    await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const after = await fs.readFile(file);
    const afterStat = await fs.stat(file);
    assert.equal(before.equals(after), true, '体检绝不允许改写会话字节');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '也不得触碰 mtime');
  });
});
