/**
 * Kimi 来源（双根两代布局；读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 五层：
 *  ① 位置真值：**双根** `~/.kimi/sessions` + `~/.kimi-code/sessions`，两个伴生文件也在探测面里；
 *  ② **两代 wire 词汇**：旧 PascalCase（TextPart/ToolCall/ToolResult）与新点分小写
 *     （turn.prompt / context.append_message / context.append_loop_event）都能归一；
 *  ③ `context.append_message` 与 `turn.prompt` 的**同文本去重**（只这一对相邻时触发）；
 *  ④ cwd 的三档来源：状态文件 > 旧代次 `kimi.json` 的 md5 反查 > 新代次 `workspaces.json` 反查；
 *     三档都没有 → 不产出（session-missing-cwd）；
 *  ⑤ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createKimiSource, kimiSource, KIMI_PROVIDER } from './kimi.ts';
import {
  md5Hex,
  normalizeEventType,
  parseKimiWire,
  readKimiSessions,
  kimiCodeSessionsDir,
  kimiLegacySessionsDir,
  workspaceMapOf,
  workDirMapOf,
} from './read-kimi.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'kimi');
if (TRUTH === undefined) throw new Error('真值表缺少 kimi 行');

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

test('t1 位置：**双根** + 两个伴生文件（三平台同形，无 env 覆盖）', () => {
  assert.equal(kimiLegacySessionsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.kimi/sessions');
  assert.equal(kimiCodeSessionsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.kimi-code/sessions');
  assert.equal(kimiLegacySessionsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.kimi' + BS + 'sessions');
});

test('t2 探测面 = 双根 + 两个伴生文件（与 truth-table.ts 逐字一致）', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(kimiSource.evidence, TRUTH.evidence);
  assert.equal(createKimiSource().evidence, TRUTH.evidence);
  const homeDir = '/home/probe';
  const probes = [...kimiSource.probePaths({ homeDir, env: {}, platform: 'linux' })];
  assert.deepEqual(probes, TRUTH.defaults['linux'].map((t) => t.split('<home>').join(homeDir)));
  assert.equal(probes.length, 4, '两条 session 根 + kimi.json + workspaces.json 都要列');
});

test('t3 事件类型归一 + 两张反查表（md5/kaos 前缀、对象与数组两种 workspaces 形态）', () => {
  assert.equal(normalizeEventType('turn.prompt'), 'turnprompt');
  assert.equal(normalizeEventType('context.append_message'), 'contextappendmessage');
  assert.equal(normalizeEventType('TextPart'), 'textpart');

  const wd = workDirMapOf({ work_dirs: [{ path: '/work/proj' }, { path: '/work/remote', kaos: 'kaos1' }, { path: '/work/local', kaos: 'local' }] });
  assert.ok(wd.has(md5Hex('/work/proj')));
  assert.ok(wd.has('kaos1_' + md5Hex('/work/remote')));
  assert.ok(wd.has(md5Hex('/work/local')), 'kaos=local 不加前缀');
  assert.equal(wd.get(md5Hex('/work/proj')), '/work/proj');

  assert.deepEqual([...workspaceMapOf({ ws1: '/work/a', ws2: { path: '/work/b' } }).entries()], [['ws1', '/work/a'], ['ws2', '/work/b']]);
  assert.deepEqual([...workspaceMapOf([{ id: 'ws3', cwd: '/work/c' }]).entries()], [['ws3', '/work/c']]);
  assert.equal(workspaceMapOf('nonsense').size, 0);
});

test('t4 旧代次 wire（PascalCase）：TextPart 合并成一条消息；ToolCall/ToolResult 配对', () => {
  const parsed = parseKimiWire([
    JSON.stringify({ type: 'TurnBegin' }),
    JSON.stringify({ type: 'TextPart', text: '第一段' }),
    JSON.stringify({ type: 'TextPart', text: '第二段' }),
    JSON.stringify({ type: 'ToolCall', id: 'c1', name: 'read', args: { p: 1 } }),
    JSON.stringify({ type: 'ToolResult', toolCallId: 'c1', content: 'body' }),
    JSON.stringify({ type: 'turn.ended' }),
  ].join(NL));
  assert.deepEqual(parsed.records.map((r) => r.role), ['assistant', 'assistant', 'user']);
  const text = parsed.records[0]?.blocks[0];
  assert.deepEqual(text, { type: 'text', text: '第一段' + NL + '第二段' }, '相邻 TextPart 合并成一条消息（wire 是分片流）');
  assert.deepEqual(parsed.records[1]?.blocks[0], { type: 'tool_call', id: 'c1', name: 'read', input: { p: 1 } });
  assert.deepEqual(parsed.records[2]?.blocks[0], { type: 'tool_result', id: 'c1', text: 'body', isError: false });
  assert.equal(parsed.bad, 0);
});

test('t5 新代次 wire（点分小写）：同文本去重 + append_loop_event 下钻一层', () => {
  const parsed = parseKimiWire([
    JSON.stringify({ type: 'turn.prompt', text: '你好' }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: '回复' } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'context.append_message', message: { role: 'assistant', content: '工具前文本' } } }),
    JSON.stringify({ type: 'turn.ended' }),
  ].join(NL));
  assert.deepEqual(parsed.records.map((r) => r.role), ['user', 'assistant']);
  assert.deepEqual(parsed.records[0]?.blocks[0], { type: 'text', text: '你好' });
  assert.deepEqual(parsed.records[1]?.blocks[0], { type: 'text', text: '回复' + NL + '工具前文本' });
  assert.equal(parsed.ignored['duplicate-text'], 1, 'turn.prompt ↔ context.append_message 同文本必须去重且可见');
  // 认不出的类型逐类计数（绝不静默）
  const odd = parseKimiWire([JSON.stringify({ type: 'something.brand.new', text: 'x' })].join(NL));
  assert.equal(odd.ignored['somethingbrandnew'], 1);
});

test('t6 端到端：旧根靠 kimi.json 的 md5 反查；新根靠 state.json / workspaces.json；都没有则跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-kimi-'));
  try {
    await writeAt(tmp, '.kimi/kimi.json', JSON.stringify({ work_dirs: [{ path: '/work/legacy' }] }));
    await writeAt(tmp, '.kimi/sessions/' + md5Hex('/work/legacy') + '/kimi-legacy-1/wire.jsonl', [
      JSON.stringify({ type: 'turn.prompt', text: '旧代次你好' }),
      JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: '旧代次回复' } }),
    ].join(NL));

    await writeAt(tmp, '.kimi-code/workspaces.json', JSON.stringify({ 'ws-1': { path: '/work/code-from-workspaces' } }));
    await writeAt(tmp, '.kimi-code/sessions/ws-1/kimi-code-1/agents/main/wire.jsonl', [
      JSON.stringify({ type: 'turn.prompt', text: '新代次你好' }),
    ].join(NL));
    await writeAt(tmp, '.kimi-code/sessions/ws-1/kimi-code-1/state.json', JSON.stringify({ cwd: '/work/code' }));
    // 新根第二个会话：state.json 缺失 → 回退 workspaces.json
    await writeAt(tmp, '.kimi-code/sessions/ws-2/kimi-code-2/agents/main/wire.jsonl', [
      JSON.stringify({ type: 'turn.prompt', text: '回退你好' }),
    ].join(NL));
    await writeAt(tmp, '.kimi-code/workspaces.json', JSON.stringify({ 'ws-1': { path: '/work/code-from-workspaces' }, 'ws-2': '/work/code-fallback' }));
    // 完全查不到 cwd → 不得产出
    await writeAt(tmp, '.kimi-code/sessions/ws-unknown/kimi-unknown/agents/main/wire.jsonl', [
      JSON.stringify({ type: 'turn.prompt', text: '没有 cwd' }),
    ].join(NL));

    const read = await readKimiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 4, '双根都要扫（只取一根是这里最危险的事）');
    const byId = new Map(read.files.map((f) => [f.id, f.parsed]));
    assert.equal(byId.get('kimi-legacy-1')?.cwd, '/work/legacy');
    assert.equal(byId.get('kimi-code-1')?.cwd, '/work/code', '状态文件是权威');
    assert.equal(byId.get('kimi-code-2')?.cwd, '/work/code-fallback', '缺 state.json 回退 workspaces.json');
    assert.equal(byId.get('kimi-unknown')?.cwd, undefined);

    const result = await kimiSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 3);
    const legacy = files.find((f) => f.relativePath.includes('kimi-legacy-1'));
    assert.ok(legacy !== undefined);
    assert.ok(legacy.relativePath.startsWith(projectKeyOf('/work/legacy') + '/'));
    assert.ok(legacy.relativePath.endsWith('/kimi-legacy-1/' + dshSessionLogName(TARGET_VERSION)));
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 'kimi-unknown'));
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => w.path).sort(), ['/work/code', '/work/code-fallback', '/work/legacy']);
    assert.equal(KIMI_PROVIDER, 'kimi');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 未安装 / 0 字节：正常状态、不抛、如实报码', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-kimi-empty-'));
  try {
    assert.deepEqual((await readKimiSessions({ homeDir: tmp, env: {}, platform: PLATFORM })).files, []);
    assert.equal((await kimiSource.detect(ctxOf(tmp))).found, false);

    await writeAt(tmp, '.kimi/sessions/' + md5Hex('/x') + '/k1/wire.jsonl', '');
    const read = await readKimiSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.deepEqual(read.files, []);
    assert.ok(read.readFindings?.some((s) => s.code === 'source-empty-file' && (s.origin ?? '').endsWith('wire.jsonl')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
