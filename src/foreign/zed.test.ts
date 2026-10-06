/**
 * zed（threads.db，data BLOB 恒 zstd / json 只读兼容）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等；② 真实库 → 读盘 → build；
 * ③ 两种真机方言（v0.3.0 外部标签 / legacy role+segments）与工具配对；
 * ④ folder_paths 的 \n + , 编码；⑤ 统一口径的失败路径。宿主无 node:sqlite 时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { readZed, zedFolderPaths, zedThreadsDbPath } from './read-zed.ts';
import { createZedSource } from './zed.ts';
import type { ForeignSourceContext } from './registry.ts';
import { expandTruthList, FOREIGN_TRUTH_TABLES, TRUTH_PROBES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';

const SQLITE_SPEC = 'node:sqlite';

interface DbLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: readonly unknown[]): unknown };
  close(): void;
}
type DbCtor = new (file: string, options?: { readOnly?: boolean }) => DbLike;

async function sqliteCtor(): Promise<DbCtor | null> {
  try {
    const mod = (await import(SQLITE_SPEC)) as { DatabaseSync?: DbCtor };
    return typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

/** 在 file 建一个真实库并执行夹具语句（父目录自动创建）；返回 false = 宿主无 node:sqlite */
async function createDb(file: string, statements: readonly (readonly [string, readonly unknown[]])[]): Promise<boolean> {
  const Ctor = await sqliteCtor();
  if (Ctor === null) return false;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const db = new Ctor(file);
  try {
    for (const [sql, params] of statements) {
      if (params.length === 0) db.exec(sql);
      else db.prepare(sql).run(...params);
    }
  } finally {
    db.close();
  }
  return true;
}

async function tempHome(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 反斜杠字符（真值表用正斜杠书写：read-vault §10.1 明示「表中路径一律用正斜杠」） */
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

/**
 * 分隔符归一后再比对：win32 上真值表模板的尾段是 POSIX 书写（`<home>/.local/share/...`），
 * 逐字比较会把 joinFor 的正确实现判红 —— 本仓库既有会话来源（vibe/reasonix/grokbuild 的单测）
 * 用同一条归一化口径做真值表交叉核对。
 */
function normalize(p: string): string {
  return p.split(BS).join('/');
}

type ZstdCompress = (buffer: Uint8Array) => Uint8Array;
const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: ZstdCompress }).zstdCompressSync;

function truth(): ForeignTruthTableEntry {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'zed');
  assert.ok(entry !== undefined, '真值表必须有 zed 条目');
  return entry;
}

/** v0.3.0 方言：serde 外部标签 {User:{…}} / {Agent:{…}} + Agent.tool_results 对象 */
function v3Thread(userText: string, assistantText: string): string {
  return JSON.stringify({
    version: '0.3.0',
    messages: [
      { User: { id: 'u-1', content: [{ Text: userText }, { Mention: { uri: 'file:///x' } }] } },
      {
        Agent: {
          content: [
            { Text: assistantText },
            { Thinking: { text: 'internal', signature: 's' } },
            { ToolUse: { id: 'tu-1', name: 'read_file', input: { type: 'text', value: '{"path":"a"}' } } },
          ],
          tool_results: {
            'tu-1': { tool_use_id: 'tu-1', is_error: false, content: [{ Text: 'file body' }] },
          },
        },
      },
      'Resume',
      { Compaction: { Summary: 'compacted' } },
    ],
  });
}

/** legacy 方言：role + segments/tool_uses/tool_results/is_visible */
function legacyThread(): string {
  return JSON.stringify({
    version: '0.1.0',
    summary: 'Blob legacy title',
    messages: [
      { is_visible: false, role: 'assistant', segments: [{ type: 'text', text: 'agent-only' }] },
      { role: 'user', segments: [{ type: 'text', text: 'legacy hi' }] },
      {
        role: 'assistant',
        segments: [{ type: 'text', text: 'legacy yo' }],
        tool_uses: [{ id: 'lt-1', name: 'shell', input: { cmd: 'ls' } }],
        tool_results: [{ tool_use_id: 'lt-1', is_error: true, content: [{ text: 'bad' }] }],
      },
    ],
  });
}

test('zed：probePaths 与真值表逐平台相等（win32 目录名大写 Zed、linux 小写 zed）', () => {
  const entry = truth();
  const source = createZedSource();
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
    );
  }
  assert.ok(zedThreadsDbPath({ homeDir: 'C:\\probe', platform: 'win32', env: {} }).includes('Zed'));
  assert.ok(zedThreadsDbPath({ homeDir: '/home/probe', platform: 'linux', env: {} }).includes('/zed/'));
  // XDG_DATA_HOME 只对 linux 生效（且仅绝对路径）
  assert.equal(
    zedThreadsDbPath({ homeDir: '/home/probe', platform: 'linux', env: { XDG_DATA_HOME: '/srv/data' } }),
    '/srv/data/zed/threads/threads.db',
  );
  assert.equal(
    zedThreadsDbPath({ homeDir: '/home/probe', platform: 'linux', env: { XDG_DATA_HOME: 'rel' } }),
    '/home/probe/.local/share/zed/threads/threads.db',
  );
});

