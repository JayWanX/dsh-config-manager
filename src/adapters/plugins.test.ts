/**
 * plugins adapter 测试：插件清单 + 用户 patch 行导出、
 * 已装同版本 Skip / 未装 Install / patch 行 Create，applyItem（install → needsRestart；patch 写回）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginsAdapter } from './plugins.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('issue #35：patch 文件随分区迁移；目标缺失的 patchedDependencies 声明导入时剔除', async () => {
  const ws = [
    'allowBuilds:',
    '  ssh2: true',
    'patchedDependencies:',
    '  dsh-approval-gate: patches/dsh-approval-gate.patch',
    '  dsh-whale-galgame: patches/dsh-whale-galgame.patch',
    '',
  ].join('\n');
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode(ws));
  await src.fs.writeFile('profiles/web/patches/dsh-approval-gate.patch', new TextEncoder().encode('diff --git a/x b/x\n'));
  // 源机缺第二个 patch 文件 → 导出必须告警（此前静默只搬声明）

  const adapter = new PluginsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.deepEqual(out.data.patchFiles?.map((p) => p.relativePath), ['patches/dsh-approval-gate.patch']);
  assert.ok(out.warnings.some((w) => w.includes('dsh-whale-galgame')), `源机缺 patch 文件必须告警: ${out.warnings.join(' | ')}`);

  // 目标机全新：只有携带了文件的那条声明能被满足
  const dst = makeContext('linux', '/home/bob', 'web');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  const wsItem = items.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.equal(wsItem?.kind, 'Create');
  assert.ok(wsItem?.detail?.includes('dsh-whale-galgame'), '剔除必须在计划项里说清');
  assert.ok(
    items.some((i) => i.id === 'plugins:pnpm-workspace-dropped' && i.kind === 'Warning'),
    '剔除必须是可见的信息项（不静默改配置语义）',
  );

  // patch 文件必须成为计划项（进导入前快照 → 可回滚；且用户可见）
  const patchItems = items.filter((i) => i.id.startsWith('plugins:patch:'));
  assert.equal(patchItems.length, 1, `每个携带的 patch 文件都应有计划项: ${items.map((i) => i.id).join(',')}`);
  assert.equal(patchItems[0]?.id, 'plugins:patch:patches/dsh-approval-gate.patch');
  assert.equal(patchItems[0]?.kind, 'Create');
  assert.deepEqual(patchItems[0]?.target, { adapter: 'plugins', ref: 'patchFile:patches/dsh-approval-gate.patch' });
  // 顺序不变量：patch 文件必须先于 pnpm-workspace.yaml（否则会留下「声明在、文件未到」的窗口，
  // 中途中断后目标机 pnpm 从此拒绝一切 add），两者都必须先于插件安装项。
  const order = items.map((i) => i.id);
  assert.ok(
    order.indexOf(patchItems[0]!.id) < order.indexOf('plugins:pnpm-workspace'),
    `patch 文件项必须先于 pnpm-workspace 项: ${order.join(' → ')}`,
  );
  const firstInstall = order.findIndex((id) => id.startsWith('plugin:'));
  if (firstInstall >= 0) {
    assert.ok(
      order.indexOf('plugins:pnpm-workspace') < firstInstall,
      `pnpm-workspace 项必须先于插件安装项: ${order.join(' → ')}`,
    );
  }

  // 按计划顺序执行：先 patch 文件项，再 pnpm-workspace 项
  const patchApply = await adapter.applyItem(patchItems[0]!, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(patchApply.ok, true);
  assert.equal(
    new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/patches/dsh-approval-gate.patch')!),
    'diff --git a/x b/x\n',
    'patch 文件必须与声明同进同出（落到 profile 的 patches/ 目录）',
  );
  const r = await adapter.applyItem(wsItem!, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(r.ok, true);
  const writtenWs = new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/pnpm-workspace.yaml')!);
  assert.ok(writtenWs.includes('dsh-approval-gate: patches/dsh-approval-gate.patch'), '可满足的声明必须保留');
  assert.ok(!writtenWs.includes('dsh-whale-galgame'), '不可满足的声明绝不能写入（否则目标机 pnpm 拒绝一切安装）');
  assert.ok(writtenWs.includes('allowBuilds:'), '其余配置不受影响');

  // 内容一致 → Skip（幂等，不重复写）
  const again = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(again.find((i) => i.id.startsWith('plugins:patch:'))?.kind, 'Skip');
  // 内容不同 → Conflict（不静默覆盖目标机已有的 patch）
  await dst.fs.writeFile('profiles/web/patches/dsh-approval-gate.patch', new TextEncoder().encode('different\n'));
  const conflicted = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(conflicted.find((i) => i.id.startsWith('plugins:patch:'))?.kind, 'Conflict');

  // 目标机本来就有该 patch 文件 → 声明保留（不误删用户环境里已就位的补丁）
  const dst2 = makeContext('linux', '/home/bob2', 'web');
  await dst2.fs.writeFile('profiles/web/patches/dsh-whale-galgame.patch', new TextEncoder().encode('existing\n'));
  const items2 = await adapter.analyzeImport(out.data, makeImportContext(dst2, new Map([['plugins', out.data]])));
  assert.equal(items2.some((i) => i.id === 'plugins:pnpm-workspace-dropped'), false, '文件已存在 → 无需剔除');
  const wsItem2 = items2.find((i) => i.id === 'plugins:pnpm-workspace');
  const r2 = await adapter.applyItem(wsItem2!, makeImportContext(dst2, new Map([['plugins', out.data]])));
  assert.equal(r2.ok, true);
  const written2 = new TextDecoder().decode(dst2.fs.files.get('/home/bob2/profiles/web/pnpm-workspace.yaml')!);
  assert.ok(written2.includes('dsh-whale-galgame: patches/dsh-whale-galgame.patch'), '已存在的 patch 文件对应声明必须保留');
});

test('issue #35：用户否决 patch 覆盖时，pnpm-workspace 项不得越权替它落盘（也不得留下悬空声明）', async () => {
  const ws = [
    'patchedDependencies:',
    '  mine: patches/mine.patch',
    '',
  ].join('\n');
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode(ws));
  await src.fs.writeFile('profiles/web/patches/mine.patch', new TextEncoder().encode('BACKUP VERSION\n'));
  const adapter = new PluginsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });

  // 场景 A：目标机已有**不同**的 patch 文件 → 计划项是 Conflict；
  // 用户 keepCurrent（不应用该项）→ 文件必须保持原样，且声明仍然成立（文件在，pnpm 能读）。
  const dst = makeContext('linux', '/home/bob', 'web');
  await dst.fs.writeFile('profiles/web/patches/mine.patch', new TextEncoder().encode('LOCAL VERSION\n'));
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  const patchItem = items.find((i) => i.id.startsWith('plugins:patch:'));
  assert.equal(patchItem?.kind, 'Conflict');
  const wsItem = items.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.ok(wsItem !== undefined, '配置内容不同 → 仍应有 pnpm-workspace 项');
  const r = await adapter.applyItem(wsItem!, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(r.ok, true);
  assert.equal(
    new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/patches/mine.patch')!),
    'LOCAL VERSION\n',
    '配置项绝不能覆盖用户已否决（keepCurrent）的 patch 文件',
  );
  const written = new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/pnpm-workspace.yaml')!);
  assert.ok(written.includes('mine: patches/mine.patch'), '文件仍在 → 声明必须保留（否则白丢用户的补丁配置）');

  // 场景 B：目标机没有该文件、且 patch 项未被应用（用户跳过 / 被墓碑过滤）→
  // 声明必须被剔除，绝不留下「声明在、文件不在」的致命组合。
  const dst2 = makeContext('linux', '/home/bob2', 'web');
  const items2 = await adapter.analyzeImport(out.data, makeImportContext(dst2, new Map([['plugins', out.data]])));
  const wsItem2 = items2.find((i) => i.id === 'plugins:pnpm-workspace');
  const r2 = await adapter.applyItem(wsItem2!, makeImportContext(dst2, new Map([['plugins', out.data]])));
  assert.equal(r2.ok, true);
  const written2 = new TextDecoder().decode(dst2.fs.files.get('/home/bob2/profiles/web/pnpm-workspace.yaml')!);
  assert.ok(!written2.includes('patchedDependencies'), `悬空声明必须剔除: ${JSON.stringify(written2)}`);
  assert.equal(dst2.fs.files.has('/home/bob2/profiles/web/patches/mine.patch'), false, '配置项不得越权写 patch 文件');
});

test('plugins: 导出剔除插件自身（默认 dsh-config-manager，可配置）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.plugins.installed.set('dsh-config-manager', { name: 'dsh-config-manager', version: '0.1.28', enabled: true });
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true });
  ctx.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true });

  // 默认 selfName = dsh-config-manager → 从导出清单剔除
  const adapter = new PluginsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.plugins.length, 2, '自身应被剔除');
  assert.ok(!out.data.plugins.some((p) => p.name === 'dsh-config-manager'), '导出清单不应包含自身');
  assert.ok(out.data.plugins.some((p) => p.name === '@linxin666/dsh-ssh'));
  assert.ok(out.data.plugins.some((p) => p.name === 'dsh-memory-evolve'));

  // 空 selfName 表示不过滤（保留全部）
  const adapterAll = new PluginsAdapter('');
  const outAll = await adapterAll.export(ctx, { includeSecrets: false });
  assert.equal(outAll.data.plugins.length, 3, 'selfName="" 不过滤');

  // 可配置成任意包名（如 scope 化安装名）
  const adapterScoped = new PluginsAdapter('@scope/dsh-config-manager');
  const outScoped = await adapterScoped.export(ctx, { includeSecrets: false });
  assert.equal(outScoped.data.plugins.length, 3, '不同包名不匹配 → 不过滤');
});

test('plugins: 导出清单与 patch 行', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true, isBundle: true, inBundles: ['@linxin666/dsh-web-ui-all'] });
  ctx.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true, spec: 'github:csyangwen/dsh-memory-evolve' });
  ctx.plugins.installed.set('@deepseek-ai/dsh-base', { name: '@deepseek-ai/dsh-base', version: '0.1.0-rc.6', enabled: true });
  ctx.patchFile.lines.set('skill-badge', { lineId: 'skill-badge', raw: { id: 'skill-badge', disabled: true } });

  const adapter = new PluginsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.equal(out.data.plugins.length, 3);
  assert.equal(out.data.patch.length, 1);
  assert.equal(out.data.patch[0]?.lineId, 'skill-badge');
  const ssh = out.data.plugins.find((p) => p.name === '@linxin666/dsh-ssh');
  assert.equal(ssh?.isBundle, true);
  assert.deepEqual(ssh?.inBundles, ['@linxin666/dsh-web-ui-all']);
  // 非 registry spec 必须随导出保留（导入时按此重装）
  const mem = out.data.plugins.find((p) => p.name === 'dsh-memory-evolve');
  assert.equal(mem?.spec, 'github:csyangwen/dsh-memory-evolve');
  assert.equal(out.data.pnpmWorkspace, null, '目标无 pnpm-workspace.yaml → null');

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('plugins: 导出携带 pnpm-workspace.yaml；analyze 目标无文件 → Create', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode('allowBuilds:\n  ssh2: true\n'));
  const adapter = new PluginsAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.pnpmWorkspace, 'allowBuilds:\n  ssh2: true\n');

  // 目标机没有该文件 → Create；有相同内容 → Skip；有不同内容 → Update
  const dst = makeContext('linux', '/home/bob', 'web');
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  const wsItem = items.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.equal(wsItem?.kind, 'Create');
  assert.deepEqual(wsItem?.target, { adapter: 'plugins', ref: 'pnpm-workspace.yaml' });
  assert.equal(items[0]?.id, 'plugins:pnpm-workspace', 'pnpm-workspace 项必须先于插件安装项');

  // applyItem 写入目标 fs
  const r = await adapter.applyItem(wsItem!, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  const written = new TextDecoder().decode(dst.fs.files.get('/home/bob/profiles/web/pnpm-workspace.yaml')!);
  assert.equal(written, 'allowBuilds:\n  ssh2: true\n');

  // 内容一致 → Skip；不同 → Update
  const same = await adapter.analyzeImport(out.data, makeImportContext(dst, new Map([['plugins', out.data]])));
  assert.equal(same.some((i) => i.id === 'plugins:pnpm-workspace'), false, '内容一致 → 不生成项');
  const other = makeContext('linux', '/home/bob', 'web');
  await other.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode('nodeLinker: isolated\n'));
  const diff = await adapter.analyzeImport(out.data, makeImportContext(other, new Map([['plugins', out.data]])));
  const diffItem = diff.find((i) => i.id === 'plugins:pnpm-workspace');
  assert.equal(diffItem?.kind, 'Update');
});

test('plugins: 已装同版本 Skip / 未装 Install / 版本不同 Conflict / patch Create', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true });
  src.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '2.0.0', enabled: true });
  src.patchFile.lines.set('my-line', { lineId: 'my-line', raw: { id: 'my-line', name: 'pkg-c', config: { x: 1 } } });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true }); // 同版本
  dst.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.5.0', enabled: true }); // 不同版本
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get('plugin:pkg-a')?.kind, 'Skip');
  assert.equal(byId.get('plugin:pkg-b')?.kind, 'Conflict');
  assert.equal(byId.get('patch:my-line')?.kind, 'Create');
  assert.equal(byId.get('patch:my-line')?.target?.ref, 'my-line');

  // patch 行写入（Create）
  const r = await adapter.applyItem(byId.get('patch:my-line')!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.deepEqual(dst.patchFile.lines.get('my-line')?.raw, { id: 'my-line', name: 'pkg-c', config: { x: 1 } });
});

test('plugins: applyItem Install → needsRestart（官方机制，不打包二进制）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('need-install', { name: 'need-install', version: '3.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const installItem = items.find((i) => i.id === 'plugin:need-install');
  assert.equal(installItem?.kind, 'Install');
  assert.equal(installItem?.target, undefined, 'Install 项不做快照（不可回滚，如实报告）');
  const r = await adapter.applyItem(installItem!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.ok(dst.plugins.installed.has('need-install'), '经 installPlugin 门面写入');
});

test('plugins: 非 registry spec（github:）随导入传给 install，registry 包不传 spec', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('dsh-memory-evolve', { name: 'dsh-memory-evolve', version: '1.0.0', enabled: true, spec: 'github:csyangwen/dsh-memory-evolve' });
  src.plugins.installed.set('dshmarket', { name: 'dshmarket', version: '1.0.3', enabled: true, spec: '^1.0.3' });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  await adapter.applyItem(items.find((i) => i.id === 'plugin:dsh-memory-evolve')!, makeImportContext(dst, sections));
  assert.equal(dst.plugins.lastSpec, 'github:csyangwen/dsh-memory-evolve', 'github: spec 必须原样传给安装通道');

  await adapter.applyItem(items.find((i) => i.id === 'plugin:dshmarket')!, makeImportContext(dst, sections));
  assert.equal(dst.plugins.lastSpec, '^1.0.3', 'registry 版本区间也透传（由门面决定按裸名装最新）');
});

test('plugins: 安装失败 → 非致命 warning（§34.17，不触发整体回滚）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('broken-pkg', { name: 'broken-pkg', version: '3.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  // 显式指定 profile：缺省会回退到 `resolveProcessProfileName()`（读 DSH_PROFILE），
  // 在桌面端会话里那是 'desktop' → 断言随运行环境漂移（实测踩过）。
  const dst = makeContext('linux', '/home/bob', 'web');
  dst.plugins.failInstall = true; // 模拟 npm ERESOLVE / 网络不可达
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const installItem = items.find((i) => i.id === 'plugin:broken-pkg');
  assert.equal(installItem?.kind, 'Install');
  const r = await adapter.applyItem(installItem!, makeImportContext(dst, sections));
  assert.equal(r.ok, false);
  assert.equal(r.warning, true, '安装失败必须记为 warning（不计入失败、不触发回滚）');
  assert.match(r.message ?? '', /ERESOLVE/);
  assert.match(r.message ?? '', /dsh plugin --profile web add broken-pkg/, '失败报告必须给可复制的手动安装命令');
  assert.ok(!dst.plugins.installed.has('broken-pkg'), '安装失败不得假装已写入');
});

test('plugins: 版本冲突 useImported → Update 走安装通道，失败同样为 warning', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '2.0.0', enabled: true });
  const adapter = new PluginsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['plugins', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.5.0', enabled: true });
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const conflict = items.find((i) => i.id === 'plugin:pkg-b');
  assert.equal(conflict?.kind, 'Conflict');
  // 模拟 analyzer 在 createImportPlan 中对 useImported 的解析结果
  const updateItem: PlanItem = { ...conflict!, kind: 'Update', conflict: { itemId: conflict!.id, resolution: 'useImported' } };

  const rOk = await adapter.applyItem(updateItem, makeImportContext(dst, sections));
  assert.equal(rOk.ok, true, 'Update 应走安装通道，而不是报缺少 target.ref');
  assert.equal(rOk.needsRestart, true);

  dst.plugins.failInstall = true;
  const rFail = await adapter.applyItem(updateItem, makeImportContext(dst, sections));
  assert.equal(rFail.ok, false);
  assert.equal(rFail.warning, true, '更新失败同样为非致命 warning');
});
/* ---------------- preview：只读预览不得触发任何本地源打包（总览慢的根因） ---------------- */

