/**
 * Continue 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`CONTINUE_GLOBAL_DIR` **替换**语义（不是 vibe 的追加语义）；
 *  ② env 只报**键名**：`probeEnvKeys` 命中 → `source-location-overridden`，且位置标签里
 *     不得出现用户 home 的绝对串（**值/机器身份绝不回传**）；
 *  ③ 解析：单对象 JSON（格式化多行也整份解析）、history 角色映射、工具调用/结果配对、
 *     contextItems 只计数、system 只计数；
 *  ④ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { normalizePlatform, joinFor } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createContinueSource, continueSource, continueDefaultProbe } from './continue.ts';
import {
  CONTINUE_DEFAULT_TITLE,
  CONTINUE_ENV_KEY,
  continueIndexOf,
  continueSessionsDir,
  indexTimeOf,
  parseContinueSession,
  readContinueSessions,
  sessionTitlesFromIndex,
} from './read-continue.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'continue');
if (TRUTH === undefined) throw new Error('真值表缺少 continue 行');

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

/* ---------------- ① 位置真值（env 替换语义） ---------------- */

test('t1 位置：CONTINUE_GLOBAL_DIR **替换**默认根；缺省 = <home>/.continue/sessions', () => {
  assert.equal(
    continueSessionsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }),
    joinFor('linux', '/home/u', '.continue', 'sessions'),
  );
  assert.equal(
    continueSessionsDir({ homeDir: '/home/u', env: { CONTINUE_GLOBAL_DIR: '/data/cont' }, platform: 'linux' }),
    joinFor('linux', '/data/cont', 'sessions'),
    'env 是**替换**：不能再把它拼在 ~/.continue 之下（与 VIBE_HOME 的追加语义相反）',
  );
  assert.equal(
    continueSessionsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }),
    'C:' + BS + 'u' + BS + '.continue' + BS + 'sessions',
  );
  // 空串 env = 未设置（envValue 的口径：绝不把 '' 当成一个目录）
  assert.equal(
    continueSessionsDir({ homeDir: '/home/u', env: { CONTINUE_GLOBAL_DIR: '' }, platform: 'linux' }),
    joinFor('linux', '/home/u', '.continue', 'sessions'),
  );
});

test('t2 证据强度与探测面取自 truth-table.ts；空环境下探测面 == 真值表默认根', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(continueSource.evidence, TRUTH.evidence);
  assert.equal(createContinueSource().evidence, TRUTH.evidence);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const homeDir = platform === 'win32' ? 'C:' + BS + 'probe' : '/home/probe';
    assert.deepEqual(
      [...continueSource.probePaths({ homeDir, env: {}, platform })],
      [...continueDefaultProbe(platform, homeDir)],
      '空环境下探测面必须是真值表的默认根（护栏正是这么比对的）',
    );
  }
});

/* ---------------- ② env 只报键名 ---------------- */

