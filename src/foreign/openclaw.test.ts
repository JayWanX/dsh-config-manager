/**
 * OpenClaw 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 六层：
 *  ① 位置真值：`<home>/.openclaw/agents`（三平台同形、无 env 覆盖），会话递归走盘 + 路径段判据；
 *  ② 事件流专用解析：`{type:"session"}` 取 id/cwd/时间，`{type:"message",message:{role,content}}`
 *     取角色与内容；gateway 注入的 `\n[message_id: …]` 尾缀剥掉；
 *  ③ 工具：`tool_use` → tool/call，`toolResult` 按 `tool_use_id` 挂回**声明它的 assistant
 *     记录之后**（合成器据此收进同一个 step）；孤儿结果丢弃并计数；
 *  ④ 伴生 `sessions.json` 索引**只贡献显示名**（对象映射 / 数组两种形态都认；认不出就忽略，
 *     绝不因此丢会话）；索引里的其它字段连内存都不进；
 *  ⑤ 记录里没有 cwd 的会话按 `session-missing-cwd` 跳过（目录名/文件名没有可逆编码语义）；
 *  ⑥ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
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
import { createOpenclawSource, openclawSource, OPENCLAW_PROVIDER } from './openclaw.ts';
import {
  openclawAgentsDir,
  parseOpenclawEventStream,
  readOpenclawSessions,
  sessionNamesFromIndex,
  stripMessageIdSuffix,
} from './read-openclaw.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'openclaw');
if (TRUTH === undefined) throw new Error('真值表缺少 openclaw 行');

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

test('t1 位置：<home>/.openclaw/agents 三平台同形', () => {
  assert.equal(openclawAgentsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.openclaw' + BS + 'agents');
  assert.equal(openclawAgentsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.openclaw/agents');
  assert.equal(openclawAgentsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.openclaw/agents');
});

test('t2 索引只取名字：对象映射（键或 sessionId）/ 数组都认，认不出就空表（绝不丢会话）', () => {
  assert.deepEqual(
    [...sessionNamesFromIndex({ s1: { displayName: '甲' }, s2: '乙' }).entries()],
    [['s1', '甲'], ['s2', '乙']],
  );
  // 参考实现以 entry.sessionId 为键（convert/openclaw.mjs openclawDisplayNames）→ 对象键与
  // sessionId 不一致时以 sessionId 为准
  assert.deepEqual(
    [...sessionNamesFromIndex({ 'file-stem': { sessionId: 'sess-1', displayName: '甲' } }).entries()],
    [['sess-1', '甲']],
  );
  assert.deepEqual(
    [...sessionNamesFromIndex([{ id: 's1', displayName: '甲' }, { sessionId: 's2', name: '乙' }]).entries()],
    [['s1', '甲'], ['s2', '乙']],
  );
  assert.equal(sessionNamesFromIndex({ s1: { unrelated: 'x' } }).size, 0, '认不出名字就不给标题');
  assert.equal(sessionNamesFromIndex('nonsense').size, 0);
  assert.equal(sessionNamesFromIndex([{ id: 's3' }]).size, 0);
});

test('t3 证据强度与探测面取自 truth-table.ts', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(openclawSource.evidence, TRUTH.evidence);
  assert.equal(createOpenclawSource().evidence, TRUTH.evidence);
  const homeDir = 'C:' + BS + 'probe';
  assert.deepEqual(
    [...openclawSource.probePaths({ homeDir, env: {}, platform: 'win32' })],
    TRUTH.defaults['win32'].map((t) => t.split('<home>').join(homeDir)),
  );
});

test('t4 专用事件流解析：session 事件取 id/cwd/时间；toolResult 挂回声明步；尾缀剥离；thinking 计数', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/work/proj', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '你好' + NL + '[message_id: abc]' }, timestamp: '2026-01-01T00:00:01Z' }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: '回复' }, { type: 'thinking', thinking: '想' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'a' } }] },
      timestamp: '2026-01-01T00:00:02Z',
    }),
    JSON.stringify({
      type: 'message',
      message: { role: 'toolResult', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '文件内容' }] },
      timestamp: '2026-01-01T00:00:03Z',
    }),
  ].join(NL);

  const out = parseOpenclawEventStream(text);
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.parsed.cwd, '/work/proj');
  assert.equal(out.parsed.raw, 4);
  assert.equal(out.parsed.bad, 0);
  assert.equal(out.parsed.records.length, 3, 'user + assistant + toolResult');
  assert.deepEqual(out.parsed.records[0]!.blocks, [{ type: 'text', text: '你好' }], 'gateway 尾缀剥掉');
  assert.equal(out.parsed.records[1]!.role, 'assistant');
  assert.deepEqual(out.parsed.records[1]!.blocks.slice(0, 2), [{ type: 'text', text: '回复' }, { type: 'tool_call', id: 'c1', name: 'Read', input: { path: 'a' } }]);
  assert.equal(out.parsed.records[2]!.role, 'user');
  assert.deepEqual(out.parsed.records[2]!.blocks, [{ type: 'tool_result', id: 'c1', text: '文件内容', isError: false }]);
  assert.equal(out.parsed.ignored['block:thinking'], 1, 'IR 无 reasoning 块 → 逐类计数');
  assert.equal(stripMessageIdSuffix('hi' + NL + '[message_id: x]'), 'hi');
});

test('t5 孤儿工具结果 / 无主 assistant：丢弃并逐类计数（绝不塞进别的回合）', () => {
  const text = [
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: '早于用户' } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }] } }),
  ].join(NL);
  const out = parseOpenclawEventStream(text);
  assert.equal(out.parsed.records.length, 1);
  assert.equal(out.parsed.ignored['message:no-turn'], 1);
  assert.equal(out.parsed.ignored['tool-result-orphan'], 1);
});

test('t6 build：索引补标题（按 session 事件 id）；工具配对跨 step；缺 cwd 跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-'));
  try {
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/s1.jsonl', [
      JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/work/proj', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '你好' }, timestamp: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }, { type: 'tool_use', id: 'c1', name: 'Read', input: {} }] }, timestamp: '2026-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '内容' }] }, timestamp: '2026-01-01T00:00:03Z' }),
    ].join(NL));
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/sessions.json', JSON.stringify({ 'file-stem': { sessionId: 'sess-1', displayName: '来自索引的标题' } }));
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/s2.jsonl', [
      JSON.stringify({ type: 'message', message: { role: 'user', content: '没有 cwd' } }),
    ].join(NL));

    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 2);
    assert.equal(read.files[0]?.id, 'sess-1', '会话 id 优先取 session 事件');
    assert.equal(read.files[0]?.parsed.title, '来自索引的标题');
    assert.equal(read.files[0]?.parsed.cwd, '/work/proj');

    const result = await openclawSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/sess-1/' + dshSessionLogName(TARGET_VERSION));

    const rows = rowsOf(files[0]!.data);
    assert.equal(rows[0]?.['type'], 'session');
    const titleRow = rows.find((r) => r['type'] === 'session/title');
    assert.equal(dataOf(titleRow)['title'], '来自索引的标题');
    const call = rows.find((r) => r['type'] === 'tool/call');
    const outcome = rows.find((r) => r['type'] === 'tool/result');
    assert.equal(dataOf(call)['callId'], 'c1');
    const outcomeData = dataOf(outcome);
    const outcomeMessage = outcomeData['message'] as Record<string, unknown>;
    assert.equal((outcomeMessage['source'] as Record<string, unknown>)['callId'], 'c1');
    assert.equal(dataOf(call)['turn'], outcomeData['turn'], '工具结果与调用同一回合');
    assert.equal(dataOf(call)['step'], outcomeData['step'], '工具结果挂回声明它的 step');

    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['sess-1'] }]);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's2'));
    assert.equal(OPENCLAW_PROVIDER, 'openclaw');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 递归走盘 + 路径段判据：嵌套 sessions 命中，非 sessions 路径的 jsonl 不进', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-walk-'));
  try {
    await writeAt(tmp, '.openclaw/agents/agentA/projects/p/sessions/deep.jsonl', [
      JSON.stringify({ type: 'session', id: 'deep-1', cwd: '/work/deep' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    ].join(NL));
    await writeAt(tmp, '.openclaw/agents/agentA/notes.jsonl', JSON.stringify({ type: 'message', message: { role: 'user', content: '不该进' } }));

    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.id, 'deep-1');
    assert.equal(read.files[0]?.parsed.cwd, '/work/deep');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t8 索引畸形 / 0 字节：只影响标题，绝不丢会话；无 agents 目录 = 未安装', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-bad-'));
  try {
    assert.equal((await openclawSource.detect(ctxOf(tmp))).found, false);

    await writeAt(tmp, '.openclaw/agents/agentB/sessions/s1.jsonl', [
      JSON.stringify({ type: 'session', id: 'bad-index-1', cwd: '/work/x' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '你好' } }),
    ].join(NL));
    await writeAt(tmp, '.openclaw/agents/agentB/sessions/sessions.json', '{broken');
    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1, '索引畸形绝不丢会话');
    assert.equal(read.files[0]?.parsed.title, '你好', '标题退回首条用户文本');
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'json-error' && (s.origin ?? '').endsWith('sessions.json')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9 会话条数触顶：报 max-sessions-reached（audit-foreign F4）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-cap-'));
  try {
    await writeAt(tmp, '.openclaw/agents/a/sessions/s1.jsonl', JSON.stringify({ type: 'session', id: 'cap-1', cwd: '/work/c' }));
    await writeAt(tmp, '.openclaw/agents/a/sessions/s2.jsonl', JSON.stringify({ type: 'session', id: 'cap-2', cwd: '/work/c' }));
    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM, maxSessionFiles: 1 });
    assert.equal(read.files.length, 1);
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'max-sessions-reached'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
