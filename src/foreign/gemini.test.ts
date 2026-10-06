/**
 * Gemini CLI 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 cursor.test.ts / codex.test.ts 同构）：
 *  ① 位置真值：`<home>/.gemini/history`（三平台同形、无 env 覆盖）；
 *  ② 解析：**单对象 JSON**（不是 JSONL）—— 用**格式化过（多行）**的夹具直接钉死这一条，
 *     并覆盖派生的三条纪律（info 计数 / toolCalls 内联结果拆成两条记录 / thoughts 计数）；
 *  ③ 端到端：`sessionSourceOf` 的 build 产出 sessions + workspaces，且证据强度与探测面
 *     取自 truth-table.ts（**真值表是单一事实源**，来源定义里不得自己填更好看的一档）。
 *
 * 取证强度：本来源是 **fixture**（真机无 ~/.gemini/history）—— 用例只断言键名/计数/结构，
 * 不含任何配置值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { readSessionLogShapeFromBytes } from '../utils/session-log.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { normalizePlatform, joinFor } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createGeminiSource, geminiSource, GEMINI_PROVIDER } from './gemini.ts';
import {
  GEMINI_SESSION_FILE_RE,
  geminiHistoryDir,
  geminiToolResultText,
  parseGeminiSession,
  readGeminiSessions,
} from './read-gemini.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'gemini');
if (TRUTH === undefined) throw new Error('真值表缺少 gemini 行');

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

function ctxOf(homeDir: string, env: Record<string, string | undefined> = {}) {
  return { homeDir, env, platform: PLATFORM, targetSessionFormatVersion: TARGET_VERSION };
}

function sessionsOf(result: ForeignImportResult) {
  return result.sections.find((s) => s.sectionId === 'sessions')?.files ?? [];
}

function workspacesOf(result: ForeignImportResult) {
  const data = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
    | { workspaces: { id: string; path: string; sessionIds: string[] }[] }
    | undefined;
  return data?.workspaces ?? [];
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：<home>/.gemini/history 三平台同形，无 env 覆盖', () => {
  assert.equal(geminiHistoryDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.gemini' + BS + 'history');
  assert.equal(geminiHistoryDir({ homeDir: '/home/u', env: {}, platform: 'darwin' }), '/home/u/.gemini/history');
  assert.equal(geminiHistoryDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.gemini/history');
  // 未知平台按 posix 处理（normalizePlatform 的口径）
  assert.equal(geminiHistoryDir({ homeDir: '/home/u', env: {}, platform: 'aix' }), '/home/u/.gemini/history');
});

test('t2 证据强度与探测面一律取自 truth-table.ts（防「未取证却列出来」）', () => {
  assert.equal(TRUTH.evidence, 'fixture', '本来源在本仓是 fixture（真机未验证）');
  assert.equal(geminiSource.evidence, TRUTH.evidence);
  assert.equal(createGeminiSource().evidence, TRUTH.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const homeDir = platform === 'win32' ? 'C:' + BS + 'probe' : '/home/probe';
    assert.deepEqual(
      [...geminiSource.probePaths({ homeDir, env: {}, platform })],
      TRUTH.defaults[platform].map((t) => t.split('<home>').join(homeDir)),
    );
  }
});

/* ---------------- ② 单对象 JSON 解析 ---------------- */

