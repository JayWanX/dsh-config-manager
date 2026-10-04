/**
 * 导入侧加固（issue #45 真机事故）：备份里**有会话、没有工作区**时，必须在分析阶段就告警。
 *
 * 事故现场：源机那次导出用的是**未含耦合逻辑的插件构建**，于是包里只有会话文件；导入后会话在 DSH 的
 * 工作区列表里看不见，用户理解成「对话丢了」。工作区记录是会话可见性的前提（workspace.path 必须等于
 * 会话首帧 cwd，且 id 在 sessionIds 里），所以「有会话没工作区」的包在导入前就必须被指出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import { probeSessionFormats } from '../utils/session-format.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { zhMsg } from './messages.ts';
import {
  sessionFormatFactsFromPlan,
  sessionFormatSkipUnits,
  sessionFormatSkippedItems,
} from '../ui/session-format-disposition.ts';
import { buildSelectedPlan, defaultSelectionFromPlan, type Selection } from '../ui/selection-model.ts';
import { sessionFormatAbortResponse } from '../routes/session-format.ts';
import type { ApplyResult, ConfigAdapter, ExportSection, ImportPlan, PlanItem } from './types.ts';

const BYTES = new TextEncoder().encode('fake-session-log-bytes');

/** 一条真会话日志的首帧（带 header.version）；不传 headerVersion 时用垃圾字节（模拟解不出）。 */
function sessionLogBytes(headerVersion?: number): Uint8Array {
  if (headerVersion === undefined) return BYTES;
  return new Uint8Array(encodeZstdFrame(Buffer.from(JSON.stringify({ version: headerVersion, id: 'session-1' }) + '\n', 'utf8')));
}

function sessionsStub(headerVersion?: number): ConfigAdapter {
  const bytes = sessionLogBytes(headerVersion);
  return {
    id: 'sessions',
    displayName: 'Sessions',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'sessions',
        // 文件名必须过 DSH 的会话日志判据（`session[.<generation>]*.jsonl[.zstd]`），
        // 否则探针按设计跳过它 —— 体检只认真正的会话日志。
        data: { version: 1, files: [{ relativePath: '--proj--/s1/session.jsonl.zstd', contentHash: sha256Hex(bytes), data: bytes }] },
        counts: { files: 1 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    // 真实 adapter（FileCollectionAdapter.analyzeImport）产出的 unitId 带适配器前缀
    // （`sessions:projectKey/会话目录`），而探针的单元键是**裸的**相对路径首两段。
    // 桩必须照**真实的**前缀形态来 —— 早期桩不带前缀，导致「键空间失配」这个真机缺陷
    // 在测试里被掩盖（计划项一条都拿不到 formatUnsupported 标记）。
    async analyzeImport(data: unknown): Promise<PlanItem[]> {
      const files = (data as { files?: { relativePath: string }[] }).files ?? [];
      return files.map((f) => {
        const parts = f.relativePath.split('/');
        return {
          id: `sessions:${f.relativePath}`,
          unitId: `sessions:${parts.slice(0, 2).join('/')}`,
          kind: 'Create',
          adapter: 'sessions',
          description: f.relativePath,
          severity: 'info',
        } as PlanItem;
      });
    },
    async applyItem(): Promise<ApplyResult> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

function workspacesStub(): ConfigAdapter {
  return {
    id: 'workspaces',
    displayName: 'Workspaces',
    defaultIncluded: true,
    portability: 'platformSpecific',
    async export(): Promise<ExportSection> {
      return { sectionId: 'workspaces', data: { version: 1, workspaces: [] }, counts: {}, warnings: [] };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<PlanItem[]> { return []; },
    async applyItem(): Promise<ApplyResult> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-import-visibility-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function analyze(
  dir: string,
  opts: { withWorkspaces: boolean; headerVersion?: number; targetFormatVersion?: number; withProbe?: boolean },
): Promise<string[]> {
  const zipPath = path.join(dir, opts.withWorkspaces ? 'both.zip' : 'sessions-only.zip');
  const adapters = opts.withWorkspaces ? [workspacesStub(), sessionsStub(opts.headerVersion)] : [sessionsStub(opts.headerVersion)];
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
    .export({ includeSecrets: false, only: opts.withWorkspaces ? ['sessions', 'workspaces'] : ['sessions'], outPath: zipPath });
  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  if (opts.targetFormatVersion !== undefined) {
    (dst as { sessionFormatVersion?: number }).sessionFormatVersion = opts.targetFormatVersion;
  }
  const importer = new Importer({
    ctx: dst,
    adapters,
    snapshotStore: new MemSnapshotStore(),
    // 用**真实探针**（解首帧 header）而不是替身：这条链路要能端到端跑通。
    ...(opts.withProbe === false ? {} : { sessionFormatProbe: (files: readonly { relativePath: string; data: Uint8Array }[]) => probeSessionFormats(files) }),
  });
  const analysis = await importer.analyzeImport(zipPath);
  return analysis.warnings;
}

test('分析阶段：包里有会话但没有工作区 → 告警「导入后这些对话可能看不见」', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: false });
    assert.ok(
      warnings.some((line) => /没有任何工作区记录/.test(line)),
      '必须在分析阶段告警（用户点执行之前就能看见）：' + JSON.stringify(warnings),
    );
  });
});

test('分析阶段：包里有工作区 → 不产生该告警（避免假阳性）', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: true });
    assert.equal(warnings.some((line) => /没有任何工作区记录/.test(line)), false, '有工作区就不该告警：' + JSON.stringify(warnings));
  });
});

