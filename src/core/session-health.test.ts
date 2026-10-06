/**
 * 会话体检分类器（T3）单测：**每类问题一条** + 严重级排序 + 「读不到一律 unknown」。
 *
 * 这里只测纯分类逻辑：输入是「宿主已经读出来的事实」（结构/行档结论），字节读取在
 * utils/session-health-scan.test.ts 里用真实临时 home 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_HEALTH_SEVERITIES,
  analyzeSessionHealth,
  classifySessionHealth,
  sessionHealthIssues,
  sessionHealthSeverityOf,
  sessionHealthNeedsAttention,
} from './session-health.ts';
import type { SessionHealthContext, SessionHealthInput } from './session-health.ts';
import { projectKeyOf } from './session-meta.ts';

const CWD = 'C:\\Users\\alice\\proj';
const KEY = projectKeyOf(CWD);
const UNIT = KEY + '/session-a';

function input(overrides: Partial<SessionHealthInput> = {}): SessionHealthInput {
  return {
    unitId: UNIT,
    sessionId: 'session-a',
    projectKey: KEY,
    headerCwd: CWD,
    headerVersion: 3,
    logFiles: 1,
    structural: { ok: true, frames: 4 },
    ...overrides,
  };
}

function ctx(overrides: Partial<SessionHealthContext> = {}): SessionHealthContext {
  return {
    targetFormatVersion: 3,
    workspaceKeys: new Set([KEY]),
    knownSessionIds: new Set(['session-a']),
    ...overrides,
  };
}

function codes(row: ReturnType<typeof classifySessionHealth>): string[] {
  return row.issues.map((i) => i.code);
}

test('T3：健康会话 → 无问题、severity=ok', () => {
  const row = classifySessionHealth(input(), ctx());
  assert.deepEqual(row.issues, []);
  assert.equal(row.severity, 'ok');
  assert.equal(sessionHealthNeedsAttention(row), false);
  assert.equal(row.version, 3);
  assert.equal(row.cwd, CWD);
});

test('T3 分类：位置与 header.cwd 推导的 projectKey 不一致 → blocksStartup（DSH 直接拒启动）', () => {
  const row = classifySessionHealth(input({ projectKey: '--Wrong--' }), ctx());
  assert.deepEqual(codes(row), ['location-mismatch']);
  assert.equal(row.severity, 'blocksStartup');
});

test('T3 分类：同一 id 出现在多个 projectKey 目录 → blocksStartup（duplicate JSONL session id）', () => {
  // 归一化键：`session-a` → `a`（sessionIdKey 去掉 session- 前缀）
  const row = classifySessionHealth(input(), ctx({ duplicateSessionIds: new Set(['a']) }));
  assert.deepEqual(codes(row), ['duplicate-id']);
  assert.equal(row.severity, 'blocksStartup');
  // 归一化后才比较：session-<uuid> 与裸 <uuid> 是同一个会话（ctx 里的键是**归一化键**，
  // 与 core/session-select.ts 的 sessionIdKey 同口径 —— 宿主侧收集时就要归一化）
  const prefixed = classifySessionHealth(
    input({ sessionId: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    ctx({ duplicateSessionIds: new Set(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) }),
  );
  assert.equal(prefixed.severity, 'blocksStartup');
});

test('T3 分类：首帧 header 读不出 / 非法帧 → unloadable', () => {
  const noHeader = classifySessionHealth(input({ structural: { ok: false, headerUnreadable: true } }), ctx());
  assert.deepEqual(codes(noHeader), ['header-unreadable']);
  assert.equal(noHeader.severity, 'unloadable');

  const corrupt = classifySessionHealth(input({ structural: { ok: false, corruptReason: 'reserved block type at byte 42' } }), ctx());
  assert.deepEqual(codes(corrupt), ['corrupt-frame']);
  assert.equal(corrupt.severity, 'unloadable');
});

test('T3 分类：撕裂尾帧 → 只提示（DSH 自愈），不升级严重级', () => {
  const row = classifySessionHealth(input({ structural: { ok: true, frames: 3, tornTail: true } }), ctx());
  assert.deepEqual(codes(row), ['torn-tail']);
  assert.equal(row.severity, 'ok', '设计稿 §10.2：DSH 对撕裂尾帧自愈，无需修复');
  assert.equal(row.issues[0]?.detail, 'self-healing');
});

test('T3 分类：深度校验的问题按 §10.2 映射严重级（重放族 = 下次请求会失败）', () => {
  const row = classifySessionHealth(
    input({
      deep: {
        verified: true,
        issues: [
          { code: 'replay-duplicate-rows', detail: '3' },
          { code: 'synthetic-closer' },
        ],
      },
    }),
    ctx(),
  );
  assert.deepEqual(codes(row).sort(), ['replay-duplicate-rows', 'synthetic-closer']);
  assert.equal(row.severity, 'nextRequestFails');

  const seqGap = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'seq-gap', detail: '2' }] } }), ctx());
  assert.equal(seqGap.severity, 'unloadable');

  const unparsable = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'unparsable-event', detail: '1' }] } }), ctx());
  assert.equal(unparsable.severity, 'unloadable');

  const missingId = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'missing-message-id' }] } }), ctx());
  assert.equal(missingId.severity, 'unloadable', 'loader 会拒整份日志');

  const dangling = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'dangling-tool-call' }] } }), ctx());
  assert.equal(dangling.severity, 'nextRequestFails', '能加载，但下一个模型请求 400');

  const settlement = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'invalid-settlement' }] } }), ctx());
  assert.equal(settlement.severity, 'nextRequestFails');

  const closedTurn = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'closed-turn-continued' }] } }), ctx());
  assert.equal(closedTurn.severity, 'nextRequestFails');
});

test('T3：深度校验**没跑**（verified=false）→ 一条结论都不下（绝不把「没检查」当「没问题」）', () => {
  const row = classifySessionHealth(
    input({ deep: { verified: false, unverifiedReason: 'row-scan-not-run' } }),
    ctx(),
  );
  assert.deepEqual(row.issues, [], '未验证不得产出任何行档结论（一条都不许猜）');
  // 同一个会话若真的跑过行档，重复行是会被报出来的（对照：证明上面那条不是因为规则不存在）
  const verified = classifySessionHealth(
    input({ deep: { verified: true, issues: [{ code: 'replay-duplicate-rows', detail: '2' }] } }),
    ctx(),
  );
  assert.deepEqual(codes(verified), ['replay-duplicate-rows']);
});

test('T3 分类：格式版本超前 / 未登记工作区 / 子代理缺父 → invisible（DSH 不报错，但看不见）', () => {
  const newer = classifySessionHealth(input({ headerVersion: 4 }), ctx());
  assert.deepEqual(codes(newer).sort(), ['format-newer']);
  assert.equal(newer.severity, 'invisible');
  assert.equal(newer.issues[0]?.detail, 'v4 > v3');

  const orphanWorkspace = classifySessionHealth(input(), ctx({ workspaceKeys: new Set(['--other--']) }));
  assert.deepEqual(codes(orphanWorkspace), ['unregistered-workspace']);
  assert.equal(orphanWorkspace.severity, 'invisible');

  const noParent = classifySessionHealth(
    input({ origin: 'subagent', parentSessionId: 'session-parent' }),
    ctx({ knownSessionIds: new Set(['session-a']) }),
  );
  assert.deepEqual(codes(noParent), ['subagent-without-parent']);
  assert.equal(noParent.severity, 'invisible');
});

test('T3：本机版本读不到 → 不做「超前」判定（宁可不报，也不谎报）', () => {
  const row = classifySessionHealth(input({ headerVersion: 99 }), ctx({ targetFormatVersion: undefined }));
  assert.equal(codes(row).includes('format-newer'), false);
  // 本机一条工作区记录都没有时同理：不把「没有工作区数据」误判成「未被登记」
  const noWorkspaces = classifySessionHealth(input(), ctx({ workspaceKeys: new Set() }));
  assert.equal(codes(noWorkspaces).includes('unregistered-workspace'), false);
});

test('T3：首帧可读但没有 cwd → 归属无法判定（只报告，不猜）', () => {
  const row = classifySessionHealth(input({ headerCwd: undefined }), ctx());
  assert.deepEqual(codes(row), ['unregistered-workspace']);
  assert.equal(row.issues[0]?.detail, 'no-cwd');
  assert.equal(row.severity, 'invisible');
});

test('T3：严重级排序（blocksStartup > unloadable > nextRequestFails > invisible > ok）与多问题取最重', () => {
  assert.deepEqual(SESSION_HEALTH_SEVERITIES, ['blocksStartup', 'unloadable', 'nextRequestFails', 'invisible', 'ok']);
  assert.equal(sessionHealthSeverityOf([]), 'ok');
  assert.equal(
    sessionHealthSeverityOf([
      { code: 'format-newer', severity: 'invisible' },
      { code: 'header-unreadable', severity: 'unloadable' },
      { code: 'torn-tail', severity: 'ok' },
    ]),
    'unloadable',
    '多问题取最重的一档',
  );
  // 多问题 → 行取最重，且问题列表按严重级排序
  const row = classifySessionHealth(input({ headerVersion: 4, deep: { verified: true, issues: [{ code: 'seq-gap' }] } }), ctx());
  assert.equal(row.severity, 'unloadable');
  assert.deepEqual(row.issues.map((i) => i.severity), ['unloadable', 'invisible']);
});

test('T3：analyzeSessionHealth 汇总按严重级计数 + 区分「做过深度校验」与「未验证」', () => {
  const { rows, summary } = analyzeSessionHealth(
    [
      input(),
      input({ unitId: KEY + '/session-b', sessionId: 'session-b', headerVersion: 4 }),
      input({ unitId: KEY + '/session-c', sessionId: 'session-c', structural: { ok: false, headerUnreadable: true } }),
      input({ unitId: KEY + '/session-d', sessionId: 'session-d', deep: { verified: true, issues: [{ code: 'seq-gap' }] } }),
      input({ unitId: KEY + '/session-e', sessionId: 'session-e' }),
    ],
    ctx(),
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(summary.bySeverity, { blocksStartup: 0, unloadable: 2, nextRequestFails: 0, invisible: 1, ok: 2 });
  assert.equal(summary.total, 5);
  assert.equal(summary.deepVerified, 1, '只有真跑过行档的那条算「已深度校验」');
  assert.equal(summary.deepUnverified, 4, '未验证必须计入（界面要能说清「另有 N 条未检查」）');
  assert.equal(summary.structurallyChecked, 5);
  // 行顺序：最重在前
  assert.equal(rows[0]?.severity, 'unloadable');
  assert.equal(rows[rows.length - 1]?.severity, 'ok');
});

test('T3：sessionHealthIssues 纯函数不修改输入（宿主可安全复用输入对象）', () => {
  const base = input();
  const snapshot = JSON.stringify(base);
  sessionHealthIssues(base, ctx());
  assert.equal(JSON.stringify(base), snapshot);
});

/* ---------------- T4：行档问题的严重级可被行档采集器覆盖（实测口径），并按 code 去重取更重 ---------------- */

