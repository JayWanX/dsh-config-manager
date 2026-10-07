/**
 * E2 面板「布局归位 / 重复 id 隔离」展示模型单测。
 *
 * 钉住的语义（都是诚实性边界，不是实现细节）：
 *  ① 只挑 **blocksStartup** 且命中 `location-mismatch` / `duplicate-id` 的行 —— 这一档才是本入口的理由；
 *  ② 重复 id **必须**选定保留哪一份，未选 / 选到非候选一律不可提交（宿主也会拒 `missing-keep` /
 *     `keep-not-a-candidate`）；
 *  ③ 逐条状态里「只报告」「失败」「已回滚」「回滚也失败」**都不得**呈现成成功；
 *  ④ 任何机器码都必须映射到字典键（未知回落 unknown，**绝不**把裸码渲染出去）；
 *  ⑤ 所有键在 recovery 字典 zh / en 里逐字存在（键名漂移即红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_LAYOUT_KIND_KEYS,
  SESSION_LAYOUT_ISSUE_CODES,
  SESSION_LAYOUT_REASON_KEYS,
  SESSION_LAYOUT_STATUS_KEYS,
  sessionLayoutApplyItems,
  sessionLayoutCandidates,
  sessionLayoutItemStatus,
  sessionLayoutKeepCandidates,
  sessionLayoutKeepState,
  sessionLayoutOverallReasonKey,
  sessionLayoutPlanActionableRows,
  sessionLayoutPlanDisplayRows,
  sessionLayoutPlanRows,
  sessionLayoutPlanSkippedCount,
  sessionLayoutPlanSubmittable,
  sessionLayoutReasonKey,
  sessionLayoutResultCounts,
  sessionLayoutStatusBadgeKind,
} from './session-layout-view.ts';
import type {
  SessionLayoutApplyItemView,
  SessionLayoutApplyView,
  SessionLayoutPlanItemView,
  SessionLayoutPlanView,
} from './session-layout-view.ts';
import type { SessionHealthResponse, SessionHealthRowView } from './session-inventory-view.ts';
import { en as recoveryEn, zh as recoveryZh } from '../client/recovery/recovery-locales.ts';

/* ------------------------------------------------------------------ 夹具 */

function row(overrides: Partial<SessionHealthRowView> = {}): SessionHealthRowView {
  return {
    unitId: '--P-A--/session-a',
    sessionId: 'session-a',
    projectKey: '--P-A--',
    severity: 'ok',
    issues: [],
    ...overrides,
  };
}

function response(rows: SessionHealthRowView[]): SessionHealthResponse {
  const by = { blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0 } as Record<string, number>;
  for (const r of rows) by[r.severity] = (by[r.severity] ?? 0) + 1;
  return {
    ok: true,
    readOnly: true,
    sessionsDir: 'D:/home/sessions',
    sessionsDirExists: true,
    targetFormatVersion: 4,
    summary: {
      total: rows.length,
      bySeverity: by as SessionHealthResponse['summary']['bySeverity'],
      structurallyChecked: rows.length,
      deepVerified: rows.length,
      deepUnverified: 0,
      untested: 0,
      unreadableEntries: 0,
    },
    rows,
    truncated: 0,
    nextSteps: { commands: [], notes: [] },
  };
}

function planItem(overrides: Partial<SessionLayoutPlanItemView> = {}): SessionLayoutPlanItemView {
  return {
    unitId: '--P-A--/session-a',
    sessionId: 'session-a',
    kind: 'move',
    fromProjectKey: '--P-A--',
    toProjectKey: '--P-B--',
    reason: 'needs-move',
    applies: true,
    ...overrides,
  };
}

function plan(overrides: Partial<SessionLayoutPlanView> = {}): SessionLayoutPlanView {
  return {
    ok: true,
    readOnly: true,
    summary: { scanned: 1, ok: 0, move: 1, rewriteMove: 0, skip: 0, keep: 0, quarantine: 0, duplicates: 0 },
    actions: [planItem()],
    needsAttention: true,
    needsKeep: [],
    ...overrides,
  };
}

