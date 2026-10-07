/**
 * 会话体检采集器（T3）单测 —— 用**真实临时 home + 真实 zstd 帧**跑：
 *  - 结构档（首帧 header / 撕裂尾帧 / 非法帧 / 空目录）；
 *  - 行档（不可解析行 / 字节相同的重复已提交行 / seq 空洞 / 能证明撞上真实续写的合成 closer 块）；
 *  - 限额与「未检查如实计数」；
 *  - **只读**：整次扫描前后字节（含 sha256）与 mtime 不变；
 *  - T4：工具生命周期四类 + tool/result 配对（只报不修；严重级 = 真 codec 实测口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

/* ---------------- C1：knownSessionIds —— 「未知」不得被伪造成「确知为空集」 ---------------- */

/** 子代理会话 header（磁盘上父对话字段叫 parentSession；采集器按 session-log 的别名映射成 parentSessionId）。 */
function subagentHeader(id: string, parent: string): Record<string, unknown> {
  return { type: 'session', version: 3, id, cwd: 'D:\\proj', origin: 'subagent', parentSession: parent };
}

test('C1 采集器：不传 knownSessionIds → 用本次遍历到的全部单元自证（父对话在本机就不报缺父）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    await writeLog(home, KEY, 'session-parent', 'session.jsonl.zstd', logBytes({ type: 'session', version: 3, id: 'parent', cwd: 'D:\\proj' }));
    await writeLog(home, KEY, 'session-child', 'session.jsonl.zstd', logBytes(subagentHeader('child', 'parent')));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const child = result.rows.find((row) => row.sessionId === 'session-child');
    assert.ok(child !== undefined);
    assert.equal(
      child.issues.some((issue) => issue.code === 'subagent-without-parent'),
      false,
      '父对话就在本机，不得报缺父: ' + JSON.stringify(child.issues),
    );
    assert.equal(result.summary.bySeverity.invisible, 0, 'invisible 必须归零（旧行为是全都算缺父）');
  });
});

test('C1 采集器：不传 knownSessionIds 且父对话真的不在本机 → 仍报缺父（自证不是「一律不报」）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    await writeLog(home, KEY, 'session-child', 'session.jsonl.zstd', logBytes(subagentHeader('child', 'no-such-parent')));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3 });
    const row = result.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.issues.some((issue) => issue.code === 'subagent-without-parent'), true, JSON.stringify(row));
    assert.equal(result.summary.bySeverity.invisible, 1);
  });
});

test('C1 采集器：调用方提供了 knownSessionIds 就用它的（显式空集 = 确知本机没有该父 → 报）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    await writeLog(home, KEY, 'session-parent', 'session.jsonl.zstd', logBytes({ type: 'session', version: 3, id: 'parent', cwd: 'D:\\proj' }));
    await writeLog(home, KEY, 'session-child', 'session.jsonl.zstd', logBytes(subagentHeader('child', 'parent')));
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 3, knownSessionIds: new Set<string>() });
    const child = result.rows.find((row) => row.sessionId === 'session-child');
    assert.ok(child !== undefined);
    assert.equal(
      child.issues.some((issue) => issue.code === 'subagent-without-parent'),
      true,
      '调用方给的集合优先于采集器自证（显式空集 = 确知本机没有该父）',
    );
  });
});

/* ---------------- T4：工具生命周期四类 + tool/result 配对（只报不修；严重级 = 真 codec 实测口径） ---------------- */

const T4_V4 = { type: 'session', version: 4, id: 'session-a', cwd: 'D:\\proj' };
const T4_V3 = { type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' };
const T4_NEW_CODES = ['missing-message-id', 'empty-tool-call-id', 'dangling-tool-call', 'duplicate-tool-call-id', 'tool-result-id-mismatch'] as const;

/** 健康骨架：turn/start → step/start → user → assistant(含 tool-call 块) → tool/call → tool/result → step/end → turn/end */
function t4Rows(): Record<string, any>[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    {
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant', id: 'a1', source: { kind: 'model' },
          content: [{ type: 'text', text: 'x' }, { type: 'tool-call', id: 'c1', name: 'n', arguments: '{}' }],
        },
      },
    },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'n', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', id: 'r1', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

const T4_USER = 2;
const T4_ASSISTANT = 3;
const T4_CALL = 4;
const T4_RESULT = 5;

