/**
 * audit-foreign F2 / F3 的回归护栏（t17）。
 *
 * F2：workspaces 记录 id 必须**唯一**（下游 workspaces 适配器按 rec.id 取记录；同 id 的第二条永远写不进去）。
 * F3：工作区标题必须是 cwd 的**最后一段**（Windows 记录里的 cwd 是反斜杠形态，按 '/' 切会拿到整条机器路径）。
 *
 * base 3f42a8b 上的红：同一目录两种写法 → 两条同 id 记录；反斜杠 cwd → title = 整条路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSessionSections } from './kernel.ts';
import { projectKeyOf } from '../core/session-select.ts';
import type { WorkspacesSection } from '../schema/types.ts';
import type { ForeignSectionOut, ForeignSkip } from './types.ts';

const BS = String.fromCharCode(92);

/** 用 collectSessionSections 跑一组 cwd（每个 cwd 一条会话），返回产出的 workspaces 分区 */
function workspacesOf(cwds: readonly string[]): WorkspacesSection {
  const sections: ForeignSectionOut[] = [];
  const skipped: ForeignSkip[] = [];
  const counts: Record<string, number> = {};
  collectSessionSections({
    files: cwds.map((_cwd, i) => ({ id: 'session-' + String(i) })),
    targetFormatVersion: 3,
    transcode: (file) => {
      const idx = Number(file.id.slice('session-'.length));
      const cwd = cwds[idx] ?? '';
      return {
        session: {
          id: file.id,
          cwd,
          relativePath: projectKeyOf(cwd) + '/' + file.id + '/session.v3.jsonl.zstd',
          data: new Uint8Array([1]),
          info: { ignored: {} },
        },
      };
    },
    workspaceIdPrefix: 'fix-probe',
    sections,
    skipped,
    counts,
  });
  const ws = sections.find((s) => s.sectionId === 'workspaces')?.data as WorkspacesSection | undefined;
  assert.ok(ws !== undefined, '必须有 workspaces 分区（否则目标机上一条对话都看不见）');
  return ws;
}

test('F2：同一目录两种写法（反斜杠/正斜杠）归并成一条记录，id 唯一且 sessionIds 合并', () => {
  const ws = workspacesOf(['C:' + BS + 'Users' + BS + 'me' + BS + 'proj', 'C:/Users/me/proj']);
  assert.equal(ws.workspaces.length, 1, '同一目录两种写法必须归并：' + JSON.stringify(ws.workspaces));
  const ids = ws.workspaces.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, 'workspaces 记录 id 必须唯一：' + JSON.stringify(ids));
  assert.deepEqual(ws.workspaces[0]?.sessionIds, ['session-0', 'session-1']);
});

test('F2：posix 的重复分隔符写法（/a/b 与 /a//b）同样归并成一条', () => {
  const ws = workspacesOf(['/home/me/proj', '/home/me//proj']);
  assert.equal(ws.workspaces.length, 1);
  const ids = ws.workspaces.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ws.workspaces[0]?.sessionIds, ['session-0', 'session-1']);
});

test('F2：不同目录仍然各出一条记录（不得过度归并）', () => {
  const ws = workspacesOf(['/home/me/one', '/home/me/two']);
  assert.equal(ws.workspaces.length, 2);
  const ids = ws.workspaces.map((w) => w.id);
  assert.equal(new Set(ids).size, 2);
});

test('F3：标题取最后一段（两种分隔符都认，尾部分隔符也不算内容）', () => {
  assert.equal(workspacesOf(['C:' + BS + 'Users' + BS + 'me' + BS + 'proj']).workspaces[0]?.title, 'proj');
  assert.equal(workspacesOf(['C:/Users/me/proj']).workspaces[0]?.title, 'proj');
  assert.equal(workspacesOf(['/home/me/proj/']).workspaces[0]?.title, 'proj');
  assert.equal(workspacesOf(['/home/me/proj']).workspaces[0]?.title, 'proj');
});

test('F3：反斜杠 cwd 产出的记录标题是目录名，不是整条机器路径', () => {
  const ws = workspacesOf(['C:' + BS + 'Users' + BS + 'me' + BS + 'proj']);
  assert.equal(ws.workspaces[0]?.title, 'proj', JSON.stringify(ws.workspaces[0]));
});

test('F3：合并后的记录标题同样取目录名（不是先到者那条的整条路径）', () => {
  const ws = workspacesOf(['C:' + BS + 'Users' + BS + 'me' + BS + 'proj', 'C:/Users/me/proj']);
  assert.equal(ws.workspaces[0]?.title, 'proj', JSON.stringify(ws.workspaces[0]));
});
