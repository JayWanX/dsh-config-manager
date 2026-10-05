/**
 * Vibe 来源回归（路径真值 × 追加语义 × 端到端）。
 *
 * 取证：本机无 ~/.vibe（fixture 级）。交叉核对记录见 read-vibe.ts 文件头
 * （PLAN-B 草稿把 vibe 标成 VS Code 根，三份报告都说 ~/.vibe + messages.jsonl）。
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

import { vibeSource } from './vibe.ts';
import { readVibe, vibeSessionRoots, vibeTimeFromDirName } from './read-vibe.ts';

test('vibe t1 路径真值：$VIBE_HOME 是**追加**（两根并存），默认 ~/.vibe/logs/session', () => {
  assertTruthPaths('vibe', vibeSessionRoots);
  assert.deepEqual(vibeSessionRoots({ homeDir: '/home/u', env: {}, platform: 'linux' }), ['/home/u/.vibe/logs/session']);
  assert.deepEqual(
    vibeSessionRoots({ homeDir: '/home/u', env: { VIBE_HOME: '/opt/vibe' }, platform: 'linux' }),
    ['/opt/vibe/logs/session', '/home/u/.vibe/logs/session'],
    '追加语义：env 根与默认根**并存**（不是替换）',
  );
  assert.deepEqual(
    vibeSessionRoots({ homeDir: '/home/u', env: { VIBE_HOME: '/home/u/.vibe' }, platform: 'linux' }),
    ['/home/u/.vibe/logs/session'],
    '同一个根不重复',
  );
});

test('vibe t2 目录名时间戳：session_<ts>_<shortId>', () => {
  assert.equal(vibeTimeFromDirName('session_1700000000000_abc'), 1700000000000);
  assert.equal(vibeTimeFromDirName('session_1700000000000'), 1700000000000);
  assert.equal(vibeTimeFromDirName('session_abc'), undefined);
  assert.equal(vibeTimeFromDirName('other_1700000000000_x'), undefined);
});

test('vibe t3 解析 + 端到端：meta.json 提供 cwd，messages.jsonl 提供消息', async () => {
  const root = await tmpRoot('vibe');
  try {
    const dir = path.join('.vibe', 'logs', 'session', 'session_1700000000000_abc');
    await writeAt(root, path.join(dir, 'meta.json'), JSON.stringify({ cwd: '/home/u/proj', title: 'vibe 会话' }));
    await writeAt(root, path.join(dir, 'messages.jsonl'), [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'yo' }),
    ].join(NL) + NL);
    await writeAt(root, path.join('.vibe', 'logs', 'session', 'not-a-session', 'x.jsonl'), '{}\n');

    const read = await readVibe({ homeDir: root, env: {}, platform: 'linux' });
    assert.equal(read.files.length, 1, '非 session_ 前缀的目录不得当会话');
    assert.equal(read.files[0]?.cwd, '/home/u/proj');
    assert.equal(read.files[0]?.createdAt, 1700000000000, 'meta 无时间时用目录名时间戳兜底');

    const result = await vibeSource.build(ctxOf(root, 'linux'));
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['workspaces.records'], 1);
    assert.deepEqual(result.skipped, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('vibe t4 VIBE_HOME 追加根也会被读到（只取默认根会漏扫）', async () => {
  const root = await tmpRoot('vibe-home');
  try {
    await writeAt(root, path.join('envroot', 'logs', 'session', 'session_1700000000000_env', 'messages.jsonl'),
      JSON.stringify({ role: 'user', content: 'env' }) + NL);
    const read = await readVibe({ homeDir: root, env: { VIBE_HOME: path.join(root, 'envroot') }, platform: 'linux' });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.id, 'session_1700000000000_env');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