function t4Clone(rows: Record<string, any>[]): Record<string, any>[] {
  return JSON.parse(JSON.stringify(rows)) as Record<string, any>[];
}

async function t4Scan(
  entries: { id: string; header: Record<string, unknown>; rows: readonly unknown[] }[],
  opts: Record<string, unknown> = {},
) {
  return withTmp(async (home) => {
    for (const e of entries) await writeLog(home, KEY, e.id, 'session.jsonl.zstd', logBytes(e.header, e.rows));
    return scanSessionHealth({ homeDir: home, targetFormatVersion: 4, ...opts });
  });
}

function t4Row(result: Awaited<ReturnType<typeof t4Scan>>, id: string) {
  const row = result.rows.find((r) => r.sessionId === id);
  assert.ok(row !== undefined, '缺少体检行: ' + id);
  return row;
}

function t4Codes(row: { issues: readonly { code: string }[] }): string[] {
  return row.issues.map((issue) => issue.code);
}

test('T4 行档 ①（t13 口径订正）：v4 缺 message id —— user/assistant/tool/result 三载体一律 unloadable', { skip: !CAPABLE }, async () => {
  const healthy = t4Clone(t4Rows());
  const noUser = t4Clone(t4Rows());
  delete noUser[T4_USER]!.data.id;
  const noAssistant = t4Clone(t4Rows());
  delete noAssistant[T4_ASSISTANT]!.data.message.id;
  const noResult = t4Clone(t4Rows());
  delete noResult[T4_RESULT]!.data.message.id;
  const result = await t4Scan([
    { id: 'healthy', header: T4_V4, rows: healthy },
    { id: 'no-user', header: T4_V4, rows: noUser },
    { id: 'no-assistant', header: T4_V4, rows: noAssistant },
    { id: 'no-result', header: T4_V4, rows: noResult },
  ]);
  assert.deepEqual(t4Codes(t4Row(result, 'healthy')), [], '健康骨架不得报任何新码');
  const user = t4Row(result, 'no-user');
  assert.deepEqual(t4Codes(user), ['missing-message-id']);
  assert.equal(user.severity, 'unloadable', 'v4 走安装版 Session 的 seed/restore 闸门：seed user/message at index 9 lacks an identified message');
  assert.equal(String(user.issues[0]?.detail).includes('codec-uncalibrated'), false, 'v4 已实测拒读，不得再标未校准');
  assert.equal(t4Row(result, 'no-assistant').severity, 'unloadable', 'assistant/message 同样被 seed/restore 闸门拒读');
  const toolResult = t4Row(result, 'no-result');
  assert.deepEqual(t4Codes(toolResult), ['missing-message-id']);
  assert.equal(toolResult.severity, 'unloadable', 'tool/result 缺 message.id = 真 codec decodeRow 当场拒读');
});

test('T4 行档 ①：pre-v4 缺 message id → unloadable（v0→v1 / v3→v4 迁移器直接拒）', { skip: !CAPABLE }, async () => {
  const noUser = t4Clone(t4Rows());
  delete noUser[T4_USER]!.data.id;
  const noAssistant = t4Clone(t4Rows());
  delete noAssistant[T4_ASSISTANT]!.data.message.id;
  const noResult = t4Clone(t4Rows());
  delete noResult[T4_RESULT]!.data.message.id;
  const result = await t4Scan([
    { id: 'v3-user', header: T4_V3, rows: noUser },
    { id: 'v3-assistant', header: T4_V3, rows: noAssistant },
    { id: 'v3-result', header: T4_V3, rows: noResult },
  ]);
  for (const id of ['v3-user', 'v3-assistant', 'v3-result']) {
    const row = t4Row(result, id);
    assert.deepEqual(t4Codes(row), ['missing-message-id'], id);
    assert.equal(row.severity, 'unloadable', id);
  }
});

