/**
 * kilocode（kilo.db，opencode fork 三表同构；目录名是 kilo）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等；② 真实库 → 读盘 → build（sessions + workspaces）；
 * ③ 「未安装不报码 / 存在但形状不符一条 source-unreadable」的统一口径。无 node:sqlite 时 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kilocodeDbPath, readKilocode } from './read-kilocode.ts';
import { createKilocodeSource } from './kilocode.ts';
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

/**
 * 分隔符归一后再比对：win32 上真值表模板的尾段是 POSIX 书写（`<home>/.local/share/...`），
 * 逐字比较会把 joinFor 的正确实现判红 —— 本仓库既有会话来源（vibe/reasonix/grokbuild 的单测）
 * 用同一条归一化口径做真值表交叉核对。
 */
function normalize(p: string): string {
  return p.split(BS).join('/');
}

function truth(): ForeignTruthTableEntry {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'kilocode');
  assert.ok(entry !== undefined, '真值表必须有 kilocode 条目');
  return entry;
}

const SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?)', ['s-1', '/work/kilocode', 'kilocode session', 1791201600000]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-1', 's-1', 1791201601000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-1', 'm-1', 's-1', 1791201601000, JSON.stringify({ type: 'text', text: 'hello kilocode' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-2', 's-1', 1791201602000, JSON.stringify({ role: 'assistant' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-2', 'm-2', 's-1', 1791201602000, JSON.stringify({ type: 'text', text: 'reply kilocode' })]],
];

test('kilocode：probePaths 与真值表逐平台相等 + evidence 一致', () => {
  const entry = truth();
  const source = createKilocodeSource();
  assert.equal(source.id, 'kilocode');
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
      platform + ' 的静态探测位置必须与真值表一致',
    );
  }
});

test('kilocode：真实临时库 → build 产出 sessions + workspaces；未安装不报码', async (t) => {
  const home = await tempHome('dcm-kilocode-');
  const source = createKilocodeSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };

  const missing = await source.build(ctx);
  assert.deepEqual(missing.sections, [], '未安装 → 不产出分区');
  assert.deepEqual(missing.skipped, [], '未安装是正常状态，绝不报码');

  const dbFile = kilocodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.local/share/kilo/kilo.db']);

  const read = await readKilocode({ homeDir: home, platform: 'linux' });
  assert.equal(read.files.length, 1);
  assert.equal(read.files[0]?.parsed.cwd, '/work/kilocode');
  assert.deepEqual(read.files[0]?.parsed.records.map((r) => r.role), ['user', 'assistant']);

  const built = await source.build(ctx);
  const sessions = built.sections.find((s) => s.sectionId === 'sessions');
  assert.equal(sessions?.files?.length, 1);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, '/work/kilocode');
  assert.equal(built.counts['sessions.transcoded'], 1);
});

test('kilocode：存在但不是本来源的库 → 一条 source-unreadable(shape-mismatch)', async (t) => {
  const home = await tempHome('dcm-kilocode-shape-');
  const dbFile = kilocodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, [['CREATE TABLE unrelated (id TEXT)', []]]))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readKilocode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(read.files, []);
  assert.equal(read.readFindings?.[0]?.detail, 'shape-mismatch');
});
/* ---------------- 只导主会话：跳过子会话（parent_id 非空）与已归档会话（time_archived 非空） ---------------- */

const AUX_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, parent_id TEXT, time_archived INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)', ['s-main', '/work/kilo', 'main', 1791201600000, null, null]],
  // '' 是「没有父会话」的哨兵值（与竞品摘要查询的 parent_id IS NULL OR parent_id = '' 同口径）→ 保留
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)', ['s-empty', '/work/kilo', 'empty parent', 1791201600500, '', null]],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)', ['s-child', '/work/kilo', 'child', 1791201601000, 's-main', null]],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)', ['s-archived', '/work/kilo', 'archived', 1791201602000, null, 1791201603000]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-1', 's-main', 1791201600000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-1', 'm-1', 's-main', 1791201600000, JSON.stringify({ type: 'text', text: 'main' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-2', 's-empty', 1791201600500, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-2', 'm-2', 's-empty', 1791201600500, JSON.stringify({ type: 'text', text: 'empty parent' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-3', 's-child', 1791201601000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-3', 'm-3', 's-child', 1791201601000, JSON.stringify({ type: 'text', text: 'child' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-4', 's-archived', 1791201602000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-4', 'm-4', 's-archived', 1791201602000, JSON.stringify({ type: 'text', text: 'archived' })]],
];

test('kilocode：跳过子会话与已归档会话（空串 parent_id 视为主会话）；剔除数可见', async (t) => {
  const home = await tempHome('dcm-kilocode-aux-');
  const dbFile = kilocodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, AUX_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readKilocode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(read.files.map((f) => f.id), ['s-main', 's-empty'], 'parent_id 非空 / time_archived 非空的会话不进结果集');
  assert.equal(read.extraCounts?.['kilocode.sessions.dropped'], 2);
  // 缺列（旧库/降级形态）时不误伤：列存在性判定，不靠猜
  const legacyHome = await tempHome('dcm-kilocode-legacy-');
  const legacyDb = kilocodeDbPath({ homeDir: legacyHome, platform: 'linux' });
  const legacyOk = await createDb(legacyDb, [
    ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)', []],
    ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
    ['INSERT INTO session VALUES (?, ?, ?, ?)', ['s-legacy', '/work/kilo', 'legacy', 1791201600000]],
    ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-legacy', 's-legacy', 1791201600000, JSON.stringify({ role: 'user', content: 'legacy' })]],
  ]);
  assert.equal(legacyOk, true);
  const legacyRead = await readKilocode({ homeDir: legacyHome, platform: 'linux' });
  assert.deepEqual(legacyRead.files.map((f) => f.id), ['s-legacy'], '缺 parent_id / time_archived 列的旧库不误伤');
});

