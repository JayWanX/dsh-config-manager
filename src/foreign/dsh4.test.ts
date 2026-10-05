/**
 * dsh4 来源回归（V4 代次，与 dsh **共用同一扫描器与同一装配器**）。
 *
 * 取证：`measured`（本机实测存在 session.v4.jsonl.zstd，首帧 version=4）。
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
const HOST: ForeignPlatform = normalizePlatform(process.platform);

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
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

import { dsh4Source } from './dsh4.ts';
import { dshGenerationOfVersion, dshProbePaths } from './read-dsh.ts';
import { dsh4GenerationOfVersion, dsh4ProbePaths, dsh4SessionsRoot } from './read-dsh4.ts';
import { encodeZstdFrame, zstdAvailable } from '../utils/zstd-frame.ts';
import { projectKeyOf } from '../core/session-select.ts';

function logBytes(header: Record<string, unknown>): Uint8Array {
  return Buffer.concat([encodeZstdFrame(Buffer.from(JSON.stringify(header) + NL))]);
}

test('dsh4 t1 与 dsh 同根同路径（同源函数，不是副本）；代次判据只认 V4', () => {
  assertTruthPaths('dsh4', dsh4ProbePaths);
  assert.deepEqual(dsh4ProbePaths({ homeDir: '/home/u', env: {}, platform: 'linux' }), dshProbePaths({ homeDir: '/home/u', env: {}, platform: 'linux' }));
  assert.equal(dsh4SessionsRoot({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.dsh/sessions');
  assert.equal(dsh4GenerationOfVersion(4), 'v4');
  assert.equal(dsh4GenerationOfVersion(3), undefined);
  assert.equal(dshGenerationOfVersion(4), 'v4');
});

test('dsh4 t2 端到端：只带走 V4 日志（v3 属于 dsh 的域），字节直通 + workspaces 连带', async (t) => {
  if (!zstdAvailable()) {
    t.skip('本宿主 Node 无 zstd');
    return;
  }
  const root = await tmpRoot('dsh4');
  try {
    const cwd = '/home/u/proj';
    const v4 = path.join('.dsh', 'sessions', 'k', 'sess-b');
    const bytes = logBytes({ type: 'session', version: 4, id: 'sess-b', createdAt: 1700000000000, cwd });
    await fs.mkdir(path.join(root, v4), { recursive: true });
    await fs.writeFile(path.join(root, v4, 'session.v4.jsonl.zstd'), bytes);
    const v3 = path.join('.dsh', 'sessions', 'k', 'sess-a');
    await fs.mkdir(path.join(root, v3), { recursive: true });
    await fs.writeFile(path.join(root, v3, 'session.v3.jsonl.zstd'), logBytes({ type: 'session', version: 3, id: 'sess-a', createdAt: 1, cwd }));

    const result = await dsh4Source.build(ctxOf(root, HOST, {}, 4));
    assert.equal(dsh4Source.evidence, 'measured');
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['dsh.logs.otherGeneration'], 1, 'v3 进「另一代次」计数，不报错');
    const file = result.sections.find((s) => s.sectionId === 'sessions')?.files?.[0];
    assert.ok(file !== undefined && file.data !== undefined);
    assert.equal(Buffer.compare(Buffer.from(file.data), Buffer.from(bytes)), 0);
    assert.equal(file.relativePath, projectKeyOf(cwd) + '/sess-b/session.v4.jsonl.zstd');
    assert.equal(result.counts['workspaces.records'], 1);

    const mismatched = await dsh4Source.build(ctxOf(root, HOST, {}, 3));
    assert.deepEqual(mismatched.sections, []);
    assert.equal(mismatched.skipped.some((s) => s.code === 'session-format-unsupported'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dsh4 t3 detect：与 dsh 同根探测', async () => {
  const root = await tmpRoot('dsh4-detect');
  try {
    assert.equal((await dsh4Source.detect(ctxOf(root, HOST))).found, false);
    const over = await dsh4Source.detect(ctxOf(root, HOST, { DSH_HOME: '/opt/dsh' }));
    assert.equal(over.skipped?.some((s) => s.code === 'source-location-overridden'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
