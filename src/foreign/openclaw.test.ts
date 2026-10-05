/**
 * OpenClaw 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`<home>/.openclaw/agents`（三平台同形、无 env 覆盖）；
 *  ② 伴生 `sessions.json` 索引**只贡献显示名**（对象映射 / 数组两种形态都认；认不出就忽略，
 *     绝不因此丢会话）；索引里的其它字段连内存都不进；
 *  ③ 记录里没有 cwd 的会话按 `session-missing-cwd` 跳过（目录名/文件名没有可逆编码语义）；
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
import { createOpenclawSource, openclawSource, OPENCLAW_PROVIDER } from './openclaw.ts';
import { openclawAgentsDir, readOpenclawSessions, sessionNamesFromIndex } from './read-openclaw.ts';
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

test('t1 位置：<home>/.openclaw/agents 三平台同形', () => {
  assert.equal(openclawAgentsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.openclaw' + BS + 'agents');
  assert.equal(openclawAgentsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.openclaw/agents');
  assert.equal(openclawAgentsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.openclaw/agents');
});

test('t2 索引只取名字：对象映射 / 数组两种形态都认，认不出就空表（绝不丢会话）', () => {
  assert.deepEqual(
    [...sessionNamesFromIndex({ s1: { displayName: '甲' }, s2: '乙' }).entries()],
    [['s1', '甲'], ['s2', '乙']],
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

test('t4 build：索引补标题；记录带 cwd 才产会话；缺 cwd 跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-'));
  try {
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/s1.jsonl', [
      JSON.stringify({ type: 'user', cwd: '/work/proj', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/sessions.json', JSON.stringify({ s1: { displayName: '来自索引的标题' } }));
    await writeAt(tmp, '.openclaw/agents/agentA/sessions/s2.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '没有 cwd' } }),
    ].join(NL));

    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 2);
    assert.equal(read.files[0]?.parsed.title, '来自索引的标题');
    assert.equal(read.files[0]?.parsed.cwd, '/work/proj');

    const result = await openclawSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/s1/' + dshSessionLogName(TARGET_VERSION));
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['s1'] }]);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's2'));
    assert.equal(OPENCLAW_PROVIDER, 'openclaw');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 索引畸形 / 0 字节：只影响标题，绝不丢会话；无 agents 目录 = 未安装', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-openclaw-bad-'));
  try {
    assert.equal((await openclawSource.detect(ctxOf(tmp))).found, false);

    await writeAt(tmp, '.openclaw/agents/agentB/sessions/s1.jsonl', JSON.stringify({
      type: 'user',
      cwd: '/work/x',
      message: { role: 'user', content: '你好' },
    }));
    await writeAt(tmp, '.openclaw/agents/agentB/sessions/sessions.json', '{broken');
    const read = await readOpenclawSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1, '索引畸形绝不丢会话');
    assert.equal(read.files[0]?.parsed.title, '你好', '标题退回首条用户文本');
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'json-error' && (s.origin ?? '').endsWith('sessions.json')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