test('plugins: preview 不调用打包钩子，但条目/白名单/告警与 export 同口径', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  src.plugins.installed.set('plain-pkg', { name: 'plain-pkg', version: '1.2.3', enabled: true });
  src.plugins.installed.set('local-pkg', { name: 'local-pkg', version: '0.1.0', enabled: true, spec: 'link:../local-pkg' });
  src.plugins.installed.set('dsh-config-manager', { name: 'dsh-config-manager', version: '9.9.9', enabled: true });
  src.patchFile.lines.set('line-a', { lineId: 'line-a', raw: { id: 'plain-pkg', disabled: true } });
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode([
    'allowBuilds:',
    '  ssh2: true',
    'patchedDependencies:',
    '  foo: patches/foo.patch',
    '',
  ].join('\n')));
  await src.fs.writeFile('profiles/web/patches/foo.patch', new TextEncoder().encode('diff --git a/x b/x\n'));

  let hookCalls = 0;
  const packedSpec = 'file:local-plugins/local-pkg-0.1.0.tgz';
  const adapter = new PluginsAdapter('dsh-config-manager', async () => {
    hookCalls += 1;
    return {
      packed: [{
        packageName: 'local-pkg',
        version: '0.1.0',
        relativePath: 'local-plugins/local-pkg-0.1.0.tgz',
        rewrittenSpec: packedSpec,
        data: new Uint8Array(2048),
      }],
      rewritten: { 'local-pkg': packedSpec },
      warnings: [],
    };
  });

  const previewed = await adapter.preview(src, { includeSecrets: false });
  assert.equal(hookCalls, 0, 'preview 必须跳过 localPack（真机 12 个本地源插件 = 12 s）');

  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(hookCalls, 1, 'export 仍然打包（导入端靠 tarball 迁移本地源插件）');

  // 同口径：patch 行、pnpm-workspace、patch 文件逐字相同
  assert.deepEqual(previewed.section.data.patch, exported.data.patch);
  // 清单只差「本地源 spec 的可移植化改写」——预览没有 tarball，不能假装已改写；
  // 其余字段（包名/版本/启用态/bundle 归属）必须逐字相同
  assert.deepEqual(
    previewed.section.data.plugins.map((p) => ({ ...p, spec: p.spec === 'link:../local-pkg' ? packedSpec : p.spec })),
    exported.data.plugins,
    '预览清单与导出清单只允许在本地源 spec 上不同',
  );
  assert.equal(previewed.section.data.pnpmWorkspace, exported.data.pnpmWorkspace);
  assert.deepEqual(previewed.section.data.patchFiles, exported.data.patchFiles);
  assert.equal(previewed.section.data.localTarballs, undefined, '预览不携带 tarball 字节');
  assert.equal(previewed.section.counts.plugins, 2);
  assert.equal(previewed.section.counts.patchLines, 1);
  assert.equal(previewed.section.counts.patchFiles, 1);
  assert.equal(previewed.section.warnings.length, 0);
  assert.equal(previewed.section.sectionId, 'plugins');

  // 预览对本地源（link:）插件不做任何打包，但单元语义必须与导出产物一致：
  // 导出产物里该插件带 tarball ⇒ fileCount: 1；预览没有字节 ⇒ 体积 0，同样 fileCount: 1
  const previewLocal = previewed.items.find((u) => u.id === 'plugin:local-pkg');
  assert.equal(previewLocal?.sizeBytes, 0, 'MemFs 未实现 dirSizeBytes ⇒ 目录体积未知按 0（宿主不支持时的旧行为）');
  assert.equal(previewLocal?.fileCount, 1, 'link: 插件导出时必然携带一个 tarball ⇒ 预览也要标成文件单元');
  const exportedLocal = adapter.listUnits(exported).find((u) => u.id === 'plugin:local-pkg');
  assert.equal(exportedLocal?.fileCount, 1);

  // items 与 listUnits(预览产物) 恒等：用户按预览勾选 = 导出真的带什么
  assert.deepEqual(previewed.items, adapter.listUnits(previewed.section));

  // 体积口径 = 该分区载荷的 UTF-8 字节数（与 /export-preview 对 JSON 分区现算的口径一致）
  assert.equal(previewed.sizeBytes, new TextEncoder().encode(JSON.stringify(previewed.section.data)).length);
});

