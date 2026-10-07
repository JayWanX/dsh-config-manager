/**
 * 会话合成行 ↔ DSH 读盘管线**硬不变量**的回归护栏（2026-10-07）。
 *
 * 为什么需要（真机事故）：导入 Hermes 历史会话后 DSH 报
 *   `stored session "…" is corrupt: … session event at seq 5 message must have model source`
 * 根因是 `synthesizeDshRows` 产出的行不满足 DSH 的 `assertMessageEventShape`
 * （`dsh-session/lib/index.js:946-955`，由 `adoptSessionEvent` 在装入时逐行执行）：
 *   · `assistant/message` 的 `message.source` 必须是 `{kind:'model', provider, model}` 且 provider/model **非空**；
 *   · `tool/result` 的 `source.callId` 必须**非空**，且与 `content[0].toolCallId` 逐字相同；
 *     块类型是 `tool-result`（连字符）—— `tool_result`/`tool_use_id`/`is_error` 这套命名会被**直接拒读**；
 *   · 真实 DSH 日志里 `assistant/message` 还带 `stream`（数组，语义不透明）与 content 里的 `tool-call` 块
 *     （`deriveEventMessage` 对空 content 返回 null，DSH 的 interrupted-turn 修复也按它记录未决调用）。
 *
 * 本测试**不依赖 DSH 在场**（CI 里没有它），只钉上面这几条形状；同一批产物已用 DSH 自己的
 * `adoptSessionEvent` 在真机逐行复验过（hermes 71 会话 / 29687 行 → 0 拒绝）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  irFallbackMessageId,
  irMessage,
  irTextBlock,
  irToolCallBlock,
  irToolResultBlock,
  synthesizeDshRows,
} from './session-ir.ts';
import type { DshSessionRow, SynthesisStats } from './session-ir.ts';

const NOW = 1700000000000;

function stats(): SynthesisStats {
  return { ignored: {}, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 };
}

/** 一份覆盖三个关键点的小会话：有 id 的调用/结果、缺 id 的调用/结果、无主结果。 */
function synth(): { rows: DshSessionRow[]; stats: SynthesisStats } {
  const s = stats();
  const rows = synthesizeDshRows(
    {
      id: 's1',
      cwd: 'D:/proj',
      createdAt: NOW,
      records: 6,
      messages: [
        irMessage(irFallbackMessageId(0), 'user', [irTextBlock('你好')], { time: NOW }),
        irMessage(irFallbackMessageId(1), 'assistant', [
          irTextBlock('看一下'),
          irToolCallBlock('c1', 'terminal', { command: 'ls' }),
        ], { time: NOW + 1, source: { model: 'hermes-model' } }),
        irMessage(irFallbackMessageId(2), 'user', [irToolResultBlock('c1', 'file.txt', false)], { time: NOW + 2 }),
        // 缺 id 的调用 → 合成器必须铸稳定 id，且结果按 FIFO 回填同一个 id
        irMessage(irFallbackMessageId(3), 'assistant', [irToolCallBlock('', 'read', { path: 'a' })], { time: NOW + 3 }),
        irMessage(irFallbackMessageId(4), 'user', [irToolResultBlock('', 'body', true)], { time: NOW + 4 }),
        // 无主结果（一个未决调用都没有）→ 计数后丢弃，绝不产出空 callId
        irMessage(irFallbackMessageId(5), 'user', [irToolResultBlock('', 'orphan', false)], { time: NOW + 5 }),
      ],
    },
    {
      title: 't',
      titleSource: { kind: 'fallback' },
      emptyBlocks: [],
      provider: 'hermes',
      reasoningEffort: 'medium',
      maxTokens: 8192,
    },
    s,
    NOW,
  );
  return { rows, stats: s };
}

const LEGACY_BLOCK_KEYS = ['tool_use_id', 'is_error', 'tool_result'];