/* ---------------- 会话格式体检（G-23：DSH 对读不出的格式静默跳过） ---------------- */

test('会话格式体检：包内 v4、本机只支持 v3 → 分析阶段必须告警（DSH 会静默跳过这些对话）', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: true, headerVersion: 4, targetFormatVersion: 3 });
    assert.ok(
      warnings.some((line) => /v4/.test(line) && /v3/.test(line) && /静默跳过/.test(line)),
      '必须在导入前说清楚（否则用户只会看到「对话没了」）：' + JSON.stringify(warnings),
    );
  });
});

test('会话格式体检：包内 v3、本机支持 v4 → 不告警（高版本可读低版本，DSH 自带迁移链）', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: true, headerVersion: 3, targetFormatVersion: 4 });
    assert.equal(warnings.some((line) => /静默跳过/.test(line)), false, '低版本包导入高版本 DSH 是合法路径：' + JSON.stringify(warnings));
  });
});

test('会话格式处置：读不了的会话必须落到具体计划项（formatUnsupported）+ 结构化摘要', async () => {
  await withTmp(async (dir) => {
    const zipPath = path.join(dir, 'both.zip');
    const adapters = [workspacesStub(), sessionsStub(4)];
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
      .export({ includeSecrets: false, only: ['sessions', 'workspaces'], outPath: zipPath });
    const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
    (dst as { sessionFormatVersion?: number }).sessionFormatVersion = 3;
    const importer = new Importer({
      ctx: dst,
      adapters,
      snapshotStore: new MemSnapshotStore(),
      sessionFormatProbe: (files: readonly { relativePath: string; data: Uint8Array }[]) => probeSessionFormats(files),
    });

    const analysis = await importer.analyzeImport(zipPath);
    assert.deepEqual(
      analysis.sessionFormats?.unreadable,
      [{ unitId: '--proj--/s1', version: 4 }],
      '摘要必须给出「哪个单元读不了」，而不是只给总数（UI 的处置靠它）',
    );
    // 计划项的 unitId 带适配器前缀（`sessions:…`），摘要里的键是不带前缀的相对路径：
    // UI 侧统一经 sessionUnitId() 归一 —— 这里钉住的是「两边键空间确实不同」这个事实，
    // 免得有人把探针改成带前缀后忘了同步。
    assert.equal(analysis.sessionFormats?.target, 3);
    assert.equal(analysis.sessionFormats?.sampled, 1);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const marked = plan.items.filter((i) => i.formatUnsupported !== undefined);
    assert.equal(marked.length, 1, '只有读不了的那条会话计划项被标记：' + JSON.stringify(plan.items.map((i) => [i.id, i.unitId])));
    assert.equal(marked[0]?.unitId, 'sessions:--proj--/s1', '真实计划项的 unitId 带适配器前缀');
    assert.deepEqual(marked[0]?.formatUnsupported, { version: 4, target: 3 }, '标记必须带版本与目标版本（文案由 UI 决定）');
    assert.equal(marked[0]?.severity, 'warning', '读不了的会话在计划/同步确认页里必须显式标成警告，不能混在普通项里');
  });
});

