/**
 * teleagent（users/<账户>/teleagent.db，每账户一库）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等（含 env 覆盖语义）；② 真实库 → 读盘 → build；
 * ③ 统一口径的失败路径。宿主无 node:sqlite 时整组 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readTeleagent, teleagentUsersDir } from './read-teleagent.ts';
import { createTeleagentSource } from './teleagent.ts';
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
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'teleagent');
  assert.ok(entry !== undefined, '真值表必须有 teleagent 条目');
  return entry;
}

const SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?)', ['s-1', '/work/teleagent', 'acct session', 1791201700000]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-1', 's-1', 1791201701000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?)', ['p-1', 'm-1', 's-1', JSON.stringify({ type: 'text', text: 'teleagent hello' })]],
];

test('teleagent：probePaths 与真值表逐平台相等（Windows 同样 ~/.local/share）+ TELEAGENT_HOME 覆盖语义', () => {
  const entry = truth();
  const source = createTeleagentSource();
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
    );
  }
  // TELEAGENT_HOME = 替换基座（→ <home>/users）；相对路径不生效（绝对才生效）
  // 注意：常量必须写成**目标平台的绝对路径字面量** —— 用 path.join 会在 Windows 上算出 \home\probe\...
  // （对 linux 不是绝对路径），测试本身会随宿主平台漂移。
  assert.equal(
    teleagentUsersDir({ homeDir: '/home/probe', platform: 'linux', env: { TELEAGENT_HOME: '/srv/tele-base' } }),
    '/srv/tele-base/users',
  );
  assert.equal(
    teleagentUsersDir({ homeDir: 'C:' + BS + 'u', platform: 'win32', env: { TELEAGENT_HOME: 'C:' + BS + 'tele-base' } }),
    'C:' + BS + 'tele-base' + BS + 'users',
  );
  assert.equal(
    teleagentUsersDir({ homeDir: '/home/probe', platform: 'linux', env: { TELEAGENT_HOME: 'relative/dir' } }),
    '/home/probe/.local/share/TeleAgent/users',
    '相对路径必须被忽略（绝不 join 到 home 上）',
  );
});

test('teleagent：多账户枚举 → 有库的账户产出会话，没库的账户不报码', async (t) => {
  const home = await tempHome('dcm-teleagent-');
  const usersDir = teleagentUsersDir({ homeDir: home, platform: 'linux', env: {} });
  const acctDb = usersDir + '/acct1/teleagent.db';
  if (!(await createDb(acctDb, SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  await fsp.mkdir(usersDir + '/acct2', { recursive: true }); // 账户目录存在但没库 = 正常

  const source = createTeleagentSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.local/share/TeleAgent/users']);

  const read = await readTeleagent({ homeDir: home, platform: 'linux', env: {} });
  assert.equal(read.files.length, 1);
  assert.equal(read.extraCounts?.['teleagent.accounts'], 2);
  assert.equal(read.extraCounts?.['teleagent.databases'], 1);
  assert.deepEqual(read.readFindings, [], '账户目录没有库不是错误');

  const built = await source.build(ctx);
  const sessions = built.sections.find((s) => s.sectionId === 'sessions');
  assert.equal(sessions?.files?.length, 1);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, '/work/teleagent');
});

test('teleagent：未安装（users 目录不存在）不报码', async () => {
  const home = await tempHome('dcm-teleagent-missing-');
  const read = await readTeleagent({ homeDir: home, platform: 'linux', env: {} });
  assert.deepEqual(read.files, []);
  assert.deepEqual(read.readFindings, []);
});