test('zed：folder_paths 是 \n 连接 + , 索引（不是 JSON 数组）', () => {
  assert.deepEqual(zedFolderPaths('/p/a' + NL + '/p/b', '1,0'), ['/p/b', '/p/a'], '按 order 索引还原原始顺序');
  assert.deepEqual(zedFolderPaths('/p/a' + NL + '/p/b', null), ['/p/a', '/p/b'], '索引缺失 → 字典序');
  assert.deepEqual(zedFolderPaths('/p/a' + NL + '/p/b', '0'), ['/p/a', '/p/b'], '索引长度不符 → 字典序');
  assert.deepEqual(zedFolderPaths('/only', ''), ['/only']);
  assert.deepEqual(zedFolderPaths(null, null), []);
});

test('zed：真实临时库（zstd + json 两种 data_type）→ v0.3.0/legacy 方言解析 + 工具配对', async (t) => {
  const home = await tempHome('dcm-zed-');
  const dbFile = zedThreadsDbPath({ homeDir: home, platform: 'linux', env: {} });
  const statements: (readonly [string, readonly unknown[]])[] = [
    ['CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER, data_type TEXT, data BLOB, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at INTEGER)', []],
    ['INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['th-json', 'JSON thread', 1791201900, 'json', v3Thread('zed json hi', 'zed json yo'), null, '/work/zed', null, 1791201899]],
    ['INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['th-legacy', '', 1791201903, 'json', legacyThread(), null, '/work/legacy', null, 1791201902]],
    // 子代理线程（parent_id 非空）不单独成会话
    ['INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['th-sub', 'sub thread', 1791201904, 'json', v3Thread('sub', 'sub'), 'th-json', '/work/zed', null, 1791201903]],
  ];
  const withZstd = typeof zstdCompressSync === 'function';
  if (withZstd) {
    statements.push(['INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['th-zstd', 'Zstd thread', 1791201902, 'zstd', zstdCompressSync(new TextEncoder().encode(v3Thread('zed zstd hi', 'zed zstd yo'))), null, '/work/zed', null, 1791201901]]);
  }
  if (!(await createDb(dbFile, statements))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const source = createZedSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.local/share/zed/threads/threads.db']);

  const read = await readZed({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(read.files.length, withZstd ? 3 : 2, '子代理线程被过滤');
  assert.equal(read.extraCounts?.['zed.threads.subagent'], 1);

  const v3 = read.files.find((f) => f.id === 'th-json');
  assert.ok(v3 !== undefined);
  assert.equal(v3.parsed.cwd, '/work/zed', 'cwd 取 folder_paths 首项');
  assert.equal(v3.parsed.title, 'JSON thread');
  assert.deepEqual(v3.parsed.records.map((r) => r.role), ['user', 'assistant', 'user'], 'v0.3.0 外部标签必须被识别');
  assert.deepEqual(v3.parsed.records[0]?.blocks, [{ type: 'text', text: 'zed json hi' }], 'Mention 引用不进对话');
  assert.deepEqual(v3.parsed.records[1]?.blocks, [
    { type: 'text', text: 'zed json yo' },
    { type: 'tool_call', id: 'tu-1', name: 'read_file', input: { path: 'a' } },
  ], 'Agent.ToolUse → tool_call（input.value 的 JSON 文本要反序列化）');
  assert.deepEqual(v3.parsed.records[2]?.blocks, [
    { type: 'tool_result', id: 'tu-1', text: 'file body', isError: false },
  ], 'Agent.tool_results 对象按 tool_use_id 配对');
  assert.equal(v3.parsed.ignored['block:thinking'], 1);
  assert.equal(v3.parsed.ignored['message:compaction'], 1);

  const legacy = read.files.find((f) => f.id === 'th-legacy');
  assert.ok(legacy !== undefined);
  assert.equal(legacy.parsed.title, 'Blob legacy title', '标题列空时回退 blob 的 title/summary');
  assert.deepEqual(legacy.parsed.records.map((r) => r.role), ['user', 'assistant', 'user']);
  assert.deepEqual(legacy.parsed.records[1]?.blocks, [
    { type: 'text', text: 'legacy yo' },
    { type: 'tool_call', id: 'lt-1', name: 'shell', input: { cmd: 'ls' } },
  ]);
  assert.deepEqual(legacy.parsed.records[2]?.blocks, [
    { type: 'tool_result', id: 'lt-1', text: 'bad', isError: true },
  ]);
  assert.equal(legacy.parsed.ignored['message:invisible'], 1, 'legacy is_visible=false 不进对话');

  if (withZstd) {
    const zstdThread = read.files.find((f) => f.id === 'th-zstd');
    assert.ok(zstdThread !== undefined, 'zstd BLOB 必须能解开');
    assert.deepEqual(zstdThread.parsed.records.map((r) => r.role), ['user', 'assistant', 'user']);
  }

  const built = await source.build(ctx);
  const sessions = built.sections.find((s) => s.sectionId === 'sessions');
  assert.equal(sessions?.files?.length, withZstd ? 3 : 2);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.ok(ws?.workspaces.some((w) => w.path === '/work/zed'));
});

test('zed：不是 zed 的库（无 threads 表 / 无 data 列）→ shape-mismatch', async (t) => {
  const home = await tempHome('dcm-zed-shape-');
  const dbFile = zedThreadsDbPath({ homeDir: home, platform: 'linux', env: {} });
  const ok = await createDb(dbFile, [['CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT)', []]]);
  if (!ok) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readZed({ homeDir: home, platform: 'linux', env: {} });
  assert.deepEqual(read.files, []);
  assert.equal(read.readFindings?.[0]?.detail, 'shape-mismatch');
});
