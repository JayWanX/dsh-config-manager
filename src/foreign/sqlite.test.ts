/**
 * `sqlite.ts` 的**零写入**与**判负层次**护栏（t9）。
 *
 * 两条硬事实（真机实测，见 sqlite.ts 文件头）：
 *  ① **只读打开不等于不写用户目录**：WAL 模式的库用 `{ readOnly: true }` 就地打开会新建
 *     `<db>-shm`（32768 B）与 `<db>-wal`（0 B）；而 `immutable=1` 在 `-wal` 非空时会忽略整条 WAL
 *     （实测 `no such table` = 静默丢数据）。⇒ 三态计划：direct / immutable / copy。
 *  ② **非 SQLite 文本文件的构造是「惰性成功」**（`new DatabaseSync(垃圾, {readOnly:true})` 不抛，
 *     `tables()` 才返回 null）⇒ **判负必须落在表探测处**，8 个来源逐源钉住。
 *
 * 本文件的断言是**可失败的**：把打开改回「就地只读打开」，第 1 组用例立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_COPY_BYTES,
  openSqliteIfShape,
  openSqliteReadOnly,
  openSqliteReadOnlyEx,
  sqliteCapability,
} from './sqlite.ts';
import { crushProjectDbPath, readCrush } from './read-crush.ts';
import { gooseDbPath, readGoose } from './read-goose.ts';
import { readKilocode, kilocodeDbPath } from './read-kilocode.ts';
import { readMimocode, mimocodeDbPath } from './read-mimocode.ts';
import { opencodeDbPath, readOpencode } from './read-opencode.ts';
import { readTeleagent, teleagentUsersDir } from './read-teleagent.ts';
import { readZcode, zcodeDbPath } from './read-zcode.ts';
import { readZed, zedThreadsDbPath } from './read-zed.ts';

const SQLITE_SPEC = 'node:sqlite';

interface DbLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: readonly unknown[]): unknown; all(...params: readonly unknown[]): unknown };
  close(): void;
}
type DbCtor = new (file: string, options?: { readOnly?: boolean }) => DbLike;

let ctorCache: DbCtor | null | undefined;
async function sqliteCtor(): Promise<DbCtor | null> {
  if (ctorCache !== undefined) return ctorCache;
  try {
    const mod = (await import(SQLITE_SPEC)) as { DatabaseSync?: DbCtor };
    ctorCache = typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    ctorCache = null;
  }
  return ctorCache;
}

/** 一个可写的真实库（夹具用；**不是**被测代码） */
async function makeWriter(file: string): Promise<DbLike | null> {
  const Ctor = await sqliteCtor();
  if (Ctor === null) return null;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  return new Ctor(file);
}

/** 目录快照：名字 + 大小 + mtime（逐字比较，任何新文件/改动都会让断言红） */
async function snapshotDir(dir: string): Promise<string[]> {
  const names = (await fsp.readdir(dir)).sort();
  const out: string[] = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(dir, name));
    out.push(name + ':' + String(st.size) + '@' + String(st.mtimeMs));
  }
  return out;
}

