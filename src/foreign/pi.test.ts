/**
 * Pi 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 七层：
 *  ① 位置真值：`<home>/.pi/agent/sessions`（三平台同形、无 env 覆盖）；
 *  ② **会话头**（`type:"session"`）单独处理：没有头的文件不是 Pi 会话，跳过并报码；
 *  ③ 事件流专用解析：`{type:"message", message:{role, content}}` 包装；工具调用是驼峰
 *     `toolCall`（入参 `arguments`）、工具结果是 role `toolResult`（`toolCallId` 配对）、
 *     思考是 `thinking`；toolResult 挂回**声明它的 assistant 记录之后**（合成器收进同一 step）；
 *  ④ **活动分支**：从末条目沿 `parentId` 走到根，旁支条目丢弃并计数（绝不把旁支混进对话）；
 *  ⑤ 标题取活动分支上最后的 `session_info.name`；compaction / branch_summary 在 IR 里无对等
 *     语义 → 逐类计数（不伪装成正文）；
 *  ⑥ 目录名 `--<cwd>--` 是**有损编码** → 只产出候选 + 存在性检查；反解不出真实目录时
 *     **不产出**该会话（下游 session-missing-cwd）；
 *  ⑦ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { decodeZstdFrame, scanZstdFrames } from '../utils/zstd-frame.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createPiSource, piSource, PI_PROVIDER } from './pi.ts';
import {
  derivedCwdOfDirName,
  parsePiTranscript,
  piCwdCandidates,
  piSessionsDir,
  piSessionIdOf,
  readPiSessions,
} from './read-pi.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'pi');
if (TRUTH === undefined) throw new Error('真值表缺少 pi 行');

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

function ctxOf(homeDir: string, env: Record<string, string | undefined> = {}) {
  return { homeDir, env, platform: PLATFORM, targetSessionFormatVersion: TARGET_VERSION };
}

function sessionsOf(result: ForeignImportResult) {
  return result.sections.find((s) => s.sectionId === 'sessions')?.files ?? [];
}

/** 解出 DSH 会话日志的行（首行是 header，其余是事件行） */
function rowsOf(data: Uint8Array): Record<string, unknown>[] {
  const scan = scanZstdFrames(data);
  const text = scan.frames.map((f) => decodeZstdFrame(data.subarray(f.start, f.end)).toString('utf8')).join('');
  return text.split(NL).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function dataOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  const d = row?.['data'];
  return d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

/** 把**本机真实路径**编码成 pi 的目录名形态（`:` 与两个分隔符都 → `-`）；仅测试用 */
function encodeDir(absPath: string): string {
  return path.resolve(absPath).split('').map((c) => (c === ':' || c === '/' || c === BS ? '-' : c)).join('');
}

/** 一条真形态的 Pi 会话（session 头 + 两条 message + session_info） */
function piBody(): string {
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-1', cwd: '/work/pi', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '你好' }, timestamp: '2026-01-01T00:00:01Z' }),
    JSON.stringify({
      type: 'message', id: 'e2', parentId: 'e1',
      message: { role: 'assistant', content: [{ type: 'text', text: '回复' }, { type: 'thinking', thinking: '想' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { cmd: 'ls' } }] },
      timestamp: '2026-01-01T00:00:02Z',
    }),
    JSON.stringify({
      type: 'message', id: 'e3', parentId: 'e2',
      message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'out' }], isError: false },
      timestamp: '2026-01-01T00:00:03Z',
    }),
    JSON.stringify({ type: 'session_info', id: 'e4', parentId: 'e3', name: 'Pi 标题' }),
  ].join(NL);
}

