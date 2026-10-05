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
import { readWorkbuddySessions, workbuddyProjectsDir } from './read-workbuddy.ts';
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