test('t3 env 覆盖只报**键名**：detect 报 source-location-overridden，位置标签不含绝对串', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-continue-env-'));
  try {
    const globalDir = path.join(tmp, 'global-continue');
    const home = path.join(tmp, 'home');
    await writeAt(globalDir, 'sessions/s1.json', JSON.stringify({
      sessionId: 's1',
      title: '标题',
      workspaceDirectory: '/work/env',
      history: [{ message: { role: 'user', content: 'hi' } }, { message: { role: 'assistant', content: 'yo' } }],
    }));
    const det = await continueSource.detect(ctxOf(home, { [CONTINUE_ENV_KEY]: globalDir }));
    assert.equal(det.found, true, 'env 生效时 detect 必须看得到真实位置');
    assert.ok(det.skipped?.some((s) => s.code === 'source-location-overridden' && s.origin === CONTINUE_ENV_KEY));
    for (const p of det.paths) {
      assert.ok(!p.includes(tmp), '回传的位置标签绝不能含绝对路径（机器身份）：' + p);
      assert.ok(!p.includes(globalDir), '更不得回传 env 的值本身');
    }
    const result = await continueSource.build(ctxOf(home, { [CONTINUE_ENV_KEY]: globalDir }));
    assert.equal(sessionsOf(result).length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ③ 解析 ---------------- */

test('t4 单对象 JSON：history 角色映射 / 工具配对 / contextItems 与 system 只计数', () => {
  const doc = {
    sessionId: 'c-1',
    title: '会话标题',
    workspaceDirectory: '/work/proj',
    history: [
      { message: { role: 'user', content: '读文件' }, contextItems: [{ name: 'a.ts' }] },
      {
        message: {
          role: 'assistant',
          content: '好的',
          toolCalls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
        },
      },
      { message: { role: 'tool', toolCallId: 't1', content: '文件内容' } },
      { message: { role: 'system', content: '系统提示' } },
      { message: { role: 'assistant', content: '读完了' } },
    ],
  };
  const outcome = parseContinueSession(JSON.stringify(doc, null, 2));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.id, 'c-1');
  assert.equal(outcome.parsed.cwd, '/work/proj');
  assert.equal(outcome.parsed.title, '会话标题');
  assert.deepEqual(outcome.parsed.records.map((r) => r.role), ['user', 'assistant', 'user', 'assistant']);
  const call = outcome.parsed.records[1]?.blocks.find((b) => b.type === 'tool_call');
  assert.deepEqual(call, { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a.ts' } }, '字符串参数按 JSON 解析');
  const res = outcome.parsed.records[2]?.blocks.find((b) => b.type === 'tool_result');
  assert.deepEqual(res, { type: 'tool_result', id: 't1', text: '文件内容', isError: false });
  assert.equal(outcome.parsed.ignored['contextItem'], 1, '上下文附件不是对话 → 只计数');
  assert.equal(outcome.parsed.ignored['system'], 1);

  assert.deepEqual(parseContinueSession('{}'), { ok: false, problem: 'history-not-array' });
  assert.deepEqual(parseContinueSession('[]'), { ok: false, problem: 'not-an-object' });
  assert.deepEqual(parseContinueSession('{x'), { ok: false, problem: 'json-error' });
});

/* ---------------- ④ 端到端 ---------------- */

test('t5 build：sessions + workspaces 同源产出；索引只贡献标题；缺 cwd 的会话跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-continue-'));
  try {
    await writeAt(tmp, '.continue/sessions/s1.json', JSON.stringify({
      sessionId: 's1',
      workspaceDirectory: '/work/proj',
      history: [{ message: { role: 'user', content: '你好' } }, { message: { role: 'assistant', content: '回复' } }],
    }));
    // 索引里有标题而无正文标题 → 只补标题（其余字段一概不读）
    await writeAt(tmp, '.continue/sessions/sessions.json', JSON.stringify([{ sessionId: 's1', title: '索引标题' }]));
    // 缺 workspaceDirectory → 不得产出
    await writeAt(tmp, '.continue/sessions/s2.json', JSON.stringify({
      sessionId: 's2',
      history: [{ message: { role: 'user', content: '无 cwd' } }],
    }));

    const read = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 2, '索引文件不是会话（必须按名字排除，不能按后缀）');
    assert.equal(read.files[0]?.parsed.title, '索引标题', '索引只贡献标题');

    const result = await continueSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.relativePath, projectKeyOf('/work/proj') + '/s1/' + dshSessionLogName(TARGET_VERSION));
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => ({ path: w.path, sessionIds: w.sessionIds })), [{ path: '/work/proj', sessionIds: ['s1'] }]);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's2'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ⑤ 参考实现对齐（convert/continue.mjs） ---------------- */