function applyItem(overrides: Partial<SessionLayoutApplyItemView> = {}): SessionLayoutApplyItemView {
  return { unitId: '--P-A--/session-a', sessionId: 'session-a', action: 'move', ok: true, movedUnitId: '--P-B--/session-a', ...overrides };
}

function applyResult(items: SessionLayoutApplyItemView[], overrides: Partial<SessionLayoutApplyView> = {}): SessionLayoutApplyView {
  return { ok: items.every((i) => i.ok), applied: items.filter((i) => i.ok).length, failed: items.filter((i) => !i.ok).length, skipped: 0, results: items, ...overrides };
}

/* ------------------------------------------------------------------ ① 候选行 */

test('E2：候选行只取 blocksStartup 且命中两类码的行（其余严重级不进本入口）', () => {
  const view = sessionLayoutCandidates(response([
    row({ unitId: '--A--/loc', sessionId: 'loc', severity: 'blocksStartup', issues: [{ code: 'location-mismatch', severity: 'blocksStartup' }] }),
    row({ unitId: '--A--/dup', sessionId: 'dup', severity: 'blocksStartup', issues: [{ code: 'duplicate-id', severity: 'blocksStartup' }, { code: 'location-mismatch', severity: 'blocksStartup' }] }),
    row({ unitId: '--A--/gap', sessionId: 'gap', severity: 'nextRequestFails', issues: [{ code: 'seq-gap', severity: 'nextRequestFails' }] }),
    row({ unitId: '--A--/ok', sessionId: 'ok', severity: 'ok', issues: [] }),
  ]));
  assert.deepEqual(view.map((c) => c.sessionId), ['loc', 'dup'], '只有 blocksStartup 且命中两类码的行');
  assert.deepEqual(view[0]?.issueCodes, ['location-mismatch']);
  assert.deepEqual(view[1]?.issueCodes, ['location-mismatch', 'duplicate-id'], '顺序按 SESSION_LAYOUT_ISSUE_CODES');
  assert.equal(view[0]?.mayNeedKeep, false);
  assert.equal(view[1]?.mayNeedKeep, true, 'duplicate-id 需要用户选保留哪一份');
  assert.equal(view[0]?.projectKey, '--P-A--');
  assert.deepEqual(sessionLayoutCandidates(null), [], '没有响应 = 没有候选（不臆造）');
  assert.deepEqual(sessionLayoutCandidates(response([row({ severity: 'blocksStartup', issues: [{ code: 'corrupt-frame', severity: 'blocksStartup' }] })])), [], '同类严重级但不是这两类码 → 不进本入口');
  assert.deepEqual([...SESSION_LAYOUT_ISSUE_CODES], ['location-mismatch', 'duplicate-id']);
});

/* ------------------------------------------------------------------ ② keep 完整性 */

test('E2：重复 id 必须选定保留哪一份（未选 / 选到非候选一律不可提交）', () => {
  const p = plan({ needsKeep: ['session-a'], actions: [planItem({ unitId: '--P-A--/session-a', kind: 'keep', applies: false, reason: 'duplicate-id' })] });
  assert.equal(sessionLayoutKeepState(null, {}).complete, false, '还没预览 = 不可提交');
  const none = sessionLayoutKeepState(p, {});
  assert.deepEqual(none.missing, ['session-a']);
  assert.equal(none.complete, false);
  assert.deepEqual(none.candidates['session-a'], ['--P-A--/session-a']);
  const wrong = sessionLayoutKeepState(p, { 'session-a': '--P-Z--/session-a' });
  assert.deepEqual(wrong.missing, ['session-a'], '选了一个不在候选里的副本 = 仍不可提交');
  assert.equal(wrong.complete, false);
  const okState = sessionLayoutKeepState(p, { 'session-a': '--P-A--/session-a' });
  assert.deepEqual(okState.missing, []);
  assert.equal(okState.complete, true);
  assert.deepEqual(sessionLayoutKeepState(plan({ needsKeep: [] }), {}).complete, true, '没有重复 id 时无需选择即可提交');
});