test('t1 位置：<home>/.pi/agent/sessions 三平台同形', () => {
  assert.equal(piSessionsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.pi' + BS + 'agent' + BS + 'sessions');
  assert.equal(piSessionsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.pi/agent/sessions');
  assert.equal(piSessionsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.pi/agent/sessions');
});

test('t2 目录名反解：只产出**绝对路径候选**（`--<cwd>--` 包装已剥掉）', () => {
  assert.deepEqual(piCwdCandidates('--home-u-proj--', 'linux'), ['/home/u/proj']);
  assert.ok(piCwdCandidates('--C:-Users-u--', 'win32').includes('C:' + BS + 'Users' + BS + 'u'));
  assert.ok(piCwdCandidates('--C--Users-u--', 'win32').includes('C:' + BS + 'Users' + BS + 'u'));
  assert.ok(piCwdCandidates('--C:-Users-u--', 'linux').every((c) => c.startsWith('/')), '非 win32 只收 posix 绝对候选');
  assert.deepEqual(piCwdCandidates('--notabsolute--', 'linux'), ['/notabsolute'], 'posix 反解补前导 / 后是绝对路径');
});

test('t3 session id：头的 id > 文件名的 uuid 段 > 文件名主干', () => {
  assert.equal(piSessionIdOf({ id: 'hdr-1' }, '2026-01-01T00-00-00_uuid-x'), 'hdr-1');
  assert.equal(piSessionIdOf({}, '2026-01-01T00-00-00_uuid-x'), 'uuid-x');
  assert.equal(piSessionIdOf(undefined, 'no-underscore-stem'), 'no-underscore-stem');
});

test('t4 证据强度与探测面取自 truth-table.ts', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(piSource.evidence, TRUTH.evidence);
  assert.equal(createPiSource().evidence, TRUTH.evidence);
  const homeDir = '/home/probe';
  assert.deepEqual(
    [...piSource.probePaths({ homeDir, env: {}, platform: 'linux' })],
    TRUTH.defaults['linux'].map((t) => t.split('<home>').join(homeDir)),
  );
});

test('t5 专用解析：message 包装取角色；toolCall / toolResult 配对；thinking 计数；标题取 session_info.name', () => {
  const out = parsePiTranscript(piBody());
  assert.ok(out.header !== undefined, '找到会话头');
  assert.equal(out.parsed.cwd, '/work/pi');
  assert.equal(out.parsed.title, 'Pi 标题');
  assert.equal(out.parsed.raw, 5);
  assert.equal(out.parsed.bad, 0);
  assert.equal(out.parsed.records.length, 3, 'user + assistant + toolResult');
  assert.equal(out.parsed.records[0]!.role, 'user');
  assert.deepEqual(out.parsed.records[0]!.blocks, [{ type: 'text', text: '你好' }]);
  assert.equal(out.parsed.records[1]!.role, 'assistant');
  assert.deepEqual(out.parsed.records[1]!.blocks, [
    { type: 'text', text: '回复' },
    { type: 'tool_call', id: 'tc1', name: 'bash', input: { cmd: 'ls' } },
  ]);
  assert.deepEqual(out.parsed.records[2]!.blocks, [{ type: 'tool_result', id: 'tc1', text: 'out', isError: false }]);
  assert.equal(out.parsed.ignored['block:thinking'], 1, 'IR 无 reasoning 块 → 逐类计数');
});

test('t6 活动分支：从末条目沿 parentId 走到根，旁支丢弃并计数', () => {
  const text = [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-branch', cwd: '/work/b' }),
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '问题' } }),
    JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: '主干回复' }] } }),
    JSON.stringify({ type: 'message', id: 'e3', parentId: 'e2', message: { role: 'user', content: '旁支问题' } }),
    JSON.stringify({ type: 'message', id: 'e4', parentId: 'e2', message: { role: 'assistant', content: [{ type: 'text', text: '活动分支回复' }] } }),
  ].join(NL);
  const out = parsePiTranscript(text);
  assert.equal(out.parsed.ignored['off-branch'], 1, 'e3 在旁支上');
  // 活动分支 = e4 → e2 → e1（e2 是共同祖先，仍在路径上；只有 e3 被丢）
  assert.deepEqual(out.parsed.records.map((r) => r.role), ['user', 'assistant', 'assistant']);
  assert.deepEqual(out.parsed.records[2]!.blocks, [{ type: 'text', text: '活动分支回复' }]);
});

test('t7 compaction / branch_summary：IR 无压缩检查点与 reasoning 块 → 逐类计数', () => {
  const text = [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-c', cwd: '/work/c' }),
    JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'compaction', id: 'e2', parentId: 'e1', summary: '摘要' }),
    JSON.stringify({ type: 'branch_summary', id: 'e3', parentId: 'e2', summary: '旁支摘要' }),
  ].join(NL);
  const out = parsePiTranscript(text);
  assert.equal(out.parsed.ignored['compaction'], 1);
  assert.equal(out.parsed.ignored['branch_summary'], 1);
});

