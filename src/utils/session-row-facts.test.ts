/**
 * 会话**行级事实**单测 —— packed 行跨度模型、连续性走查、引用面收集。
 *
 * 为什么这三样必须有单测：它们是「体检说可修」与「执行器真的去修」共用的唯一判据；
 * 判错一次就是真机 407/1194 份 v0 日志被误判有损（或反向：把 DSH 拒读的坏日志报成干净）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectSessionRowReferences,
  findSyntheticCloserRun,
  packedRowSpan,
  parseSessionRowFacts,
  referencesContain,
  sessionRowMayHaveReferences,
  walkSessionRowContinuity,
} from './session-row-facts.ts';

/** 官方 v0 released 打包行的最小合法形状（tool-call-chunks 用 args）。 */
function packed(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text-chunks',
    seq0: 17,
    time0: 1000,
    data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'], ...data },
    ...over,
  };
}

const factsOf = (values: readonly unknown[]) => values.map((value) => parseSessionRowFacts(JSON.stringify(value)));

test('packedRowSpan：合法 packed 行给出 payload.length（text-chunks / reasoning-chunks / tool-call-chunks）', () => {
  assert.equal(packedRowSpan(packed()), 3);
  assert.equal(packedRowSpan(packed({ type: 'reasoning-chunks' })), 3);
  assert.equal(packedRowSpan(packed({ type: 'tool-call-chunks' }, { texts: undefined, args: ['a', 'b'], dt: [1] })), 2);
  assert.equal(packedRowSpan(packed({}, { texts: ['only'], dt: [] })), 1, '单元素载荷：dt 长度必须是 0');
  assert.equal(packedRowSpan({ type: 'turn/start', seq: 0 }), 'opaque', '非 packed 类型');
});

test('packedRowSpan：四个对抗样本一律「不可判定」（ADV-1 长度陷阱 / ADV-3 空载荷 / ADV-4 额外键 / 缺 seq0、dt 长度不符）', () => {
  // ADV-1：texts 是字符串 —— 'abcdef'.length === 6 会骗过「取 .length」的天真实现
  assert.equal(packedRowSpan(packed({ type: 'reasoning-chunks' }, { texts: 'abcdef', dt: [] })), 'opaque');
  // ADV-3：空数组（跨度 0 会让真实事件被静默跳过）
  assert.equal(packedRowSpan(packed({}, { texts: [], dt: [] })), 'opaque');
  // ADV-4：多带一个 seq 成员（官方 assertReleasedV0Keys 严格键集直接拒）
  assert.equal(packedRowSpan(packed({ seq: 2 })), 'opaque');
  // 缺 seq0 / seq0 非整数 / 缺 time0
  const withoutSeq0 = packed();
  delete withoutSeq0['seq0'];
  assert.equal(packedRowSpan(withoutSeq0), 'opaque');
  assert.equal(packedRowSpan(packed({ seq0: '17' })), 'opaque');
  assert.equal(packedRowSpan(packed({ seq0: 1.5 })), 'opaque');
  const withoutTime0 = packed();
  delete withoutTime0['time0'];
  assert.equal(packedRowSpan(withoutTime0), 'opaque');
  // 载荷里有非字符串项 / dt 长度不符
  assert.equal(packedRowSpan(packed({}, { texts: ['a', 1, 'c'], dt: [1, 1] })), 'opaque');
  assert.equal(packedRowSpan(packed({}, { texts: ['a', 'b', 'c'], dt: [1] })), 'opaque');
  // data 不是对象
  assert.equal(packedRowSpan({ type: 'text-chunks', seq0: 1, time0: 1, data: null }), 'opaque');
});

test('parseSessionRowFacts：packed 行带 packedSpan/packedSeq0，普通行不带', () => {
  const facts = factsOf([packed(), { type: 'turn/start', seq: 0 }, { type: 'text-chunks', seq0: 1, time0: 1, data: { texts: 'x', dt: [] } }]);
  assert.equal(facts[0]?.packedSpan, 3);
  assert.equal(facts[0]?.packedSeq0, 17);
  assert.equal(facts[1]?.packedSpan, undefined);
  assert.equal(facts[1]?.seq, 0);
  assert.equal(facts[2]?.packedSpan, 'opaque');
});

test('walkSessionRowContinuity：packed 行按跨度覆盖区间（标量 0..16 + packed@17 三项 + 标量 20 → 致密）', () => {
  const values: unknown[] = [];
  for (let seq = 0; seq <= 16; seq += 1) values.push({ type: 'step/start', seq, data: { turn: 1, step: seq } });
  values.push(packed({ seq0: 17 }));
  values.push({ type: 'turn/end', seq: 20 });
  assert.deepEqual(
    walkSessionRowContinuity(factsOf(values)),
    { firstAnomalyIndex: -1, firstOpaqueIndex: -1 },
    'packed 行覆盖 17..19 → 下一条标量行应为 20',
  );
});

test('walkSessionRowContinuity：packed 行 seq0 不对齐 = 真空洞（ADV-2；绝不「信任 seq0」变成漏报）', () => {
  const walk = walkSessionRowContinuity(factsOf([{ type: 'turn/start', seq: 0 }, packed({ seq0: 3 }), { type: 'turn/end', seq: 5 }]));
  assert.equal(walk.firstAnomalyIndex, 1, 'seq0=3 应为 1 → 异常');
  assert.equal(walk.firstOpaqueIndex, -1);
  const short = walkSessionRowContinuity(
    factsOf([{ type: 'turn/start', seq: 0 }, packed({ seq0: 1 }, { texts: ['a', 'b'], dt: [1] }), { type: 'turn/end', seq: 4 }]),
  );
  assert.equal(short.firstAnomalyIndex, 2, 'packed 覆盖 1..2 → 下一条应为 3');
});