test('t3 单对象 JSON（**格式化多行**也整份解析）：info 计数 / toolCalls 内联结果拆两条 / thoughts 计数', () => {
  const doc = {
    sessionId: 'g-1',
    projectHash: 'hash',
    startTime: '2026-01-01T00:00:00Z',
    directories: ['/work/proj'],
    kind: 'chat',
    messages: [
      { type: 'user', content: '你好', timestamp: '2026-01-01T00:00:01Z' },
      { type: 'info', content: '一个非消息记录' },
      {
        type: 'gemini',
        content: '我读一下文件',
        model: 'gemini-2.5-pro',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' }, result: 'file body' }],
        thoughts: '先看目录',
      },
    ],
  };
  // **关键**：多行格式化 —— 若按 JSONL 逐行解析，这份文件会整份失败
  const outcome = parseGeminiSession(JSON.stringify(doc, null, 2));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.id, 'g-1');
  assert.equal(outcome.parsed.cwd, '/work/proj');
  assert.equal(outcome.parsed.records.length, 3, 'user + assistant(工具调用) + user(工具结果)');
  assert.equal(outcome.parsed.records[0]?.role, 'user');
  assert.equal(outcome.parsed.records[1]?.role, 'assistant');
  assert.equal(outcome.parsed.records[2]?.role, 'user', '内联工具结果必须拆成一条 user 记录（DSH 工具生命周期闭合）');
  const callBlocks = outcome.parsed.records[1]?.blocks.filter((b) => b.type === 'tool_call') ?? [];
  assert.equal(callBlocks.length, 1);
  assert.deepEqual(callBlocks[0], { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
  const resultBlocks = outcome.parsed.records[2]?.blocks.filter((b) => b.type === 'tool_result') ?? [];
  assert.deepEqual(resultBlocks, [{ type: 'tool_result', id: 'c1', text: 'file body', isError: false }]);
  assert.equal(outcome.parsed.ignored['info'], 1, 'info 不是消息 → 逐类计数');
  assert.equal(outcome.parsed.ignored['thoughts'], 1, 'IR 无 reasoning 块 → 如实计数');

  // 非对象 / 缺 messages / 畸形 JSON 一律给稳定机器码，绝不抛
  assert.deepEqual(parseGeminiSession('[]'), { ok: false, problem: 'not-an-object' });
  assert.deepEqual(parseGeminiSession('{}'), { ok: false, problem: 'messages-not-array' });
  assert.deepEqual(parseGeminiSession('{oops'), { ok: false, problem: 'json-error' });
});

/* ---------------- ③ 读盘 + 端到端 ---------------- */

test('t4 读盘 + build：sessions + workspaces 同源产出；缺 cwd 的会话按 session-missing-cwd 跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-'));
  try {
    const rel = '.gemini/history/-work-proj/chats/session-1.json';
    await writeAt(tmp, rel, JSON.stringify({
      sessionId: 'g-1',
      startTime: '2026-01-01T00:00:00Z',
      directories: ['/work/proj'],
      messages: [
        { type: 'user', content: '你好' },
        { type: 'gemini', content: '回复', model: 'gemini-2.5' },
      ],
    }, null, 2));
    // 第二个会话：没有 directories → 不得产出（下游 session-missing-cwd）
    await writeAt(tmp, '.gemini/history/-work-other/chats/session-2.json', JSON.stringify({
      sessionId: 'g-2',
      messages: [{ type: 'user', content: '无 cwd' }],
    }));
    // 0 字节文件：如实报码、不算会话
    await writeAt(tmp, '.gemini/history/-work-empty/chats/session-3.json', '');

    const read = await readGeminiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 2);
    // 结果按相对路径排序（目录遍历顺序三平台不同）→ 按 id 找，别按下标
    assert.ok(read.files.some((f) => f.id === 'g-1'));
    assert.ok(read.files.some((f) => f.id === 'g-2'));
    assert.ok(read.readFindings?.some((s) => s.code === 'source-empty-file' && (s.origin ?? '').endsWith('session-3.json')));

    const result = await geminiSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1, '缺 cwd 的会话绝不产出（DSH 要求日志位置 == projectKey(cwd)/id）');
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/g-1/' + dshSessionLogName(TARGET_VERSION));
    assert.ok((files[0]?.data.length ?? 0) > 0, '必须真的产出字节');
    const ws = workspacesOf(result);
    assert.deepEqual(ws.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['g-1'] }]);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 'g-2'));

    // detect 只 stat、不读内容：命中位置是**相对 home 的 POSIX 标签**
    const det = await geminiSource.detect(ctxOf(tmp));
    assert.equal(det.found, true);
    assert.ok(det.paths.includes('.gemini/history'), '位置标签必须是相对 home 的 POSIX 串：' + det.paths.join(','));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 未安装是正常状态：不抛、不产出任何分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-none-'));
  try {
    const read = await readGeminiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(read.files, []);
    const result = await geminiSource.build(ctxOf(tmp));
    assert.deepEqual(result.sections, []);
    const det = await geminiSource.detect(ctxOf(tmp));
    assert.equal(det.found, false);
    assert.deepEqual(det.paths, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6 provider 名与平台拼接：provider 进 request/header，路径用 joinFor 的目标平台分隔符', () => {
  assert.equal(GEMINI_PROVIDER, 'gemini');
  assert.equal(joinFor('win32', 'C:' + BS + 'u', '.gemini'), 'C:' + BS + 'u' + BS + '.gemini');
  assert.equal(NL.length, 1);
});

/* ---------------- ④ 真实 toolCalls 形态（chat-import convert/gemini.mjs:72,105-116） ---------------- */