test('t7 推理/工具世代：thinking 与 reasoning.text 只显式计数；toolCalls 权威、toolCallStates 仅回退', () => {
  // 推理**不进正文**（本地 IR 无 reasoning 块）→ 只显式计数，绝不伪装成正文
  const doc = {
    sessionId: 'c-2',
    title: CONTINUE_DEFAULT_TITLE,
    workspaceDirectory: '/work/x',
    history: [
      { message: { role: 'user', content: '读文件' } },
      { message: { role: 'thinking', content: '先看目录' } },
      {
        message: { role: 'assistant', content: '好的' },
        reasoning: { text: '先看目录' },
        toolCallStates: [{ toolCallId: 't1', status: 'errored', output: [{ content: '读失败' }] }],
      },
      { message: { role: 'tool', toolCallId: 't1', content: '读失败' } },
    ],
  };
  const outcome = parseContinueSession(JSON.stringify(doc));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.parsed.ignored['continue:thinking'], 1, 'thinking 必须显式计数');
  assert.equal(outcome.parsed.ignored['continue:reasoning'], undefined, '与 thinking 同文 → 去重后不另计');
  assert.equal(outcome.parsed.title, '读文件', '默认标题 New Session 不是显式标题 → 首问兜底');
  assert.deepEqual(outcome.parsed.records.map((r) => r.role), ['user', 'assistant', 'user']);
  const call = outcome.parsed.records[1]?.blocks.find((b) => b.type === 'tool_call');
  assert.deepEqual(call, { type: 'tool_call', id: 't1', name: '', input: undefined }, 'toolCallStates 回退取调用');
  const res = outcome.parsed.records[2]?.blocks.find((b) => b.type === 'tool_result');
  assert.deepEqual(res, { type: 'tool_result', id: 't1', text: '读失败', isError: true }, '错误位取 status === errored');

  // 两个世代同时存在 = 同一数组的镜像 → 只在 toolCalls 为空时回退，绝不重复产出
  const both = {
    sessionId: 'c-3',
    workspaceDirectory: '/work/x',
    history: [
      { message: { role: 'user', content: 'hi' } },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        },
        toolCallStates: [
          { toolCallId: 't1', status: 'done', toolCall: { id: 't1', function: { name: 'read_file', arguments: '{"path":"a"}' } }, output: '内容' },
        ],
      },
    ],
  };
  const o2 = parseContinueSession(JSON.stringify(both));
  assert.equal(o2.ok, true);
  if (!o2.ok) return;
  const calls = o2.parsed.records.flatMap((r) => r.blocks).filter((b) => b.type === 'tool_call');
  const results = o2.parsed.records.flatMap((r) => r.blocks).filter((b) => b.type === 'tool_result');
  assert.equal(calls.length, 1, '同消息同时存在两个世代时不得重复产出调用');
  assert.equal(results.length, 1, 'state.output 只补没有独立结果消息的调用（这里恰好补一次）');
  assert.deepEqual(results[0], { type: 'tool_result', id: 't1', text: '内容', isError: false });

  // 独立 tool 消息覆盖该调用 → state.output 不再补（不重复）
  const covered = {
    sessionId: 'c-4',
    workspaceDirectory: '/work/x',
    history: [
      { message: { role: 'user', content: 'hi' } },
      { message: { role: 'assistant', content: '', toolCalls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }] } },
      { message: { role: 'tool', toolCallId: 't1', content: '来自消息' } },
    ],
    toolCallStates: [{ toolCallId: 't1', output: '来自 state' }],
  };
  const o3 = parseContinueSession(JSON.stringify(covered));
  assert.equal(o3.ok, true);
  if (!o3.ok) return;
  const coveredResults = o3.parsed.records.flatMap((r) => r.blocks).filter((b) => b.type === 'tool_result');
  assert.deepEqual(coveredResults.map((b) => (b.type === 'tool_result' ? b.text : '')), ['来自消息']);
});

