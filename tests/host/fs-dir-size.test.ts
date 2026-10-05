/**
 * `FileSystemFacade.dirSizeBytes` 的**真实文件系统**验证 + 插件预览的接线守卫。
 *
 * 为什么需要真机级测试：这是「只读预览给出本地源插件体积」的唯一度量入口，语义全是与真实
 * 文件系统相关的细节（递归合计、跳过 node_modules、不跟随链接目录、`maxEntries` 兜底、
 * 非目录 → null）。单测里的 MemFs 是内存 Map，验不出这些；同时它又是**唯一**允许访问
 * `$DSH_HOME` 之外绝对路径的度量（真机 12 个 `link:` 插件全在桌面端 resources 目录里），
 * 所以边界必须钉死：越界要能测、链接目录不能跟、node_modules 不能数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DshFileSystemFacade } from '../../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsSource = fsSync.readFileSync(path.join(root, 'src/adapters/plugins.ts'), 'utf8');

/** 建一个「像本地源插件」的目录树：源码若干层 + 一个巨大的 node_modules。 */
async function makePluginDir(base: string): Promise<void> {
  await fs.mkdir(path.join(base, 'src', 'deep'), { recursive: true });
  await fs.mkdir(path.join(base, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(base, 'index.js'), 'a'.repeat(1000));
  await fs.writeFile(path.join(base, 'src', 'deep', 'mod.js'), 'b'.repeat(500));
  await fs.writeFile(path.join(base, 'node_modules', 'left-pad', 'index.js'), 'c'.repeat(999_999));
}

test('dirSizeBytes：递归合计常规文件、跳过 node_modules，非目录/缺失 → null', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-dirsize-'));
  try {
    await makePluginDir(path.join(home, 'pkg'));
    const facade = new DshFileSystemFacade(home);
    assert.equal(
      await facade.dirSizeBytes(path.join(home, 'pkg')),
      1500,
      '递归合计常规文件；node_modules 整个跳过（npm pack 自身也排除它，数进去量级会错一个数量级）',
    );
    assert.equal(
      await facade.dirSizeBytes(path.join(home, 'pkg', 'index.js')),
      null,
      '不是目录 → null（调用方对这类路径退回「体积按 0」，与 statSize 对目录返回 null 同语义）',
    );
    assert.equal(await facade.dirSizeBytes(path.join(home, 'gone')), null, '不存在 → null');
    assert.equal(
      await facade.dirSizeBytes(path.join(home, 'pkg'), { maxEntries: 1 }),
      1000,
      'maxEntries 兜底：超限即停并返回已累计值（宁可低估，也不让预览卡在一个超大目录上）',
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('dirSizeBytes：不受 home 边界限制（真机 link: 源在 $DSH_HOME 之外）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-dirsize-home-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-dirsize-outside-'));
  try {
    await fs.mkdir(path.join(outside, 'dsh-tauri'), { recursive: true });
    await fs.writeFile(path.join(outside, 'dsh-tauri', 'index.js'), 'd'.repeat(2048));
    const facade = new DshFileSystemFacade(home);
    assert.equal(
      await facade.dirSizeBytes(outside),
      2048,
      'link: 目录常在 $DSH_HOME 之外（桌面端 resources）：本方法与 realpathDir 同族，走绝对路径且不受 home 边界限制',
    );
    // 对照：home 相对路径家族仍然挡死越界（不得因新增方法开洞）
    await assert.rejects(() => facade.mtimeMs('../outside/index.js'), 'home 相对路径的越界约束不变');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('dirSizeBytes：不跟随符号链接 / junction 目录（不绕圈、不跑出该目录）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-dirsize-link-'));
  try {
    const pkg = path.join(home, 'pkg');
    await makePluginDir(pkg);
    const elsewhere = path.join(home, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(elsewhere, 'huge.js'), 'e'.repeat(500_000));
    try {
      await fs.symlink(elsewhere, path.join(pkg, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // 无符号链接权限的环境（未开开发者模式的 Windows）：跳过这一条，其余语义仍被本文件覆盖
      assert.ok(error instanceof Error);
      return;
    }
    const facade = new DshFileSystemFacade(home);
    assert.equal(
      await facade.dirSizeBytes(pkg),
      1500,
      '链接目录既不是文件也不是目录（readdir 的 isDirectory() 对它恒为 false）⇒ 跳过，绝不跟进去',
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('插件预览接线：link: 源必须走门面度量，适配器内不得手写目录递归', () => {
  const start = pluginsSource.indexOf('async function measureLocalSources');
  assert.ok(start > 0, '未找到 measureLocalSources');
  const block = pluginsSource.slice(start, start + 2200);
  assert.match(block, /const dirSize = ctx\.fs\.dirSizeBytes;/, '目录体积必须取自宿主门面（跳过 node_modules / 链接目录的规则只有一处）');
  assert.match(block, /kind === 'link'[\s\S]{0,80}dirSize\.call\(ctx\.fs, abs\)/, 'link: 源走 dirSizeBytes');
  assert.doesNotMatch(block, /readdir|listRecursive/, '适配器里绝不手写目录递归（local-plugin-pack.ts 的安全约束）');
});