test('plugins: preview 零 spawn 量本地源体积（file: 走 stat、link: 走目录度量）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  // file: 相对路径以 profile 目录为基准（resolveLocalPluginPath 的契约）
  await src.fs.writeFile('profiles/web/pkgs/local.tgz', new Uint8Array(4096));
  src.plugins.installed.set('file-pkg', {
    name: 'file-pkg', version: '1.0.0', enabled: true, spec: 'file:pkgs/local.tgz',
  });
  src.plugins.installed.set('link-pkg', {
    name: 'link-pkg', version: '1.0.0', enabled: true, spec: 'link:../outside/link-pkg',
  });
  src.plugins.installed.set('registry-pkg', {
    name: 'registry-pkg', version: '1.0.0', enabled: true, spec: '^1.2.3',
  });
  // 宿主门面提供目录度量：link: 是 npm pack 的输入目录，量级比 pack 产物大（gzip），但零 spawn
  const measured: string[] = [];
  src.fs.dirSizeBytes = async (absPath: string) => {
    measured.push(absPath);
    return absPath.endsWith('link-pkg') ? 24_576 : null;
  };

  const adapter = new PluginsAdapter('dsh-config-manager', undefined);
  const previewed = await adapter.preview(src, { includeSecrets: false });
  const byId = new Map(previewed.items.map((u) => [u.id, u]));
  assert.equal(byId.get('plugin:file-pkg')?.sizeBytes, 4096, 'file: 源按 stat 得到的字节数');
  assert.equal(byId.get('plugin:file-pkg')?.fileCount, 1, '有本地源体积 = 随包携带一个文件');
  assert.equal(byId.get('plugin:link-pkg')?.sizeBytes, 24_576, 'link: 源按宿主门面的目录度量（绝对路径）');
  assert.equal(byId.get('plugin:link-pkg')?.fileCount, 1, 'link: 仍需打包迁移 ⇒ 与导出产物一样是「携带一个文件」的单元');
  assert.equal(measured.length, 1, '只量本地源目录，不碰 registry 包');
  assert.ok(measured[0]?.endsWith('link-pkg'), '绝对路径由 spec 推导（resolveLocalPluginPath）');
  assert.equal(byId.get('plugin:registry-pkg')?.sizeBytes, 0);
  assert.equal(byId.get('plugin:registry-pkg')?.fileCount, undefined, 'registry 包不带文件');
});

