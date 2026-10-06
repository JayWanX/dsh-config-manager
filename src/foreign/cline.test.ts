/**
 * Cline 来源回归（路径真值 × modern/legacy 两代解析 × 端到端 × 环境变量覆盖）。
 *
 * 取证：本机无 ~/.cline 与对应 VS Code globalStorage（fixture 级）；夹具在测试内即时构造。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, vscodeUserDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';

const BS = String.fromCharCode(92);
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];
/** 读真实临时目录的用例用**运行平台**（绝对路径判定要对得上真机） */
const HOST: ForeignPlatform = normalizePlatform(process.platform);

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

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

function normalize(p: string): string {
  return p.split(BS).join('/');
}

function assertTruthPaths(id: string, probePaths: (opts: RootProbeOptions) => readonly string[]): void {
  for (const platform of PLATFORMS) {
    const probe = TRUTH_PROBES[platform];
    const opts: RootProbeOptions = { homeDir: probe.homeDir, env: TRUTH_PROBE_ENV, platform };
    assert.deepEqual(
      probePaths(opts).map(normalize),
      truthProbePaths(id, opts).map(normalize),
      id + ' × ' + platform + ' 的 probePaths 与真值表不一致',
    );
  }
}

function ctxOf(homeDir: string, platform: ForeignPlatform, env: Record<string, string | undefined> = {}, version = 3, projectDir?: string): ForeignSourceContext {
  return {
    homeDir,
    env,
    platform,
    targetSessionFormatVersion: version,
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

import { clineSource } from './cline.ts';
import { clineCwdOf, clineProbePaths, readCline, resolveClineRoots } from './read-cline.ts';

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

/** 建真实索引库；返回 false = 宿主无 node:sqlite */
async function createDb(file: string, statements: readonly (readonly [string, readonly unknown[]])[]): Promise<boolean> {
  const Ctor = await sqliteCtor();
  if (Ctor === null) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
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

test('cline t1 路径真值：modern 三级 + 三个 VS Code globalStorage × 三平台与真值表逐项一致', () => {
  assertTruthPaths('cline', clineProbePaths);
  const linux = clineProbePaths({ homeDir: '/home/u', env: {}, platform: 'linux' });
  assert.deepEqual(linux, [
    '/home/u/.cline/data/sessions',
    ['/home/u', '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
    ['/home/u', '.config', 'Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
    ['/home/u', '.config', 'VSCodium', 'User', 'globalStorage', 'saoudrizwan.claude-dev'].join('/'),
  ]);
  const roots = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_SESSION_DATA_DIR: '/data/cline' }, platform: 'linux' });
  assert.equal(roots.modern, '/data/cline');
  assert.equal(roots.modernFrom, 'CLINE_SESSION_DATA_DIR');
  const dataDir = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_DATA_DIR: '/data/c' }, platform: 'linux' });
  assert.equal(dataDir.modern, '/data/c/sessions');
  const dirEnv = resolveClineRoots({ homeDir: '/home/u', env: { CLINE_DIR: '/opt/cline' }, platform: 'linux' });
  assert.equal(dirEnv.modern, '/opt/cline/data/sessions');
  const oneLegacy = resolveClineRoots({
    homeDir: '/home/u',
    env: { CLINE_LEGACY_GLOBAL_STORAGE_DIR: '/one/legacy', CLINE_VSCODE_GLOBAL_STORAGE_DIR: '/two' },
    platform: 'linux',
  });
  assert.deepEqual(oneLegacy.legacy, ['/one/legacy'], '两个 override 命中即**只返回该一个** legacy 根');
});

test('cline t2 cwd 只认显式权威字段（manifest / legacy 索引），绝不深搜工具入参', () => {
  assert.equal(clineCwdOf({ cwdOnTaskInitialization: '/p/a' }, 'linux'), '/p/a');
  assert.equal(clineCwdOf({ cwd: '/p/m' }, 'linux'), '/p/m');
  assert.equal(clineCwdOf({ workspace_root: '/p/w' }, 'linux'), '/p/w');
  // 泛键深搜（旧实现）会把工具入参里的 path 当会话 cwd —— 必须不再命中
  assert.equal(clineCwdOf({ cwd: 'relative/nope', nested: { path: '/p/b' } }, 'linux'), undefined);
  assert.equal(clineCwdOf({ toolInput: { path: '/p/b' } }, 'linux'), undefined);
  assert.equal(clineCwdOf({ cwd: 'relative/nope' }, 'linux'), undefined);
});

