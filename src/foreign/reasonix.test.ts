/**
 * Reasonix 来源回归（路径真值 × 伴生 meta/标题 × WAL 合并 × 工具配对 × 端到端）。
 *
 * 取证：本机无 ~/.reasonix（fixture 级）；夹具在测试内即时构造。
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

import { reasonixSource } from './reasonix.ts';
import {
  greedyDecodeSlugPath,
  parseReasonixTranscript,
  readReasonix,
  reasonixDesktopLayout,
  reasonixMetaPath,
  reasonixModernMetaPath,
  reasonixSessionRoots,
  reasonixStemTime,
  reasonixWalPath,
 } from './read-reasonix.ts';

const PLATFORM = normalizePlatform(process.platform);

test('reasonix t1 路径真值：~/.reasonix/sessions + （仅 win32）%APPDATA%/reasonix', () => {
  assertTruthPaths('reasonix', reasonixSessionRoots);
  assert.deepEqual(reasonixSessionRoots({ homeDir: '/home/u', env: {}, platform: 'linux' }), ['/home/u/.reasonix/sessions']);
  assert.deepEqual(reasonixSessionRoots({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), ['/Users/u/.reasonix/sessions']);
  assert.deepEqual(reasonixSessionRoots({ homeDir: 'C:/u', env: {}, platform: 'win32' }), [
    ['C:/u', '.reasonix', 'sessions'].join(BS),
    ['C:/u', 'AppData', 'Roaming', 'reasonix'].join(BS),
  ]);
});

test('reasonix t2 伴生路径：旧版 <stem>.meta.json / 新版 <file>.jsonl.meta / WAL <stem>.events.jsonl', () => {
  assert.equal(reasonixMetaPath('C:' + BS + 'x' + BS + 'desktop-1.jsonl'), 'C:' + BS + 'x' + BS + 'desktop-1.meta.json');
  assert.equal(reasonixMetaPath('/a/b.jsonl'), '/a/b.meta.json');
  assert.equal(reasonixModernMetaPath('/a/b.jsonl'), '/a/b.jsonl.meta');
  assert.equal(reasonixWalPath('/a/b.jsonl'), '/a/b.events.jsonl');
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

test('reasonix t4 无 meta：主会话缺 cwd → session-missing-cwd；subagent-sub-* 只计数不产会话', async () => {
  const root = await tmpRoot('reasonix-nometa');
  try {
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-2.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'subagent-sub-1.jsonl'), JSON.stringify({ role: 'user', content: 'x' }) + NL);
    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    // extraSkips（结构性提示）排在 readFindings 之后、转码 skip 之前
    assert.deepEqual(result.skipped.map((s) => s.code), ['unsupported-session-record', 'session-missing-cwd']);
    assert.equal(result.skipped[0]?.detail, 'subagent-session');
    assert.equal(result.counts['reasonix.subagentSessions'], 1, '子代理会话必须可见地计数，绝不静默');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** 参考 cwd-map.mjs 的 reasonix slug 编码：分隔符 → `-`，win32 全小写（盘符段不带冒号） */
function slugOf(workspace: string): string {
  const s = workspace.split(BS).join('/').split(':').join('-').split('/').join('-');
  return PLATFORM === 'win32' ? s.toLowerCase() : s;
}

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

