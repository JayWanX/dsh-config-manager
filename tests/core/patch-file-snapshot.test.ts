/**
 * issue #35（回滚安全）：pnpm patch 文件必须进入导入前快照，并在回滚时被还原。
 *
 * 若只把 patch 文件写进 profile 的 patches/ 而不纳入快照，导入**覆盖了目标机原有 patch 文件**
 * 之后再回滚，原文件就永久丢失了——这违反「导入前强制快照（可回滚）」的不变量。
 *
 * 注：MemFs 的 key 归一化依赖 `homeDir` 前缀，故这里统一用 win32 宿主 + 盘符 homeDir
 * （与 `tests/core/snapshot.test.ts` 同款夹具；用 POSIX homeDir 会让 win32 的 path.join 产出
 * 反斜杠路径而绕过前缀判定，属夹具平台不匹配，不是被测行为）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshot, resolveFileTarget, resolveFileTargetRel, PLUGIN_PATCH_REF_PREFIX } from '../../src/core/backup.ts';
import { rollback } from '../../src/core/rollback.ts';
import { makeContext, MemSnapshotStore } from '../../src/adapters/test-helpers.ts';
import { SECTION_IDS } from '../../src/schema/config.ts';
import type { ImportPlan, PlanItem } from '../../src/core/types.ts';
import type { SectionId } from '../../src/schema/types.ts';

const HOME = 'C:\\Users\\bob';

/** 全分区 0 计数的 estimatedActions（ImportPlan 要求完整 Record<SectionId, number>；键集合以 SECTION_IDS 为准） */
function emptyEstimatedActions(): Record<SectionId, number> {
  const out = {} as Record<SectionId, number>;
  for (const id of SECTION_IDS) out[id] = 0;
  return out;
}

function patchPlan(): ImportPlan {
  const items: PlanItem[] = [{
    id: 'plugins:patch:patches/a.patch',
    kind: 'Update',
    adapter: 'plugins',
    description: 'write pnpm patch file',
    severity: 'info',
    target: { adapter: 'plugins', ref: `${PLUGIN_PATCH_REF_PREFIX}patches/a.patch` },
  }];
  return { items, globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: emptyEstimatedActions() };
}

test('issue #35：patch 文件 ref 解析到 profiles/<profile>/ 下（不是 homeDir 根）', () => {
  const ctx = makeContext('win32', HOME, 'web');
  const abs = resolveFileTarget(ctx, 'plugins', `${PLUGIN_PATCH_REF_PREFIX}patches/a.patch`);
  assert.match(abs, /profiles[\\/]web[\\/]patches[\\/]a\.patch$/, `实际: ${abs}`);
  // 缺省 profile 回落 web（与 pnpm-workspace.yaml 同一基准）
  const noProfile = makeContext('win32', HOME);
  assert.match(
    resolveFileTarget(noProfile, 'plugins', `${PLUGIN_PATCH_REF_PREFIX}patches/a.patch`),
    /profiles[\\/]web[\\/]patches[\\/]a\.patch$/,
  );
});

test('issue #35：journal 指纹用的 home-relative 路径必须真实存在（否则 crash 后无法证明已应用）', async () => {
  const ctx = makeContext('win32', HOME, 'web');
  // plugins 分区的两个文件类 ref 都不在 FILE_BASES 的静态基准上，必须带 profile
  assert.equal(
    resolveFileTargetRel('plugins', `${PLUGIN_PATCH_REF_PREFIX}patches/a.patch`, 'web'),
    'profiles/web/patches/a.patch',
  );
  assert.equal(resolveFileTargetRel('plugins', 'pnpm-workspace.yaml', 'web'), 'profiles/web/pnpm-workspace.yaml');
  assert.equal(resolveFileTargetRel('plugins', 'pnpm-workspace.yaml'), 'profiles/web/pnpm-workspace.yaml', '缺省 profile → web');
  // 该相对路径必须与绝对路径指向同一个文件（两条路径口径一致才谈得上指纹可信）
  await ctx.fs.writeFile('profiles/web/patches/a.patch', Buffer.from('P\n', 'utf8'));
  const rel = resolveFileTargetRel('plugins', `${PLUGIN_PATCH_REF_PREFIX}patches/a.patch`, 'web');
  assert.equal(await ctx.fs.exists(rel), true, `home-relative 路径必须存在: ${rel}`);
  // 其它分区行为不变
  assert.equal(resolveFileTargetRel('skills', 'coding.md'), 'skills/coding.md');
});

test('issue #35：导入前快照覆盖 patch 文件，回滚还原被覆盖的原内容', async () => {
  const ctx = makeContext('win32', HOME, 'web');
  await ctx.fs.writeFile('profiles/web/patches/a.patch', Buffer.from('ORIGINAL PATCH\n', 'utf8'));

  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({ ctx, plan: patchPlan(), sourceZip: 'C:\\tmp\\x.zip', store, adapters: [] });

  const entry = snapshot.entries.find((e) => e.ref.startsWith(PLUGIN_PATCH_REF_PREFIX));
  assert.ok(entry !== undefined, `快照必须登记 patch 文件条目: ${JSON.stringify(snapshot.entries)}`);
  assert.equal(entry.kind, 'file', '必须是整文件条目（可整文件还原），而不是 patchLine');
  assert.equal(entry.existed, true, '目标机已有该文件 → existed=true，回滚才能恢复原值');
  assert.ok(entry.copiedTo !== undefined && entry.copiedTo !== '', '必须真的把原字节拷进 blobs');

  // 模拟导入覆盖该文件
  await ctx.fs.writeFile('profiles/web/patches/a.patch', Buffer.from('NEW PATCH\n', 'utf8'));

  const report = await rollback({ ctx, snapshot, store, adapters: [] });
  assert.equal(report.full, true, `回滚必须完整: ${JSON.stringify(report)}`);
  assert.equal(
    new TextDecoder().decode(await ctx.fs.readFile('profiles/web/patches/a.patch')),
    'ORIGINAL PATCH\n',
    '回滚必须把 patch 文件还原为导入前内容（否则目标机原有补丁被静默替换）',
  );
});

test('issue #35：目标机原本没有该 patch 文件 → 快照 existed=false（不谎报有原值）', async () => {
  const ctx = makeContext('win32', HOME, 'web');
  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({ ctx, plan: patchPlan(), sourceZip: 'C:\\tmp\\x.zip', store, adapters: [] });
  const entry = snapshot.entries.find((e) => e.ref.startsWith(PLUGIN_PATCH_REF_PREFIX));
  assert.equal(entry?.existed, false);
  assert.equal(entry?.before, null);
  const report = await rollback({ ctx, snapshot, store, adapters: [] });
  assert.equal(report.full, true, JSON.stringify(report));
});
