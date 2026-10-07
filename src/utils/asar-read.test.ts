/**
 * 最小只读 asar 读取器单测（缺口⑤）。
 *
 * 全部用**测试内构造的合成 asar**（与真机容器同构：8 字节包长 pickle + 头 pickle + 数据区），
 * 不依赖真机 121 MB 的 app.asar：
 *  · 正常嵌套条目（含依赖闭包 + 不相关包不得被取出）；
 *  · 缺失条目 / 越界路径 / 非普通条目（link）→ undefined 或明确失败码；
 *  · 畸形 header / 截断文件 → 明确错误，**不抛死**给调用方（extract 一律返回结论）；
 *  · 缓存可注入、命中即复用、清单损坏回落到重新解包、原子发布不留临时目录；
 *  · 源 asar 只读（size + mtime 跑前跑后未变，安装目录不得多出任何文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AsarReadError,
  clearAsarIndexCache,
  defaultAsarCacheDir,
  extractAsarPackages,
  isSafeAsarPath,
  readAsarEntry,
  readAsarIndex,
  readAsarTextEntry,
} from './asar-read.ts';

/* --------------------------------------------------------- 合成 asar 构造 */

interface SynthFile {
  /** 文件内容（字符串按 UTF-8） */
  content?: string | Buffer;
  /** 强制 offset（构造「条目越界」用） */
  offset?: number;
  /** 强制 size（构造「条目越界」用） */
  size?: number;
  /** asarUnpack 条目：容器内不留数据 */
  unpacked?: boolean;
  /** 符号链接：非普通条目 */
  link?: string;
}

/** 一个 pickle 字符串载荷：[payloadSize][jsonLength][json][0~3 对齐填充]。 */
function pickleHeader(json: string): Buffer {
  const bytes = Buffer.from(json, 'utf8');
  const padded = (bytes.length + 3) & ~3;
  const payload = Buffer.alloc(4 + padded);
  payload.writeUInt32LE(bytes.length, 0);
  bytes.copy(payload, 4);
  const header = Buffer.alloc(4 + payload.length);
  header.writeUInt32LE(payload.length, 0);
  payload.copy(header, 4);
  return header;
}