test('t7 内联结果取 result[].functionResponse.response.output；resultDisplay 兜底；status=error → isError', () => {
  const doc = {
    sessionId: 'g-tools',
    startTime: '2026-01-01T00:00:00Z',
    directories: ['/work/proj'],
    messages: [
      { type: 'user', content: '读文件并搜索' },
      {
        type: 'gemini',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', args: { path: 'a.ts' }, result: [{ functionResponse: { response: { output: '文件正文' } } }] },
          { name: 'grep', args: { q: 'x' }, resultDisplay: 'display 文本', status: 'error' },
        ],
      },
    ],
  };
  const outcome = parseGeminiSession(JSON.stringify(doc));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const callBlocks = outcome.parsed.records[1]?.blocks.filter((b) => b.type === 'tool_call') ?? [];
  assert.deepEqual(callBlocks, [
    { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
    // id 缺失 → 铸 gemini-<turn>-<n>（turn=1 是已开启的用户回合数，n 是该条消息内的调用序号）
    { type: 'tool_call', id: 'gemini-1-2', name: 'grep', input: { q: 'x' } },
  ]);
  const resultBlocks = outcome.parsed.records[2]?.blocks.filter((b) => b.type === 'tool_result') ?? [];
  assert.deepEqual(resultBlocks, [
    { type: 'tool_result', id: 'c1', text: '文件正文', isError: false },
    { type: 'tool_result', id: 'gemini-1-2', text: 'display 文本', isError: true },
  ]);

  // 直接测取值口径：不是 text/content/message 的形态也必须取到（此前通用 flattenText 返回空串）
  const ignored: Record<string, number> = {};
  assert.equal(geminiToolResultText({ result: [{ functionResponse: { response: { output: 'x' } } }] }, ignored), 'x');
  assert.equal(geminiToolResultText({ result: [{ functionResponse: {} }], resultDisplay: 'd' }, ignored), 'd');
  assert.equal(geminiToolResultText({ result: [{ functionResponse: {} }] }, ignored), undefined);
  assert.equal(geminiToolResultText({}, ignored), undefined);
});

test('t8 tool/call 与 tool/result 的 callId 必须逐字相同（端到端解字节，配对断裂会让 DSH 判损坏）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-tools-'));
  try {
    await writeAt(tmp, '.gemini/history/-work-proj/chats/session-tools.json', JSON.stringify({
      sessionId: 'g-tools',
      startTime: '2026-01-01T00:00:00Z',
      directories: ['/work/proj'],
      messages: [
        { type: 'user', content: '读文件' },
        { type: 'gemini', content: '', model: 'gemini-2.5', toolCalls: [{ name: 'read_file', args: { path: 'a.ts' }, result: 'b' }] },
      ],
    }));
    const result = await geminiSource.build(ctxOf(tmp));
    const file = sessionsOf(result)[0];
    assert.ok(file !== undefined);
    const shape = readSessionLogShapeFromBytes(file.data);
    assert.equal(shape.ok, true);
    if (!shape.ok) return;
    const rows = shape.rows.filter((r): r is Record<string, unknown> => r !== null);
    const call = rows.find((r) => r['type'] === 'tool/call');
    const toolResult = rows.find((r) => r['type'] === 'tool/result');
    assert.ok(call !== undefined && toolResult !== undefined, '调用与结果都必须落行');
    const callId = (call['data'] as Record<string, unknown>)['callId'];
    const message = (toolResult['data'] as Record<string, unknown>)['message'] as Record<string, unknown>;
    const source = message['source'] as Record<string, unknown>;
    assert.equal(callId, 'gemini-1-1');
    assert.equal(source['callId'], callId, 'tool/result 必须挂回同一次 tool/call（否则 DSH 判损坏）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9 会话文件名：大小写不敏感、拒绝空 stem（session-.json）', async () => {
  assert.equal(GEMINI_SESSION_FILE_RE.test('session-1.json'), true);
  assert.equal(GEMINI_SESSION_FILE_RE.test('Session-1.JSON'), true);
  assert.equal(GEMINI_SESSION_FILE_RE.test('session-.json'), false, '空 stem 不是合法会话名');
  assert.equal(GEMINI_SESSION_FILE_RE.test('session.json'), false);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gemini-name-'));
  try {
    const body = (id: string) => JSON.stringify({ sessionId: id, directories: ['/work/proj'], messages: [{ type: 'user', content: 'hi' }] });
    await writeAt(tmp, '.gemini/history/slot/chats/Session-Upper.json', body('g-upper'));
    await writeAt(tmp, '.gemini/history/slot/chats/session-.json', body('g-empty-stem'));
    const read = await readGeminiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(read.files.map((f) => f.id), ['g-upper'], '大写文件名要读，空 stem 要拒');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