test('walkSessionRowContinuity：不可判定行（畸形 packed / 无 seq 且非 packed）与不可解析行各有归属', () => {
  const opaquePacked = walkSessionRowContinuity(factsOf([{ type: 'turn/start', seq: 0 }, packed({ seq0: 1 }, { texts: 'abcdef', dt: [] })]));
  assert.equal(opaquePacked.firstOpaqueIndex, 1);
  assert.equal(opaquePacked.firstAnomalyIndex, -1);

  const noSeq = walkSessionRowContinuity(factsOf([{ type: 'turn/start', seq: 0 }, { type: 'session/title', data: { title: 'x' } }]));
  assert.equal(noSeq.firstOpaqueIndex, 1, '无 seq 且非 packed 行 = 不可判定，绝不当空气跳过');

  assert.equal(walkSessionRowContinuity([parseSessionRowFacts('{"seq":0}'), null]).firstAnomalyIndex, 1, '不可解析行按异常处理');
  assert.deepEqual(walkSessionRowContinuity([]), { firstAnomalyIndex: -1, firstOpaqueIndex: -1 });
});

test('walkSessionRowContinuity：首个 seq 必须是 0，且 seq 回退即异常', () => {
  assert.equal(walkSessionRowContinuity(factsOf([{ type: 'a', seq: 5 }])).firstAnomalyIndex, 0);
  assert.equal(walkSessionRowContinuity(factsOf([{ type: 'a', seq: 0 }, { type: 'b', seq: 2 }])).firstAnomalyIndex, 1);
  assert.equal(walkSessionRowContinuity(factsOf([{ type: 'a', seq: 0 }, { type: 'b', seq: 0 }])).firstAnomalyIndex, 1);
});

test('collectSessionRowReferences：三个引用面全部覆盖（sourceEventSeqs / messageSeqs / surfaceOp / targets）', () => {
  const row = {
    type: 'compaction/summary',
    seq: 9,
    sourceEventSeqs: [1, 4, [6, 8]],
    messageSeqs: [2],
    surfaceOp: { startSeq: 10, endSeq: 12 },
    data: { targets: [{ seq: 3 }, { seq: 15 }], nested: { messageSeqs: [20] } },
  };
  const refs = collectSessionRowReferences(JSON.stringify(row));
  assert.deepEqual(refs.seqs, [1, 2, 3, 4, 10, 12, 15, 20]);
  assert.deepEqual(refs.ranges, [{ start: 6, end: 8 }]);
  for (const seq of [1, 4, 6, 7, 8, 12, 20]) assert.equal(referencesContain(refs, seq), true, 'seq ' + String(seq));
  for (const seq of [0, 5, 9, 13, 21]) assert.equal(referencesContain(refs, seq), false, 'seq ' + String(seq));
});

test('collectSessionRowReferences：区间反向书写归一化；非引用键不误收；坏 JSON → 空引用', () => {
  assert.deepEqual(collectSessionRowReferences(JSON.stringify({ sourceEventSeqs: [[8, 6]] })).ranges, [{ start: 6, end: 8 }]);
  assert.deepEqual(collectSessionRowReferences(JSON.stringify({ sourceEventSeqs: [[5, 5]] })), { seqs: [5], ranges: [] }, '退化区间 = 单点');
  assert.deepEqual(collectSessionRowReferences(JSON.stringify({ seq: 3, other: { seq: 4 }, targets: [1, 2] })), { seqs: [], ranges: [] }, '只有 targets[].seq 的对象项才算引用');
  assert.deepEqual(collectSessionRowReferences('not json'), { seqs: [], ranges: [] });
  assert.deepEqual(collectSessionRowReferences('null'), { seqs: [], ranges: [] });
});

test('sessionRowMayHaveReferences：预筛必须是**保守**的（有引用 ⇒ 一定为 true）', () => {
  const withRefs = [
    { sourceEventSeqs: [1] },
    { messageSeqs: [1] },
    { surfaceOp: { startSeq: 1 } },
    { data: { targets: [{ seq: 1 }] } },
  ];
  for (const row of withRefs) assert.equal(sessionRowMayHaveReferences(JSON.stringify(row)), true, JSON.stringify(row));
  assert.equal(sessionRowMayHaveReferences(JSON.stringify({ type: 'turn/start', seq: 0 })), false);
});

test('findSyntheticCloserRun 与跨度模型互不干扰（回归护栏）', () => {
  const rows = [
    { type: 'step/start', seq: 0, turn: 1 },
    { type: 'step/end', seq: 1, turn: 1 },
    { type: 'turn/end', seq: 2, turn: 1 },
    { type: 'assistant/chunk', seq: 3, turn: 1 },
  ];
  assert.equal(findSyntheticCloserRun(rows)?.turn, 1);
  // 经 JSON 解析出来的 facts（turn 来自 data.turn）同样可用
  const facts = rows.map((row) => parseSessionRowFacts(JSON.stringify({ type: row.type, seq: row.seq, data: { turn: row.turn } })));
  assert.equal(findSyntheticCloserRun(facts.filter((fact) => fact !== null))?.turn, 1);
});
