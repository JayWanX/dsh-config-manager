/**
 * opencode（opencode.db，session/message/part 三表）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖三件事：
 *  ① probePaths 与 `truth-table.ts` 逐平台逐字相等（四份竞品调研交叉核对的机械护栏）；
 *  ② 真值表形态的真实库 → 读盘层解析 → build 产出 sessions + workspaces；
 *  ③ 统一口径的失败路径（读不到 = null → 一条 source-unreadable；未安装 = 不报码）。
 *
 * 宿主没有 `node:sqlite` 时整组 skip（本仓库零依赖测试纪律允许 skip，不允许全红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sqliteCapability } from './sqlite.ts';
import { opencodeDbPath, readOpencode, readOpencodeFamilyDatabase } from './read-opencode.ts';
import type { SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';
import { createOpencodeSource } from './opencode.ts';
import { kilocodeDbPath, readKilocode } from './read-kilocode.ts';
import { mimocodeDbPath, readMimocode } from './read-mimocode.ts';
import { readZcode, zcodeDbPath } from './read-zcode.ts';
import { readTeleagent, teleagentUsersDir } from './read-teleagent.ts';
import { gooseDbPath, readGoose } from './read-goose.ts';
import { readZed, zedThreadsDbPath } from './read-zed.ts';
import { crushProjectDbPath, readCrush } from './read-crush.ts';
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

function opencodeTruth(): ForeignTruthTableEntry {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'opencode');
  assert.ok(entry !== undefined, '真值表必须有 opencode 条目');
  return entry;
}

const OPENCODE_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  // 会话时间刻意用**秒**（SQLite 源常见形态）：读盘层必须自适应成安全整数毫秒
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)', ['ses-1', 'proj', '/work/demo', 'Demo session', 1791201526, 1791201530]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['msg-1', 'ses-1', 1791201527, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['part-1', 'msg-1', 'ses-1', 1791201527, JSON.stringify({ type: 'text', text: 'hello from opencode' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['msg-2', 'ses-1', 1791201528, JSON.stringify({ role: 'assistant', model: 'gpt-x' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['part-2', 'msg-2', 'ses-1', 1791201528, JSON.stringify({ type: 'text', text: 'hi there' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['part-3', 'msg-2', 'ses-1', 1791201529, JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed', input: { path: 'a.txt' }, output: 'file body' } })]],
];

test('opencode：probePaths 与真值表逐平台相等 + evidence 一致', () => {
  const entry = opencodeTruth();
  const source = createOpencodeSource();
  assert.equal(source.id, 'opencode');
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
      platform + ' 的静态探测位置必须与真值表一致（Windows 也不走 %APPDATA%）',
    );
  }
});

test('opencode：真实临时库 → 解析出自适应时间/工具配对，build 产出 sessions + workspaces', async (t) => {
  const home = await tempHome('dcm-opencode-');
  const dbFile = opencodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, OPENCODE_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const source = createOpencodeSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };

  const det = await source.detect(ctx);
  assert.equal(det.found, true, '库存在 → 必须命中');
  assert.deepEqual(det.paths, ['.local/share/opencode/opencode.db'], '位置标签必须是相对 home 的 POSIX 路径');

  // 读盘层：秒时间戳 → 毫秒安全整数；工具 part 拆成「助手 tool_call + 用户 tool_result」两条记录
  const read = await readOpencode({ homeDir: home, platform: 'linux' });
  assert.equal(read.files.length, 1);
  const file = read.files[0];
  assert.ok(file !== undefined);
  assert.equal(file.id, 'ses-1');
  assert.equal(file.parsed.cwd, '/work/demo');
  assert.equal(file.parsed.createdAt, 1791201526000, '秒 → 毫秒');
  assert.deepEqual(file.parsed.records.map((r) => r.role), ['user', 'assistant', 'user']);
  assert.deepEqual(
    file.parsed.records.map((r) => r.blocks.map((b) => b.type)),
    [['text'], ['text', 'tool_call'], ['tool_result']],
    '同一助手消息的正文与 tool_call 同属一条记录；tool_result 拆到用户侧（否则合成器会静默丢掉它）',
  );

  const built = await source.build(ctx);
  assert.equal(built.source, 'opencode');
  const sessions = built.sections.find((s) => s.sectionId === 'sessions');
  assert.equal(sessions?.files?.length, 1, '必须产出 sessions 分区');
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string; sessionIds: string[] }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, '/work/demo', 'workspaces 必须与会话同源产出（只给会话 = 目标机看不见对话）');
  assert.deepEqual(ws?.workspaces[0]?.sessionIds, ['ses-1']);
  assert.equal(built.counts['sessions.transcoded'], 1);
});

test('opencode：未安装（库不存在）不报码；存在但非本来源的库 = shape-mismatch（响亮且统一）', async (t) => {
  const home = await tempHome('dcm-opencode-missing-');
  const empty = await readOpencode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(empty.files, []);
  assert.deepEqual(empty.readFindings, [], '未安装是正常状态，绝不报码');

  const dbFile = opencodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, [['CREATE TABLE other (id TEXT)', []]]))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const wrongShape = await readOpencode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(wrongShape.files, []);
  assert.equal(wrongShape.readFindings?.[0]?.code, 'source-unreadable');
  assert.equal(wrongShape.readFindings?.[0]?.detail, 'shape-mismatch');
});

test('opencode：宿主缺 node:sqlite 时结构化降级（0 文件 + 稳定机器码，不抛）', async (t) => {
  const home = await tempHome('dcm-opencode-cap-');
  const dbFile = opencodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, OPENCODE_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readOpencode({
    homeDir: home,
    platform: 'linux',
    sqliteDeps: { capability: async () => ({ available: false, reason: 'module-unavailable' }) },
  });
  assert.deepEqual(read.files, []);
  assert.equal(read.readFindings?.[0]?.code, 'source-unreadable');
  assert.equal(read.readFindings?.[0]?.detail, 'sqlite-capability:module-unavailable');
});

test('sqlite.ts：能力探测形状正确；非 SQLite 文件在「表探测」处判负（绝不静默当空库）', async (t) => {
  const cap = await sqliteCapability();
  assert.equal(typeof cap.available, 'boolean');
  if (!cap.available) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const home = await tempHome('dcm-sqlite-garbage-');
  const garbage = opencodeDbPath({ homeDir: home, platform: 'linux' });
  await fsp.mkdir(path.dirname(garbage), { recursive: true });
  await fsp.writeFile(garbage, 'this is definitely not a sqlite database');
  // 实测：DatabaseSync 对非库文件是**惰性**的（构造不抛），因此判负必须在表探测处
  const db = await openSqliteReadOnly(garbage);
  assert.ok(db !== null, '只读构造对非库文件仍是惰性成功（实测）');
  assert.equal(readOpencodeFamilyDatabase(db), null, '表探测读不到 → 家族读器必须返回 null');
  db.close();
});

/* ---------------- 跨来源：SQLite 批的能力探测门必须对 8 个来源都生效 ---------------- */