test('T4 分类：行档问题自带 severity 时优先使用（同 code 不同代际后果不同），缺省才回落静态表', () => {
  // 静态表里 dangling-tool-call 是 nextRequestFails（「未证明 step 已闭合」的历史默认）
  const fallback = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'dangling-tool-call' }] } }), ctx());
  assert.equal(fallback.severity, 'nextRequestFails', '缺省回落静态表');
  // 行档采集器证明「step 已关闭」后自带 unloadable（真 codec 实测拒读）
  const closed = classifySessionHealth(
    input({ deep: { verified: true, issues: [{ code: 'dangling-tool-call', severity: 'unloadable', detail: '1 unresolved' }] } }),
    ctx(),
  );
  assert.equal(closed.severity, 'unloadable', '自带 severity 必须压过静态表');
  assert.equal(closed.issues[0]?.severity, 'unloadable');
  // 反向：采集器实测较轻（v4 缺 user/assistant message.id 只是下一次请求会失败）
  const unproven = classifySessionHealth(
    input({ deep: { verified: true, issues: [{ code: 'missing-message-id', severity: 'nextRequestFails', detail: '1 row(s); codec-unproven' }] } }),
    ctx(),
  );
  assert.equal(unproven.severity, 'nextRequestFails', '不得一律升级成 unloadable');
});

