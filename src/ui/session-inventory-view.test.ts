/**
 * 「会话体检」面板展示模型（T5）单测：严重级 → 徽章语义、摘要口径（**未验证必须可见**）、
 * 空态 / 截断 / 相位判定，以及「缺字段不填假值」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_REPAIR_REASON_KEYS,
  SESSION_SEVERITY_KEYS,
  formatSessionBytes,
  sessionHealthEmpty,
  sessionHealthPhase,
  sessionHealthRows,
  sessionHealthSummaryView,
  sessionHealthTruncated,
  sessionRepairCommands,
  sessionRepairEntries,
  sessionRepairReasonKey,
  sessionSeverityBadgeKind,
} from './session-inventory-view.ts';
import type { SessionHealthResponse, SessionHealthRowView } from './session-inventory-view.ts';

function row(overrides: Partial<SessionHealthRowView> = {}): SessionHealthRowView {
  return {
    unitId: '--p--/session-a',
    sessionId: 'session-a',
    projectKey: '--p--',
    severity: 'ok',
    issues: [],
    version: 3,
    cwd: 'D:\\proj',
    sizeBytes: 2048,
    mtimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function response(rows: SessionHealthRowView[], overrides: Partial<SessionHealthResponse> = {}): SessionHealthResponse {
  const by = { blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0 } as Record<string, number>;
  for (const r of rows) by[r.severity] = (by[r.severity] ?? 0) + 1;
  return {
    ok: true,
    readOnly: true,
    sessionsDir: 'D:\\home\\sessions',
    sessionsDirExists: true,
    targetFormatVersion: 3,
    summary: {
      total: rows.length,
      bySeverity: by as SessionHealthResponse['summary']['bySeverity'],
      structurallyChecked: rows.length,
      deepVerified: 0,
      deepUnverified: rows.length,
      untested: 0,
      unreadableEntries: 0,
    },
    rows,
    truncated: 0,
    nextSteps: { commands: [], notes: [] },
    ...overrides,
  };
}

test('T5：严重级 → 徽章语义（阻断启动/不可加载 = error；下次请求失败/不可见 = warn；ok = ok）', () => {
  assert.equal(sessionSeverityBadgeKind('blocksStartup'), 'error');
  assert.equal(sessionSeverityBadgeKind('unloadable'), 'error');
  assert.equal(sessionSeverityBadgeKind('nextRequestFails'), 'warn');
  assert.equal(sessionSeverityBadgeKind('invisible'), 'warn');
  assert.equal(sessionSeverityBadgeKind('ok'), 'ok');
  // 每个严重级都有文案键（缺一个就会渲染出裸枚举 —— DESIGN.md 禁止）
  for (const key of Object.values(SESSION_SEVERITY_KEYS)) assert.match(key, /^sessions\.severity\./);
});

test('T5：行 → 展示行（版本/归属/子代理/体积/时间），缺字段一律不填假值', () => {
  // T11 起列表只显示有问题的行 —— 本用例只验字段映射，故给一个需要处理的严重级
  const [full] = sessionHealthRows(response([row({ origin: 'subagent', severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }] })]));
  assert.equal(full?.versionText, 'v3');
  assert.equal(full?.projectKeyText, '--p--');
  assert.equal(full?.subagent, true);
  assert.equal(full?.sizeText, '2.0 KiB');
  assert.equal(full?.mtimeMs, 1_700_000_000_000);
  assert.deepEqual(full?.issueCodes, ['format-newer']);

  const [bare] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], version: undefined, sizeBytes: undefined, mtimeMs: undefined, projectKey: '' })]));
  assert.equal(bare?.versionText, null);
  assert.equal(bare?.sizeText, null);
  assert.equal(bare?.mtimeMs, null);
  assert.equal(bare?.projectKeyText, null, '空 projectKey 不得渲染成空字符串列');

  assert.deepEqual(sessionHealthRows(null), [], 'null 响应 → 空列表（不是 0 行假数据）');
});

test('T5：摘要口径 —— needsAttention 只数非 ok，且「未验证」必须一直可见', () => {
  const view = sessionHealthSummaryView(response([
    row({ severity: 'unloadable' }),
    row({ severity: 'invisible', unitId: '--p--/b', sessionId: 'b' }),
    row({ severity: 'ok', unitId: '--p--/c', sessionId: 'c' }),
  ]));
  assert.equal(view?.total, 3);
  assert.equal(view?.needsAttention, 2);
  assert.equal(view?.allHealthy, false);
  assert.equal(view?.deepUnverified, 3, '未做深度校验的条数必须如实呈现');
  assert.equal(view?.repairable, 0, '没有问题码 → 0 条可修复');
  assert.equal(sessionHealthSummaryView(null), null);

  // T8：可修复条数只数「重放重复行」（界面据此给「修复」入口）
  // T9：可修复条数覆盖四类可修码（零损失两类 + 有损截断两类），不可修的码不计入
  const withRepairable = sessionHealthSummaryView(response([
    row({ severity: 'nextRequestFails', issues: [{ code: 'replay-duplicate-rows', severity: 'nextRequestFails' }] }),
    row({ severity: 'unloadable', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'seq-gap', severity: 'unloadable' }] }),
    row({ severity: 'invisible', unitId: '--p--/c', sessionId: 'c', issues: [{ code: 'format-newer', severity: 'invisible' }] }),
  ]));
  assert.equal(withRepairable?.repairable, 2, '重放重复行 + seq 空洞可修；格式超前不可修');
  assert.equal(withRepairable?.needsAttention, 3);
});

test('T5：全绿但**未做深检**时 allHealthy 仍为 true，deepUnverified 保留（界面据此措辞）', () => {
  const view = sessionHealthSummaryView(response([row(), row({ unitId: '--p--/b', sessionId: 'b' })]));
  assert.equal(view?.allHealthy, true);
  assert.equal(view?.needsAttention, 0);
  assert.equal(view?.deepUnverified, 2);
});

test('T5：空态 / 截断 / 相位判定', () => {
  assert.equal(sessionHealthEmpty(response([])), true);
  assert.equal(sessionHealthEmpty(response([row()])), false);
  assert.equal(sessionHealthEmpty(null), false);

  assert.equal(sessionHealthTruncated(response([row()], { truncated: 7 })), 7);
  assert.equal(sessionHealthTruncated(null), 0);

  assert.equal(sessionHealthPhase({ loading: false, error: null, response: null }), 'idle');
  assert.equal(sessionHealthPhase({ loading: true, error: null, response: null }), 'loading');
  assert.equal(sessionHealthPhase({ loading: false, error: null, response: response([]) }), 'ready');
  assert.equal(sessionHealthPhase({ loading: true, error: 'boom', response: null }), 'error', '错误优先于加载态');
});

test('T5：体积格式化（B/KiB/MiB/GiB）与非法值', () => {
  assert.equal(formatSessionBytes(0), '0 B');
  assert.equal(formatSessionBytes(2048), '2.0 KiB');
  assert.equal(formatSessionBytes(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatSessionBytes(3 * 1024 * 1024 * 1024), '3.00 GiB');
  assert.equal(formatSessionBytes(-1), '', '非法值不显示（不填 0）');
  assert.equal(formatSessionBytes(Number.NaN), '');
});

test('T5：离线出路恒为三条（应用内修复只覆盖重放重复行，其余仍只有离线一条路）', () => {
  const commands = sessionRepairCommands();
  assert.deepEqual(commands.map((c) => c.command), [
    'dsh-config-manager sessions doctor --json',
    'dsh-config-manager sessions repair',
    'dsh-config-manager sessions repair --fix',
  ]);
  for (const c of commands) assert.match(c.command, /^dsh-config-manager sessions /, '不得给出猜出来的其它工具/命令');
});

test('T9：行 → repairable 覆盖应用内可修的四类（零损失两类 + 有损截断两类）', () => {
  for (const code of ['replay-duplicate-rows', 'synthetic-closer', 'seq-gap', 'unparsable-event']) {
    const [hit] = sessionHealthRows(response([row({ severity: 'nextRequestFails', issues: [{ code, severity: 'nextRequestFails' }] })]));
    assert.equal(hit?.repairable, true, '应当可修: ' + code);
  }
  // 应用内不动的类别：撕裂尾帧（DSH 自愈）、格式超前、缺工作区/缺父对话、header 不可读
  for (const code of ['torn-tail', 'format-newer', 'unregistered-workspace', 'subagent-without-parent', 'header-unreadable']) {
    const [miss] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code, severity: 'invisible' }] })]));
    assert.equal(miss?.repairable, false, '不得出现「应用内修复」入口: ' + code);
  }
  // T11：**正常会话默认不进列表**（「只显示有问题的对话」）——全绿时列表为空
  assert.deepEqual(sessionHealthRows(response([row()])), [], '正常会话默认隐藏');
  // 但可修的行即使当前判为 ok 也必须留在列表里（判据分叉时宁可显示也不藏）
  const [keptOk] = sessionHealthRows(response([row({ issues: [{ code: 'replay-duplicate-rows', severity: 'ok' }] })]));
  assert.equal(keptOk?.repairable, true, '可修行不得被过滤掉');
});

test('T11：列表只含有问题的会话（+ 可修行），并如实给出被隐藏的正常会话数', () => {
  const mixed = response([
    row({ severity: 'ok' }),
    row({ severity: 'nextRequestFails', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'synthetic-closer', severity: 'nextRequestFails' }] }),
    row({ severity: 'ok', unitId: '--p--/c', sessionId: 'c' }),
  ]);
  assert.deepEqual(sessionHealthRows(mixed).map((r) => r.sessionId), ['b'], '只有 b 需要处理');
  assert.equal(sessionHealthSummaryView(mixed)?.hiddenHealthy, 2, '被隐藏的正常会话数必须如实给出');
});

test('T8：修复原因 → 文案键（已知逐个映射；未知/缺省一律回退 unknown）', () => {
  for (const reason of ['unknown-unit', 'not-found', 'locked', 'busy', 'changed', 'repair-not-found', 'already-rolled-back', 'unavailable', 'unreadable', 'corrupt-container', 'torn-tail', 'invalid-header', 'nothing-to-fix', 'verification-refused', 'write-failed', 'postcheck-failed', 'backup-invalid']) {
    assert.match(sessionRepairReasonKey(reason), /^sessions\.repair\.reason\./, '缺映射会渲染出裸枚举: ' + reason);
  }
  assert.equal(sessionRepairReasonKey('locked'), 'sessions.repair.reason.locked');
  assert.equal(sessionRepairReasonKey('no-such-reason'), 'sessions.repair.reason.unknown');
  assert.equal(sessionRepairReasonKey(undefined), 'sessions.repair.reason.unknown');
  for (const key of Object.values(SESSION_REPAIR_REASON_KEYS)) assert.match(key, /^sessions\.repair\.reason\./);
});

test('T8：台账 → 展示行（跳过坏记录、最近在前、回滚态可见）', () => {
  const entries = sessionRepairEntries(response([], {
    repairs: [
      { repairId: 'a', unitId: '--p--/a', sessionId: 'a', at: 100, droppedRows: 2 },
      { repairId: '', unitId: '--p--/bad', sessionId: 'bad', at: 999 },
      { repairId: 'b', unitId: '--p--/b', sessionId: 'b', at: 300, droppedRows: 1, rolledBackAt: 400 },
    ],
  }));
  assert.deepEqual(entries.map((e) => e.repairId), ['b', 'a'], '最近在前，坏记录被跳过');
  assert.equal(entries[0]?.rolledBack, true);
  assert.equal(entries[1]?.rolledBack, false);
  assert.equal(entries[1]?.droppedRows, 2);
  assert.equal(entries[1]?.backupName, null, '缺字段不填假值');
  assert.deepEqual(sessionRepairEntries(null), []);
  assert.deepEqual(sessionRepairEntries(response([])), [], '没有 repairs 字段 → 空列表（不是假数据）');
});
