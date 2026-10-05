/**
 * ChatGPT 来源回归（**无自动根** × 显式路径契约 × mapping DAG 链 × 端到端）。
 *
 * 取证：export 包结构来自公开导出格式 + 四份报告的落点（documented）；夹具在测试内即时构造。
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
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];
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

import { chatgptSource } from './chatgpt.ts';
import { chatgptChainOf, chatgptExplicitPath, dirnameFor, epochMsOf, readChatgpt } from './read-chatgpt.ts';

test('chatgpt t1 无自动根：probePaths 恒空 + 恒报 source-needs-explicit-path（**绝不猜 cwd**）', async () => {
  assertTruthPaths('chatgpt', (opts) => chatgptSource.probePaths(opts));
  for (const platform of PLATFORMS) {
    assert.deepEqual(chatgptSource.probePaths({ homeDir: '/home/u', env: {}, platform }), []);
  }
  const root = await tmpRoot('chatgpt-detect');
  try {
    const det = await chatgptSource.detect(ctxOf(root, HOST));
    assert.equal(det.found, false, '自动探测永远 0 命中');
    assert.equal(det.paths.length, 0);
    assert.equal(det.skipped?.some((s) => s.code === 'source-needs-explicit-path'), true, '必须如实报码，不许假装「未安装」');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chatgpt t2 显式路径只在 projectDir 上取值；缺省绝不回落到 cwd/home', () => {
  assert.equal(chatgptExplicitPath({ homeDir: '/home/u', env: {}, platform: 'linux' }), undefined);
  assert.equal(chatgptExplicitPath({ homeDir: '/home/u', env: {}, platform: 'linux', projectDir: '  ' }), undefined);
  assert.equal(chatgptExplicitPath({ homeDir: '/home/u', env: {}, platform: 'linux', projectDir: '/x/conversations.json' }), '/x/conversations.json');
});

test('chatgpt t3 时间与父目录：浮点秒 → 毫秒；win32 盘符根保留', () => {
  assert.equal(epochMsOf(1700000000.5), 1700000000500);
  assert.equal(epochMsOf(1700000000000), 1700000000000);
  assert.equal(epochMsOf('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(epochMsOf('nope'), undefined);
  assert.equal(dirnameFor('linux', '/a/b/conversations.json'), '/a/b');
  assert.equal(dirnameFor('win32', 'C:' + BS + 'a' + BS + 'conversations.json'), 'C:' + BS + 'a');
});

test('chatgpt t4 mapping DAG：current_node 向上回溯；缺 current_node 取最长根链', () => {
  const mapping = {
    n0: { parent: null, children: ['n1'] },
    n1: { parent: 'n0', children: ['n2'] },
    n2: { parent: 'n1', children: ['n3'] },
    n3: { parent: 'n2', children: [] },
    side: { parent: null, children: [] },
  };
  assert.deepEqual(chatgptChainOf(mapping, 'n2'), ['n0', 'n1', 'n2']);
  assert.deepEqual(chatgptChainOf(mapping, undefined), ['n0', 'n1', 'n2', 'n3']);
  assert.deepEqual(chatgptChainOf(undefined, 'x'), []);
});

function conversation(): string {
  return JSON.stringify([{
    id: 'conv-1',
    title: 'chatgpt 会话',
    create_time: 1700000000.5,
    current_node: 'n3',
    mapping: {
      n0: { id: 'n0', message: null, parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'n0',
        children: ['n2'],
        message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['sys'] }, create_time: 1700000000.6 },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: ['n3'],
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] }, create_time: 1700000000.7 },
      },
      n3: {
        id: 'n3',
        parent: 'n2',
        children: [],
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['world'] }, create_time: 1700000000.8 },
      },
    },
  }]);
}

test('chatgpt t5 显式文件：解析链、cwd 由显式路径所在目录推导并**如实报码**', async () => {
  const root = await tmpRoot('chatgpt-export');
  try {
    const file = path.join(root, 'conversations.json');
    await writeAt(root, 'conversations.json', conversation());
    const read = await readChatgpt({ homeDir: root, env: {}, platform: HOST, projectDir: file });
    assert.equal(read.files.length, 1);
    const session = read.files[0];
    assert.ok(session !== undefined);
    assert.equal(session.id, 'conv-1');
    assert.equal(session.cwd, root, 'cwd = 显式文件所在目录（唯一一处推导）');
    assert.equal(session.title, 'chatgpt 会话');
    assert.equal(session.records.length, 2, 'system 节点不进正文（逐类进 ignored）');
    assert.equal(session.ignored['chatgpt:role-system'], 1);
    assert.equal(read.readFindings?.some((s) => s.code === 'session-cwd-derived'), true, '推导必须可见');

    const result = await chatgptSource.build(ctxOf(root, HOST, {}, 3, file));
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['workspaces.records'], 1);
    const codes = result.skipped.map((s) => s.code);
    assert.ok(codes.includes('session-cwd-derived'));
    assert.ok(codes.includes('unsupported-session-record'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chatgpt t6 未给显式路径：build 只报 source-needs-explicit-path，不产出任何分区', async () => {
  const root = await tmpRoot('chatgpt-nopath');
  try {
    const result = await chatgptSource.build(ctxOf(root, HOST));
    assert.deepEqual(result.sections, []);
    assert.deepEqual(result.skipped.map((s) => s.code), ['source-needs-explicit-path']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
