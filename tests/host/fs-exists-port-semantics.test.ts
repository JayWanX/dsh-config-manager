/**
 * 持久回归（t92）：HostContext.fs.exists() 的「读不到 ≠ 没有」口径（t85 / t23）+ t81 消费点。
 *
 * 来源：t85（FIX-port-exists）的回归原先只存在于临时验证树（outputs/bug-audit/final-sweep/t85-exists.test.ts），
 * 随树删除即丢失；本文件把它正式落到 tests/host/，并把「非 ENOENT」的来源换成**跨平台确定性**的一种。
 *
 * 为什么不能靠「自发现 errno」（attempt 1 的教训，本机实测见 outputs/bug-audit/sync/t92-errno-probe.txt）：
 *  - Windows 上「非法文件名字符 / 父组件是文件 / 超长名 / 保留设备名」**全部落回 ENOENT** ⇒ 自发现用例在 win32 恒红、无判别力；
 *  - 真正确定的非 ENOENT 来源只有**路径含 NUL**：Node 在进入系统调用前就抛 ERR_INVALID_ARG_VALUE（跨平台一致）；
 *  - 而 `isPathSafe()`（Zip Slip §19.1-2）**明确拒绝**含 NUL 的条目名 ⇒ patchedDependencies 的**声明路径**走不通 NUL。
 *    所以消费点（t81）改成：把 NUL 放进 **profile 段**（`profiles/<profile>/patches/x.patch`）—— 声明路径仍然安全，
 *    但目标机的存在性探测必然非 ENOENT ⇒ 正好落进本口径的分支。
 *
 * 覆盖：
 *  t92-a 单元：ENOENT → false；非 ENOENT（NUL 路径）→ 按「存在」处理（true）；
 *  t92-b 端到端（判别力所在）：真实 adapter + 真实 facade，读不出来（非 ENOENT）的声明**不得**被剔除，
 *        真不存在（ENOENT）的**必须**被剔除（对照组）；该条在 base 形态的 exists() 上必红；
 *  t92-c 端到端（落盘）：真实 plan → applyItem → 读回落盘的 pnpm-workspace.yaml 逐字断言保留/剔除；
 *  t92-d 接缝：端口探测抛非 ENOENT 时，适配器**绝不**产出「把声明删掉」的计划，而是显式上抛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DshFileSystemFacade } from '../../src/index.ts';
import { PluginsAdapter, PNPM_PROFILE_DIR, PNPM_WORKSPACE_REL } from '../../src/adapters/plugins.ts';
import { makeContext, makeImportContext } from '../../src/adapters/test-helpers.ts';
import type { PluginsSection } from '../../src/schema/types.ts';

/** 单元用例用：JS 字符串里真含 NUL（Node 会在系统调用前抛 ERR_INVALID_ARG_VALUE） */
const NUL_REL = 'patches/dsh-x\u0000.patch';
/** 消费点用：NUL 放在 profile 段（声明路径保持路径安全） */
const NUL_PROFILE = 'web\u0000';
const UNREADABLE_MARK = 'unreadable@1.0.0';
const PRESENT_REL = 'patches/dsh-present.patch';
const ABSENT_REL = 'patches/dsh-truly-absent.patch';