/** 与真机同构的合成 asar（路径用 '/' 分段；'/' 前的段自动成为目录）。 */
function buildAsar(files: Record<string, SynthFile>): Buffer {
  const body: Buffer[] = [];
  let bodyLength = 0;
  const tree: Record<string, unknown> = {};
  for (const [rel, def] of Object.entries(files)) {
    const parts = rel.split('/');
    let cursor = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i] as string;
      const existing = cursor[segment];
      if (existing === undefined) {
        const created: { files: Record<string, unknown> } = { files: {} };
        cursor[segment] = created;
        cursor = created.files;
      } else {
        cursor = (existing as { files: Record<string, unknown> }).files;
      }
    }
    const name = parts[parts.length - 1] as string;
    if (def.link !== undefined) {
      cursor[name] = { link: def.link };
      continue;
    }
    const bytes = def.content === undefined ? Buffer.alloc(0) : typeof def.content === 'string' ? Buffer.from(def.content, 'utf8') : def.content;
    const offset = def.offset ?? bodyLength;
    const size = def.size ?? bytes.length;
    cursor[name] = { size, offset: String(offset), ...(def.unpacked === true ? { unpacked: true } : {}) };
    if (def.offset === undefined && def.unpacked !== true) {
      body.push(bytes);
      bodyLength += bytes.length;
    }
  }
  const header = pickleHeader(JSON.stringify({ files: tree }));
  const out = Buffer.alloc(8 + header.length + bodyLength);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(header.length, 4);
  header.copy(out, 8);
  Buffer.concat(body).copy(out, 8 + header.length);
  return out;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-asar-read-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeAsar(dir: string, name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

/** 一份带依赖闭包的合成包树（外加一个**不相关**的包，用来验证不会顺带取出）。 */
const PKG_FILES: Record<string, SynthFile> = {
  'dsh/node_modules/@scope/pkg/package.json': { content: JSON.stringify({ name: '@scope/pkg', version: '1.0.0', type: 'module', main: 'index.js', dependencies: { '@scope/dep': '1.0.0' } }) },
  'dsh/node_modules/@scope/pkg/lib/index.js': { content: 'export const fromPkg = 1;\n' },
  'dsh/node_modules/@scope/dep/package.json': { content: JSON.stringify({ name: '@scope/dep', version: '1.0.0' }) },
  'dsh/node_modules/@scope/dep/index.js': { content: 'export const fromDep = 2;\n' },
  'dsh/node_modules/@scope/dep/extra/notes.txt': { content: 'nested file\n' },
  'dsh/node_modules/unrelated/package.json': { content: JSON.stringify({ name: 'unrelated', version: '9.9.9' }) },
  'dsh/node_modules/unrelated/index.js': { content: 'nope\n' },
};

/* ------------------------------------------------------------------- 用例 */

test('asar-read：合成容器 —— 解析头、读单个条目（offset 正确）、命中进程内索引缓存', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const file = await writeAsar(dir, 'app.asar', buildAsar(PKG_FILES));
    const index = await readAsarIndex(file);
    assert.equal(index.headerBytes > 8, true);
    assert.equal(index.files.size, 7);
    assert.equal(index.directories.has('dsh/node_modules/@scope/pkg'), true);
    assert.equal(index.files.get('dsh/node_modules/@scope/pkg/lib/index.js')?.size, Buffer.byteLength('export const fromPkg = 1;\n', 'utf8'));
    const text = await readAsarTextEntry(file, 'dsh/node_modules/@scope/pkg/lib/index.js');
    assert.equal(text, 'export const fromPkg = 1;\n');
    assert.equal(await readAsarTextEntry(file, 'dsh/node_modules/@scope/dep/extra/notes.txt'), 'nested file\n');
    // 同一路径第二次解析命中进程内索引（对象同一引用）
    assert.equal(await readAsarIndex(file), index);
  });
});

test('asar-read：正常嵌套条目 —— 依赖闭包取出、不相关包不取出、源 asar 只读', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const asarPath = await writeAsar(dir, 'app.asar', buildAsar(PKG_FILES));
    const cacheDir = path.join(dir, 'cache');
    const before = await fs.stat(asarPath);

    const result = await extractAsarPackages({ asarPath, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.cached, false);
    assert.deepEqual(result.packages.map((p) => p.name), ['@scope/pkg']);
    assert.equal(result.files, 5, '闭包 = @scope/pkg(2) + @scope/dep(3)');
    assert.deepEqual(result.unresolved, []);

    const read = (rel: string): Promise<string> => fs.readFile(path.join(result.dir, ...rel.split('/')), 'utf8');
    assert.equal(await read('dsh/node_modules/@scope/pkg/lib/index.js'), 'export const fromPkg = 1;\n');
    assert.equal(await read('dsh/node_modules/@scope/dep/extra/notes.txt'), 'nested file\n');
    await assert.rejects(fs.stat(path.join(result.dir, 'dsh', 'node_modules', 'unrelated')), /ENOENT/, '不相关包绝不能被取出');

    // 缓存清单 + 原子发布：缓存根下只有键目录，没有 .tmp- 残留
    const manifest = JSON.parse(await fs.readFile(path.join(result.dir, '.dsh-cm-asar.json'), 'utf8')) as { key: string; files: number };
    assert.equal(manifest.key, result.key);
    assert.equal(manifest.files, 5);
    assert.deepEqual(await fs.readdir(cacheDir), [result.key]);

    // 源 asar 只读：size + mtime 未变，安装目录条目没多
    const after = await fs.stat(asarPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['app.asar', 'cache'], '安装目录不得多出任何东西（缓存落在 cacheDir 里）');
  });
});

