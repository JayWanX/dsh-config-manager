/**
 * WorkBuddy 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`<home>/.workbuddy/projects`（三平台同形、无 env 覆盖）；
 *  ② **不猜 cwd**：目录名是 cwd 的**哈希（不可逆）** → 本层绝不做任何反解；即使目录名长得
 *     像路径，也**不得**被当成 cwd（这条是本用例的核心断言）；
 *  ③ 记录里有 cwd 才产会话；没有则下游按 `session-missing-cwd` 跳过并报码；
 *  ④ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createWorkbuddySource, workbuddySource, WORKBUDDY_PROVIDER } from './workbuddy.ts';
import { extractWorkbuddyUserQuery, parseWorkbuddyJsonl, readWorkbuddySessions, workbuddyProjectsDir } from './read-workbuddy.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'workbuddy');
if (TRUTH === undefined) throw new Error('真值表缺少 workbuddy 行');

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

test('t1 位置：<home>/.workbuddy/projects 三平台同形', () => {
  assert.equal(workbuddyProjectsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.workbuddy' + BS + 'projects');
  assert.equal(workbuddyProjectsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.workbuddy/projects');
  assert.equal(workbuddyProjectsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.workbuddy/projects');
});

test('t2 证据强度与探测面取自 truth-table.ts', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(workbuddySource.evidence, TRUTH.evidence);
  assert.equal(createWorkbuddySource().evidence, TRUTH.evidence);
  const homeDir = '/home/probe';
  assert.deepEqual(
    [...workbuddySource.probePaths({ homeDir, env: {}, platform: 'linux' })],
    TRUTH.defaults['linux'].map((t) => t.split('<home>').join(homeDir)),
  );
});

test('t3 目录名是哈希：长得像路径也**绝不**当 cwd（不猜）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workbuddy-hash-'));
  try {
    // 目录名故意写成「像路径的形态」——反解会得到一个本机不存在的路径，本层必须放弃而非硬用
    await writeAt(tmp, '.workbuddy/projects/-looks-like-a-path-abc/s1.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    const read = await readWorkbuddySessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.parsed.cwd, undefined, '哈希目录名不得被反解成 cwd');
    assert.ok(!read.readFindings?.some((s) => s.code === 'session-cwd-derived'), '本来源根本没有推导路径');

    const result = await workbuddySource.build(ctxOf(tmp));
    assert.deepEqual(sessionsOf(result), []);
    assert.deepEqual(result.sections, []);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's1'));
    assert.equal(WORKBUDDY_PROVIDER, 'workbuddy');
    assert.equal(joinFor('win32', 'C:' + BS + 'u', 'a'), 'C:' + BS + 'u' + BS + 'a');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t4 build：记录带 cwd → sessions + workspaces 同源产出', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workbuddy-'));
  try {
    await writeAt(tmp, '.workbuddy/projects/hash-1/s1.jsonl', [
      JSON.stringify({ type: 'user', cwd: '/work/proj', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复', model: 'x' } }),
    ].join(NL));
    const result = await workbuddySource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/s1/' + dshSessionLogName(TARGET_VERSION));
    assert.ok((files[0]?.data.length ?? 0) > 0);
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['s1'] }]);

    // detect 只 stat
    const det = await workbuddySource.detect(ctxOf(tmp));
    assert.equal(det.found, true);
    assert.ok(det.paths.includes('.workbuddy/projects'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 未安装 / 0 字节：正常状态、不抛、如实报码', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workbuddy-empty-'));
  try {
    const none = await readWorkbuddySessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(none.files, []);
    assert.equal((await workbuddySource.detect(ctxOf(tmp))).found, false);

    await writeAt(tmp, '.workbuddy/projects/hash-2/empty.jsonl', '');
    const read = await readWorkbuddySessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(read.files, []);
    assert.ok(read.readFindings?.some((s) => s.code === 'source-empty-file' && (s.origin ?? '').endsWith('empty.jsonl')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ⑥ 参考实现对齐（convert/workbuddy.mjs） ---------------- */

