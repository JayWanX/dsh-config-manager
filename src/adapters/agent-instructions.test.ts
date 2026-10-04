/**
 * agentInstructions adapter 回归测试（2026-09 真机报告「总览/导出页变慢」）。
 *
 * 事故：v0.1.68 给文件类分区加了 `preview()`（走基类 `collect()` → 目录递归），而本 adapter 的
 * `baseDir` 是 ''（AGENTS.md 就在 `$DSH_HOME` 根），于是**预览**把整个 home 递归了一遍：
 * 实测 4.8 s / 4016 个文件 / 242 MB，选择器还冒出 21 个假单元（profiles、sessions、attachments…）。
 * 真实导出走的是本类的 `export()` 覆写（只读一个文件）——**预览与导出分叉**，两个界面同屏显示
 * 互相矛盾的数字，且 `/export-preview` 成了总览/导出页的慢点。
 *
 * 现在的契约（本文件钉住）：
 *  ① 清单枚举 = 单文件白名单：**绝不**调用 home 根的递归（用「一被调用就抛哨兵」的门面证明）；
 *  ② 预览与导出**逐项一致**（条目 / 体积 / 计数 / 告警），因为两者共用 collect() 与同一份清单；
 *  ③ home 里的无关文件（profiles/、sessions/…）一个都不进该分区；
 *  ④ AGENTS.md 不存在 → 空分区 + dirEmpty 告警（与旧行为一致），不是错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentInstructionsAdapter } from './agent-instructions.ts';
import { makeContext } from './test-helpers.ts';
import type { MockHostContext } from './test-helpers.ts';
import { sha256Hex } from '../utils/hashing.ts';

const FILE = AgentInstructionsAdapter.FILE;

/** 哨兵：基类的目录递归若被调用，本 adapter 的用例立即失败（这正是事故的根因） */
function trapRecursion(ctx: MockHostContext): void {
  const boom = async (): Promise<never> => { throw new Error('__NO_RECURSION__') };
  Object.defineProperty(ctx.fs, 'listRecursive', { value: boom, configurable: true });
  Object.defineProperty(ctx.fs, 'listRecursiveDetailed', { value: boom, configurable: true });
}

/** 造一份「像真机」的 home：AGENTS.md 之外还有一堆无关内容（旧实现会把它们算进该分区） */
async function seedHome(ctx: MockHostContext): Promise<void> {
  await ctx.fs.writeFile(FILE, new TextEncoder().encode('# global instructions'));
  await ctx.fs.writeFile('profiles/web/package.json', new Uint8Array(1024));
  await ctx.fs.writeFile('sessions/proj/session-1/log.jsonl.zstd', new Uint8Array(4096));
  await ctx.fs.writeFile('attachments/a.bin', new Uint8Array(2048));
}

test('agentInstructions：清单 = 单文件白名单（绝不递归 home 根）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice\\.dsh');
  await seedHome(ctx);
  trapRecursion(ctx);
  const adapter = new AgentInstructionsAdapter();

  const preview = await adapter.preview(ctx, { includeSecrets: false });
  assert.equal(preview.section.counts?.files, 1, '只有 AGENTS.md');
  assert.equal(preview.sizeBytes, Buffer.byteLength('# global instructions'));
  assert.equal(preview.items.length, 1, '一个单元（AGENTS.md 自身），不是 21 个假单元');
  assert.equal(preview.items[0]?.id, 'agentInstructions:' + FILE);

  const exported = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(exported.data.files.map((f) => f.relativePath), [FILE]);
  assert.equal(Buffer.from(exported.data.files[0]?.data ?? []).toString('utf8'), '# global instructions');
  assert.equal(exported.data.files[0]?.contentHash, sha256Hex(new TextEncoder().encode('# global instructions')));
});

test('agentInstructions：预览与导出逐项一致（条目 / 体积 / 计数 / 告警）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice\\.dsh');
  await seedHome(ctx);
  const adapter = new AgentInstructionsAdapter();

  const preview = await adapter.preview(ctx, { includeSecrets: false });
  const exported = await adapter.export(ctx, { includeSecrets: false });

  assert.deepEqual(
    preview.section.data.files.map((f) => f.relativePath),
    exported.data.files.map((f) => f.relativePath),
  );
  assert.deepEqual(preview.section.counts, exported.counts);
  assert.deepEqual(preview.section.warnings, exported.warnings);
  assert.equal(preview.sizeBytes, exported.data.files.reduce((n, f) => n + f.data.byteLength, 0));
  // 预览的条目必须是「无内容形态」（空 data / 空 hash），绝不能带真实内容进任何下游
  assert.equal(preview.section.data.files[0]?.data.byteLength, 0);
  assert.equal(preview.section.data.files[0]?.contentHash, '');
});

test('agentInstructions：unitActivityTimes / listUnits 走基类同口径（1 个单元）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice\\.dsh');
  await seedHome(ctx);
  const adapter = new AgentInstructionsAdapter();
  const exported = await adapter.export(ctx, { includeSecrets: false });
  const units = adapter.listUnits(exported);
  assert.equal(units.length, 1);
  assert.equal(units[0]?.fileCount, 1);
  assert.equal(units[0]?.sizeBytes, Buffer.byteLength('# global instructions'));
});

test('agentInstructions：文件不存在 → 空分区 + dirEmpty 告警（预览与导出一致，不抛错）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice\\.dsh');
  trapRecursion(ctx);
  const adapter = new AgentInstructionsAdapter();

  const preview = await adapter.preview(ctx, { includeSecrets: false });
  const exported = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(preview.section.counts?.files, 0);
  assert.equal(preview.sizeBytes, 0);
  assert.deepEqual(preview.items, []);
  assert.deepEqual(preview.section.warnings, exported.warnings);
  assert.equal(preview.section.warnings.length, 1, '必须有一条「目录为空」告警（绝不静默）');
});

test('agentInstructions：门面没有 statSize 的旧宿主也能用（退回读文件判存在）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice\\.dsh');
  await seedHome(ctx);
  Object.defineProperty(ctx.fs, 'statSize', { value: undefined, configurable: true });
  trapRecursion(ctx);
  const adapter = new AgentInstructionsAdapter();
  const preview = await adapter.preview(ctx, { includeSecrets: false });
  assert.equal(preview.section.counts?.files, 1);
  assert.equal(preview.sizeBytes, Buffer.byteLength('# global instructions'));
});