test('E2：能否提交 —— 计划 + 计划可用 + keep 完整，三者缺一不可', () => {
  const needsKeep = plan({ needsKeep: ['session-a'], actions: [planItem({ unitId: '--P-A--/session-a', kind: 'keep', applies: false, reason: 'duplicate-id' })] });
  assert.equal(sessionLayoutPlanSubmittable(null, sessionLayoutKeepState(null, {})), false, '还没预览 = 不可提交');
  assert.equal(sessionLayoutPlanSubmittable(needsKeep, sessionLayoutKeepState(needsKeep, {})), false, 'keep 未选 = 不可提交');
  assert.equal(sessionLayoutPlanSubmittable(needsKeep, sessionLayoutKeepState(needsKeep, { 'session-a': '--P-A--/session-a' })), true);
  const broken = plan({ ok: false, reason: 'sessions-root-unreadable', actions: [], needsKeep: [] });
  assert.equal(sessionLayoutPlanSubmittable(broken, sessionLayoutKeepState(broken, {})), false, '会话根读不出来 = 不可提交');
});

test('E2：计划展示行只剔除 ok（保留被 keep 挡住的隔离条与「只报告」条）', () => {
  const p = plan({
    actions: [
      planItem({ unitId: '--P-A--/loc', sessionId: 'loc', kind: 'move' }),
      planItem({ unitId: '--P-A--/ok', sessionId: 'ok', kind: 'ok', reason: 'already-placed', applies: false }),
      planItem({ unitId: '--P-A--/dup', sessionId: 'dup', kind: 'quarantine', applies: false, reason: 'duplicate-id' }),
      planItem({ unitId: '--P-A--/locked', sessionId: 'locked', kind: 'skip', reason: 'locked', applies: false }),
    ],
  });
  assert.deepEqual(sessionLayoutPlanDisplayRows(p).map((r) => r.sessionId), ['loc', 'dup', 'locked'], 'ok 行是噪音，其余如实显示');
  assert.deepEqual(sessionLayoutPlanDisplayRows(null), []);
});

test('E2：某重复 id 的可选副本 = 计划里同 id 的 keep/quarantine 条（顺序稳定、去重）', () => {
  const p = plan({
    needsKeep: ['session-a'],
    actions: [
      planItem({ unitId: '--P-A--/session-a', kind: 'keep', applies: false, reason: 'duplicate-id' }),
      planItem({ unitId: '--P-B--/session-a', kind: 'quarantine', applies: false, reason: 'duplicate-id' }),
      planItem({ unitId: '--P-A--/session-a', kind: 'keep', applies: false, reason: 'duplicate-id' }),
      planItem({ unitId: '--P-A--/other', sessionId: 'other', kind: 'move' }),
    ],
  });
  assert.deepEqual(sessionLayoutKeepCandidates(p, 'session-a'), ['--P-A--/session-a', '--P-B--/session-a']);
  assert.deepEqual(sessionLayoutKeepCandidates(p, 'other'), [], 'move 条不是副本候选');
  assert.deepEqual(sessionLayoutKeepCandidates(null, 'session-a'), []);
});

/* ------------------------------------------------------------------ 计划展示行 */