const MIN_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [['CREATE TABLE t (id TEXT)', []]];

interface CapabilityCase {
  readonly id: string;
  readonly run: (home: string) => Promise<SessionReadOutcome<SqliteSessionFile>>;
}

test('SQLite 批：8 个来源逐个注入「缺 node:sqlite」→ 0 文件 + 稳定机器码（结构化降级，不崩）', async (t) => {
  if ((await sqliteCtor()) === null) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const sqliteDeps = { capability: async () => ({ available: false, reason: 'module-unavailable' as const }) };
  const cases: readonly CapabilityCase[] = [
    { id: 'opencode', run: async (home) => { await createDb(opencodeDbPath({ homeDir: home, platform: 'linux' }), MIN_SCHEMA); return await readOpencode({ homeDir: home, platform: 'linux', sqliteDeps }); } },
    { id: 'mimocode', run: async (home) => { await createDb(mimocodeDbPath({ homeDir: home, platform: 'linux' }), MIN_SCHEMA); return await readMimocode({ homeDir: home, platform: 'linux', sqliteDeps }); } },
    { id: 'kilocode', run: async (home) => { await createDb(kilocodeDbPath({ homeDir: home, platform: 'linux' }), MIN_SCHEMA); return await readKilocode({ homeDir: home, platform: 'linux', sqliteDeps }); } },
    { id: 'zcode', run: async (home) => { await createDb(zcodeDbPath({ homeDir: home, platform: 'linux' }), MIN_SCHEMA); return await readZcode({ homeDir: home, platform: 'linux', sqliteDeps }); } },
    {
      id: 'teleagent',
      run: async (home) => {
        const usersDir = teleagentUsersDir({ homeDir: home, platform: 'linux', env: {} });
        await createDb(usersDir + '/acct1/teleagent.db', MIN_SCHEMA);
        return await readTeleagent({ homeDir: home, platform: 'linux', env: {}, sqliteDeps });
      },
    },
    { id: 'goose', run: async (home) => { await createDb(gooseDbPath({ homeDir: home, platform: 'linux', env: {} }), MIN_SCHEMA); return await readGoose({ homeDir: home, platform: 'linux', env: {}, sqliteDeps }); } },
    { id: 'zed', run: async (home) => { await createDb(zedThreadsDbPath({ homeDir: home, platform: 'linux', env: {} }), MIN_SCHEMA); return await readZed({ homeDir: home, platform: 'linux', env: {}, sqliteDeps }); } },
    {
      id: 'crush',
      run: async (home) => {
        const project = path.join(home, 'proj');
        await createDb(crushProjectDbPath('linux', project), MIN_SCHEMA);
        return await readCrush({ homeDir: home, platform: 'linux', env: {}, projectDir: project, sqliteDeps });
      },
    },
  ];
  for (const item of cases) {
    const home = await tempHome('dcm-cap-' + item.id + '-');
    const read = await item.run(home);
    assert.deepEqual([...read.files], [], item.id + '：缺能力必须产出 0 文件');
    assert.ok(
      read.readFindings?.some((s) => s.detail === 'sqlite-capability:module-unavailable'),
      item.id + '：缺能力必须留下稳定机器码（绝不伪装成「未安装」）',
    );
  }
});
