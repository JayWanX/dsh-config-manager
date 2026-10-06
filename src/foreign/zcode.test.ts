/**
 * zcode（db.sqlite，session/message/part；message 表可能缺失）：真实临时库夹具的单测（AGENTS.md：SQLite 源用真实临时库造夹具）。
 *
 * 覆盖：① probePaths 与 truth-table.ts 逐平台相等；② 真实库 → 读盘 → build（sessions + workspaces）；
 * ③ 「未安装不报码 / 存在但形状不符一条 source-unreadable」的统一口径。无 node:sqlite 时 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zcodeDbPath, readZcode } from './read-zcode.ts';
import { createZcodeSource } from './zcode.ts';
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
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'zcode');
  assert.ok(entry !== undefined, '真值表必须有 zcode 条目');
  return entry;
}

const SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?)', ['s-1', '/work/zcode', 'zcode session', 1791201600000]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-1', 's-1', 1791201601000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-1', 'm-1', 's-1', 1791201601000, JSON.stringify({ type: 'text', text: 'hello zcode' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-2', 's-1', 1791201602000, JSON.stringify({ role: 'assistant' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-2', 'm-2', 's-1', 1791201602000, JSON.stringify({ type: 'text', text: 'reply zcode' })]],
];

test('zcode：probePaths 与真值表逐平台相等 + evidence 一致', () => {
  const entry = truth();
  const source = createZcodeSource();
  assert.equal(source.id, 'zcode');
  assert.equal(source.evidence, entry.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.deepEqual(
      [...source.probePaths({ homeDir: TRUTH_PROBES[platform].homeDir, env: {}, platform })].map(normalize),
      expandTruthList(platform, entry.defaults[platform]).map(normalize),
      platform + ' 的静态探测位置必须与真值表一致',
    );
  }
});

test('zcode：真实临时库 → build 产出 sessions + workspaces；未安装不报码', async (t) => {
  const home = await tempHome('dcm-zcode-');
  const source = createZcodeSource();
  const ctx: ForeignSourceContext = { homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 };

  const missing = await source.build(ctx);
  assert.deepEqual(missing.sections, [], '未安装 → 不产出分区');
  assert.deepEqual(missing.skipped, [], '未安装是正常状态，绝不报码');

  const dbFile = zcodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const det = await source.detect(ctx);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.zcode/cli/db/db.sqlite']);

  const read = await readZcode({ homeDir: home, platform: 'linux' });
  assert.equal(read.files.length, 1);
  assert.equal(read.files[0]?.parsed.cwd, '/work/zcode');
  assert.deepEqual(read.files[0]?.parsed.records.map((r) => r.role), ['user', 'assistant']);

  const built = await source.build(ctx);
  const sessions = built.sections.find((s) => s.sectionId === 'sessions');
  assert.equal(sessions?.files?.length, 1);
  const ws = built.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string }[] } | undefined;
  assert.equal(ws?.workspaces[0]?.path, '/work/zcode');
  assert.equal(built.counts['sessions.transcoded'], 1);
});

test('zcode：存在但不是本来源的库 → 一条 source-unreadable(shape-mismatch)', async (t) => {
  const home = await tempHome('dcm-zcode-shape-');
  const dbFile = zcodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, [['CREATE TABLE unrelated (id TEXT)', []]]))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readZcode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(read.files, []);
  assert.equal(read.readFindings?.[0]?.detail, 'shape-mismatch');
});

test('zcode：极简/降级形态（只有 session 表、无 message 表）不假装有会话，逐条报 session-empty', async (t) => {
  const home = await tempHome('dcm-zcode-degraded-');
  const dbFile = zcodeDbPath({ homeDir: home, platform: 'linux' });
  const ok = await createDb(dbFile, [
    ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT)', []],
    ['INSERT INTO session VALUES (?, ?, ?)', ['s-only', '/work/zcode', 'no messages']],
  ]);
  if (!ok) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const source = createZcodeSource();
  const read = await readZcode({ homeDir: home, platform: 'linux' });
  assert.equal(read.files.length, 1, '会话元数据仍要读出来（可见性）');
  assert.deepEqual(read.files[0]?.parsed.records, []);
  const built = await source.build({ homeDir: home, env: {}, platform: 'linux', targetSessionFormatVersion: 3 });
  assert.deepEqual(built.sections, [], '没有可迁移的消息 → 不产出会话分区');
  assert.ok(built.skipped.some((s) => s.code === 'session-empty'), '必须逐条报 session-empty');
});
/* ---------------- 只导主会话（parent_id IS NULL OR parent_id = ''） ---------------- */