test('t8 索引：title 与 dateCreated 都读；dateCreated 是毫秒数字串（不是时间戳文本）', async () => {
  assert.equal(indexTimeOf('1700000000000'), 1700000000000, '纯数字串按数值解析（Date.parse 会给 NaN）');
  assert.equal(indexTimeOf(1700000000000), 1700000000000);
  assert.equal(indexTimeOf('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(indexTimeOf('nope'), undefined);
  const idx = continueIndexOf([
    { sessionId: 's1', title: '标题一', dateCreated: '1700000000000' },
    { sessionId: 's2', title: CONTINUE_DEFAULT_TITLE, dateCreated: 1700000000001 },
    { title: '没有 id' },
  ]);
  assert.equal(idx.get('s1')?.createdAt, 1700000000000);
  assert.equal(idx.get('s2')?.title, '', '默认标题常量在索引侧同样过滤');
  assert.equal(idx.size, 2, '没有 id 的条目直接跳过');
  assert.deepEqual([...sessionTitlesFromIndex([{ sessionId: 's1', title: '标题一' }])], [['s1', '标题一']]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-continue-idx-'));
  try {
    await writeAt(tmp, '.continue/sessions/s1.json', JSON.stringify({
      sessionId: 's1',
      title: CONTINUE_DEFAULT_TITLE,
      workspaceDirectory: '/work/idx',
      history: [{ message: { role: 'user', content: '问题' } }],
    }));
    await writeAt(tmp, '.continue/sessions/sessions.json', JSON.stringify([
      { sessionId: 's1', title: '索引标题', dateCreated: '1700000000000' },
    ]));
    const read = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files[0]?.parsed.title, '索引标题');
    assert.equal(read.files[0]?.parsed.createdAt, 1700000000000, '记录没有时间戳时用索引的 dateCreated');

    // 记录自带 createdAt 时以记录为准（索引只补缺）
    await writeAt(tmp, '.continue/sessions/s3.json', JSON.stringify({
      sessionId: 's3',
      createdAt: 1600000000000,
      workspaceDirectory: '/work/idx',
      history: [{ message: { role: 'user', content: '问题' } }],
    }));
    await writeAt(tmp, '.continue/sessions/sessions.json', JSON.stringify([
      { sessionId: 's3', title: '索引标题', dateCreated: '1700000000000' },
    ]));
    const read2 = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read2.files.find((f) => f.id === 's3')?.parsed.createdAt, 1600000000000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9 结构自拒：非 Continue JSON（索引/空对象/别的 .json）静默跳过并计数，畸形 JSON 仍响亮', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-continue-sig-'));
  try {
    await writeAt(tmp, '.continue/sessions/s1.json', JSON.stringify({
      sessionId: 's1',
      workspaceDirectory: '/work/sig',
      history: [{ message: { role: 'user', content: '你好' } }],
    }));
    // JetBrains 会留下空对象；目录里也可能混入别的 JSON 文档
    await writeAt(tmp, '.continue/sessions/empty.json', '{}');
    await writeAt(tmp, '.continue/sessions/other.json', JSON.stringify({ unrelated: true }));
    const read = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 1, '只有带 history 的文档算会话');
    assert.equal(
      read.readFindings?.some((s) => s.detail === 'history-not-array' || s.detail === 'not-an-object'),
      false,
      '非会话 JSON 不再产生 history-not-array 噪音：' + JSON.stringify(read.readFindings),
    );
    assert.equal(read.extraCounts?.['continue.nonSessionFiles'], 2, '跳过的条数必须可见');

    // 畸形 JSON 仍要响亮（可能是被截断的真实会话）
    await writeAt(tmp, '.continue/sessions/broken2.json', '{not json');
    const read2 = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.ok(read2.readFindings?.some((s) => s.detail === 'json-error' && s.origin === 'broken2.json'));
    assert.equal(read2.extraCounts?.['continue.nonSessionFiles'], 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6 未安装 / 畸形：不抛；畸形 JSON 报 source-unreadable(json-error) 且不产出分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-continue-bad-'));
  try {
    const none = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(none.files, []);

    await writeAt(tmp, '.continue/sessions/broken.json', '{not json');
    const read = await readContinueSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(read.files, []);
    assert.ok(read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'json-error' && s.origin === 'broken.json'));
    const result = await continueSource.build(ctxOf(tmp));
    assert.deepEqual(result.sections, []);
    assert.ok(result.skipped.some((s) => s.code === 'source-unreadable'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
