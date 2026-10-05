/**
 * goose（<dataDir>/sessions/sessions.db，content_json 块词汇）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等（含 env 覆盖语义）；② 真实库 → 读盘 → build；
 * ③ 统一口径的失败路径。宿主无 node:sqlite 时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gooseDbPath, readGoose, readGooseDatabase } from './read-goose.ts';
import { createGooseSource } from './goose.ts';
import type { ForeignSourceContext } from './registry.ts';
import { expandTruthList, FOREIGN_TRUTH_TABLES, TRUTH_PROBES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import { openSqliteReadOnly } from './sqlite.ts';

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

/**
 * 分隔符归一后再比对：win32 上真值表模板的尾段是 POSIX 书写（`<home>/.local/share/...`），
 * 逐字比较会把 joinFor 的正确实现判红 —— 本仓库既有会话来源（vibe/reasonix/grokbuild 的单测）
 * 用同一条归一化口径做真值表交叉核对。
 */
function normalize(p: string): string {
  return p.split(BS).join('/');
}

function truth(): ForeignTruthTableEntry {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'goose');
  assert.ok(entry !== undefined, '真值表必须有 goose 条目');
  return entry;
}

/** 三方平台分支 + darwin/linux 的**段差异**（Block 段 linux 没有、/data 段只有 win32 与 env 覆盖有） */
test('goose：probePaths 与真值表逐平台相等；GOOSE_PATH_ROOT 仅绝对路径生效', () => {
  const entry = truth();
  const source = createGooseSource();
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
    );
  }
  assert.equal(
    gooseDbPath({ homeDir: '/home/probe', platform: 'linux', env: { GOOSE_PATH_ROOT: '/srv/goose' } }),
    '/srv/goose/data/sessions/sessions.db',
    'env 覆盖 = 替换基座 → <root>/data',
  );
  assert.equal(
    gooseDbPath({ homeDir: '/home/probe', platform: 'linux', env: { GOOSE_PATH_ROOT: 'rel/goose' } }),
    '/home/probe/.local/share/goose/sessions/sessions.db',
    '相对路径必须被忽略',
  );
});

const GOOSE_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT, working_dir TEXT, name TEXT, created_at INTEGER)', []],
  ['CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER)', []],
  ['INSERT INTO sessions VALUES (?, ?, ?, ?, ?)', ['g-1', 'chat', '/work/goose', 'Goose run', 1791201800]],
  ['INSERT INTO messages VALUES (?, ?, ?, ?, ?)', ['g-msg-1', 'g-1', 'user', JSON.stringify([{ type: 'text', text: 'goose user' }]), 1791201801]],
  ['INSERT INTO messages VALUES (?, ?, ?, ?, ?)', ['g-msg-2', 'g-1', 'assistant', JSON.stringify([
    { type: 'text', text: 'goose assistant' },
    { type: 'toolRequest', id: 't-1', toolCall: { value: { name: 'shell', arguments: { cmd: 'ls' } } } },
    { type: 'toolResponse', id: 't-1', toolResult: { value: { content: [{ type: 'text', text: 'out' }] } } },
    { type: 'thinking', thinking: 'internal' },
  ]), 1791201802]],
];

test('goose：真实临时库 → content_json 块映射 + 工具配对闭合 + build 产出 workspaces', async (t) => {
  const home = await tempHome('dcm-goose-');
  const dbFile = gooseDbPath({ homeDir: home, platform: 'linux', env: {} });
  if (!(await createDb(dbFile, GOOSE_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const source = createGooseSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.local/share/goose/sessions/sessions.db']);

  const read = await readGoose({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(read.files.length, 1);
  const file = read.files[0];
  assert.ok(file !== undefined);
  assert.equal(file.parsed.cwd, '/work/goose');
  assert.equal(file.parsed.title, 'Goose run');
  assert.equal(file.parsed.createdAt, 1791201800000, '秒 → 毫秒');
  assert.deepEqual(
    file.parsed.records.map((r) => r.role),
    ['user', 'assistant', 'user'],
    'toolResponse 拆到用户侧记录（同一 step 内闭合）',
  );
  assert.deepEqual(
    file.parsed.records[1]?.blocks.map((b) => b.type),
    ['text', 'tool_call'],
  );
  assert.deepEqual(file.parsed.records[2]?.blocks.map((b) => b.type), ['tool_result']);
  assert.equal(file.parsed.ignored['block:thinking'], 1, 'thinking 不迁移但逐类计数');

  const built = await source.build(ctx);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, '/work/goose');
});

test('goose：同名 sessions.db 但不是 goose（没有 working_dir，cline 形态）→ shape-mismatch', async (t) => {
  const home = await tempHome('dcm-goose-shape-');
  const dbFile = gooseDbPath({ homeDir: home, platform: 'linux', env: {} });
  const ok = await createDb(dbFile, [
    ['CREATE TABLE sessions (session_id TEXT PRIMARY KEY, title TEXT)', []],
    ['CREATE TABLE messages (session_id TEXT, content TEXT)', []],
  ]);
  if (!ok) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const db = await openSqliteReadOnly(dbFile);
  assert.ok(db !== null);
  assert.equal(readGooseDatabase(db), null, '签名判定必须靠结构自证（sessions.id + working_dir）');
  db.close();
  const read = await readGoose({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(read.readFindings?.[0]?.detail, 'shape-mismatch');
});