async function tempHome(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 查询并展开成普通对象（node:sqlite 的行是 null-prototype 对象，deepStrictEqual 会比较原型） */
function rows(db: { all(sql: string): unknown } | null, sql = 'SELECT * FROM t'): unknown {
  if (db === null) return null;
  const raw = db.all(sql);
  return Array.isArray(raw) ? raw.map((r) => ({ ...(r as Record<string, unknown>) })) : raw;
}

/** 等一拍：copy 模式的临时副本清理是 close() 之后的异步 rm（源目录断言不依赖它） */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/* ---------------- ① 零写入：三种库形态读一遍，源目录逐字不变 ---------------- */

test('sqlite.ts 零写入：回滚日志库（direct）读一遍后源目录逐字不变', async (t) => {
  const Ctor = await sqliteCtor();
  if (Ctor === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-direct-');
  const file = path.join(dir, 'db.sqlite');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.prepare('INSERT INTO t VALUES(?)').run('plain');
  writer.close();

  const before = await snapshotDir(dir);
  const opened = await openSqliteReadOnlyEx(file);
  assert.equal(opened.mode, 'direct');
  assert.ok(opened.db !== null);
  assert.deepEqual(rows(opened.db), [{ v: 'plain' }]);
  opened.db.close();
  await tick();
  assert.deepEqual(await snapshotDir(dir), before, '回滚日志模式：不得新增/改动任何文件');
});

test('sqlite.ts 零写入：WAL 库有 pending -wal（copy）——既读到 WAL 数据，又不碰源目录', async (t) => {
  const Ctor = await sqliteCtor();
  if (Ctor === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-wal-');
  const file = path.join(dir, 'wal.db');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('PRAGMA wal_autocheckpoint=0');
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.prepare('INSERT INTO t VALUES(?)').run('only-in-wal');
  // 表与数据都还在 -wal 里（未 checkpoint）——这正是 immutable 会丢数据、必须改走 copy 的场景
  const walBefore = await fsp.stat(file + '-wal');
  assert.ok(walBefore.size > 0, '夹具前提：-wal 非空');

  const before = await snapshotDir(dir);
  const opened = await openSqliteReadOnlyEx(file);
  assert.equal(opened.mode, 'copy', '有 pending -wal 时必须复制到私有目录再读');
  assert.ok(opened.db !== null);
  assert.deepEqual(rows(opened.db), [{ v: 'only-in-wal' }], 'WAL 里的数据绝不能丢');
  opened.db.close();
  await tick();
  assert.deepEqual(await snapshotDir(dir), before, 'copy 模式：不得新增/改动源目录任何文件');
  writer.close();
});

test('sqlite.ts 零写入：WAL 库已干净关闭（immutable）——零伴生文件（旧实现会新建 -shm/-wal）', async (t) => {
  const Ctor = await sqliteCtor();
  if (Ctor === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-clean-');
  const file = path.join(dir, 'clean.db');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.prepare('INSERT INTO t VALUES(?)').run('clean');
  writer.close(); // 干净关闭：SQLite 自己 checkpoint 并删掉 -wal/-shm

  const before = await snapshotDir(dir);
  assert.deepEqual(before.map((e) => e.split(':')[0]), ['clean.db'], '夹具前提：干净关闭后无伴生文件');
  const opened = await openSqliteReadOnlyEx(file);
  // 老 Node（URI 不被 node:sqlite 接受）会退到 copy —— 两条路都零写入，故只断言「不是 direct」
  assert.notEqual(opened.mode, 'direct', 'WAL 库即使没有 -wal 也不能就地打开（那会新建伴生文件）');
  assert.ok(opened.db !== null);
  assert.deepEqual(rows(opened.db), [{ v: 'clean' }]);
  opened.db.close();
  await tick();
  assert.deepEqual(await snapshotDir(dir), before, '读一遍 WAL 库后源目录必须逐字不变');
});

/* ---------------- ② copy 的上限：超限即报码，绝不退回就地打开 ---------------- */

test('sqlite.ts copy 上限：超过 maxCopyBytes 时报 copy-too-large 且不碰源目录', async (t) => {
  const Ctor = await sqliteCtor();
  if (Ctor === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-cap-');
  const file = path.join(dir, 'big.db');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('PRAGMA wal_autocheckpoint=0');
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.prepare('INSERT INTO t VALUES(?)').run('x');

  const before = await snapshotDir(dir);
  const opened = await openSqliteReadOnlyEx(file, { maxCopyBytes: 1 });
  assert.equal(opened.db, null);
  assert.equal(opened.problem, 'copy-too-large');
  await tick();
  assert.deepEqual(await snapshotDir(dir), before, '拒绝复制时也绝不就地打开（那会写用户目录）');
  writer.close();
});

test('sqlite.ts 缺文件 / 目录 / 兼容签名：missing / not-a-file / openSqliteIfShape', async (t) => {
  const dir = await tempHome('dcm-sqlite-misc-');
  const missing = await openSqliteReadOnlyEx(path.join(dir, 'nope.db'));
  assert.equal(missing.db, null);
  assert.equal(missing.problem, 'missing');
  const dirResult = await openSqliteReadOnlyEx(dir);
  assert.equal(dirResult.db, null);
  assert.equal(dirResult.problem, 'not-a-file');

  if ((await sqliteCtor()) === null) { t.skip('宿主无 node:sqlite'); return; }
  const file = path.join(dir, 'shape.db');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.close();
  const ok = await openSqliteIfShape(file, { t: [] });
  assert.ok(ok !== null);
  ok.close();
  assert.equal(await openSqliteIfShape(file, { other: [] }), null, '签名不符 → null');
  assert.ok(DEFAULT_MAX_COPY_BYTES >= 64 * 1024 * 1024);
});

/* ---------------- ③ URI 编码：路径含 # / 空格的 WAL 库仍能零写入读到 ---------------- */

test('sqlite.ts URI 编码：路径含 # 与空格时 immutable 仍可用（不做 URI 编码就会打不开）', async (t) => {
  const Ctor = await sqliteCtor();
  if (Ctor === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-uri-');
  const simple = path.join(dir, 'simple.db');
  const weird = path.join(dir, 'we ird#name.db');
  for (const file of [simple, weird]) {
    const writer = await makeWriter(file);
    assert.ok(writer !== null);
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('CREATE TABLE t(v TEXT)');
    writer.prepare('INSERT INTO t VALUES(?)').run('payload');
    writer.close();
  }
  const simpleOpened = await openSqliteReadOnlyEx(simple);
  simpleOpened.db?.close();
  const uriSupported = simpleOpened.mode === 'immutable';

  const before = await snapshotDir(dir);
  const opened = await openSqliteReadOnlyEx(weird);
  assert.equal(
    opened.mode,
    uriSupported ? 'immutable' : 'copy',
    'URI 可用时含 # / 空格的路径也必须能走 immutable（证明 sqliteUri 的编码生效）',
  );
  assert.ok(opened.db !== null);
  assert.deepEqual(rows(opened.db), [{ v: 'payload' }]);
  opened.db.close();
  await tick();
  assert.deepEqual(await snapshotDir(dir), before);
});

/* ---------------- ④ 判负层次：惰性构造 + 8 个来源的表探测判负 ---------------- */

test('sqlite.ts 惰性构造：非 SQLite 文本文件的构造成功，但 tables() 为 null（判负在表探测处）', async (t) => {
  if ((await sqliteCtor()) === null) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-lazy-');
  const file = path.join(dir, 'garbage.db');
  await fsp.writeFile(file, 'this is definitely not a sqlite database');
  const opened = await openSqliteReadOnlyEx(file);
  assert.ok(opened.db !== null, '实测：垃圾文件的构造是惰性的（不抛）');
  assert.equal(opened.db.tables(), null, '判负必须发生在表探测处');
  opened.db.close();
});

test('sqlite.ts 判负层次：8 个 SQLite 来源在垃圾库上都报 shape-mismatch（不是 open-failed）', async (t) => {
  if ((await sqliteCtor()) === null) { t.skip('宿主无 node:sqlite'); return; }
  const home = await tempHome('dcm-sqlite-matrix-');
  const garbage = 'not a sqlite database at all';
  const writeGarbage = async (file: string): Promise<void> => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, garbage);
  };
  const project = path.join(home, 'proj');
  await writeGarbage(opencodeDbPath({ homeDir: home, platform: 'linux' }));
  await writeGarbage(mimocodeDbPath({ homeDir: home, platform: 'linux' }));
  await writeGarbage(kilocodeDbPath({ homeDir: home, platform: 'linux' }));
  await writeGarbage(zcodeDbPath({ homeDir: home, platform: 'linux' }));
  await writeGarbage(teleagentUsersDir({ homeDir: home, platform: 'linux', env: {} }) + '/acct1/teleagent.db');
  await writeGarbage(gooseDbPath({ homeDir: home, platform: 'linux', env: {} }));
  await writeGarbage(zedThreadsDbPath({ homeDir: home, platform: 'linux', env: {} }));
  await writeGarbage(crushProjectDbPath('linux', project));

  const cases: readonly (readonly [string, () => Promise<{ files: readonly unknown[]; readFindings?: readonly { detail?: string | undefined }[] | undefined }>])[] = [
    ['opencode', () => readOpencode({ homeDir: home, platform: 'linux' })],
    ['mimocode', () => readMimocode({ homeDir: home, platform: 'linux' })],
    ['kilocode', () => readKilocode({ homeDir: home, platform: 'linux' })],
    ['zcode', () => readZcode({ homeDir: home, platform: 'linux' })],
    ['teleagent', () => readTeleagent({ homeDir: home, platform: 'linux', env: {} })],
    ['goose', () => readGoose({ homeDir: home, platform: 'linux', env: {} })],
    ['zed', () => readZed({ homeDir: home, platform: 'linux', env: {} })],
    ['crush', () => readCrush({ homeDir: home, platform: 'linux', env: {}, projectDir: project })],
  ];
  for (const [id, run] of cases) {
    const outcome = await run();
    assert.deepEqual([...outcome.files], [], id + '：垃圾库不得产出会话');
    assert.equal(
      outcome.readFindings?.[0]?.detail,
      'shape-mismatch',
      id + '：判负必须在表探测处（构造是惰性的，open-failed 会指向错误的层）',
    );
  }
});

/* ---------------- ⑤ 能力探测（既有口径不回归） ---------------- */

test('sqlite.ts 能力探测：形状稳定，且 openSqliteReadOnly 兼容签名返回句柄或 null', async (t) => {
  const cap = await sqliteCapability();
  assert.equal(typeof cap.available, 'boolean');
  if (!cap.available) { t.skip('宿主无 node:sqlite'); return; }
  const dir = await tempHome('dcm-sqlite-compat-');
  const file = path.join(dir, 'c.db');
  const writer = await makeWriter(file);
  assert.ok(writer !== null);
  writer.exec('CREATE TABLE t(v TEXT)');
  writer.close();
  const db = await openSqliteReadOnly(file);
  assert.ok(db !== null);
  assert.ok(Array.isArray(db.tables()));
  const missing = await openSqliteReadOnly(path.join(dir, 'none.db'));
  assert.equal(missing, null);
  db.close();
});
