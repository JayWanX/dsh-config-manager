/**
 * Reasonix 来源回归（路径真值 × 伴生 meta 解析 × 端到端）。
 *
 * 取证：本机无 ~/.reasonix（fixture 级）；夹具在测试内即时构造。
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

import { reasonixSource } from './reasonix.ts';
import { readReasonix, reasonixMetaPath, reasonixSessionRoots } from './read-reasonix.ts';

test('reasonix t1 路径真值：~/.reasonix/sessions + （仅 win32）%APPDATA%/reasonix', () => {
  assertTruthPaths('reasonix', reasonixSessionRoots);
  assert.deepEqual(reasonixSessionRoots({ homeDir: '/home/u', env: {}, platform: 'linux' }), ['/home/u/.reasonix/sessions']);
  assert.deepEqual(reasonixSessionRoots({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), ['/Users/u/.reasonix/sessions']);
  assert.deepEqual(reasonixSessionRoots({ homeDir: 'C:/u', env: {}, platform: 'win32' }), [
    ['C:/u', '.reasonix', 'sessions'].join(BS),
    ['C:/u', 'AppData', 'Roaming', 'reasonix'].join(BS),
  ]);
});

test('reasonix t2 伴生 meta 路径：<stem>.jsonl → <stem>.meta.json', () => {
  assert.equal(reasonixMetaPath('C:' + BS + 'x' + BS + 'desktop-1.jsonl'), 'C:' + BS + 'x' + BS + 'desktop-1.meta.json');
  assert.equal(reasonixMetaPath('/a/b.jsonl'), '/a/b.meta.json');
});

test('reasonix t3 解析 + 端到端：meta.json 提供 cwd/summary，jsonl 提供消息', async () => {
  const root = await tmpRoot('reasonix');
  try {
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-1.jsonl'), [
      JSON.stringify({ role: 'user', content: 'hello', timestamp: 1700000000000 }),
      JSON.stringify({ role: 'assistant', content: 'hi there' }),
      JSON.stringify({ type: 'tool-call', junk: true }),
    ].join(NL) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-1.meta.json'), JSON.stringify({ workspace: '/home/u/proj', summary: 'reasonix 会话' }));

    const read = await readReasonix({ homeDir: root, env: {}, platform: 'linux' });
    assert.equal(read.files.length, 1);
    const file = read.files[0];
    assert.ok(file !== undefined);
    assert.equal(file.id, 'desktop-1');
    assert.equal(file.cwd, '/home/u/proj');
    assert.equal(file.title, 'reasonix 会话');
    assert.equal(file.records.length, 2, '未迁移类型要进 ignored，不得进正文');
    assert.equal(file.ignored['tool-call'], 1);

    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['workspaces.records'], 1);
    assert.equal(result.skipped.length, 1, '未迁移记录逐类报 unsupported-session-record');
    assert.equal(result.skipped[0]?.code, 'unsupported-session-record');
    assert.equal(result.skipped[0]?.detail, 'tool-call');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reasonix t4 无 meta：cwd 缺失 → session-missing-cwd（绝不猜）', async () => {
  const root = await tmpRoot('reasonix-nometa');
  try {
    await writeAt(root, path.join('.reasonix', 'sessions', 'subagent-sub-1.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + NL);
    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    assert.deepEqual(result.skipped.map((s) => s.code), ['session-missing-cwd']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