async function observedCode(p: string): Promise<string> {
  try {
    await fs.access(p);
    return 'NO_ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).name;
  }
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-t92-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sectionWith(pnpmWorkspace: string): PluginsSection {
  return { version: 1, plugins: [], patch: [], pnpmWorkspace };
}

function workspaceText(entries: readonly (readonly [string, string])[]): string {
  return ['patchedDependencies:', ...entries.map(([name, rel]) => '  ' + name + ': ' + rel), ''].join('\n');
}

test('t92-a：ENOENT → false；非 ENOENT（NUL 路径）→ 按「存在」处理', async () => {
  await withTmp(async (home) => {
    const facade = new DshFileSystemFacade(home);
    const code = await observedCode(path.join(home, NUL_REL));
    console.log('[OBSERVE] 非 ENOENT 来源（NUL 路径）code = ' + code);
    assert.notEqual(code, 'ENOENT', '前提：NUL 路径必须产生非 ENOENT 错误，否则本用例无判别力');
    assert.equal(await facade.exists('missing.txt'), false, 'ENOENT 必须仍为 false（不得破坏按需创建语义）');
    assert.equal(await facade.exists(NUL_REL), true, '非 ENOENT（' + code + '）必须按「存在」处理（t85/t23 口径）');
  });
});

test('t92-b 端到端（t81 消费点）：读不出来（非 ENOENT）的声明不得被剔除；真不存在的必须被剔除', async () => {
  await withTmp(async (home) => {
    const profile = NUL_PROFILE;
    const probe = await observedCode(path.join(home, PNPM_PROFILE_DIR(profile) + '/' + 'patches/x.patch'));
    console.log('[OBSERVE] 消费点非 ENOENT 来源（profile 含 NUL）code = ' + probe);
    assert.notEqual(probe, 'ENOENT', '前提：该 profile 下的探测必须非 ENOENT，否则本用例无判别力');
    const section = sectionWith(workspaceText([['unreadable@1.0.0', 'patches/dsh-x.patch']]));
    // fs 端口换成**真实** facade（MemFs 不产生真实 errno，测不到本口径）
    const runWith = async (prof: string) => {
      const target = makeContext('win32', home, prof);
      // 真实 facade 顶掉 MemFs（MemFs 不产生真实 errno）；类型按 MockHostContext 的端口断言。
      target.fs = new DshFileSystemFacade(home) as unknown as typeof target.fs;
      const ctx = makeImportContext(target, new Map<string, unknown>([['plugins', section]]));
      const items = await new PluginsAdapter().analyzeImport(section, ctx);
      return { items, dropped: items.find((i) => i.id === 'plugins:pnpm-workspace-dropped') };
    };
    // A：profile 段含 NUL ⇒ 存在性探测报 ERR_INVALID_ARG_VALUE（非 ENOENT）⇒ exists() = true ⇒ 声明不得被剔除
    const a = await runWith(profile);
    console.log('[OBSERVE] A（读不出来）被剔除的声明 :: ' + JSON.stringify(a.dropped?.description ?? null));
    assert.ok(a.items.some((i) => i.id === 'plugins:pnpm-workspace'), '必须有 pnpm-workspace.yaml 计划项');
    assert.equal((a.dropped?.description ?? '').includes(UNREADABLE_MARK), false,
      '读不出来（非 ENOENT ⇒ exists() = true）的声明绝不能被剔除（t81 现场，issue #35）: ' + (a.dropped?.description ?? '(无剔除项)'));
    // B：同一条声明 + 普通 profile（目录不存在 ⇒ ENOENT ⇒ exists() = false）⇒ 必须被剔除（对照组，证明同一条断言有判别力）
    const b = await runWith('web');
    console.log('[OBSERVE] B（真不存在）被剔除的声明 :: ' + JSON.stringify(b.dropped?.description ?? null));
    assert.ok(b.dropped !== undefined, '对照组：真不存在（ENOENT）的声明必须被剔除，否则本用例无判别力');
    assert.ok(b.dropped.description.includes(UNREADABLE_MARK), '对照组必须命中同一条声明: ' + b.dropped.description);
  });
});

test('t92-c 端到端（落盘）：applyItem 写出的 pnpm-workspace.yaml 保留在读声明、剔除真缺声明', async () => {
  await withTmp(async (home) => {
    const profile = 'web';
    const patchesDir = path.join(home, PNPM_PROFILE_DIR(profile), 'patches');
    await fs.mkdir(patchesDir, { recursive: true });
    await fs.writeFile(path.join(home, PNPM_PROFILE_DIR(profile), PRESENT_REL), 'patch\n', 'utf8');
    const section = sectionWith(workspaceText([
      ['present@1.0.0', PRESENT_REL],
      ['absent@1.0.0', ABSENT_REL],
    ]));
    const target = makeContext('win32', home, profile);
    target.fs = new DshFileSystemFacade(home) as unknown as typeof target.fs;
    const ctx = makeImportContext(target, new Map<string, unknown>([['plugins', section]]));
    const adapter = new PluginsAdapter();
    const items = await adapter.analyzeImport(section, ctx);
    const item = items.find((i) => i.id === 'plugins:pnpm-workspace');
    assert.ok(item !== undefined, '必须有 pnpm-workspace.yaml 计划项');
    const applied = await adapter.applyItem(item, ctx);
    assert.equal(applied.ok, true, '写入必须成功: ' + JSON.stringify(applied));
    const written = await fs.readFile(path.join(home, PNPM_WORKSPACE_REL(profile)), 'utf8');
    console.log('[OBSERVE] 落盘内容 :: ' + JSON.stringify(written));
    assert.ok(written.includes('present@1.0.0: ' + PRESENT_REL), '文件确实存在的声明必须保留');
    assert.equal(written.includes('absent@1.0.0'), false, '对照组：真不存在（ENOENT）的声明必须被剔除');
  });
});

test('t92-d 接缝：端口探测抛非 ENOENT → 适配器显式上抛，绝不产出「把声明删掉」的计划', async () => {
  await withTmp(async (home) => {
    const section = sectionWith(workspaceText([['unreadable@1.0.0', 'patches/dsh-x.patch']]));
    const target = makeContext('win32', home, 'web');
    const real = new DshFileSystemFacade(home);
    const err = Object.assign(new Error('read failed'), { code: 'ERR_INVALID_ARG_VALUE' });
    target.fs = {
      exists: async (rel: string) => (rel.includes('patches/') ? Promise.reject(err) : real.exists(rel)),
    } as unknown as typeof target.fs;
    const ctx = makeImportContext(target, new Map<string, unknown>([['plugins', section]]));
    await assert.rejects(
      () => new PluginsAdapter().analyzeImport(section, ctx),
      (e: unknown) => (e as { code?: string }).code === 'ERR_INVALID_ARG_VALUE',
      '探测失败不得降级成「声明不可满足」——必须显式上抛（t81/t23）',
    );
  });
});
