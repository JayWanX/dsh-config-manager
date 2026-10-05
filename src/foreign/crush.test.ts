/**
 * crush（用户级 projects.json + 每项目一个 <项目>/.crush/crush.db）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等；② 真实库 → 读盘 → build；
 * ③ 统一口径的失败路径（响亮报码 / 形状自证）。宿主无 node:sqlite 时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { crushProjectDbPath, crushProjectPathsOf, crushRegistryPath, readCrush, readCrushDatabase } from './read-crush.ts';
import { createCrushSource } from './crush.ts';
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
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'crush');
  assert.ok(entry !== undefined, '真值表必须有 crush 条目');
  return entry;
}

const CRUSH_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER)', []],
  ['CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, parts TEXT, created_at INTEGER, model TEXT)', []],
  ['CREATE TABLE read_files (id TEXT PRIMARY KEY, session_id TEXT, path TEXT)', []],
  ['INSERT INTO sessions VALUES (?, ?, ?, ?)', ['c-1', 'Crush run', 1791202000, 1791202010]],
  ['INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)', ['c-m1', 'c-1', 'user', JSON.stringify([{ type: 'text', text: 'crush user' }]), 1791202001, null]],
  ['INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)', ['c-m2', 'c-1', 'assistant', JSON.stringify([{ type: 'text', text: 'crush reply' }]), 1791202002, 'model-x']],
];

test('crush：probePaths 与真值表相等（用户级只到 projects.json）；显式 projectDir 追加项目库', () => {
  const entry = truth();
  const source = createCrushSource();
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
      '无 projectDir 时只探测用户级注册表（库在项目里，绝不猜项目 = cwd）',
    );
  }
  const withProject = [...source.probePaths({ homeDir: '/home/probe', env: {}, platform: 'linux', projectDir: '/work/p' })];
  assert.deepEqual(withProject, ['/home/probe/.local/share/crush/projects.json', '/work/p/.crush/crush.db']);
});

test('crush：projects.json 四种形态都能取出项目路径（认不出来不猜，返回空）', () => {
  assert.deepEqual(crushProjectPathsOf(['/p/a', '/p/b']), ['/p/a', '/p/b']);
  assert.deepEqual(crushProjectPathsOf([{ path: '/p/a' }, { project_path: '/p/b' }, { directory: '/p/c' }]), ['/p/a', '/p/b', '/p/c']);
  assert.deepEqual(crushProjectPathsOf({ projects: [{ path: '/p/a' }] }), ['/p/a']);
  assert.deepEqual(crushProjectPathsOf({ projects: { '/p/a': {}, '/p/b': { path: '/p/b' } } }), ['/p/a', '/p/b']);
  assert.deepEqual(crushProjectPathsOf({ version: 1, projects: 'nonsense' }), []);
  assert.deepEqual(crushProjectPathsOf(42), []);
});

test('crush：每项目一库 —— 有库的项目产出会话，没库的项目**响亮报码**', async (t) => {
  const home = await tempHome('dcm-crush-');
  const projA = path.join(home, 'projA');
  const projB = path.join(home, 'projB');
  const dbFile = crushProjectDbPath('linux', projA);
  if (!(await createDb(dbFile, CRUSH_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const registry = crushRegistryPath({ homeDir: home, platform: 'linux', env: {} });
  await fsp.mkdir(path.dirname(registry), { recursive: true });
  await fsp.writeFile(registry, JSON.stringify({ projects: [{ path: projA }, { path: projB }] }));

  const source = createCrushSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.local/share/crush/projects.json']);

  const read = await readCrush({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(read.files.length, 1, '只有 projA 有库');
  assert.equal(read.files[0]?.parsed.cwd, projA, '会话没有 cwd 列时取项目目录本身（库就在它下面）');
  assert.equal(read.extraCounts?.['crush.projects'], 2);
  assert.equal(read.extraCounts?.['crush.databases'], 1);
  assert.equal(read.readFindings?.[0]?.code, 'source-unreadable');
  assert.equal(read.readFindings?.[0]?.detail, 'crush-db-missing', '点名了却没有库 = 必须响亮，绝不静默跳过');
  assert.ok((read.readFindings?.[0]?.origin ?? '').includes('crush.db'));

  const built = await source.build(ctx);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, projA);
  assert.ok(built.skipped.some((s) => s.detail === 'crush-db-missing'));
});

test('crush：注册表坏掉 / 显式 projectDir 没有库 → 各自响亮报码；注册表不存在 = 未安装不报码', async (t) => {
  const home = await tempHome('dcm-crush-missing-');

  const notInstalled = await readCrush({ homeDir: home, platform: 'linux', env: {} });
  assert.deepEqual(notInstalled.files, []);
  assert.deepEqual(notInstalled.readFindings, [], '未安装是正常状态');

  const registry = crushRegistryPath({ homeDir: home, platform: 'linux', env: {} });
  await fsp.mkdir(path.dirname(registry), { recursive: true });
  await fsp.writeFile(registry, '{ this is not json');
  const broken = await readCrush({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(broken.readFindings?.[0]?.detail, 'projects-json:json-error');

  const explicit = await readCrush({ homeDir: home, platform: 'linux', env: {}, projectDir: path.join(home, 'nowhere') });
  const missing = explicit.readFindings?.find((s) => s.detail === 'crush-db-missing');
  assert.ok(missing !== undefined, '显式点名的项目也必须响亮报码');
});

test('crush：sessions/messages 表在但 messages 没有 parts 列 → shape-mismatch', async (t) => {
  const home = await tempHome('dcm-crush-shape-');
  const proj = path.join(home, 'proj');
  const dbFile = crushProjectDbPath('linux', proj);
  const ok = await createDb(dbFile, [
    ['CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)', []],
    ['CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, body TEXT)', []],
  ]);
  if (!ok) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const db = await openSqliteReadOnly(dbFile);
  assert.ok(db !== null);
  assert.equal(readCrushDatabase(db, proj, 'proj/.crush/crush.db'), null);
  db.close();
});