test('T4 行档 ②（t13 口径订正）：空 tool-call id 只进 empty-tool-call-id（v4 / pre-v4 均 unloadable）', { skip: !CAPABLE }, async () => {
  const emptyCall = t4Clone(t4Rows());
  emptyCall[T4_CALL]!.data.callId = '';
  const emptyBlock = t4Clone(t4Rows());
  emptyBlock[T4_ASSISTANT]!.data.message.content[1].id = '';
  const nonEmpty = t4Clone(t4Rows());
  const result = await t4Scan([
    { id: 'empty-call', header: T4_V4, rows: emptyCall },
    { id: 'empty-block', header: T4_V4, rows: emptyBlock },
    { id: 'non-empty', header: T4_V4, rows: nonEmpty },
    { id: 'v3-empty-call', header: T4_V3, rows: emptyCall },
  ]);
  for (const id of ['empty-call', 'empty-block']) {
    const row = t4Row(result, id);
    assert.deepEqual(t4Codes(row), ['empty-tool-call-id'], id);
    assert.equal(row.severity, 'unloadable', id + '：v4 走 Session.fromRestore 闸门 → tool call id requires a nonempty string');
  }
  assert.equal(t4Codes(t4Row(result, 'non-empty')).includes('empty-tool-call-id'), false, '反例：非空 id 不报');
  assert.equal(t4Row(result, 'v3-empty-call').severity, 'unloadable', 'pre-v4 迁移器直接拒');
});

test('T4 行档（t13/t16）：版本读不出 → 三个码仍取较轻的 nextRequestFails 并注明未校准（口径不变）', { skip: !CAPABLE }, async () => {
  // header 缺 version 字段：readLogHeaderFromBytes 只认「非负安全整数」，缺字段 = 版本不可读
  const noVersion = { type: 'session', id: 'session-a', cwd: 'D:\\proj' };
  const noUser = t4Clone(t4Rows());
  delete noUser[T4_USER]!.data.id;
  const emptyCall = t4Clone(t4Rows());
  emptyCall[T4_CALL]!.data.callId = '';
  const dupBlock = t4Clone(t4Rows());
  dupBlock[T4_ASSISTANT]!.data.message.content.push({ type: 'tool-call', id: 'c1', name: 'n', arguments: '{}' });
  const result = await t4Scan([
    { id: 'nover-user', header: noVersion, rows: noUser },
    { id: 'nover-call', header: noVersion, rows: emptyCall },
    { id: 'nover-dup', header: noVersion, rows: dupBlock },
  ]);
  for (const id of ['nover-user', 'nover-call', 'nover-dup']) {
    const row = t4Row(result, id);
    assert.equal(row.severity, 'nextRequestFails', id + '：版本不可读 → 宁可取较轻并注明，不谎称已校准');
    assert.match(String(row.issues[0]?.detail), /codec-uncalibrated/, id);
  }
});

test('T4 行档 ③：已关闭 step 的悬空 tool/call → unloadable；尾部 step 未闭合 → 不报；空 id 的 call 只进 ②', { skip: !CAPABLE }, async () => {
  const dangling = t4Clone(t4Rows());
  dangling.splice(T4_RESULT, 1);
  const openTail = t4Clone(t4Rows());
  openTail.splice(T4_RESULT, 1);
  openTail.splice(openTail.length - 2, 2); // 去掉 step/end + turn/end：尾部 step 仍开着（正常崩溃形状）
  const emptyCallClosed = t4Clone(t4Rows());
  emptyCallClosed.splice(T4_RESULT, 1);
  emptyCallClosed[T4_CALL]!.data.callId = '';
  // 内容块的 id 也必须置空：T18 起「只由 assistant 内容块声明、没有结果、step 已闭合」本身就是悬空，
  // 若这里仍留着合法的 c1，这条样本就会同时（正确地）报出 dangling，污染本断言。
  emptyCallClosed[T4_ASSISTANT]!.data.message.content[1].id = '';
  const paired = t4Clone(t4Rows());
  const result = await t4Scan([
    { id: 'dangling', header: T4_V4, rows: dangling },
    { id: 'open-tail', header: T4_V4, rows: openTail },
    { id: 'empty-call-closed', header: T4_V4, rows: emptyCallClosed },
    { id: 'paired', header: T4_V4, rows: paired },
  ]);
  const found = t4Row(result, 'dangling');
  assert.deepEqual(t4Codes(found), ['dangling-tool-call']);
  assert.equal(found.severity, 'unloadable');
  assert.deepEqual(t4Codes(t4Row(result, 'open-tail')), [], '尾部未闭合的 step 是正常崩溃形状（引擎会补 closer），不得报');
  assert.deepEqual(t4Codes(t4Row(result, 'empty-call-closed')), ['empty-tool-call-id'], '空 id 的 call 只进 ②，不得同时进 dangling');
  assert.equal(t4Codes(t4Row(result, 'paired')).includes('dangling-tool-call'), false, '反例：有配对 tool/result 不报');
});