test('reasonix t5 工具配对：两代 tool_calls × role:"tool" → assistant(tool_call)+user(tool_result) 同 id', async () => {
  const lines = [
    JSON.stringify({ role: 'user', content: '跑工具' }),
    JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: '结果正文' }),
    JSON.stringify({ role: 'assistant', tool_calls: [{ name: 'grep', arguments: '{"q":"x"}' }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'reasonix-2-1', content: '扁平结果' }),
  ];
  const parsed = parseReasonixTranscript(lines.join(NL) + NL);
  assert.equal(parsed.records.length, 5, 'user + 调用 + 结果 + 调用 + 结果');
  assert.equal(parsed.records[0]?.role, 'user');
  assert.deepEqual(parsed.records[1]?.blocks, [{ type: 'tool_call', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }]);
  assert.deepEqual(parsed.records[2]?.blocks, [{ type: 'tool_result', id: 'call-1', text: '结果正文', isError: false }]);
  assert.deepEqual(parsed.records[3]?.blocks, [{ type: 'tool_call', id: 'reasonix-2-1', name: 'grep', input: { q: 'x' } }]);
  assert.deepEqual(parsed.records[4]?.blocks, [{ type: 'tool_result', id: 'reasonix-2-1', text: '扁平结果', isError: false }]);

  // 端到端：tool/call 与 tool/result 的 callId 必须逐字相同（配对断裂会让 DSH 判损坏）
  const root = await tmpRoot('reasonix-tools');
  try {
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-3.jsonl'), lines.join(NL) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-3.meta.json'), JSON.stringify({ workspace: '/home/u/proj' }));
    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    const session = sessionFilesOf(result)[0];
    assert.ok(session !== undefined);
    const rows = rowsOf(session.data);
    const callIds = rows.filter((r) => r['type'] === 'tool/call').map((r) => dataOf(r)['callId']);
    const resultIds = rows.filter((r) => r['type'] === 'tool/result').map((r) => {
      const message = dataOf(r)['message'] as Record<string, unknown>;
      return (message['source'] as Record<string, unknown>)['callId'];
    });
    assert.deepEqual(callIds, ['call-1', 'reasonix-2-1']);
    assert.deepEqual(resultIds, callIds, '结果必须挂回同一次调用');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reasonix t6 WAL 合并（replace 整表接管 / 追加）+ 伴生 .events/.conflicts/.guardian 不算会话', async () => {
  const root = await tmpRoot('reasonix-wal');
  try {
    const meta = JSON.stringify({ workspace: '/home/u/proj' });
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-4.jsonl'), JSON.stringify({ role: 'user', content: '旧' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-4.events.jsonl'), JSON.stringify({ type: 'replace', messages: [{ role: 'user', content: 'WAL 权威' }, { role: 'assistant', content: '答' }] }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-4.meta.json'), meta);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-5.jsonl'), JSON.stringify({ role: 'user', content: '基线' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-5.events.jsonl'), JSON.stringify({ role: 'assistant', content: '追加' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-5.meta.json'), meta);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-6.jsonl'), JSON.stringify({ role: 'user', content: '主' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-6.meta.json'), meta);
    for (const suffix of ['events', 'conflicts', 'guardian']) {
      await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-6.' + suffix + '.jsonl'), JSON.stringify({ role: 'user', content: '旁路' }) + NL);
    }
    const read = await readReasonix({ homeDir: root, env: {}, platform: 'linux' });
    assert.deepEqual(read.files.map((f) => f.id), ['desktop-4', 'desktop-5', 'desktop-6'], '旁路日志绝不能变成幻影会话');
    const four = read.files.find((f) => f.id === 'desktop-4');
    assert.equal(four?.walMerged, true);
    assert.equal(four?.records.length, 2, 'replace 整表接管：checkpoint 的「旧」不再出现');
    const firstBlock = four?.records[0]?.blocks[0];
    assert.ok(firstBlock !== undefined && firstBlock.type === 'text');
    assert.equal(firstBlock.text, 'WAL 权威');
    const five = read.files.find((f) => f.id === 'desktop-5');
    assert.equal(five?.walMerged, true);
    assert.equal(five?.records.length, 2, '追加式 WAL：checkpoint + WAL 记录');
    // desktop-6 的 .events.jsonl 是**它的 WAL**（增量合并进同一会话），绝不独立成会话；
    // .conflicts / .guardian 是真正的旁路日志，一条都不合并。
    const six = read.files.find((f) => f.id === 'desktop-6');
    assert.equal(six?.walMerged, true);
    assert.equal(six?.records.length, 2, '.events 作为增量合并，而不是幻影会话');
    assert.equal(read.extraCounts?.['reasonix.walRecords'], 4, 'WAL 合并必须可见（绝不静默）');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reasonix t7 新版 sidecar：workspace_root/topic_title 供 cwd/标题（无旧版 meta.json 也能导入）；scope=global 不给 cwd', async () => {
  const root = await tmpRoot('reasonix-modern');
  try {
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-202601020304-1.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-202601020304-1.jsonl.meta'), JSON.stringify({ topic_title: '新版标题', workspace_root: '/w/proj', scope: 'workspace' }));
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-202601020305-2.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', 'desktop-202601020305-2.jsonl.meta'), JSON.stringify({ topic_title: '全局', scope: 'global' }));
    const read = await readReasonix({ homeDir: root, env: {}, platform: 'linux' });
    const one = read.files.find((f) => f.id === 'desktop-202601020304-1');
    assert.equal(one?.cwd, '/w/proj', '新版 sidecar 的 workspace_root 就是 cwd（缺旧版 meta.json 不再整条跳过）');
    assert.equal(one?.title, '新版标题');
    const two = read.files.find((f) => f.id === 'desktop-202601020305-2');
    assert.equal(two?.cwd, undefined, 'scope=global 不属于任何工作区 → 绝不猜 cwd');
    assert.equal(two?.title, '全局');

    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    assert.deepEqual(sessionFilesOf(result).map((f) => f.relativePath.split('/')[1]), ['desktop-202601020304-1']);
    assert.deepEqual(result.skipped.map((s) => s.code), ['session-missing-cwd']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reasonix t8 桌面布局 projects/<slug>/sessions：.titles.json 权威标题 + slug 逆解码', async () => {
  const root = await tmpRoot('reasonix-desktop');
  // slug 逆解码的候选目录：用**短前缀**的独立 temp 根（贪心解码只合并 ≤3 段，
  // 带 4 段连字符的 temp 根名会让候选永远拼不出来 —— 那是参考实现同款局限，不是本仓缺陷）
  const slugRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm'));
  try {
    const ws = path.join(slugRoot, 'ws');
    await fs.mkdir(ws, { recursive: true });
    const slug = slugOf(ws);
    const rel = path.join('.reasonix', 'sessions', 'projects', slug, 'sessions');
    await writeAt(root, path.join(rel, 'desk-202602030405.jsonl'), JSON.stringify({ role: 'user', content: '第一问' }) + NL);
    await writeAt(root, path.join(rel, '.titles.json'), JSON.stringify({ 'desk-202602030405': '桌面标题' }));

    assert.equal(reasonixDesktopLayout(path.join(root, rel, 'desk-202602030405.jsonl'))?.slug, slug);
    assert.equal(reasonixDesktopLayout('/x/.reasonix/sessions/desk.jsonl'), undefined, '不是 projects/<slug>/sessions 布局就不启用桌面口径');

    const read = await readReasonix({ homeDir: root, env: {}, platform: PLATFORM });
    const file = read.files.find((f) => f.id === 'desk-202602030405');
    assert.ok(file !== undefined);
    assert.equal(file.title, '桌面标题', '.titles.json 是桌面版的权威标题');
    const decoded = await greedyDecodeSlugPath(slug, PLATFORM);
    if (decoded !== undefined) {
      assert.equal(path.normalize(decoded).toLowerCase(), path.normalize(ws).toLowerCase());
      assert.equal(file.cwd, decoded, 'slug 逆解码命中真实目录 → 就是 cwd');
    } else {
      // temp 根里含 . / 空格等编码歧义字符的环境下贪心解码必然失败（参考同款局限）→ 只钉否定面
      assert.equal(file.cwd, undefined);
    }
    assert.equal(await greedyDecodeSlugPath('dcm--no--such--path--xyz', PLATFORM), undefined, '解不出来绝不臆测');
  } finally {
    await fs.rm(slugRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reasonix t9 createdAt 兜底 stem 内嵌时刻（YYYYMMDDHHMM）；usage snake_case → camelCase', async () => {
  const root = await tmpRoot('reasonix-time');
  try {
    const stem = 'desktop-202601020304-7';
    await writeAt(root, path.join('.reasonix', 'sessions', stem + '.jsonl'), [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'yo', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } }),
    ].join(NL) + NL);
    await writeAt(root, path.join('.reasonix', 'sessions', stem + '.meta.json'), JSON.stringify({ workspace: '/w/proj' }));
    const read = await readReasonix({ homeDir: root, env: {}, platform: 'linux' });
    const file = read.files[0];
    assert.equal(file?.createdAt, reasonixStemTime(stem), '缺时间戳时用 stem 内嵌时刻，绝不用导入时刻');
    assert.ok(reasonixStemTime(stem) !== undefined);
    assert.equal(reasonixStemTime('desktop-202613020304-7'), undefined, '月份 13 非法 → 不给时间');
    assert.equal(reasonixStemTime('desktop-1'), undefined);

    const result = await reasonixSource.build(ctxOf(root, 'linux'));
    const session = sessionFilesOf(result)[0];
    assert.ok(session !== undefined);
    const rows = rowsOf(session.data);
    // 标题行承载会话创建时间；行序是「首条人类 user/message → session/title」（见 synthesizeDshRows
    // 的标题行注释：非 user 来源的标题必须引用一条更早的人类消息），所以不能再看 rows[0]。
    const title = rows.find((r) => r['type'] === 'session/title');
    assert.ok(title !== undefined);
    assert.equal(title['time'], reasonixStemTime(stem), '会话创建时间必须落成记录时间而非导入时刻');
    const assistant = rows.find((r) => r['type'] === 'assistant/message');
    assert.ok(assistant !== undefined);
    assert.deepEqual(dataOf(assistant)['usage'], {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 2,
      reasoningTokens: 0,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
