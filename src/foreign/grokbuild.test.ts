/**
 * Grok Build 来源回归（路径真值 × 解析 × 端到端）。
 *
 * 取证：本机无 ~/.grok（fixture 级）；夹具在测试内即时构造（可复现），真机未验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

/** 真值表模板按**宿主真值**展开（与 registry.ts 的 probePathsOf 同口径） */
function truthProbePaths(id: string, opts: RootProbeOptions): string[] {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === id);
  assert.ok(entry !== undefined, '真值表缺少 ' + id);
  const platform = normalizePlatform(opts.platform);
  const appdata = roamingAppDataDir(platform, opts.homeDir, opts.env);
  const xdgdata = xdgDataHome(platform, opts.homeDir, opts.env);
  return entry.defaults[platform].map((template) => template
    .split('<home>').join(opts.homeDir)
    .split('<appdata>').join(appdata)
    .split('<xdgdata>').join(xdgdata));
}

/** 分隔符归一（真值表用正斜杠书写：read-vault §10.1 明示「表中路径一律用正斜杠」） */
function normalize(p: string): string {
  return p.split(BS).join('/');
}

/** 三平台交叉核对：真值表 defaults ↔ 来源的 probePaths（归一后逐项相等） */
function assertTruthPaths(id: string, probePaths: (opts: RootProbeOptions) => readonly string[]): void {
  for (const platform of PLATFORMS) {
    const probe = TRUTH_PROBES[platform];
    const opts: RootProbeOptions = { homeDir: probe.homeDir, env: TRUTH_PROBE_ENV, platform };
    const mine = probePaths(opts).map(normalize);
    const truth = truthProbePaths(id, opts).map(normalize);
    assert.deepEqual(mine, truth, id + ' × ' + platform + ' 的 probePaths 与真值表不一致');
  }
}

function ctxOf(homeDir: string, platform: ForeignPlatform, env: Record<string, string | undefined> = {}, version = 3): ForeignSourceContext {
  return { homeDir, env, platform, targetSessionFormatVersion: version };
}

import { grokbuildSource } from './grokbuild.ts';
import { grokCwdFromDirName, grokSessionRoots, readGrokbuild } from './read-grokbuild.ts';

test('grokbuild t1 路径真值：双根（sessions + archived_sessions）× 三平台与真值表逐项一致', () => {
  assertTruthPaths('grokbuild', grokSessionRoots);
  const linux = grokSessionRoots({ homeDir: '/home/u', env: {}, platform: 'linux' });
  assert.deepEqual(linux, ['/home/u/.grok/sessions', '/home/u/.grok/archived_sessions']);
  const win = grokSessionRoots({ homeDir: 'C:/u', env: { GROK_HOME: 'D:/grok' }, platform: 'win32' });
  assert.deepEqual(
    win,
    ['D:/grok' + BS + 'sessions', 'D:/grok' + BS + 'archived_sessions'],
    'GROK_HOME 是替换语义（win32 上分隔符必须是目标平台的 BS）',
  );
});

test('grokbuild t2 目录名逆变换：encodeURIComponent(cwd) 可逆，非绝对路径一律不认', () => {
  assert.equal(grokCwdFromDirName(encodeURIComponent('/home/u/my proj'), 'linux'), '/home/u/my proj');
  assert.equal(grokCwdFromDirName(encodeURIComponent('C:' + BS + 'work' + BS + 'proj'), 'win32'), 'C:' + BS + 'work' + BS + 'proj');
  assert.equal(grokCwdFromDirName('relative-dir', 'linux'), undefined);
  assert.equal(grokCwdFromDirName('%E0%A4%A', 'linux'), undefined);
});

test('grokbuild t3 解析 + 端到端：双根都被读到，会话落 sessions/workspaces 两个分区', async () => {
  const root = await tmpRoot('grok');
  try {
    const cwd = '/home/u/proj';
    const encoded = encodeURIComponent(cwd);
    await writeAt(root, path.join('.grok', 'sessions', encoded, 's-1', 'summary.json'), JSON.stringify({ cwd, title: 'grok 会话' }));
    await writeAt(root, path.join('.grok', 'sessions', encoded, 's-1', 'chat_history.jsonl'), [
      JSON.stringify({ role: 'user', content: 'hi', timestamp: 1700000000000 }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'yo' }] }),
    ].join(NL) + NL);
    await writeAt(root, path.join('.grok', 'archived_sessions', encoded, 's-2', 'chat_history.jsonl'), [
      JSON.stringify({ role: 'user', content: 'archived', timestamp: 1700000001000 }),
    ].join(NL) + NL);

    const read = await readGrokbuild({ homeDir: root, env: {}, platform: 'linux' });
    assert.equal(read.files.length, 2, '双根都要扫到（只取一根会漏扫）');
    const first = read.files.find((f) => f.id === 's-1');
    assert.ok(first !== undefined);
    assert.equal(first.cwd, cwd);
    assert.equal(first.title, 'grok 会话');
    assert.equal(first.records.length, 2);

    const ctx = ctxOf(root, 'linux');
    const result = await grokbuildSource.build(ctx);
    assert.equal(result.source, 'grokbuild');
    assert.equal(result.counts['sessions.files'], 2);
    assert.equal(result.counts['workspaces.records'], 1, '两条会话同 cwd → 一条工作区记录');
    const sessions = result.sections.find((s) => s.sectionId === 'sessions');
    assert.ok(sessions !== undefined && sessions.files !== undefined);
    for (const file of sessions.files) {
      assert.ok(file.relativePath.startsWith('--home-u-proj--/'), 'relativePath 必须按 projectKey(cwd) 归位：' + file.relativePath);
      assert.equal(file.data.length > 0, true);
    }
    assert.deepEqual(result.skipped, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('grokbuild t4 缺 cwd：目录名不可逆时如实落 session-missing-cwd，绝不猜', async () => {
  const root = await tmpRoot('grok-nocwd');
  try {
    await writeAt(root, path.join('.grok', 'sessions', 'not-a-cwd', 's-3', 'chat_history.jsonl'),
      JSON.stringify({ role: 'user', content: 'x' }) + NL);
    const result = await grokbuildSource.build(ctxOf(root, 'linux'));
    assert.deepEqual(result.skipped.map((s) => s.code), ['session-missing-cwd']);
    assert.equal(result.counts['sessions.files'], undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('grokbuild t5 detect：只 stat 真值位置；GROK_HOME 命中如实报 source-location-overridden', async () => {
  const root = await tmpRoot('grok-detect');
  try {
    const miss = await grokbuildSource.detect(ctxOf(root, 'linux'));
    assert.equal(miss.found, false);
    const over = await grokbuildSource.detect({ homeDir: root, env: { GROK_HOME: '/nope' }, platform: 'linux' });
    assert.equal(over.skipped?.some((s) => s.code === 'source-location-overridden' && s.origin === 'GROK_HOME'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