test('E2：计划行 → 键映射 + 只列出将要执行的条（未选定 keep 的条要显式标出）', () => {
  const p = plan({
    actions: [
      planItem({ unitId: '--P-A--/loc', sessionId: 'loc', kind: 'move', toProjectKey: '--P-B--', reason: 'needs-move', applies: true }),
      planItem({ unitId: '--P-A--/dup', sessionId: 'dup', kind: 'quarantine', toProjectKey: undefined, reason: 'duplicate-id', applies: false }),
      planItem({ unitId: '--P-A--/ok', sessionId: 'ok', kind: 'ok', reason: 'already-placed', applies: false }),
      planItem({ unitId: '--P-A--/nocwd', sessionId: 'nocwd', kind: 'skip', reason: 'no-cwd', applies: false }),
      planItem({ unitId: '--P-A--/locked', sessionId: 'locked', kind: 'skip', reason: 'locked', applies: false }),
    ],
  });
  const rows = sessionLayoutPlanRows(p);
  assert.equal(rows.length, 5);
  assert.equal(rows[0]?.kindKey, 'sessions.layout.kind.move');
  assert.equal(rows[0]?.reasonKey, 'sessions.layout.reason.needsMove');
  assert.equal(rows[0]?.toProjectKey, '--P-B--');
  assert.equal(rows[1]?.blockedByKeepSelection, true, 'kind=quarantine 且 applies=false = 被 keep 选择挡住');
  assert.equal(sessionLayoutPlanSkippedCount(p), 2, 'skip 条数必须如实给出');
  assert.deepEqual(sessionLayoutPlanActionableRows(p).map((r) => r.sessionId), ['loc'], '只有真的会落盘的条');
  assert.deepEqual(sessionLayoutPlanRows(null), []);
});

/* ------------------------------------------------------------------ ③ 逐条状态 */

test('E2：逐条状态 —— 归位 / 隔离 / 保留 / 只报告 / 失败 / 已回滚 / 回滚也失败（无一被算成成功）', () => {
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'move', ok: true })), 'moved');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'rewrite-move', ok: true })), 'moved');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'quarantine', ok: true, quarantineDir: '.cm-repair-quarantine-x/--P-B--/session-a' })), 'quarantined');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'keep', ok: true, movedUnitId: undefined })), 'kept');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'skip', ok: false, reason: 'no-cwd' })), 'skipped');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'move', ok: false, reason: 'locked' })), 'failed');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'move', ok: false, reason: 'move-failed', rolledBack: true })), 'rolledBack');
  assert.equal(sessionLayoutItemStatus(applyItem({ action: 'move', ok: false, reason: 'reindex-failed', rolledBack: false })), 'rollbackFailed', '回滚也没成功 = 危险态');
  // 成功但类别未知：绝不当成「已归位」
  assert.notEqual(sessionLayoutItemStatus(applyItem({ action: 'skip', ok: true })), 'moved');
});

test('E2：逐条状态 → 徽章语义（只报不修 / 回滚绝不给 ok）', () => {
  assert.equal(sessionLayoutStatusBadgeKind('moved'), 'ok');
  assert.equal(sessionLayoutStatusBadgeKind('quarantined'), 'ok');
  assert.equal(sessionLayoutStatusBadgeKind('kept'), 'info');
  assert.equal(sessionLayoutStatusBadgeKind('skipped'), 'warn');
  assert.equal(sessionLayoutStatusBadgeKind('rolledBack'), 'warn');
  assert.equal(sessionLayoutStatusBadgeKind('failed'), 'error');
  assert.equal(sessionLayoutStatusBadgeKind('rollbackFailed'), 'error');
});

test('E2：结果计数（失败总数含已回滚与回滚失败，与宿主 failed 同口径）', () => {
  const items = sessionLayoutApplyItems(applyResult([
    applyItem({ unitId: '--P-A--/1', sessionId: '1', action: 'move', ok: true }),
    applyItem({ unitId: '--P-A--/2', sessionId: '2', action: 'quarantine', ok: true, quarantineDir: 'q/2' }),
    applyItem({ unitId: '--P-A--/3', sessionId: '3', action: 'keep', ok: true }),
    applyItem({ unitId: '--P-A--/4', sessionId: '4', action: 'skip', ok: false, reason: 'locked' }),
    applyItem({ unitId: '--P-A--/5', sessionId: '5', action: 'move', ok: false, reason: 'move-failed' }),
    applyItem({ unitId: '--P-A--/6', sessionId: '6', action: 'move', ok: false, reason: 'reindex-failed', rolledBack: true }),
    applyItem({ unitId: '--P-A--/7', sessionId: '7', action: 'move', ok: false, reason: 'reindex-failed', rolledBack: false }),
  ]));
  assert.deepEqual(sessionLayoutResultCounts(items), {
    moved: 1, quarantined: 1, kept: 1, skipped: 1, failed: 1, rolledBack: 1, rollbackFailed: 1, failedTotal: 3,
  });
  assert.deepEqual(sessionLayoutResultCounts([]), {
    moved: 0, quarantined: 0, kept: 0, skipped: 0, failed: 0, rolledBack: 0, rollbackFailed: 0, failedTotal: 0,
  });
});

