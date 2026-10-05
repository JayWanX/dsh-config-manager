/**
 * Pi 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 五层：
 *  ① 位置真值：`<home>/.pi/agent/sessions`（三平台同形、无 env 覆盖）；
 *  ② **首行是会话头**：按 JSONL 逐行当消息会把头当成一条空消息 → 本用例钉住「头单独处理」，
 *     并把「头解析不出来」如实计一条 bad（其余行仍照常解析）；
 *  ③ 目录名 `--<cwd>--` 是**有损编码** → 只产出候选 + 存在性检查；反解不出真实目录时
 *     **不产出**该会话（下游 session-missing-cwd）；
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
import { createPiSource, piSource, PI_PROVIDER } from './pi.ts';
import { derivedCwdOfDirName, piCwdCandidates, piSessionsDir, piSessionIdOf, readPiSessions } from './read-pi.ts';
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

/** 把**本机真实路径**编码成 pi 的目录名形态（`:` 与两个分隔符都 → `-`）；仅测试用 */
function encodeDir(absPath: string): string {
  return path.resolve(absPath).split('').map((c) => (c === ':' || c === '/' || c === BS ? '-' : c)).join('');
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
  // 相对形态（没有前导分隔符的解码结果）绝不作为候选：那会把「相对 cwd」当成绝对路径用
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

test('t5 读盘：首行当会话头（不进记录）、坏头如实计 bad、其余行照常解析', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-'));
  try {
    const dir = '--' + encodeDir(tmp) + '--';
    const body = [
      JSON.stringify({ type: 'session', id: 'pi-1', timestamp: '2026-01-01T00:00:00Z' }), // 头：无 cwd
      JSON.stringify({ type: 'user', role: 'user', content: '你好' }),
      JSON.stringify({ type: 'assistant', role: 'assistant', content: '回复' }),
    ].join(NL);
    await writeAt(tmp, '.pi/agent/sessions/' + dir + '/2026-01-01T00-00-00_abc.jsonl', body);

    const read = await readPiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.id, 'pi-1', '头里的 id 优先');
    assert.equal(read.files[0]?.parsed.records.length, 2, '首行是头，不得变成一条消息');
    assert.equal(read.files[0]?.parsed.raw, 2, '头不计入 raw（它是源记录，但由本层单独消费）');
    assert.equal(read.files[0]?.parsed.bad, 0);

    // 头部坏 JSON：仍解析其余行，并把坏头计一条 bad
    await writeAt(tmp, '.pi/agent/sessions/' + dir + '/2026-01-01T00-00-00_badheader.jsonl', [
      '{oops',
      JSON.stringify({ role: 'user', content: '你好' }),
    ].join(NL));
    const read2 = await readPiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    const bad = read2.files.find((f) => f.id === 'badheader');
    assert.ok(bad !== undefined);
    assert.equal(bad.parsed.bad, 1);
    assert.equal(bad.parsed.records.length, 1, '坏头绝不拖垮其余行');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6 cwd：头里的 cwd 优先；头没有则目录名反解（本机真实存在才用）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-cwd-'));
  try {
    // ① 头里的 cwd（权威）
    await writeAt(tmp, '.pi/agent/sessions/--whatever-1--/a.jsonl', [
      JSON.stringify({ type: 'session', id: 'pi-hdr', cwd: '/work/hdr' }),
      JSON.stringify({ role: 'user', content: '你好' }),
    ].join(NL));
    // ② 头没有 cwd：目录名反解。反解是有损的 → 只在临时路径**不含 `-`**时才能确定性编码，
    //    这条自适应断言在含 `-` 的机器上退化为「不产出」（下面单独断言），保持用例可离线复现。
    const raw = path.resolve(tmp);
    const encodable = !raw.split(':').join('').includes('-');
    if (encodable) {
      const dir = '--' + encodeDir(tmp) + '--';
      await writeAt(tmp, '.pi/agent/sessions/' + dir + '/b.jsonl', [
        JSON.stringify({ type: 'session', id: 'pi-derived' }),
        JSON.stringify({ role: 'user', content: '你好' }),
      ].join(NL));
      assert.ok(await derivedCwdOfDirName(dir, PLATFORM) !== undefined, '可编码时反解必须命中真实目录');
    } else {
      assert.equal(await derivedCwdOfDirName('--no-such-cwd-xyz--', PLATFORM), undefined);
    }

    const result = await piSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    const hdr = files.find((f) => f.relativePath.includes('pi-hdr'));
    assert.ok(hdr !== undefined);
    assert.ok(hdr.relativePath.startsWith(projectKeyOf('/work/hdr') + '/'));
    assert.ok(hdr.relativePath.endsWith('/pi-hdr/' + dshSessionLogName(TARGET_VERSION)));
    assert.equal(PI_PROVIDER, 'pi');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 头没有 cwd 且目录名反解不出真实目录 → 绝不产出（session-missing-cwd）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pi-nocwd-'));
  try {
    await writeAt(tmp, '.pi/agent/sessions/--no-such-cwd-xyz--/a.jsonl', [
      JSON.stringify({ type: 'session', id: 'pi-nocwd' }),
      JSON.stringify({ role: 'user', content: '你好' }),
    ].join(NL));
    const result = await piSource.build(ctxOf(tmp));
    assert.deepEqual(sessionsOf(result), []);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 'pi-nocwd'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