test('T18（W3-F1）：只由 assistant 内容块声明的悬空调用 —— step 已闭合要报、尾部未闭合不报', { skip: !CAPABLE }, async () => {
  // block-only：删掉 tool/call 行与 tool/result，只留 assistant/message 内容块里的 c1
  const blockOnlyClosed = t4Clone(t4Rows());
  blockOnlyClosed.splice(T4_RESULT, 1);
  blockOnlyClosed.splice(T4_CALL, 1);
  const blockOnlyByTurn = t4Clone(blockOnlyClosed);
  blockOnlyByTurn.splice(blockOnlyByTurn.findIndex((r) => r.type === 'step/end'), 1); // 只剩 turn/end
  const blockOnlyOpenTail = t4Clone(blockOnlyClosed);
  blockOnlyOpenTail.splice(blockOnlyOpenTail.length - 2, 2); // 去掉 step/end + turn/end：尾部 step 仍开着
  const result = await t4Scan([
    { id: 'block-only-closed', header: T4_V4, rows: blockOnlyClosed },
    { id: 'block-only-turn-close', header: T4_V4, rows: blockOnlyByTurn },
    { id: 'block-only-open-tail', header: T4_V4, rows: blockOnlyOpenTail },
  ]);
  for (const id of ['block-only-closed', 'block-only-turn-close']) {
    const row = t4Row(result, id);
    assert.deepEqual(t4Codes(row), ['dangling-tool-call'], id);
    assert.equal(row.severity, 'unloadable', id);
    assert.equal(row.issues[0]?.detail, '1 unresolved', id);
  }
  assert.deepEqual(
    t4Codes(t4Row(result, 'block-only-open-tail')),
    [],
    '尾部 step 仍开着 = 正常崩溃形状（引擎补 closer），不得报',
  );
});

test('T18（W3-F1）：既有 tool/call 行 + assistant 内容块同 callId 只报一次（不双报）', { skip: !CAPABLE }, async () => {
  // 行与块都声明 c1、都没有结果、step 已闭合：共用一个 calls 队列 → 只应计 1 处悬空
  const bothCarriers = t4Clone(t4Rows());
  bothCarriers.splice(T4_RESULT, 1);
  const result = await t4Scan([{ id: 'both-carriers', header: T4_V4, rows: bothCarriers }]);
  const row = t4Row(result, 'both-carriers');
  assert.deepEqual(t4Codes(row), ['dangling-tool-call']);
  assert.equal(row.severity, 'unloadable');
  assert.equal(row.issues[0]?.detail, '1 unresolved', '同一 callId 的两个载体只算一次');
});

test('T4 行档 ③：turn/end 也关闭其回合里仍开着的 step（漏 step/end 的崩溃恢复形状）', { skip: !CAPABLE }, async () => {
  const dangling = t4Clone(t4Rows());
  dangling.splice(T4_RESULT, 1);
  const stepEndIndex = dangling.findIndex((r) => r.type === 'step/end');
  dangling.splice(stepEndIndex, 1); // 只剩 turn/end
  const result = await t4Scan([{ id: 'turn-close', header: T4_V4, rows: dangling }]);
  assert.deepEqual(t4Codes(t4Row(result, 'turn-close')), ['dangling-tool-call']);
});

test('T4 行档 ④（t16 口径订正）：同一步重复通告同一 callId → unloadable；健康形态「1 内容块 + 1 tool/call 行」不得误报', { skip: !CAPABLE }, async () => {
  const dupRow = t4Clone(t4Rows());
  dupRow.splice(T4_CALL + 1, 0, t4Clone(t4Rows())[T4_CALL]!);
  const dupBlock = t4Clone(t4Rows());
  dupBlock[T4_ASSISTANT]!.data.message.content.push({ type: 'tool-call', id: 'c1', name: 'n', arguments: '{}' });
  const healthy = t4Clone(t4Rows());
  const result = await t4Scan([
    { id: 'dup-row', header: T4_V4, rows: dupRow },
    { id: 'dup-block', header: T4_V4, rows: dupBlock },
    { id: 'healthy', header: T4_V4, rows: healthy },
  ]);
  assert.equal(
    t4Codes(t4Row(result, 'healthy')).includes('duplicate-tool-call-id'),
    false,
    '真机健康日志里同一个 callId 本来就会同时出现在内容块与 tool/call 行 —— 跨类相加必然误报',
  );
  for (const id of ['dup-row', 'dup-block']) {
    const row = t4Row(result, id);
    assert.deepEqual(t4Codes(row), ['duplicate-tool-call-id'], id);
    assert.equal(row.severity, 'unloadable', id + '：v4 走 Session.fromRestore 闸门 → assistant/message repeats advertised tool call');
  }
});