test('会话格式体检：本机版本解析不到 → 不告警、也不谎报兼容（宁可不报）', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: true, headerVersion: 4 });
    assert.equal(warnings.some((line) => /静默跳过/.test(line)), false, '无法判定时不得猜版本：' + JSON.stringify(warnings));
  });
});

/* ---------------- T1：三种处置 × 命中（abort / skip / guide） ---------------- */

/** 用真实 Importer 生成一份「包内 v4、本机 v3」的计划（处置判定的输入）。 */
async function planWithUnreadable(dir: string): Promise<{ zipPath: string; plan: ImportPlan }> {
  const zipPath = path.join(dir, 'both.zip');
  const adapters = [workspacesStub(), sessionsStub(4)];
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
    .export({ includeSecrets: false, only: ['sessions', 'workspaces'], outPath: zipPath });
  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  (dst as { sessionFormatVersion?: number }).sessionFormatVersion = 3;
  const importer = new Importer({
    ctx: dst,
    adapters,
    snapshotStore: new MemSnapshotStore(),
    sessionFormatProbe: (files: readonly { relativePath: string; data: Uint8Array }[]) => probeSessionFormats(files),
  });
  const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
  return { zipPath, plan };
}

test('T1 abort：计划含读不了的会话 → 返回带 code 的阻断体（计划阶段零写入）', async () => {
  await withTmp(async (dir) => {
    const { plan } = await planWithUnreadable(dir);
    const blocked = sessionFormatAbortResponse(plan, 'abort', zhMsg);
    assert.ok(blocked !== null, 'abort 必须阻断');
    assert.equal(blocked.code, 'sessionFormatUnsupported');
    assert.deepEqual(blocked.unreadable, [{ unitId: 'sessions:--proj--/s1', version: 4 }]);
    assert.equal(blocked.target, 3);
    assert.match(blocked.error, /v4/);
    // 阻断体只读：计划本身逐字未变（没有「先标后撤」这类副作用）
    assert.equal(plan.items.filter((i) => i.formatUnsupported !== undefined).length, 1);
  });
});

test('T1 skip：不阻断计划；这些会话单元默认不勾选，其余项照常进子计划', async () => {
  await withTmp(async (dir) => {
    const { plan } = await planWithUnreadable(dir);
    assert.equal(sessionFormatAbortResponse(plan, 'skip', zhMsg), null, 'skip 不阻断');
    const facts = sessionFormatFactsFromPlan(plan.items);
    const units = sessionFormatSkipUnits(facts, 'skip');
    assert.deepEqual(units, ['sessions:--proj--/s1']);
    const selection: Selection = { ...defaultSelectionFromPlan(plan), excluded: [...units] };
    assert.equal(sessionFormatSkippedItems(plan, selection).length, 1, '报告计数与读取不了的单元逐条一致');
    const cropped = buildSelectedPlan(plan, selection);
    assert.equal(cropped.items.some((i) => i.unitId === 'sessions:--proj--/s1'), false, '会话单元不写盘');
    assert.deepEqual(
      cropped.items.map((i) => i.id),
      plan.items.filter((i) => i.unitId !== 'sessions:--proj--/s1').map((i) => i.id),
      '其余项逐条照常进子计划（处置只作用在命中的会话单元上）',
    );
  });
});

test('T1 guide：不阻断也不跳过 —— 写入行为与改造前逐字一致', async () => {
  await withTmp(async (dir) => {
    const { plan } = await planWithUnreadable(dir);
    assert.equal(sessionFormatAbortResponse(plan, 'guide', zhMsg), null, 'guide 不阻断');
    const selection = defaultSelectionFromPlan(plan);
    assert.deepEqual(sessionFormatSkipUnits(sessionFormatFactsFromPlan(plan.items), 'guide'), []);
    assert.equal(sessionFormatSkippedItems(plan, selection).length, 0);
    assert.equal(buildSelectedPlan(plan, selection).items.length, plan.items.length, 'guide 下没有任何项被处置规则剔除');
  });
});
