/**
 * Claude Code 会话 → DSH 会话日志的转码护栏。
 *
 * 三层：
 *  ① 形态（路径 / header / 事件序列）；
 *  ② 拒绝面（不认识的格式版本、缺 cwd、非法 id 一律跳过并报码，不产出半成品）；
 *  ③ **用 DSH 自己的 codec 验证产物**（encode 已按 v3 规则对齐，这里再把产物解码回逻辑事件）。
 *     ③ 需要本机装有 DSH（codec 在 profiles 的 node_modules 里）；找不到就 skip，不伪装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSessionLogShapeFromBytes } from '../utils/session-log.ts';
import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName, transcodeClaudeSession } from './claude-sessions.ts';

const NL = String.fromCharCode(10);
const ID = '11111111-1111-4111-8111-111111111111';
const CWD = 'D:/proj/app';

function line(o: unknown): string {
  return JSON.stringify(o);
}

function sessionText(): string {
  return [
    line({ type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: '帮我看看这个 bug' } }),
    line({
      type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000002', timestamp: '2026-10-01T10:00:05.000Z', cwd: CWD,
      message: {
        model: 'claude-sonnet-4',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        content: [
          { type: 'text', text: '我先看一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    line({
      type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000003', timestamp: '2026-10-01T10:00:06.000Z', cwd: CWD,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'entry1' }] },
    }),
    line({ type: 'assistant', uuid: 'aaaaaaaa-0000-4000-8000-000000000004', timestamp: '2026-10-01T10:00:07.000Z', cwd: CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: '修好了' }] } }),
    line({ type: 'attachment', uuid: 'aaaaaaaa-0000-4000-8000-000000000005', timestamp: '2026-10-01T10:00:08.000Z', cwd: CWD }),
    '{ 这不是合法 JSON',
  ].join(NL) + NL;
}

test('t1 形态：路径 / header / 事件序列', () => {
  const result = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3, now: 1_700_000_000_000 });
  assert.ok(result.session, '应转码成功');
  const s = result.session;
  assert.equal(s.id, ID);
  assert.equal(s.cwd, CWD);
  assert.equal(s.relativePath, projectKeyOf(CWD) + '/' + ID + '/' + dshSessionLogName(3));
  assert.equal(s.relativePath, '--D-proj-app--/' + ID + '/session.v3.jsonl.zstd');

  const shape = readSessionLogShapeFromBytes(s.data);
  assert.equal(shape.ok, true, '产物必须是 DSH 可扫的 zstd 帧序列');
  if (!shape.ok) return;
  const header = shape.headerValue as Record<string, unknown>;
  assert.equal(header['type'], 'session');
  assert.equal(header['version'], 3);
  assert.equal(header['id'], ID);
  assert.equal(header['cwd'], CWD);
  assert.equal(header['isSeeded'], false);
  assert.equal(header['delegationDepth'], 0);
  assert.equal(header['createdAt'], Date.parse('2026-10-01T10:00:00.000Z'));

  const types = shape.rows.map((r) => (r === null ? 'null' : (r as Record<string, unknown>)['type']));
  assert.deepEqual(types, [
    'session/title', 'user/message', 'turn/start', 'request/header', 'step/start',
    'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ]);

  // seq 必须从 0 连续递增（DSH 按位置校验引用）
  const seqs = shape.rows.map((r) => (r as Record<string, unknown>)['seq']);
  assert.deepEqual(seqs, seqs.map((_, i) => i));

  const toolCall = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'tool/call') as Record<string, unknown>;
  const callData = toolCall['data'] as Record<string, unknown>;
  assert.equal(callData['name'], 'Bash');
  assert.equal(callData['callId'], 'toolu_1');
  assert.equal(callData['arguments'], '{"command":"ls"}');

  const userRow = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'user/message') as Record<string, unknown>;
  assert.equal(userRow['surfaceOp'], 'append', 'user/message 也必须有 surfaceOp 标记');

  const assistant = shape.rows.find((r) => (r as Record<string, unknown>)['type'] === 'assistant/message') as Record<string, unknown>;
  assert.equal(assistant['surfaceOp'], 'append', '消息类事件必须带 surfaceOp 标记');
  const usage = (assistant['data'] as Record<string, unknown>)['usage'] as Record<string, unknown>;
  assert.equal(usage['inputTokens'], 10);
  assert.equal(usage['totalTokens'], 15);
  assert.equal(usage['cacheReadTokens'], 2);

  assert.equal(s.info.toolCalls, 1);
  assert.equal(s.info.toolResults, 1);
  assert.equal(s.info.ignored['attachment'], 1);
  assert.equal(s.info.ignored['unparsable'], 1);
});

test('t2 拒绝面：不认识的格式版本 / 缺 cwd / 非法 id 一律跳过并报码', () => {
  const base = { id: ID, text: sessionText() };
  assert.equal(transcodeClaudeSession(base, { formatVersion: 2 }).skip?.code, 'session-format-unsupported');
  assert.equal(transcodeClaudeSession({ ...base, id: 'a/b' }, { formatVersion: 3 }).skip?.code, 'session-unsafe-id');
  const noCwd = [line({ type: 'user', uuid: 'aaaaaaaa-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } })].join(NL);
  assert.equal(transcodeClaudeSession({ id: ID, text: noCwd }, { formatVersion: 3 }).skip?.code, 'session-missing-cwd');
  assert.equal(transcodeClaudeSession({ id: ID, text: '' }, { formatVersion: 3 }).skip?.code, 'session-empty');
});

test('t3 产物可被 DSH 自己的 codec 解码回逻辑事件（本机无 codec 则 skip）', async (t) => {
  const dirs = [
    process.env['DSH_SESSION_CODEC_DIR'],
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
  ].filter((d): d is string => typeof d === 'string' && d !== '');
  let codecMod: unknown;
  let formatMod: unknown;
  for (const dir of dirs) {
    try {
      codecMod = await import(pathToFileURL(path.join(dir, 'dsh-session-format-v2-to-v3', 'lib', 'index.js')).href);
      formatMod = await import(pathToFileURL(path.join(dir, 'dsh-session-format', 'lib', 'index.js')).href);
      break;
    } catch {
      codecMod = undefined;
    }
  }
  if (codecMod === undefined || formatMod === undefined) {
    t.skip('未找到 DSH 会话 codec（仅本机安装 DSH 时可用）');
    return;
  }
  const codec = (codecMod as Record<string, any>)['releasedV3SessionFormatCodec'];
  const Collector = (formatMod as Record<string, any>)['SessionFormatEventCollector'];
  const result = transcodeClaudeSession({ id: ID, text: sessionText() }, { formatVersion: 3 });
  assert.ok(result.session);
  const shape = readSessionLogShapeFromBytes(result.session.data);
  assert.equal(shape.ok, true);
  if (!shape.ok) return;

  const header = codec.decodeHeader(shape.headerValue);
  assert.equal(header.id, ID);
  const collector = new Collector();
  const decoder = codec.createDecoder(shape.headerValue, collector);
  for (const row of shape.rows) decoder.decodeRow(row, collector);
  assert.equal(decoder.finish(collector), 0);
  const types = collector.values.map((e: Record<string, unknown>) => e['type']);
  assert.ok(types.includes('user/message'));
  assert.ok(types.includes('assistant/message'));
  assert.ok(types.includes('tool/call'));
  assert.ok(types.includes('tool/result'));
  assert.ok(types.includes('turn/end'));
});