test('E2：应用结果 → 展示项（状态键 + 原因键 + 隔离去向；未知原因回落 unknown）', () => {
  const view = applyResult([
    applyItem({ unitId: '--P-A--/loc', sessionId: 'loc', action: 'move', ok: true, movedUnitId: '--P-B--/loc' }),
    applyItem({ unitId: '--P-A--/dup', sessionId: 'dup', action: 'quarantine', ok: true, quarantineDir: '.cm-repair-quarantine-2026/--P-A--/dup' }),
    applyItem({ unitId: '--P-A--/bad', sessionId: 'bad', action: 'move', ok: false, reason: 'reindex-failed', rolledBack: false, needsAttention: true }),
    applyItem({ unitId: '--P-A--/skip', sessionId: 'skip', action: 'skip', ok: false, reason: 'locked' }),
    applyItem({ unitId: '--P-A--/weird', sessionId: 'weird', action: 'move', ok: false, reason: 'future-code' }),
  ]);
  const items = sessionLayoutApplyItems(view);
  assert.deepEqual(items.map((i) => i.status), ['moved', 'quarantined', 'rollbackFailed', 'skipped', 'failed']);
  assert.equal(items[0]?.movedUnitId, '--P-B--/loc');
  assert.equal(items[1]?.quarantineDir, '.cm-repair-quarantine-2026/--P-A--/dup');
  assert.equal(items[1]?.statusKey, 'sessions.layout.status.quarantined');
  assert.equal(items[2]?.reasonKey, 'sessions.layout.reason.reindexFailed');
  assert.equal(items[2]?.needsAttention, true);
  assert.equal(items[2]?.statusKey, 'sessions.layout.status.rollbackFailed');
  assert.equal(items[4]?.reasonKey, 'sessions.layout.reason.unknown', '未知码绝不裸渲染');
  assert.deepEqual(sessionLayoutApplyItems(null), []);
});

test('E2：整体未执行（reindex-unavailable / 会话根读不出来）→ 单独的文案键，不是成功', () => {
  const blocked = sessionLayoutApplyItems(applyResult([], { ok: false, applied: 0, failed: 0, skipped: 0, reason: 'reindex-unavailable' }));
  assert.deepEqual(blocked, [], '一条也不执行 → 没有任何「成功」条目');
  assert.equal(sessionLayoutOverallReasonKey('reindex-unavailable'), 'sessions.layout.reason.reindexUnavailable');
  assert.equal(sessionLayoutOverallReasonKey('sessions-root-unreadable'), 'sessions.layout.reason.sessionsRootUnreadable');
  assert.equal(sessionLayoutOverallReasonKey('future-code'), 'sessions.layout.reason.unknown');
  assert.equal(sessionLayoutOverallReasonKey(undefined), null);
  assert.equal(sessionLayoutOverallReasonKey(''), null);
});

/* ------------------------------------------------------------------ ④ reason → key */

