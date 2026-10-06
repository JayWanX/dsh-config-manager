/**
 * 千问办公 / Qwen 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`<home>/.qwenworkcn/projects`（三平台同形、无 env 覆盖）；
 *  ② **一处刻意留白**：chat-import 只写 `<slug>`，没有任何报告说明它的编码语义
 *     → 本层**不据 slug 推导 cwd**（推导 = 猜）；即使 slug 长得像路径也不得被当成 cwd；
 *  ③ cwd 只认 `workspace-directories` 里的真实项目目录（记录内 cwd 是千问临时工作区，丢弃）；
 *     没有则下游按 `session-missing-cwd` 跳过并报码；
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
import { createQwenSource, qwenSource, QWEN_PROVIDER } from './qwen.ts';
import { parseQwenJsonl, qwenProjectsDir, readQwenSessions, realQwenWorkspaceDir } from './read-qwen.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'qwen');
if (TRUTH === undefined) throw new Error('真值表缺少 qwen 行');

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

test('t1 位置：<home>/.qwenworkcn/projects 三平台同形', () => {
  assert.equal(qwenProjectsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.qwenworkcn' + BS + 'projects');
  assert.equal(qwenProjectsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.qwenworkcn/projects');
  assert.equal(qwenProjectsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.qwenworkcn/projects');
});

test('t2 证据强度与探测面取自 truth-table.ts', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(qwenSource.evidence, TRUTH.evidence);
  assert.equal(createQwenSource().evidence, TRUTH.evidence);
  const homeDir = '/home/probe';
  assert.deepEqual(
    [...qwenSource.probePaths({ homeDir, env: {}, platform: 'linux' })],
    TRUTH.defaults['linux'].map((t) => t.split('<home>').join(homeDir)),
  );
});

test('t3 slug 编码语义未取证：长得像路径也**绝不**当 cwd（不猜）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-slug-'));
  try {
    await writeAt(tmp, '.qwenworkcn/projects/-looks-like-a-path-abc/s1.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    const read = await readQwenSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.parsed.cwd, undefined, 'slug 只当遍历键，绝不参与 cwd 推导');
    assert.ok(!read.readFindings?.some((s) => s.code === 'session-cwd-derived'));

    const result = await qwenSource.build(ctxOf(tmp));
    assert.deepEqual(result.sections, []);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's1'));
    assert.equal(QWEN_PROVIDER, 'qwen');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t4 build：workspace-directories 提供真实项目目录 → sessions + workspaces 同源产出', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-'));
  try {
    await writeAt(tmp, '.qwenworkcn/projects/slug-1/s1.jsonl', [
      JSON.stringify({ type: 'workspace-directories', directories: ['/tmp/.qwenworkcn/ws', '/work/proj'] }),
      JSON.stringify({ type: 'user', cwd: '/tmp/.qwenworkcn/ws', humanInput: { text: '你好' }, message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    const result = await qwenSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/s1/' + dshSessionLogName(TARGET_VERSION));
    assert.ok((files[0]?.data.length ?? 0) > 0);
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['s1'] }]);
    const det = await qwenSource.detect(ctxOf(tmp));
    assert.equal(det.found, true);
    assert.ok(det.paths.includes('.qwenworkcn/projects'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 未安装 / 畸形 JSONL：不抛；坏行计数不产出会话', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-bad-'));
  try {
    assert.deepEqual((await readQwenSessions({ homeDir: tmp, env: {}, platform: PLATFORM })).files, []);

    await writeAt(tmp, '.qwenworkcn/projects/slug-2/bad.jsonl', '{not json' + NL + '[]' + NL);
    const read = await readQwenSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.parsed.bad, 2, '坏行如实计数（绝不静默）');
    const result = await qwenSource.build(ctxOf(tmp));
    assert.deepEqual(result.sections, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6 cwd 权威：workspace-directories 里第一个非 .qwenworkcn 目录；记录内 cwd 丢弃', async () => {
  assert.equal(realQwenWorkspaceDir(['/tmp/.qwenworkcn/ws', '/work/real']), '/work/real');
  assert.equal(realQwenWorkspaceDir(['C:' + BS + 'tmp' + BS + '.qwenworkcn' + BS + 'ws']), undefined, '全在临时工作区下 = 无项目');
  assert.equal(realQwenWorkspaceDir('nonsense'), undefined);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-ws-'));
  try {
    await writeAt(tmp, '.qwenworkcn/projects/slug-1/s1.jsonl', [
      JSON.stringify({ type: 'workspace-directories', directories: ['/tmp/.qwenworkcn/ws', '/work/real'], cwd: '/tmp/.qwenworkcn/ws' }),
      JSON.stringify({ type: 'user', cwd: '/tmp/.qwenworkcn/ws', humanInput: { text: '真实提问' }, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    const parsed = parseQwenJsonl(await fs.readFile(path.join(tmp, '.qwenworkcn', 'projects', 'slug-1', 's1.jsonl'), 'utf8'));
    assert.equal(parsed.cwd, '/work/real', '记录内的 .qwenworkcn cwd 不得被采信');
    assert.equal(parsed.title, '真实提问');
    assert.deepEqual(parsed.records[0]?.blocks, [{ type: 'text', text: '真实提问' }]);

    const result = await qwenSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.ok(files[0]?.relativePath.startsWith(projectKeyOf('/work/real') + '/'), '会话必须挂到真实项目 projectKey');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 提问权威：humanInput 优先；<system 注入型 user 不产提问也不作标题', () => {
  const parsed = parseQwenJsonl([
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>环境上下文</system-reminder>' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '被丢弃的回复' } }),
    JSON.stringify({ type: 'user', humanInput: { text: '人类原话' }, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }, { type: 'text', text: '混写' }] } }),
  ].join(NL));
  assert.equal(parsed.ignored['skipped-system-user'], 1, '注入型 user 单独计数不标丢失');
  assert.equal(parsed.title, '人类原话', '标题取 humanInput，绝不取注入文本');
  assert.deepEqual(parsed.records[0]?.blocks, [{ type: 'text', text: '人类原话' }]);
});

test('t8 主转录自证 + 同 sessionId 去重留最新', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-dedup-'));
  try {
    const aDir = path.join(tmp, '.qwenworkcn', 'projects', 'slug-a');
    const bDir = path.join(tmp, '.qwenworkcn', 'projects', 'slug-b');
    await writeAt(tmp, '.qwenworkcn/projects/slug-a/s1.jsonl', [
      JSON.stringify({ sessionId: 's1', type: 'workspace-directories', directories: ['/work/real'] }),
      JSON.stringify({ type: 'user', humanInput: { text: '副本 A' }, message: { role: 'user', content: 'x' } }),
    ].join(NL));
    await writeAt(tmp, '.qwenworkcn/projects/slug-b/s1.jsonl', [
      JSON.stringify({ sessionId: 's1', type: 'workspace-directories', directories: ['/work/real'] }),
      JSON.stringify({ type: 'user', humanInput: { text: '副本 B' }, message: { role: 'user', content: 'x' } }),
    ].join(NL));
    await fs.utimes(path.join(aDir, 's1.jsonl'), new Date(1000), new Date(1000));
    await fs.utimes(path.join(bDir, 's1.jsonl'), new Date(2000), new Date(2000));

    await writeAt(tmp, '.qwenworkcn/projects/slug-aux/aux.jsonl', [
      JSON.stringify({ sessionId: 'main-1', type: 'user', humanInput: { text: '辅助' }, message: { role: 'user', content: 'x' } }),
    ].join(NL));

    const read = await readQwenSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1, '同 sessionId 双副本去重为一条');
    assert.equal(read.files[0]?.parsed.title, '副本 B', '留 mtime 最新的副本');
    assert.ok(read.readFindings?.some((s) => s.code === 'unsupported-session-record' && s.detail === 'auxiliary-transcript'), 'stem ≠ sessionId 必须报码');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9 runtime-config.model 透传；thinking 无 IR 块 → 逐类计数不静默', () => {
  const parsed = parseQwenJsonl([
    JSON.stringify({ type: 'runtime-config', model: 'qwen3-max' }),
    JSON.stringify({ type: 'user', humanInput: { text: 'hi' }, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '正文' }] } }),
  ].join(NL));
  assert.equal(parsed.records[1]?.model, 'qwen3-max', 'runtime-config.model 必须带到助手记录');
  assert.deepEqual(parsed.records[1]?.blocks, [{ type: 'text', text: '正文' }]);
  assert.equal(parsed.ignored['reasoning-block'], 1, 'thinking 无承载块 → 计数可见（IR 层缺 reasoning 块）');
});
