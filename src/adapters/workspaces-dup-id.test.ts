/**
 * 回归护栏（audit-foreign **foreign-F2** 的适配器侧加固，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * 现象（F2）：记录 id 由 projectKeyOf(path) 派生（多对一）→ 同一目录的两种写法产出**同 id 的两条记录**：
 *   · 计划里出现同 id 的两条 Create（用户一次决策命中两条，逐条决策语义错乱）；
 *   · adapters/workspaces.ts 的 applyItem 此前用 find() 恒取第一条 → 第二条记录的 path/title/sessionIds
 *     **静默消失**，而 analysis.valid 仍为 true（零告警）。
 *
 * 加固后的行为（绝不静默丢弃）：同 id 记录先按 id **归并**（sessionIds 取并集、按裸键去重；path/title 取先到者）
 * 再规划/写入；计划项带 raw 标注 duplicateIdRecords=N（可见）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkspacesAdapter } from './workspaces.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import { projectKeyOf } from '../core/session-select.ts';
import type { WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
import type { PlanItem } from '../core/types.ts';

const ID = 'ws-dup';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

/** 同一目录的两种写法（Windows 反斜杠 / 正斜杠）→ 同一个派生 id（F2 的前提）。 */
const DUP_RECORDS: WorkspaceRecord[] = [
  { id: ID, path: 'C:\\Users\\me\\proj', title: 'proj-a', sessionIds: [SESSION_A], createdAt: 'c', updatedAt: 'c' },
  { id: ID, path: 'C:/Users/me/proj', title: 'proj-b', sessionIds: [SESSION_B], createdAt: 'c', updatedAt: 'c' },
];

function importCtxOf(records: WorkspaceRecord[], platform: 'win32' | 'linux' = 'win32') {
  const dst = makeContext(platform, platform === 'win32' ? 'C:\\Users\\me' : '/home/me');
  const data: WorkspacesSection = { version: 1, workspaces: records };
  const sections = new Map<string, unknown>([['workspaces', data]]);
  return { dst, data, ctx: makeImportContext(dst, sections) };
}

function createItemFor(id: string, ref: string): PlanItem {
  return {
    id, kind: 'Create', adapter: 'workspaces', description: 'x', severity: 'info',
    target: { adapter: 'workspaces', ref },
  };
}

test('foreign-F2 前提：两种路径写法确实派生出同一个 id（与上游 F2 同一现象）', () => {
  assert.equal(projectKeyOf(DUP_RECORDS[0]!.path), projectKeyOf(DUP_RECORDS[1]!.path));
});

test('foreign-F2：同 id 两条记录 → 计划里必须只有**一条** Create（不再出现同 id 双项）', async () => {
  const adapter = new WorkspacesAdapter();
  const { data, ctx } = importCtxOf(DUP_RECORDS);
  const items = await adapter.analyzeImport(data, ctx);
  const creates = items.filter((i) => i.id === 'workspace:' + ID);
  assert.equal(creates.length, 1, 'base 上同 id 会产出两条 Create（用户一次决策命中两条）');
  assert.equal(items.filter((i) => i.kind === 'PathMapping').length, 1, '同 id 只应有一条 PathMapping');
});

test('foreign-F2：归并必须带上第二条记录的 sessionIds（并集），并在计划里可见', async () => {
  const adapter = new WorkspacesAdapter();
  const { data, ctx } = importCtxOf(DUP_RECORDS);
  const items = await adapter.analyzeImport(data, ctx);
  const create = items.find((i) => i.id === 'workspace:' + ID) as PlanItem & { sessionIds?: string[] };
  assert.ok(create !== undefined);
  assert.deepEqual(create.sessionIds, [SESSION_A, SESSION_B], 'base 上只带第一条的 sessionIds（第二条静默消失）');
  assert.match(create.detail ?? '', /duplicateIdRecords=2/, '归并必须在计划里可见（绝不静默）');
});

test('foreign-F2：applyItem 写入的是**归并后**的记录（两条计划项都执行也只会写同一条归并结果）', async () => {
  const adapter = new WorkspacesAdapter();
  const { dst, ctx } = importCtxOf(DUP_RECORDS);
  const item = createItemFor('workspace:' + ID, ID);
  const r1 = await adapter.applyItem(item, ctx);
  assert.equal(r1.ok, true);
  // 同 id 的第二条计划项（base 上它们 id/ref 完全相同，这里显式模拟「两条都执行」）
  const r2 = await adapter.applyItem(item, ctx);
  assert.equal(r2.ok, true);

  const rec = dst.workspace.records.get(ID);
  assert.ok(rec !== undefined, '工作区记录必须写入');
  assert.deepEqual(rec.sessionIds, [SESSION_A, SESSION_B], 'base 上只写第一条 → 第二条的会话归属静默丢失');
  assert.equal(rec.path, 'C:\\Users\\me\\proj', 'path 取先到者（与上游内核归并口径一致）');
  assert.equal(rec.title, 'proj-a', 'title 取先到者');
});

