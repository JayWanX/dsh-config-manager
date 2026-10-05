/**
 * 千问办公 / Qwen 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`<home>/.qwenworkcn/projects`（三平台同形、无 env 覆盖）；
 *  ② **一处刻意留白**：chat-import 只写 `<slug>`，没有任何报告说明它的编码语义
 *     → 本层**不据 slug 推导 cwd**（推导 = 猜）；即使 slug 长得像路径也不得被当成 cwd；
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
import { createQwenSource, qwenSource, QWEN_PROVIDER } from './qwen.ts';
import { qwenProjectsDir, readQwenSessions } from './read-qwen.ts';
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

test('t4 build：记录带 cwd → sessions + workspaces 同源产出', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qwen-'));
  try {
    await writeAt(tmp, '.qwenworkcn/projects/slug-1/s1.jsonl', [
      JSON.stringify({ type: 'user', cwd: '/work/proj', message: { role: 'user', content: '你好' } }),
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