test('E2：计划/执行原因逐个映射（未知一律 unknown，绝不渲染裸码）', () => {
  const codes = [
    'no-cwd', 'inconsistent-generations', 'locked', 'already-placed', 'needs-move', 'needs-rewrite-move', 'duplicate-id',
    'busy', 'missing-keep', 'keep-not-a-candidate', 'target-exists', 'quarantine-exists', 'rewrite-failed',
    'missing-target-key', 'move-failed', 'reindex-failed', 'not-found', 'io-error',
    'reindex-unavailable', 'sessions-root-unreadable',
  ];
  for (const code of codes) {
    const key = sessionLayoutReasonKey(code);
    assert.match(key, /^sessions\.layout\.reason\./, '缺映射会渲染裸码: ' + code);
    assert.ok(Object.values(SESSION_LAYOUT_REASON_KEYS).includes(key), '必须是登记过的键（不是裸码）: ' + code);
    assert.notEqual(key, code, '绝不把机器码当键返回: ' + code);
  }
  assert.equal(sessionLayoutReasonKey('missing-keep'), 'sessions.layout.reason.missingKeep');
  assert.equal(sessionLayoutReasonKey('keep-not-a-candidate'), 'sessions.layout.reason.keepNotACandidate');
  assert.equal(sessionLayoutReasonKey('reindex-unavailable'), 'sessions.layout.reason.reindexUnavailable');
  assert.equal(sessionLayoutReasonKey('no-such-code'), 'sessions.layout.reason.unknown');
  assert.equal(sessionLayoutReasonKey(undefined), 'sessions.layout.reason.unknown');
  assert.equal(sessionLayoutReasonKey(''), 'sessions.layout.reason.unknown');
  for (const key of Object.values(SESSION_LAYOUT_REASON_KEYS)) assert.match(key, /^sessions\.layout\.reason\./);
  for (const key of Object.values(SESSION_LAYOUT_KIND_KEYS)) assert.match(key, /^sessions\.layout\.kind\./);
  for (const key of Object.values(SESSION_LAYOUT_STATUS_KEYS)) assert.match(key, /^sessions\.layout\.status\./);
});

/* ------------------------------------------------------------------ ⑤ 字典齐备 */

test('E2：模型产出的每一个键都在 recovery 字典 zh / en 里逐字存在（键名漂移即红）', () => {
  const panelKeys = [
    'sessions.layout.title', 'sessions.layout.desc', 'sessions.layout.preview', 'sessions.layout.previewing',
    'sessions.layout.planEmpty', 'sessions.layout.planTitle', 'sessions.layout.planReadOnly',
    'sessions.layout.summary', 'sessions.layout.planSkipped', 'sessions.layout.keepTitle', 'sessions.layout.keepHint',
    'sessions.layout.keepMissing', 'sessions.layout.apply', 'sessions.layout.applying', 'sessions.layout.resultTitle',
    'sessions.layout.done', 'sessions.layout.runtimeNote', 'sessions.layout.quarantineNote', 'sessions.layout.refreshHint',
    'sessions.layout.close', 'sessions.layout.onlyReported', 'sessions.layout.apiMissing',
  ];
  const keys: string[] = [
    ...panelKeys,
    ...Object.values(SESSION_LAYOUT_KIND_KEYS),
    ...Object.values(SESSION_LAYOUT_STATUS_KEYS),
    ...Object.values(SESSION_LAYOUT_REASON_KEYS),
  ];
  assert.equal(new Set(keys).size, keys.length, '键不得重复登记');
  for (const key of keys) {
    const zhValue: string = recoveryZh[key as keyof typeof recoveryZh];
    const enValue: string = recoveryEn[key as keyof typeof recoveryEn];
    assert.equal(typeof zhValue, 'string', 'zh 缺键：' + key);
    assert.equal(typeof enValue, 'string', 'en 缺键：' + key);
    assert.ok(zhValue !== '' && enValue !== '', '文案不得为空：' + key);
    assert.notEqual(zhValue, enValue, 'en 必须是镜像而不是复制：' + key);
  }
  // 两条硬事实必须在文案里（口径要求）
  assert.match(recoveryZh['sessions.layout.runtimeNote'], /DSH 运行时/);
  assert.match(recoveryZh['sessions.layout.quarantineNote'], /隔离目录/);
  assert.match(recoveryEn['sessions.layout.runtimeNote'].toLowerCase(), /while dsh is running/);
  assert.match(recoveryEn['sessions.layout.quarantineNote'].toLowerCase(), /quarantine/);
});