test('foreign-F2：同一会话的两种命名形态（session-<uuid> / <uuid>）按裸键去重，只留一条', async () => {
  const adapter = new WorkspacesAdapter();
  const records: WorkspaceRecord[] = [
    { id: ID, path: '/home/me/p', title: 'a', sessionIds: ['session-' + SESSION_A], createdAt: 'c', updatedAt: 'c' },
    { id: ID, path: '/home/me//p', title: 'b', sessionIds: [SESSION_A, SESSION_B], createdAt: 'c', updatedAt: 'c' },
  ];
  const { dst, data, ctx } = importCtxOf(records, 'linux');
  const items = await adapter.analyzeImport(data, ctx);
  const create = items.find((i) => i.id === 'workspace:' + ID) as PlanItem & { sessionIds?: string[] };
  assert.deepEqual(create.sessionIds, ['session-' + SESSION_A, SESSION_B], '同一会话的两种写法不得各占一条');
  await adapter.applyItem(createItemFor('workspace:' + ID, ID), ctx);
  assert.deepEqual(dst.workspace.records.get(ID)?.sessionIds, ['session-' + SESSION_A, SESSION_B]);
});

test('foreign-F2：三条同 id 记录（两种写法 + 一条重复）→ 全部并集，且不因畸形 sessionIds 崩溃', async () => {
  const adapter = new WorkspacesAdapter();
  const records = [
    ...DUP_RECORDS,
    { id: ID, path: 'C:\\Users\\me\\proj', title: 'proj-c', sessionIds: undefined as unknown as string[], createdAt: 'c', updatedAt: 'c' },
  ];
  const { dst, data, ctx } = importCtxOf(records);
  const items = await adapter.analyzeImport(data, ctx);
  const create = items.find((i) => i.id === 'workspace:' + ID) as PlanItem & { sessionIds?: string[] };
  assert.match(create.detail ?? '', /duplicateIdRecords=3/);
  assert.deepEqual(create.sessionIds, [SESSION_A, SESSION_B]);
  await adapter.applyItem(createItemFor('workspace:' + ID, ID), ctx);
  assert.deepEqual(dst.workspace.records.get(ID)?.sessionIds, [SESSION_A, SESSION_B]);
});

/* ---------------- t73（VERIFY-adapters-dup-id）F1 回归：非字符串 sessionIds 元素 ---------------- */

test('t73-F1：sessionIds 含非字符串元素（1 / null）+ 两条同 id → 两入口都不抛，非法元素被丢弃、合法元素保留', async () => {
  const adapter = new WorkspacesAdapter();
  const records: WorkspaceRecord[] = [
    { id: ID, path: 'C:\\Users\\me\\proj', title: 'proj-a', sessionIds: [1 as unknown as string, SESSION_A], createdAt: 'c', updatedAt: 'c' },
    { id: ID, path: 'C:/Users/me/proj', title: 'proj-b', sessionIds: [null as unknown as string, SESSION_B], createdAt: 'c', updatedAt: 'c' },
  ];
  const { dst, data, ctx } = importCtxOf(records);
  const items = await adapter.analyzeImport(data, ctx);
  const create = items.find((i) => i.id === 'workspace:' + ID) as PlanItem & { sessionIds?: string[] };
  assert.deepEqual(create.sessionIds, [SESSION_A, SESSION_B], '非法元素必须被丢弃、合法元素保留');
  const r = await adapter.applyItem(createItemFor('workspace:' + ID, ID), ctx);
  assert.equal(r.ok, true, 'applyItem 不得抛（base 上归并去重会对 1/null 调 sessionIdKey → raw.startsWith is not a function）');
  assert.deepEqual(dst.workspace.records.get(ID)?.sessionIds, [SESSION_A, SESSION_B], '写入的也必须是过滤后的集合');
});

test('t73-F1：validate 必须对非字符串 sessionIds 元素判无效（不再放行到 analyzeImport 抛 TypeError）', async () => {
  const adapter = new WorkspacesAdapter();
  for (const bad of [1, null, {}, true]) {
    const data: WorkspacesSection = {
      version: 1,
      workspaces: [{ id: ID, path: '/p', title: 't', sessionIds: [bad as unknown as string], createdAt: 'c', updatedAt: 'c' }],
    };
    const dst = makeContext('win32', 'C:\\Users\\me');
    const ctx = makeImportContext(dst, new Map<string, unknown>([['workspaces', data]]));
    const v = await adapter.validate(data, ctx.msg);
    assert.equal(v.valid, false, '非字符串元素 ' + String(bad) + ' 必须让 validate 判无效');
    assert.ok(v.issues.some((i) => i.path.includes('sessionIds[')), '必须报出元素下标：' + JSON.stringify(v.issues));
  }
});