test('asar-read：缓存命中即复用（不重复解包），清单损坏则回落重新解包', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const asarPath = await writeAsar(dir, 'app.asar', buildAsar(PKG_FILES));
    const cacheDir = path.join(dir, 'cache');
    const first = await extractAsarPackages({ asarPath, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const marker = path.join(first.dir, 'dsh', 'node_modules', '@scope', 'pkg', 'lib', 'index.js');
    const markerBefore = (await fs.stat(marker)).mtimeMs;

    const second = await extractAsarPackages({ asarPath, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.cached, true, '命中清单即复用');
    assert.equal(second.dir, first.dir);
    assert.equal((await fs.stat(marker)).mtimeMs, markerBefore, '命中路径不得重写文件');
    assert.deepEqual(await fs.readdir(cacheDir), [first.key]);

    // 清单损坏 → 视为未命中 → 重新解包（仍然原子发布、不留 .tmp-）
    await fs.writeFile(path.join(first.dir, '.dsh-cm-asar.json'), '{ broken', 'utf8');
    const third = await extractAsarPackages({ asarPath, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.equal(third.cached, false);
    assert.deepEqual(await fs.readdir(cacheDir), [first.key]);
    assert.equal((await fs.stat(marker)).mtimeMs >= markerBefore, true);
  });
});

test('asar-read：缺失条目 / 越界路径 → undefined；缺失包 → unresolved-package', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const asarPath = await writeAsar(dir, 'app.asar', buildAsar(PKG_FILES));
    assert.equal(await readAsarEntry(asarPath, 'dsh/node_modules/@scope/pkg/missing.js'), undefined);
    assert.equal(await readAsarTextEntry(asarPath, 'dsh/node_modules/nope/package.json'), undefined);
    // 越界 / 绝对路径 / 反斜杠：直接拒绝（undefined），绝不去算路径
    assert.equal(await readAsarEntry(asarPath, '../secret.txt'), undefined);
    assert.equal(await readAsarEntry(asarPath, '/abs/secret.txt'), undefined);
    assert.equal(await readAsarEntry(asarPath, 'dsh\\node_modules\\pkg'), undefined);

    const missing = await extractAsarPackages({ asarPath, packages: ['@scope/nope'], resolveFrom: 'dsh/node_modules', cacheDir: path.join(dir, 'cache') });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.code : '', 'unresolved-package');

    const empty = await extractAsarPackages({ asarPath, packages: [], resolveFrom: 'dsh/node_modules', cacheDir: path.join(dir, 'cache') });
    assert.equal(empty.ok === false ? empty.code : '', 'unresolved-package');

    const badPrefix = await extractAsarPackages({ asarPath, packages: ['@scope/pkg'], resolveFrom: '../..', cacheDir: path.join(dir, 'cache') });
    assert.equal(badPrefix.ok === false ? badPrefix.code : '', 'unsafe-entry');
  });
});

test('asar-read：非普通条目（link / 目录）拒绝；越界名字不进索引', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const asarPath = await writeAsar(dir, 'app.asar', buildAsar({
      'dsh/node_modules/pkg/package.json': { content: '{"name":"pkg"}' },
      'dsh/node_modules/pkg/real.js': { content: 'ok\n' },
      'dsh/node_modules/pkg/link.js': { link: '../outside.js' },
      '..': { content: 'escape\n' },
    }));
    const index = await readAsarIndex(asarPath);
    assert.equal(index.files.has('dsh/node_modules/pkg/link.js'), false, 'link 条目不得进索引');
    assert.equal(index.files.has('..'), false, '越界名字不得进索引');
    assert.equal(await readAsarEntry(asarPath, 'dsh/node_modules/pkg/link.js'), undefined);
    const result = await extractAsarPackages({ asarPath, packages: ['pkg'], resolveFrom: 'dsh/node_modules', cacheDir: path.join(dir, 'cache') });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.files, 2, '只有两个普通文件被取出');
    await assert.rejects(fs.stat(path.join(result.dir, 'dsh', 'node_modules', 'pkg', 'link.js')), /ENOENT/);

    assert.equal(isSafeAsarPath('a/../b'), false);
    assert.equal(isSafeAsarPath('a/./b'), false);
    assert.equal(isSafeAsarPath('/a'), false);
    assert.equal(isSafeAsarPath('a\\b'), false);
    assert.equal(isSafeAsarPath('a/b'), true);
  });
});