test('t6 提问提取：<user_query> 优先；缺失时剥 system-reminder 与其余标签', () => {
  assert.equal(
    extractWorkbuddyUserQuery([{ type: 'input_text', text: '<system-reminder>提示</system-reminder><user_query>真正的问题</user_query>' }]),
    '真正的问题',
    '人类提问在 <user_query> 信封里，注入上下文不是提问',
  );
  assert.equal(
    extractWorkbuddyUserQuery([{ type: 'input_text', text: '  <user_query>' + NL + '  多行提问  ' + NL + '</user_query>' }]),
    '多行提问',
  );
  assert.equal(
    extractWorkbuddyUserQuery([{ type: 'input_text', text: '<system-reminder>一大段注入</system-reminder>剩余纯文本' }]),
    '剩余纯文本',
    '没有 user_query 时剥掉 system-reminder 整块',
  );
  assert.equal(extractWorkbuddyUserQuery([{ type: 'image_blob_ref', path: '/x.png' }]), '', '没有可提取文本就是空提问');
  assert.equal(extractWorkbuddyUserQuery('裸字符串提问'), '裸字符串提问');
});

test('t7 事件流：function_call/result 按 callId 配对；reasoning 只显式计数；孤儿/未完成/中断各归各档', () => {
  const lines = [
    JSON.stringify({ type: 'message', sessionId: 'wb-1', cwd: '/work/wb', role: 'user', timestamp: '2026-10-05T00:00:00Z', content: [
      { type: 'input_text', text: '<user_query>帮我读文件</user_query>' + NL + '<project_context>项目上下文</project_context>' },
    ] }),
    JSON.stringify({ type: 'reasoning', sessionId: 'wb-1', rawContent: [{ type: 'reasoning_text', text: '先看看' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }),
    JSON.stringify({ type: 'function_call', sessionId: 'wb-1', callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }),
    JSON.stringify({ type: 'function_call_result', callId: 'c1', status: 'completed', output: { type: 'text', text: '文件内容' } }),
    JSON.stringify({ type: 'function_call_result', callId: 'c1', status: 'incomplete', output: '不该出现' }),
    JSON.stringify({ type: 'function_call_result', callId: 'ghost', status: 'completed', output: '没有对应调用' }),
    JSON.stringify({ type: 'function_call', callId: 'c2', name: 'x', arguments: '{}', providerData: { isPartialAborted: true } }),
    JSON.stringify({ type: 'file-history-snapshot', sessionId: 'wb-1', files: {} }),
    JSON.stringify({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<system-reminder>系统提醒</system-reminder>接下来做什么' },
    ] }),
  ];
  const parsed = parseWorkbuddyJsonl(lines.join(NL));
  assert.equal(parsed.cwd, '/work/wb');
  assert.equal(parsed.title, '帮我读文件', '注入的 project_context 不得成为标题');
  assert.deepEqual(parsed.records.map((r) => r.role), ['user', 'assistant', 'user', 'user']);
  assert.deepEqual(parsed.records[0]?.blocks, [{ type: 'text', text: '帮我读文件' }], '提问必须从 <user_query> 提取');
  assert.deepEqual(parsed.records[1]?.blocks, [
    { type: 'text', text: '好的' },
    { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  ], 'function_call 必须结构化为 tool/call（旧行为整类丢弃）');
  assert.deepEqual(parsed.records[2]?.blocks, [{ type: 'tool_result', id: 'c1', text: '文件内容', isError: false }]);
  assert.deepEqual(parsed.records[3]?.blocks, [{ type: 'text', text: '接下来做什么' }]);
  // 推理在本地 IR 没有承载位 → 只显式计数，绝不伪装成正文
  assert.equal(parsed.ignored['workbuddy:reasoning'], 1);
  assert.equal(parsed.ignored['workbuddy:incomplete-result'], 1);
  assert.equal(parsed.ignored['workbuddy:orphan-tool-result'], 1);
  assert.equal(parsed.ignored['workbuddy:aborted-call'], 1);
  assert.equal(parsed.ignored['workbuddy:file-history-snapshot'], 1);
  const allBlocks = parsed.records.flatMap((r) => r.blocks);
  assert.equal(allBlocks.some((b) => b.type === 'text' && b.text.includes('先看看')), false, '推理绝不进正文');
});

test('t8 端到端：参考事件流形态的 transcript 产出会话与工作区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workbuddy-events-'));
  try {
    const body = [
      JSON.stringify({ type: 'message', sessionId: 'wb-1', cwd: '/work/wb', role: 'user', content: [{ type: 'input_text', text: '<user_query>你好</user_query>' }] }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复' }] }),
    ].join(NL);
    await writeAt(tmp, '.workbuddy/projects/hash-3/wb-1.jsonl', body);
    const read = await readWorkbuddySessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files[0]?.parsed.cwd, '/work/wb');
    const result = await workbuddySource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/wb') + '/wb-1/' + dshSessionLogName(TARGET_VERSION));
    assert.ok((files[0]?.data.length ?? 0) > 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