const CHILD_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, parent_id TEXT)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?)', ['s-main', '/work/z', 'main', 1791201600000, null]],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?)', ['s-child', '/work/z', 'child', 1791201601000, 's-main']],
  ['INSERT INTO session VALUES (?, ?, ?, ?, ?)', ['s-empty', '/work/z', 'empty parent', 1791201602000, '']],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-main', 's-main', 1791201600000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-main', 'm-main', 's-main', 1791201600000, JSON.stringify({ type: 'text', text: 'main' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-child', 's-child', 1791201601000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-child', 'm-child', 's-child', 1791201601000, JSON.stringify({ type: 'text', text: 'child' })]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-empty', 's-empty', 1791201602000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-empty', 'm-empty', 's-empty', 1791201602000, JSON.stringify({ type: 'text', text: 'empty parent' })]],
];

test('zcode：过滤子会话（parent_id 非空）；空串与 NULL 同等视为主会话', async (t) => {
  const home = await tempHome('dcm-zcode-child-');
  const dbFile = zcodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, CHILD_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readZcode({ homeDir: home, platform: 'linux' });
  assert.deepEqual(read.files.map((f) => f.id), ['s-main', 's-empty'], '子会话（subagent/分叉产物）不进结果集');
  assert.equal(read.extraCounts?.['zcode.sessions.dropped'], 1);
});

/* ---------------- 压缩摘要（compaction part 的 summary.body / 消息级 data.summary.body） ---------------- */

const SUMMARY_SCHEMA: readonly (readonly [string, readonly unknown[]])[] = [
  ['CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)', []],
  ['CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)', []],
  ['INSERT INTO session VALUES (?, ?, ?, ?)', ['s-comp', '/work/z', 'compacted', 1791201600000]],
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-user', 's-comp', 1791201600000, JSON.stringify({ role: 'user' })]],
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-user', 'm-user', 's-comp', 1791201600000, JSON.stringify({ type: 'text', text: 'hi' })]],
  // 消息级摘要（data.summary.body）：源侧压缩标记，正文由**会话级摘要**承载
  ['INSERT INTO message VALUES (?, ?, ?, ?)', ['m-sum', 's-comp', 1791201601000, JSON.stringify({ role: 'assistant', summary: { body: 'compacted history' } })]],
  // part 级压缩（type=compaction 的 summary.body）：同一条压缩记录
  ['INSERT INTO part VALUES (?, ?, ?, ?, ?)', ['p-comp', 'm-sum', 's-comp', 1791201601000, JSON.stringify({ type: 'compaction', summary: { body: 'compacted history' }, compactBoundary: { keptMessageCount: 1 } })]],
];

test('zcode：压缩摘要（part.summary.body / data.summary.body）被识别并计数，绝不静默丢', async (t) => {
  const home = await tempHome('dcm-zcode-summary-');
  const dbFile = zcodeDbPath({ homeDir: home, platform: 'linux' });
  if (!(await createDb(dbFile, SUMMARY_SCHEMA))) {
    t.skip('宿主无 node:sqlite');
    return;
  }
  const read = await readZcode({ homeDir: home, platform: 'linux' });
  const file = read.files[0];
  assert.ok(file !== undefined);
  // 本地 IR 没有「会话级摘要 / 压缩检查点」通道（session-ir.ts 记的待办能力）→ 摘要正文承载不了，
  // 但它**必须可见**：part 级与消息级各计一类，绝不静默丢弃（详见汇报里的共享层缺口）。
  assert.equal(file.parsed.ignored['part:compaction'], 1);
  assert.equal(file.parsed.ignored['message:summary'], 1);
  // 不伪装成正文：摘要文本不进对话
  const texts = file.parsed.records.flatMap((r) => r.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
  assert.deepEqual(texts, ['hi']);
});