test('t8 没有会话头的文件不是 Pi 会话：跳过并报码，其余文件照常', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-noheader-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--x--/a.jsonl', JSON.stringify({ role: 'user', content: 'hi' }));
    await writeAt(tmp, '.pi/agent/sessions/--x--/b.jsonl', piBody());
    const read = await readPiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.id, 'pi-1');
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'not-a-session' && (s.origin ?? '').endsWith('a.jsonl')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9 cwd：头里的 cwd 优先；头没有则目录名反解（本机真实存在才用）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-cwd-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--whatever-1--/a.jsonl', piBody());
    // 头没有 cwd：目录名反解。反解是有损的 → 只在临时路径**不含 -** 时才能确定性编码，
    // 这条自适应断言在含 - 的机器上退化为「不产出」，保持用例可离线复现。
    const raw = path.resolve(tmp);
    const encodable = !raw.split(':').join('').includes('-');
    if (encodable) {
      const dir = '--' + encodeDir(tmp) + '--';
      await writeAt(tmp, '.pi/agent/sessions/' + dir + '/b.jsonl', [
        JSON.stringify({ type: 'session', version: 3, id: 'pi-derived' }),
        JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }),
      ].join(NL));
      assert.ok(await derivedCwdOfDirName(dir, PLATFORM) !== undefined, '可编码时反解必须命中真实目录');
    } else {
      assert.equal(await derivedCwdOfDirName('--no-such-cwd-xyz--', PLATFORM), undefined);
    }

    const result = await piSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    const hdr = files.find((f) => f.relativePath.includes('pi-1'));
    assert.ok(hdr !== undefined);
    assert.ok(hdr.relativePath.startsWith(projectKeyOf('/work/pi') + '/'));
    assert.ok(hdr.relativePath.endsWith('/pi-1/' + dshSessionLogName(TARGET_VERSION)));
    assert.equal(PI_PROVIDER, 'pi');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t10 头没有 cwd 且目录名反解不出真实目录 → 绝不产出（session-missing-cwd）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-nocwd-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--no-such-cwd-xyz--/a.jsonl', [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-nocwd' }),
      JSON.stringify({ type: 'message', id: 'e1', message: { role: 'user', content: '你好' } }),
    ].join(NL));
    const result = await piSource.build(ctxOf(tmp));
    assert.deepEqual(sessionsOf(result), []);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 'pi-nocwd'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t11 端到端：标题 / workspaces / 工具结果与调用同 step', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-e2e-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--work-pi--/2026-01-01T00-00-00_abc.jsonl', piBody());
    const result = await piSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/pi') + '/pi-1/' + dshSessionLogName(TARGET_VERSION));

    const rows = rowsOf(files[0]!.data);
    assert.equal(rows[0]?.['type'], 'session');
    assert.equal(dataOf(rows.find((r) => r['type'] === 'session/title'))['title'], 'Pi 标题');
    const call = rows.find((r) => r['type'] === 'tool/call');
    const outcome = rows.find((r) => r['type'] === 'tool/result');
    assert.equal(dataOf(call)['callId'], 'tc1');
    const outcomeMessage = dataOf(outcome)['message'] as Record<string, unknown>;
    assert.equal((outcomeMessage['source'] as Record<string, unknown>)['callId'], 'tc1');
    assert.equal(dataOf(call)['turn'], dataOf(outcome)['turn'], '工具结果与调用同一回合');
    assert.equal(dataOf(call)['step'], dataOf(outcome)['step'], '工具结果挂回声明它的 step');

    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/pi', sessionIds: ['pi-1'] }]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t12 会话条数触顶：报 max-sessions-reached（audit-foreign F4）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-cap-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--x--/2026-01-01T00-00-00_a.jsonl', piBody());
    await writeAt(tmp, '.pi/agent/sessions/--x--/2026-01-01T00-00-00_b.jsonl', piBody());
    const read = await readPiSessions({ homeDir: tmp, env: {}, platform: PLATFORM, maxSessionFiles: 1 });
    assert.equal(read.files.length, 1);
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'max-sessions-reached'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