test('asar-read：畸形 header → malformed-header（明确错误，不抛死调用方）', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const readError = async (bytes: Buffer): Promise<string> => {
      const file = await writeAsar(dir, 'bad-' + Math.random().toString(36).slice(2) + '.asar', bytes);
      try {
        await readAsarIndex(file);
        return 'no-error';
      } catch (error) {
        assert.equal(error instanceof AsarReadError, true, String(error));
        return (error as AsarReadError).code;
      }
    };
    // 头 pickle 合法但 JSON 不是 JSON
    const notJson = (() => {
      const header = pickleHeader('this is not json');
      const out = Buffer.alloc(8 + header.length);
      out.writeUInt32LE(4, 0);
      out.writeUInt32LE(header.length, 4);
      header.copy(out, 8);
      return out;
    })();
    assert.equal(await readError(notJson), 'malformed-header');
    // JSON 是对象但没有 files
    const headerNoFiles = pickleHeader(JSON.stringify({ nope: true }));
    const noFiles = Buffer.alloc(8 + headerNoFiles.length);
    noFiles.writeUInt32LE(4, 0);
    noFiles.writeUInt32LE(headerNoFiles.length, 4);
    headerNoFiles.copy(noFiles, 8);
    assert.equal(await readError(noFiles), 'malformed-header');
    // 全 0xFF 的假头：headerBytes 越界 → truncated（而不是把内存打爆）
    assert.equal(await readError(Buffer.alloc(64, 0xff)), 'truncated');

    // extract 侧同样只返回结论（绝不 throw）
    const file = await writeAsar(dir, 'malformed.asar', notJson);
    const result = await extractAsarPackages({ asarPath: file, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir: path.join(dir, 'cache') });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : '', 'malformed-header');
  });
});

test('asar-read：截断文件 → truncated（8 字节以内 / 头被切 / 条目越界）', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const good = buildAsar(PKG_FILES);
    const cases: { name: string; bytes: Buffer }[] = [
      { name: 'tiny', bytes: Buffer.from([1, 2, 3]) },
      { name: 'half-header', bytes: good.subarray(0, 400) },
      { name: 'no-body', bytes: good.subarray(0, good.length - 8) },
    ];
    for (const item of cases) {
      const file = await writeAsar(dir, item.name + '.asar', item.bytes);
      await assert.rejects(readAsarIndex(file), (error: unknown) => error instanceof AsarReadError && error.code === 'truncated', item.name);
      const result = await extractAsarPackages({ asarPath: file, packages: ['@scope/pkg'], resolveFrom: 'dsh/node_modules', cacheDir: path.join(dir, 'cache') });
      assert.equal(result.ok === false ? result.code : 'ok', 'truncated', item.name);
    }
    // 条目自身越界（offset 超出文件尾）→ truncated
    const outOfRange = buildAsar({ 'dsh/node_modules/pkg/package.json': { content: '{"name":"pkg"}', offset: 10_000_000 } });
    const file = await writeAsar(dir, 'oor.asar', outOfRange);
    await assert.rejects(readAsarIndex(file), (error: unknown) => error instanceof AsarReadError && error.code === 'truncated');
  });
});

test('asar-read：容器不存在 / 不是文件 → not-found；缺省缓存根正确', async () => {
  await withTmp(async (dir) => {
    clearAsarIndexCache();
    const result = await extractAsarPackages({ asarPath: path.join(dir, 'nope.asar'), packages: ['x'], cacheDir: path.join(dir, 'cache') });
    assert.equal(result.ok === false ? result.code : '', 'not-found');
    const dirAsContainer = await extractAsarPackages({ asarPath: dir, packages: ['x'], cacheDir: path.join(dir, 'cache') });
    assert.equal(dirAsContainer.ok === false ? dirAsContainer.code : '', 'not-found');
    assert.equal(defaultAsarCacheDir(), path.join(os.tmpdir(), 'dsh-cm-asar-codec'));
  });
});