test('cline t3 解析 + 端到端：modern（messages.json）与 legacy（api_conversation_history + 索引）都产出会话', async () => {
  const root = await tmpRoot('cline');
  try {
    const modernDir = path.join('.cline', 'data', 'sessions', 'sess-1');
    await writeAt(root, path.join(modernDir, 'sess-1.json'), JSON.stringify({
      metadata: { title: 'cline 会话' },
      cwd: path.join(root, 'proj'),
    }));
    await writeAt(root, path.join(modernDir, 'sess-1.messages.json'), JSON.stringify({
      version: 1,
      agent: 'lead',
      messages: [
        { role: 'user', content: 'hi', ts: 1700000000000 },
        { type: 'say', say: 'text', text: 'yo', ts: 1700000001000 },
        { type: 'say', say: 'api_req_started', text: 'request' },
      ],
    }));
    await writeAt(root, path.join(modernDir, 'sess-1.compaction.json'), JSON.stringify({ summary: 'x' }));
    // 子代理消息文件（同目录 <agentId>.messages.json）不是主线会话，但要被计数而非静默丢弃
    await writeAt(root, path.join(modernDir, 'team-agent.messages.json'), JSON.stringify({ agent: 'subagent', messages: [] }));
    // 只有子代理文件的目录：不得被当成一条对话
    await writeAt(root, path.join('.cline', 'data', 'sessions', 'sess-2', 'agent-x.messages.json'), JSON.stringify({ agent: 'subagent', messages: [{ role: 'user', content: 'x' }] }));
    // 规范文件里 agent != 'lead'：同样不单独成会话
    await writeAt(root, path.join('.cline', 'data', 'sessions', 'sess-3', 'sess-3.messages.json'), JSON.stringify({
      version: 1,
      agent: 'teammate',
      messages: [{ role: 'user', content: 'x' }],
    }));

    // legacy 根按**运行平台**真值定位（win32 = %APPDATA% 回落 <home>/AppData/Roaming；
    // linux/darwin = <home>/.config 或 Application Support）—— 夹具不写死 linux 形态
    const legacyRoot = path.join(
      vscodeUserDataDir(HOST, root, {}, 'Code'),
      'globalStorage', 'saoudrizwan.claude-dev',
    );
    const legacyTaskDir = path.join(legacyRoot, 'tasks', 'task-1');
    // 权威转写是 api_conversation_history.json（ui_messages.json 只做标题兜底）
    await writeAt(root, path.relative(root, path.join(legacyTaskDir, 'api_conversation_history.json')), JSON.stringify([
      { role: 'user', content: 'legacy q', ts: 1700000002000 },
      { role: 'assistant', content: 'legacy a' },
    ]));
    await writeAt(root, path.relative(root, path.join(legacyTaskDir, 'ui_messages.json')), JSON.stringify([
      { type: 'say', say: 'user_feedback', text: 'legacy q' },
      { type: 'ask', ask: 'text', text: 'legacy q' },
    ]));
    // 任务索引在 **tasks/ 的兄弟目录** state/taskHistory.json（一个数组）
    await writeAt(root, path.relative(root, path.join(legacyRoot, 'state', 'taskHistory.json')), JSON.stringify([
      { id: 'task-1', task: 'legacy 任务', cwdOnTaskInitialization: path.join(root, 'legacy-proj'), ts: 1700000002500 },
    ]));

    const read = await readCline({ homeDir: root, env: {}, platform: HOST });
    assert.equal(read.files.length, 2, 'modern 与 legacy 两条路径都要读到；子代理会话被过滤');
    const modern = read.files.find((f) => f.id === 'sess-1');
    assert.ok(modern !== undefined);
    assert.equal(modern.flavor, 'modern');
    assert.equal(modern.cwd, path.join(root, 'proj'));
    assert.equal(modern.title, 'cline 会话');
    assert.equal(modern.records.length, 2);
    assert.equal(modern.ignored['cline:api_req_started'], 1, '未迁移的 say 子类型必须逐类计数');
    assert.equal(modern.ignored['compaction'], 1);

    assert.equal(read.files.find((f) => f.id === 'sess-2'), undefined, '只有子代理文件的目录不得成为会话');
    assert.equal(read.files.find((f) => f.id === 'sess-3'), undefined, "agent !== 'lead' 的规范文件不得成为会话");
    assert.equal(read.extraCounts?.['cline.subagent-files'], 2, '子代理消息文件必须计数而非静默丢弃');
    assert.equal(read.extraCounts?.['cline.subagent-sessions'], 1);
    assert.ok(read.readFindings?.some((s) => s.detail === 'subagent-messages-only'));

    const legacy = read.files.find((f) => f.id === 'task-1');
    assert.ok(legacy !== undefined);
    assert.equal(legacy.flavor, 'legacy');
    assert.equal(legacy.cwd, path.join(root, 'legacy-proj'), 'legacy cwd 只认兄弟目录 state/taskHistory.json 的索引');
    assert.equal(legacy.title, 'legacy 任务', '标题取索引的 task');
    assert.equal(legacy.createdAt, 1700000002500, '时间取索引的 ts');
    assert.equal(legacy.records.length, 2, '转写只来自 api_conversation_history.json');
    assert.equal(legacy.records[0]?.role, 'user');
    assert.equal(legacy.ignored['cline:ui-messages-not-read'], 1, 'ui_messages.json 只做标题兜底，不当转写');

    const result = await clineSource.build(ctxOf(root, HOST));
    assert.equal(result.counts['sessions.files'], 2);
    assert.equal(result.counts['workspaces.records'], 2);
    const details = result.skipped.filter((s) => s.code === 'unsupported-session-record').map((s) => s.detail).sort();
    assert.deepEqual(details, ['cline:api_req_started', 'cline:ui-messages-not-read', 'compaction']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cline t5 db/sessions.db 是权威索引：cwd/标题/started_at 与子代理判定都从它取', async (t) => {
  const root = await tmpRoot('cline-db');
  try {
    const clineDir = path.join(root, 'cline-home');
    const dbFile = path.join(clineDir, 'data', 'db', 'sessions.db');
    const ok = await createDb(dbFile, [
      ['CREATE TABLE sessions (session_id TEXT PRIMARY KEY, cwd TEXT, workspace_root TEXT, metadata_json TEXT, started_at INTEGER, is_subagent INTEGER, agent_id TEXT, parent_session_id TEXT)', []],
      ['INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sess-db', path.join(root, 'db-proj'), null, JSON.stringify({ title: 'DB 标题' }), 1700000005000, 0, null, null]],
      ['INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sess-sub', path.join(root, 'db-proj'), null, JSON.stringify({ title: 'sub' }), 1700000005001, 1, null, null]],
    ]);
    if (!ok) {
      t.skip('宿主无 node:sqlite');
      return;
    }
    // 两个目录都只有规范转写、没有 manifest：元数据只能来自 DB 索引
    await writeAt(root, path.relative(root, path.join(clineDir, 'data', 'sessions', 'sess-db', 'sess-db.messages.json')), JSON.stringify({
      version: 1, agent: 'lead', messages: [{ role: 'user', content: 'hi', ts: 1700000005000 }],
    }));
    await writeAt(root, path.relative(root, path.join(clineDir, 'data', 'sessions', 'sess-sub', 'sess-sub.messages.json')), JSON.stringify({
      version: 1, agent: 'lead', messages: [{ role: 'user', content: 'sub', ts: 1700000005001 }],
    }));

    const read = await readCline({ homeDir: root, env: { CLINE_DIR: clineDir }, platform: HOST });
    const modern = read.files.find((f) => f.id === 'sess-db');
    assert.ok(modern !== undefined);
    assert.equal(modern.cwd, path.join(root, 'db-proj'), 'cwd 取 DB 索引（无 manifest 也能拿到）');
    assert.equal(modern.title, 'DB 标题');
    assert.equal(modern.createdAt, 1700000005000, '时间取 started_at');
    assert.equal(read.files.find((f) => f.id === 'sess-sub'), undefined, 'DB is_subagent=1 → 不单独成会话');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cline t4 detect：只 stat 探测位置；五个覆盖变量命中如实报 source-location-overridden', async () => {
  const root = await tmpRoot('cline-detect');
  try {
    const miss = await clineSource.detect(ctxOf(root, HOST));
    assert.equal(miss.found, false);
    const over = await clineSource.detect(ctxOf(root, HOST, { CLINE_DIR: path.join(root, 'alt') }));
    assert.equal(over.skipped?.some((s) => s.code === 'source-location-overridden' && s.origin === 'CLINE_DIR'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