test('合成行：assistant/message 的 source 必须是 kind=model 且 provider/model 非空', () => {
  const { rows } = synth();
  const assistants = rows.filter((r) => r.type === 'assistant/message');
  assert.ok(assistants.length >= 2, '语料里应有助手消息');
  for (const row of assistants) {
    const data = row.data as { message: { source: Record<string, unknown> }; stream?: unknown };
    assert.equal(data.message.source['kind'], 'model', 'DSH 拒读 kind!=="model" 的 assistant 行');
    assert.equal(typeof data.message.source['provider'], 'string');
    assert.notEqual(data.message.source['provider'], '', 'provider 必须非空');
    assert.equal(typeof data.message.source['model'], 'string');
    assert.notEqual(data.message.source['model'], '', 'model 必须非空（缺省兜底 unknown）');
    assert.ok(Array.isArray(data.stream), 'assistant/message 必须带 stream 数组（装入边界要求）');
  }
});

test('合成行：assistant content 必须携带 tool-call 块，且 id 与 tool/call 事件逐字一致', () => {
  const { rows } = synth();
  const callEvents = rows.filter((r) => r.type === 'tool/call');
  const callIds = callEvents.map((r) => (r.data as { callId: string }).callId);
  assert.equal(callIds.length, 2);
  for (const id of callIds) assert.ok(id !== '', 'tool/call 的 callId 必须非空');
  const blocks = rows
    .filter((r) => r.type === 'assistant/message')
    .flatMap((r) => (r.data as { message: { content: { type: string; id?: string }[] } }).message.content)
    .filter((b) => b.type === 'tool-call');
  assert.deepEqual(blocks.map((b) => b.id), callIds, 'content 里的 tool-call 块必须与 tool/call 事件同 id、同序');
});

test('合成行：tool/result 用 DSH 的 tool-result / toolCallId / isError 形状，callId 非空且与调用配对', () => {
  const { rows } = synth();
  const callIds = new Set(rows.filter((r) => r.type === 'tool/call').map((r) => (r.data as { callId: string }).callId));
  const results = rows.filter((r) => r.type === 'tool/result');
  assert.equal(results.length, 2, '有 id 的 + 缺 id 回填的 → 恰好两条；无主结果必须被丢弃');
  for (const row of results) {
    const data = row.data as { message: { source: { kind: string; callId: string }; content: Record<string, unknown>[] } };
    assert.equal(data.message.source['kind'], 'tool');
    const callId = data.message.source['callId'];
    assert.ok(typeof callId === 'string' && callId !== '', 'source.callId 必须非空（空串会被 DSH 拒读）');
    assert.ok(callIds.has(callId), 'callId 必须指向一条真实发出过的 tool/call');
    assert.equal(data.message.content.length, 1, 'tool/result 必须恰好一个内容块');
    const block = data.message.content[0] as Record<string, unknown>;
    assert.equal(block['type'], 'tool-result', '块类型必须是 tool-result（连字符）');
    assert.equal(block['toolCallId'], callId, '块的 toolCallId 必须与 source.callId 逐字相同');
    assert.equal(typeof block['isError'], 'boolean');
    assert.ok(Array.isArray(block['content']), '块内容必须是数组');
    for (const legacy of LEGACY_BLOCK_KEYS) {
      assert.equal(legacy in block, false, '不得使用会被 DSH 拒读的旧键：' + legacy);
    }
  }
});

test('合成行：无主结果不产出空 callId，按 orphan-tool-result 计数', () => {
  const { rows, stats: s } = synth();
  for (const row of rows) {
    const data = row.data as { message?: { source?: Record<string, unknown> } };
    const source = data.message?.source;
    if (source === undefined) continue;
    assert.notEqual(source['kind'], 'assistant', 'source.kind="assistant" 是本次真机事故的根因，绝不回归');
    if (source['kind'] === 'tool') assert.notEqual(source['callId'], '');
  }
  assert.equal(s.ignored['orphan-tool-result'], 1, '无主结果必须计数可见');
});
