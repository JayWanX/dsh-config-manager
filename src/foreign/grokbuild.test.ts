/**
 * Grok Build 来源回归（路径真值 × summary 真字段 × 真实 {type,…} 转录 × 端到端）。
 *
 * 取证：本机无 ~/.grok（fixture 级）；夹具在测试内即时构造（可复现），真机未验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSessionLogShapeFromBytes } from '../utils/session-log.ts';
import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';
import type { ForeignImportResult } from './types.ts';

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
import { grokCwdFromDirName, grokSessionRoots, parseGrokHistory, readGrokbuild } from './read-grokbuild.ts';

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
    await writeAt(root, path.join('.grok', 'archived_sessions', encoded, 's-2', 'summary.json'), JSON.stringify({ cwd }));
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

test('grokbuild t4 缺 cwd：summary 无 cwd 且目录名不可逆 → session-missing-cwd；无 summary 的目录不算会话', async () => {
  const root = await tmpRoot('grok-nocwd');
  try {
    await writeAt(root, path.join('.grok', 'sessions', 'not-a-cwd', 's-3', 'summary.json'), JSON.stringify({ title: '无 cwd' }));
    await writeAt(root, path.join('.grok', 'sessions', 'not-a-cwd', 's-3', 'chat_history.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + NL);
    // 只有 chat_history.jsonl、没有 summary.json 的目录：不是会话（发现口径 = 含 summary.json）
    await writeAt(root, path.join('.grok', 'sessions', 'not-a-cwd', 'no-summary', 'chat_history.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + NL);
    const result = await grokbuildSource.build(ctxOf(root, 'linux'));
    assert.deepEqual(result.skipped.map((s) => s.code), ['session-missing-cwd']);
    assert.equal(result.counts['sessions.files'], undefined);
    assert.equal(result.counts['grokbuild.sessionDirs'], 1, '无 summary.json 的目录不进发现面');
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

function sessionFilesOf(result: ForeignImportResult) {
  return result.sections.find((s) => s.sectionId === 'sessions')?.files ?? [];
}

/** 解出会话字节里的行（DSH codec 视角）；解不出即断言失败，绝不静默跳过 */
function rowsOf(data: Uint8Array): Record<string, unknown>[] {
  const shape = readSessionLogShapeFromBytes(data);
  assert.equal(shape.ok, true, '产物必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return [];
  return shape.rows.filter((r): r is Record<string, unknown> => r !== null);
}

function dataOf(row: Record<string, unknown>): Record<string, unknown> {
  return row['data'] as Record<string, unknown>;
}

test('grokbuild t6 真实形状：顶层 tool_calls + type:"tool_result" 配对（callId 必须逐字相同）', async () => {
  const lines = [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '跑工具' }] }),
    JSON.stringify({ type: 'assistant', content: '', tool_calls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }] }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1', content: '结果正文' }),
    JSON.stringify({ type: 'assistant', content: '', tool_calls: [{ name: 'grep', arguments: '{"q":1}' }] }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'grokbuild-2-1', content: '第二结果' }),
  ];
  const parsed = parseGrokHistory(lines.join(NL) + NL);
  assert.equal(parsed.records.length, 5, 'user + 调用 + 结果 + 调用 + 结果（此前顶层 tool_calls 与 tool_result 全丢）');
  assert.equal(parsed.records[0]?.role, 'user');
  assert.deepEqual(parsed.records[1]?.blocks, [{ type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }]);
  assert.deepEqual(parsed.records[2]?.blocks, [{ type: 'tool_result', id: 'call-1', text: '结果正文', isError: false }]);
  assert.deepEqual(parsed.records[3]?.blocks, [{ type: 'tool_call', id: 'grokbuild-2-1', name: 'grep', input: { q: 1 } }]);
  assert.deepEqual(parsed.records[4]?.blocks, [{ type: 'tool_result', id: 'grokbuild-2-1', text: '第二结果', isError: false }]);

  const root = await tmpRoot('grok-tools');
  try {
    const dir = path.join('.grok', 'sessions', 'x', 's-tools');
    await writeAt(root, path.join(dir, 'summary.json'), JSON.stringify({ info: { cwd: '/home/u/proj' } }));
    await writeAt(root, path.join(dir, 'chat_history.jsonl'), lines.join(NL) + NL);
    const result = await grokbuildSource.build(ctxOf(root, 'linux'));
    const session = sessionFilesOf(result)[0];
    assert.ok(session !== undefined);
    const rows = rowsOf(session.data);
    const callIds = rows.filter((r) => r['type'] === 'tool/call').map((r) => dataOf(r)['callId']);
    const resultIds = rows.filter((r) => r['type'] === 'tool/result').map((r) => {
      const message = dataOf(r)['message'] as Record<string, unknown>;
      return (message['source'] as Record<string, unknown>)['callId'];
    });
    assert.deepEqual(callIds, ['call-1', 'grokbuild-2-1']);
    assert.deepEqual(resultIds, callIds, '结果必须挂回同一次调用（配对断裂会让 DSH 判损坏）');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('grokbuild t7 summary 真字段 + 注入行过滤 + 递归发现（多层嵌套目录里的会话也认）', async () => {
  const root = await tmpRoot('grok-summary');
  try {
    const encoded = encodeURIComponent('/wrong/decoded');
    const deep = path.join('.grok', 'sessions', encoded, 'deep', 'nested', 's-9');
    await writeAt(root, path.join(deep, 'summary.json'), JSON.stringify({ info: { id: 'grok-info-id', cwd: '/home/u/real' }, generated_title: '生成标题', updated_at: '2026-01-02T00:00:00Z' }));
    await writeAt(root, path.join(deep, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '第一问' }] }),
      JSON.stringify({ type: 'user', content: '注入文本', synthetic_reason: 'system_reminder' }),
      JSON.stringify({ type: 'user', content: '压缩交接', synthetic_reason: 'compaction_meta' }),
      JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: '想一下' }] }),
      JSON.stringify({ type: 'system', content: '系统提示' }),
      JSON.stringify({ type: 'assistant', content: '答' }),
    ].join(NL) + NL);
    const flat = path.join('.grok', 'sessions', encoded, 's-10');
    await writeAt(root, path.join(flat, 'summary.json'), JSON.stringify({ info: { cwd: '/home/u/real' }, session_summary: '摘要标题', created_at: '2026-01-01T00:00:00Z' }));
    await writeAt(root, path.join(flat, 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: 'hi' }) + NL);

    const read = await readGrokbuild({ homeDir: root, env: {}, platform: 'linux' });
    assert.deepEqual(read.files.map((f) => f.id), ['grok-info-id', 's-10'], '递归发现（含 3 层以上嵌套）');
    const file = read.files[0];
    assert.ok(file !== undefined);
    assert.equal(file.cwd, '/home/u/real', 'info.cwd 优先于目录名逆变换');
    assert.equal(file.title, '生成标题', 'generated_title 优先');
    assert.equal(file.createdAt, Date.parse('2026-01-02T00:00:00Z'), 'created_at 缺失时用 updated_at');
    assert.deepEqual(file.records.map((r) => r.role), ['user', 'assistant'], '注入/reasoning/system 绝不进正文');
    assert.equal(file.ignored['injected-user'], 1);
    assert.equal(file.ignored['compaction-meta'], 1, '压缩交接摘要按 IR 能力如实计数（不塞进正文）');
    assert.equal(file.ignored['reasoning'], 1);
    assert.equal(file.ignored['system'], 1);
    const second = read.files[1];
    assert.equal(second?.title, '摘要标题', 'session_summary 是 generated_title 的回退');
    assert.equal(second?.createdAt, Date.parse('2026-01-01T00:00:00Z'), 'created_at 优先于 updated_at');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
