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
import { parseVibeJsonl, readVibe, vibeSessionRoots, vibeTimeFromDirName } from './read-vibe.ts';

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

test('vibe t5 cwd 权威：meta.environment.working_directory / origin_directory（顶层 cwd 仅兜底）', async () => {
  const root = await tmpRoot('vibe-meta');
  try {
    const dir = path.join('.vibe', 'logs', 'session', 's-env');
    await writeAt(root, path.join(dir, 'meta.json'), JSON.stringify({ environment: { working_directory: '/home/u/env' } }));
    await writeAt(root, path.join(dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + NL);
    const dir2 = path.join('.vibe', 'logs', 'session', 's-origin');
    await writeAt(root, path.join(dir2, 'meta.json'), JSON.stringify({ origin_directory: '/home/u/origin' }));
    await writeAt(root, path.join(dir2, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'yo' }) + NL);

    const read = await readVibe({ homeDir: root, env: {}, platform: 'linux' });
    const byId = new Map(read.files.map((f) => [f.id, f.cwd]));
    assert.equal(byId.get('s-env'), '/home/u/env', '真实布局在 environment.working_directory');
    assert.equal(byId.get('s-origin'), '/home/u/origin');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('vibe t6 messages.jsonl：tool_calls / role=tool / reasoning / compaction / images 全部有处置', () => {
  const parsed = parseVibeJsonl([
    JSON.stringify({ role: 'user', content: 'hi', images: [{ source: { kind: 'file', path: '/x.png' } }] }),
    JSON.stringify({ role: 'assistant', content: '正文', reasoning_content: '思考', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'c1', content: 'body', tool_result: { output: 'body' } }),
    JSON.stringify({ role: 'tool', tool_call_id: 'ghost', content: '孤儿结果' }),
    JSON.stringify({ role: 'user', content: '', context_boundary: 'compaction' }),
    JSON.stringify({ role: 'user', content: 'after' }),
  ].join(NL));
  assert.deepEqual(parsed.records.map((r) => r.role), ['user', 'assistant', 'user', 'user']);
  assert.deepEqual(parsed.records[1]?.blocks, [
    { type: 'text', text: '正文' },
    { type: 'tool_call', id: 'c1', name: 'read', input: { p: 1 } },
  ]);
  assert.deepEqual(parsed.records[2]?.blocks[0], { type: 'tool_result', id: 'c1', text: 'body', isError: false });
  assert.equal(parsed.ignored['reasoning-block'], 1, 'reasoning_content 无 IR 块 → 计数可见');
  assert.equal(parsed.ignored['dropped-tool-result'], 1, '孤儿结果丢弃必须可见');
  assert.equal(parsed.ignored['compaction'], 1, 'compaction 边界计数（合成器暂无检查点能力）');
  assert.equal(parsed.ignored['image-block'], 1, 'images 无 IR 块 → 计数可见');
});

test('vibe t7 时间：meta.start_time 与目录名时间戳都做秒/毫秒判定', async () => {
  assert.equal(vibeTimeFromDirName('session_1700000000_abc'), 1700000000000, '10 位秒 → 毫秒');
  assert.equal(vibeTimeFromDirName('session_1700000000000_abc'), 1700000000000, '13 位毫秒原样');
  const root = await tmpRoot('vibe-time');
  try {
    const dir = path.join('.vibe', 'logs', 'session', 'session_1700000000_sec');
    await writeAt(root, path.join(dir, 'meta.json'), JSON.stringify({ start_time: 1600000000, title: 't' }));
    await writeAt(root, path.join(dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + NL);
    const read = await readVibe({ homeDir: root, env: {}, platform: 'linux' });
    assert.equal(read.files[0]?.createdAt, 1600000000000, 'meta.start_time 是秒 → 换算毫秒，且优先于目录名');
    const withDirFallback = await tmpRoot('vibe-time2');
    try {
      await writeAt(withDirFallback, path.join('.vibe', 'logs', 'session', 'session_1700000000_sec', 'messages.jsonl'),
        JSON.stringify({ role: 'user', content: 'hi' }) + NL);
      const read2 = await readVibe({ homeDir: withDirFallback, env: {}, platform: 'linux' });
      assert.equal(read2.files[0]?.createdAt, 1700000000000, '缺 meta 时目录名秒值兜底');
    } finally {
      await fs.rm(withDirFallback, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('vibe t8 发现自证：任意目录名 + 递归收集含 messages.jsonl 的目录', async () => {
  const root = await tmpRoot('vibe-walk');
  try {
    await writeAt(root, path.join('.vibe', 'logs', 'session', 'outer', 'inner', 'deep', 'messages.jsonl'),
      JSON.stringify({ role: 'user', content: 'nested' }) + NL);
    await writeAt(root, path.join('.vibe', 'logs', 'session', 'outer', 'inner', 'deep', 'meta.json'),
      JSON.stringify({ origin_directory: '/home/u/deep' }));
    await writeAt(root, path.join('.vibe', 'logs', 'session', 'not-a-session', 'x.jsonl'), '{}\n');

    const read = await readVibe({ homeDir: root, env: {}, platform: 'linux' });
    assert.equal(read.files.length, 1);
    assert.equal(read.files[0]?.id, 'deep', '按 messages.jsonl 自证，不限目录名前缀与层级');
    assert.equal(read.files[0]?.cwd, '/home/u/deep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