test('T4 行档 ⑤：tool/result 的 toolCallId 缺失或与 source.callId 不一致 → unloadable（B5/B7 两类形状）', { skip: !CAPABLE }, async () => {
  const missingToolCallId = t4Clone(t4Rows());
  delete missingToolCallId[T4_RESULT]!.data.message.toolCallId;
  const sourceMismatch = t4Clone(t4Rows());
  sourceMismatch[T4_RESULT]!.data.message.source.callId = 'call-other';
  const v3Shape = t4Clone(t4Rows());
  {
    const message = v3Shape[T4_RESULT]!.data.message;
    delete message.toolCallId;
    message.content = [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }];
  }
  const result = await t4Scan([
    { id: 'missing-toolcallid', header: T4_V4, rows: missingToolCallId },
    { id: 'source-mismatch', header: T4_V4, rows: sourceMismatch },
    { id: 'v3-shape', header: T4_V3, rows: v3Shape },
  ]);
  const missing = t4Row(result, 'missing-toolcallid');
  assert.deepEqual(t4Codes(missing), ['tool-result-id-mismatch']);
  assert.equal(missing.severity, 'unloadable');
  // source.callId 被改坏后，这条 call 也就没有配对结果了 —— 悬空一并如实报出（不同 code）
  assert.ok(t4Codes(t4Row(result, 'source-mismatch')).includes('tool-result-id-mismatch'));
  assert.equal(t4Row(result, 'source-mismatch').severity, 'unloadable');
  assert.equal(
    t4Codes(t4Row(result, 'v3-shape')).includes('tool-result-id-mismatch'),
    false,
    'v0/v3 形状（content[0].toolCallId 配对）必须放行',
  );
});

test('T4 行档：未做行档（deepLimit=0）的会话不得出现任何新 code', { skip: !CAPABLE }, async () => {
  const broken = t4Clone(t4Rows());
  delete broken[T4_USER]!.data.id;
  delete broken[T4_RESULT]!.data.message.toolCallId;
  broken[T4_CALL]!.data.callId = '';
  const result = await t4Scan([{ id: 'broken', header: T4_V4, rows: broken }], { deepLimit: 0 });
  assert.equal(result.summary.deepVerified, 0);
  assert.equal(result.summary.deepUnverified, 1);
  const codes = t4Codes(t4Row(result, 'broken'));
  for (const code of T4_NEW_CODES) assert.equal(codes.includes(code), false, '没跑行档就不得下结论: ' + code);
});

test('T4 只读：含四类新码的日志扫描前后文件字节与 mtime 逐字节不变', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const broken = t4Clone(t4Rows());
    delete broken[T4_USER]!.data.id;                          // ①
    broken[T4_ASSISTANT]!.data.message.content[1].id = '';   // ②
    broken.splice(T4_RESULT, 1);                             // ③（step 已关闭）
    const file = await writeLog(home, KEY, 'session-a', 'session.jsonl.zstd', logBytes(T4_V4, broken));
    const before = await fs.readFile(file);
    const beforeStat = await fs.stat(file);
    const result = await scanSessionHealth({ homeDir: home, targetFormatVersion: 4 });
    assert.ok(result.rows[0]!.issues.some((i) => T4_NEW_CODES.includes(i.code as typeof T4_NEW_CODES[number])));
    const after = await fs.readFile(file);
    const afterStat = await fs.stat(file);
    assert.equal(before.equals(after), true, '体检绝不允许改写会话字节');
    assert.equal(sha256Of(after), sha256Of(before), 'sha256 也不得变化');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '也不得触碰 mtime');
  });
});