test('plugins: preview 的目录度量不可用/抛错时体积按 0，绝不因此失败', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  src.plugins.installed.set('link-pkg', {
    name: 'link-pkg', version: '1.0.0', enabled: true, spec: 'link:../outside/link-pkg',
  });

  // 宿主门面存在但越界抛错（真机：link: 目录在 $DSH_HOME 之外时 home 相对方法会抛 fsPathEscape）
  src.fs.dirSizeBytes = async () => {
    throw new Error('host.fsPathEscape');
  };
  const adapter = new PluginsAdapter('dsh-config-manager', undefined);
  const failed = await adapter.preview(src, { includeSecrets: false });
  assert.equal(
    failed.items.find((u) => u.id === 'plugin:link-pkg')?.sizeBytes,
    0,
    '度量抛错 ⇒ 体积按 0，但仍算「随包携带一个文件」',
  );
  assert.equal(failed.items.find((u) => u.id === 'plugin:link-pkg')?.fileCount, 1);
  assert.equal(failed.section.warnings.length, 0, '体积只是展示数字，不得变成分区告警');
});

test('plugins: preview 的条目级白名单与 export 一致（含原子组全或无）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'web');
  src.plugins.installed.set('pkg-a', { name: 'pkg-a', version: '1.0.0', enabled: true });
  src.plugins.installed.set('pkg-b', { name: 'pkg-b', version: '1.0.0', enabled: true });
  src.patchFile.lines.set('line-a', { lineId: 'line-a', raw: { id: 'pkg-a', disabled: true } });
  await src.fs.writeFile('profiles/web/pnpm-workspace.yaml', new TextEncoder().encode([
    'allowBuilds:',
    '  ssh2: true',
    'patchedDependencies:',
    '  foo: patches/foo.patch',
    '',
  ].join('\n')));
  await src.fs.writeFile('profiles/web/patches/foo.patch', new TextEncoder().encode('diff --git a/x b/x\n'));

  const adapter = new PluginsAdapter('dsh-config-manager', undefined);
  const only = ['plugin:pkg-a', 'plugins:pnpm-workspace', 'plugins:patch:patches/foo.patch'];
  // 注：白名单只影响「保留哪些单元」，不影响预览是否打包 —— preview 永远不打包
  const previewed = await adapter.preview(src, { includeSecrets: false, includeItems: { plugins: only } });
  const exported = await adapter.export(src, { includeSecrets: false, includeItems: { plugins: only } });
  assert.deepEqual(previewed.section.data, exported.data);
  assert.deepEqual(previewed.items, adapter.listUnits(previewed.section));

  // 取消 pnpm-workspace 时 patch 文件一并剔除（全或无），预览同样不产出半套
  const dropped = await adapter.preview(src, {
    includeSecrets: false,
    includeItems: { plugins: ['plugin:pkg-a', 'plugins:patch:patches/foo.patch'] },
  });
  assert.equal(dropped.section.data.pnpmWorkspace, null);
  assert.equal(dropped.section.data.patchFiles, undefined);
});

