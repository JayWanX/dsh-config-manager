/**
 * Cline 来源回归（路径真值 × modern/legacy 两代解析 × 端到端 × 环境变量覆盖）。
 *
 * 取证：本机无 ~/.cline 与对应 VS Code globalStorage（fixture 级）；夹具在测试内即时构造。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, vscodeUserDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';

const BS = String.fromCharCode(92);
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];
/** 读真实临时目录的用例用**运行平台**（绝对路径判定要对得上真机） */
const HOST: ForeignPlatform = normalizePlatform(process.platform);

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

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

function normalize(p: string): string {
  return p.split(BS).join('/');
}

function assertTruthPaths(id: string, probePaths: (opts: RootProbeOptions) => readonly string[]): void {
  for (const platform of PLATFORMS) {
    const probe = TRUTH_PROBES[platform];
    const opts: RootProbeOptions = { homeDir: probe.homeDir, env: TRUTH_PROBE_ENV, platform };
    assert.deepEqual(
      probePaths(opts).map(normalize),
      truthProbePaths(id, opts).map(normalize),
      id + ' × ' + platform + ' 的 probePaths 与真值表不一致',
    );
  }
}

function ctxOf(homeDir: string, platform: ForeignPlatform, env: Record<string, string | undefined> = {}, version = 3, projectDir?: string): ForeignSourceContext {
  return {
    homeDir,
    env,
    platform,
    targetSessionFormatVersion: version,
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

import { clineSource } from './cline.ts';
import { clineCwdOf, clineProbePaths, readCline, resolveClineRoots } from './read-cline.ts';

test('cline t1 路径真值：modern 三级 + 三个 VS Code globalStorage × 三平台与真值表逐项一致', () => {
  assertTruthPaths('cline', clineProbePaths);
  const linux = clineProbePaths({ homeDir: '/home/u', env: {}, platform: 'linux' });
  assert.deepEqual(linux, [
    '/home/u/.cline/data/sessions',
    ['/home/u', '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
    ['/home/u', '.config', 'Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
    ['/home/u', '.config', 'VSCodium', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
  ]);
  const roots = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_SESSION_DATA_DIR: '/data/cline' }, platform: 'linux' });
  assert.equal(roots.modern, '/data/cline');
  assert.equal(roots.modernFrom, 'CLINE_SESSION_DATA_DIR');
  const dataDir = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_DATA_DIR: '/data/c' }, platform: 'linux' });
  assert.equal(dataDir.modern, '/data/c/sessions');
  const dirEnv = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_DIR: '/opt/cline' }, platform: 'linux' });
  assert.equal(dirEnv.modern, '/opt/cline/data/sessions');
  const oneLegacy = resolveClineRoots({
    homeDir: '/home/u',
    env: { CLINE_LEGACY_GLOBAL_STORAGE_DIR: '/one/legacy', CLINE_VSCODE_GLOBAL_STORAGE_DIR: '/two' },
    platform: 'linux',
  });
  assert.deepEqual(oneLegacy.legacy, ['/one/legacy'], '两个 override 命中即**只返回该一个** legacy 根');
});

test('cline t2 cwd 搜索：键名白名单 + 目标平台绝对路径双重过滤', () => {
  assert.equal(clineCwdOf({ metadata: { cwdOnTaskInitialization: '/p/a' } }, 'linux'), '/p/a');
  assert.equal(clineCwdOf({ cwd: 'relative/nope', nested: { path: '/p/b' } }, 'linux'), '/p/b');
  assert.equal(clineCwdOf({ cwd: 'relative/nope' }, 'linux'), undefined);
});

test('cline t3 解析 + 端到端：modern（messages.json）与 legacy（ui_messages）都产出会话', async () => {
  const root = await tmpRoot('cline');
  try {
    const modernDir = path.join('.cline', 'data', 'sessions', 'sess-1');
    await writeAt(root, path.join(modernDir, 'sess-1.json'), JSON.stringify({ cwd: path.join(root, 'proj'), title: 'cline 会话' }));
    await writeAt(root, path.join(modernDir, 'sess-1.messages.json'), JSON.stringify([
      { role: 'user', content: 'hi', ts: 1700000000000 },
      { type: 'say', say: 'text', text: 'yo', ts: 1700000001000 },
      { type: 'say', say: 'api_req_started', text: 'request' },
    ]));
    await writeAt(root, path.join(modernDir, 'sess-1.compaction.json'), JSON.stringify({ summary: 'x' }));

    // legacy 根按**运行平台**真值定位（win32 = %APPDATA% 回落 <home>/AppData/Roaming；
    // linux/darwin = <home>/.config 或 Application Support）—— 夹具不写死 linux 形态
    const legacyDir = path.join(
      vscodeUserDataDir(HOST, root, {}, 'Code'),
      'globalStorage', 'saoudrizwan.claude-dev', 'tasks', 'task-1',
    );
    await writeAt(root, path.relative(root, path.join(legacyDir, 'ui_messages.json')), JSON.stringify([
      { type: 'say', say: 'user_feedback', text: 'legacy q', ts: 1700000002000 },
      { type: 'say', say: 'text', text: 'legacy a' },
    ]));
    await writeAt(root, path.relative(root, path.join(legacyDir, 'state', 'taskHistory.json')), JSON.stringify({
      cwdOnTaskInitialization: path.join(root, 'legacy-proj'),
      task: 'legacy 任务',
    }));

    const read = await readCline({ homeDir: root, env: {}, platform: HOST });
    assert.equal(read.files.length, 2, 'modern 与 legacy 两条路径都要读到');
    const modern = read.files.find((f) => f.id === 'sess-1');
    assert.ok(modern !== undefined);
    assert.equal(modern.flavor, 'modern');
    assert.equal(modern.cwd, path.join(root, 'proj'));
    assert.equal(modern.title, 'cline 会话');
    assert.equal(modern.records.length, 2);
    assert.equal(modern.ignored['cline:api_req_started'], 1, '未迁移的 say 子类型必须逐类计数');
    assert.equal(modern.ignored['compaction'], 1);

    const legacy = read.files.find((f) => f.id === 'task-1');
    assert.ok(legacy !== undefined);
    assert.equal(legacy.flavor, 'legacy');
    assert.equal(legacy.cwd, path.join(root, 'legacy-proj'), 'legacy cwd 只认 cwdOnTaskInitialization');
    assert.equal(legacy.records.length, 2);
    assert.equal(legacy.records[0]?.role, 'user', 'say=user_feedback 属用户侧');

    const result = await clineSource.build(ctxOf(root, HOST));
    assert.equal(result.counts['sessions.files'], 2);
    assert.equal(result.counts['workspaces.records'], 2);
    const details = result.skipped.filter((s) => s.code === 'unsupported-session-record').map((s) => s.detail).sort();
    assert.deepEqual(details, ['cline:api_req_started', 'compaction']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cline t4 detect：只 stat 探测位置；五个覆盖变量命中如实报 source-location-overridden', async () => {
  const root = await tmpRoot('cline-detect');
  try {
    const miss = await clineSource.detect(ctxOf(root, HOST));
    assert.equal(miss.found, false);
    const over = await clineSource.detect(ctxOf(root, HOST, { CLINE_DIR: path.join(root, 'alt') }));
    assert.equal(over.skipped?.some((s) => s.code === 'source-location-overridden' && s.origin === 'CLINE_DIR'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