test('T4 分类：新增三个问题码都有严重级（tool-result-id-mismatch / empty-tool-call-id / duplicate-tool-call-id）', () => {
  assert.equal(sessionHealthSeverityOf([{ code: 'tool-result-id-mismatch', severity: 'unloadable' }]), 'unloadable');
  const mismatch = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'tool-result-id-mismatch' }] } }), ctx());
  assert.equal(mismatch.severity, 'unloadable', 'toolCallId 不配对 = 真 codec 直接拒读');
  const emptyId = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'empty-tool-call-id' }] } }), ctx());
  assert.equal(emptyId.issues[0]?.severity, 'unloadable', '静态回落也是 unloadable（v4 下采集器会自带 nextRequestFails）');
  const dup = classifySessionHealth(input({ deep: { verified: true, issues: [{ code: 'duplicate-tool-call-id' }] } }), ctx());
  assert.equal(dup.issues[0]?.severity, 'unloadable');
});

test('T4 分类：同一个 code 重复出现只留一条，且取更重的严重级', () => {
  const heavierLast = classifySessionHealth(
    input({
      deep: {
        verified: true,
        issues: [
          { code: 'replay-duplicate-rows', severity: 'nextRequestFails', detail: 'light' },
          { code: 'replay-duplicate-rows', severity: 'unloadable', detail: 'heavy' },
        ],
      },
    }),
    ctx(),
  );
  assert.deepEqual(codes(heavierLast), ['replay-duplicate-rows'], '重复 code 必须去重');
  assert.equal(heavierLast.issues[0]?.severity, 'unloadable');
  assert.equal(heavierLast.issues[0]?.detail, 'heavy');

  const heavierFirst = classifySessionHealth(
    input({
      deep: {
        verified: true,
        issues: [
          { code: 'replay-duplicate-rows', severity: 'unloadable', detail: 'heavy' },
          { code: 'replay-duplicate-rows', severity: 'nextRequestFails', detail: 'light' },
        ],
      },
    }),
    ctx(),
  );
  assert.deepEqual(codes(heavierFirst), ['replay-duplicate-rows']);
  assert.equal(heavierFirst.issues[0]?.severity, 'unloadable', '后来的较轻记录不得把结论说轻');
  assert.equal(heavierFirst.issues[0]?.detail, 'heavy');
});

