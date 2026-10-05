/**
 * cache-cleaner 测试：缓存自动清理的保留期 / 白名单边界 / 容错。
 * 使用真实临时目录（node:os tmpdir）+ node:fs 真实读写（与 plugin-cli.fs.test.ts 同模式）。
 * 覆盖：
 *   - tmp：过期 .zip 删、新 .zip 留、非 zip 文件留、dsh-sync-pull-* 目录超期删
 *   - exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留
 *   - market/cache：过期 index.json / items 条目删；新条目留；删空后回收 items/hash 目录
 *   - market/work：过期 git 副本删、新副本留
 *   - 保留期边界（恰好等于保留期 → 不删）、目录不存在 → 不抛错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupCaches,
  TMP_RETENTION_DEFAULT_MS,
  EXPORTS_RETENTION_DEFAULT_MS,
  MARKET_RETENTION_DEFAULT_MS,
} from './cache-cleaner.ts';
import { scanDiskUsage } from './disk-usage.ts';

/** 建独立临时数据目录，返回 { root, tmpDir, exportsDir, marketCacheRoot, marketWorkRoot, cleanup } */
async function makeDataDir(): Promise<{
  root: string;
  tmpDir: string;
  exportsDir: string;
  marketCacheRoot: string;
  marketWorkRoot: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cache-'));
  const tmpDir = path.join(root, 'tmp');
  const exportsDir = path.join(root, 'exports');
  const marketCacheRoot = path.join(root, 'market', 'cache');
  const marketWorkRoot = path.join(root, 'market', 'work');
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.mkdir(marketCacheRoot, { recursive: true });
  await fs.mkdir(marketWorkRoot, { recursive: true });
  return {
    root,
    tmpDir,
    exportsDir,
    marketCacheRoot,
    marketWorkRoot,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** 把目标 mtime 拨到指定毫秒（Windows 精度足够，测试用秒级偏移） */
async function touch(p: string, mtimeMs: number): Promise<void> {
  const st = await fs.stat(p);
  await fs.utimes(p, st.atimeMs ? new Date(st.atimeMs) : new Date(), new Date(mtimeMs));
}

test('tmp：过期 .zip 删、新 .zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldZip = path.join(d.tmpDir, 'upload-old.zip');
    const newZip = path.join(d.tmpDir, 'upload-new.zip');
    const txt = path.join(d.tmpDir, 'notes.txt');
    await fs.writeFile(oldZip, Buffer.alloc(10));
    await fs.writeFile(newZip, Buffer.alloc(20));
    await fs.writeFile(txt, 'keep me');
    await touch(oldZip, now - TMP_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newZip, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 zip');
    assert.equal(report.freedBytes, 10, '释放字节 = 被删文件 size');
    assert.equal(await fs.readFile(newZip).then((b) => b.length), 20, '新 zip 保留');
    assert.equal(await fs.readFile(txt, 'utf8'), 'keep me', '非 zip 文件保留');
    await assert.rejects(() => fs.stat(oldZip), '超期 zip 已删');
    assert.ok(report.detail.some((s) => s.includes('upload-old.zip')), 'detail 含删除记录');
  } finally {
    await d.cleanup();
  }
});

test('tmp：dsh-sync-pull-* 临时目录超期删、新目录留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldDir = path.join(d.tmpDir, 'dsh-sync-pull-abc');
    const newDir = path.join(d.tmpDir, 'dsh-sync-pull-def');
    const otherDir = path.join(d.tmpDir, 'keep-dir');
    await fs.mkdir(path.join(oldDir, 'inner'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'inner'), { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'inner', 'snapshot.zip'), Buffer.alloc(5));
    await touch(oldDir, now - TMP_RETENTION_DEFAULT_MS - 5000);
    await touch(newDir, now - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 sync 临时目录');
    await assert.rejects(() => fs.stat(oldDir), '超期 sync 目录整棵已删');
    assert.ok(await fs.stat(newDir), '新 sync 目录保留');
    assert.ok(await fs.stat(otherDir), '无关目录保留');
  } finally {
    await d.cleanup();
  }
});

test('exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldExport = path.join(d.exportsDir, 'dsh-config-old.zip');
    const newExport = path.join(d.exportsDir, 'dsh-config-new.zip');
    const readme = path.join(d.exportsDir, 'readme.txt');
    await fs.writeFile(oldExport, Buffer.alloc(15));
    await fs.writeFile(newExport, Buffer.alloc(25));
    await fs.writeFile(readme, 'keep');
    await touch(oldExport, now - EXPORTS_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newExport, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期导出 zip');
    assert.equal(report.freedBytes, 15, '释放字节 = 被删文件 size');
    await assert.rejects(() => fs.stat(oldExport), '超期导出 zip 已删');
    assert.ok(await fs.stat(newExport), '新导出 zip 保留');
    assert.equal(await fs.readFile(readme, 'utf8'), 'keep', '非 zip 文件保留');
    assert.ok(report.detail.some((s) => s.includes('exports/')), 'detail 含 exports 删除记录');
  } finally {
    await d.cleanup();
  }
});

test('exports：豁免前缀（定时备份 dsh-config-auto-*）超期也不删，保留策略归备份调度器', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldAuto = path.join(d.exportsDir, 'dsh-config-auto-old.zip');
    const oldManual = path.join(d.exportsDir, 'dsh-config-old.zip');
    await fs.writeFile(oldAuto, Buffer.alloc(9));
    await fs.writeFile(oldManual, Buffer.alloc(11));
    await touch(oldAuto, now - EXPORTS_RETENTION_DEFAULT_MS - 1000); // 超期
    await touch(oldManual, now - EXPORTS_RETENTION_DEFAULT_MS - 1000); // 超期

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      exportsExemptPrefix: 'dsh-config-auto-',
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删手动导出，豁免前缀保留');
    await assert.rejects(() => fs.stat(oldManual), '超期手动导出 zip 已删');
    assert.equal(await fs.readFile(oldAuto).then((b) => b.length), 9, '豁免前缀（定时备份）即使超期也不删');
    assert.ok(report.detail.some((s) => s.includes('dsh-config-old.zip')), 'detail 只含手动导出删除记录');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：全过期 → 条目、items 目录、hash 目录依次回收', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash1');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    const index = path.join(hashDir, 'index.json');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.writeFile(path.join(oldItem, 'config.zip'), Buffer.alloc(7));
    await fs.writeFile(index, '{}');
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);
    await touch(index, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    // 删除：index.json + 条目 + 空 items 目录 + 空 hash 目录
    assert.equal(report.removed, 4, 'index、条目、items 目录、hash 目录依次回收');
    await assert.rejects(() => fs.stat(oldItem), '过期条目已删');
    await assert.rejects(() => fs.stat(index), '过期 index.json 已删');
    await assert.rejects(() => fs.stat(itemsDir), 'items 目录删空后已回收');
    await assert.rejects(() => fs.stat(hashDir), 'hash 目录删空后已回收');
    assert.ok(await fs.stat(d.marketCacheRoot), 'market/cache 根保留');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：有过期条目但 index.json 保留（未过期）时 hash 目录不被回收', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash2');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.writeFile(path.join(hashDir, 'index.json'), '{}');
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 2, '条目 + 空 items 目录被回收');
    assert.ok(await fs.stat(hashDir), 'index.json 未过期 → hash 目录保留');
    assert.ok(await fs.stat(path.join(hashDir, 'index.json')), 'index.json 保留');
  } finally {
    await d.cleanup();
  }
});

test('market/cache：有新条目时 items/hash 目录不被回收，新条目保留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash3');
    const itemsDir = path.join(hashDir, 'items');
    const oldItem = path.join(itemsDir, 'old-item');
    const newItem = path.join(itemsDir, 'new-item');
    await fs.mkdir(oldItem, { recursive: true });
    await fs.mkdir(newItem, { recursive: true });
    await touch(oldItem, now - MARKET_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删过期条目，items/hash 目录因新条目保留');
    await assert.rejects(() => fs.stat(oldItem), '过期条目已删');
    assert.ok(await fs.stat(newItem), '新条目保留');
    assert.ok(await fs.stat(itemsDir), 'items 目录保留（仍有新条目）');
    assert.ok(await fs.stat(hashDir), 'hash 目录保留');
  } finally {
    await d.cleanup();
  }
});

test('market/work：过期 git 副本删、新副本留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldWork = path.join(d.marketWorkRoot, 'oldhash');
    const newWork = path.join(d.marketWorkRoot, 'newhash');
    await fs.mkdir(path.join(oldWork, '.git'), { recursive: true });
    await fs.mkdir(path.join(newWork, '.git'), { recursive: true });
    await touch(oldWork, now - MARKET_RETENTION_DEFAULT_MS - 1000);
    await touch(newWork, now - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删过期 git 副本');
    await assert.rejects(() => fs.stat(oldWork), '过期副本整棵已删');
    assert.ok(await fs.stat(newWork), '新副本保留');
  } finally {
    await d.cleanup();
  }
});

test('保留期边界：恰好等于保留期 → 不删（超期判定为严格大于）', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const zip = path.join(d.tmpDir, 'upload-boundary.zip');
    await fs.writeFile(zip, Buffer.alloc(3));
    await touch(zip, now - TMP_RETENTION_DEFAULT_MS); // 恰好 = 保留期

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });

    assert.equal(report.removed, 0, '边界文件不删');
    assert.ok(await fs.stat(zip), '边界 zip 保留');
  } finally {
    await d.cleanup();
  }
});

test('容错：目录不存在 → 不抛错、removed=0', async () => {
  const d = await makeDataDir();
  try {
    const report = await cleanupCaches({
      tmpDir: path.join(d.root, 'no-such-tmp'),
      exportsDir: path.join(d.root, 'no-such-exports'),
      marketCacheRoot: path.join(d.root, 'no-such-cache'),
      marketWorkRoot: path.join(d.root, 'no-such-work'),
    });
    assert.equal(report.removed, 0);
    // e2e-F3（t14 修订）：四个缺失目录**不再计入 errors**。原断言 `errors === 4` 钉住的正是被真机
    // 判定为缺陷的行为（全新安装时 market/cache、market/work 尚未创建 → 前端误报「清理失败 N 项」）。
    // ENOENT（不存在）≠ 读失败：真正的 EACCES/EBUSY 仍然计数（见下一条用例）。
    assert.equal(report.errors, 0, '可选目录不存在不计入 errors');
  } finally {
    await d.cleanup();
  }
});

/**
 * R2（t41）：isENOENT 门**两侧**都要有持久回归 —— 目录**不存在**（ENOENT）不计错；
 * 目录**存在却读不动**（tmpDir 指向文件 → ENOTDIR）**必须**计错。只钉一侧的话，
 * 将来把门放宽成「吞掉一切错误」就没人拦了（「读不到 ≠ 没有」是本仓库的既有硬约束）。
 * base sha 3f42a8b 上本用例红：前半段 errors=4（ENOENT 也被计错）。
 */
test('R2：目录不存在（ENOENT）不计错，但存在却读不动（ENOTDIR）必须计错', async () => {
  const d = await makeDataDir();
  try {
    const notADir = path.join(d.root, 'tmp-is-a-file');
    await fs.writeFile(notADir, 'not a directory');
    const unreadable = await cleanupCaches({
      tmpDir: notADir,
      exportsDir: path.join(d.root, 'no-such-exports'),
      marketCacheRoot: path.join(d.root, 'no-such-cache'),
      marketWorkRoot: path.join(d.root, 'no-such-work'),
      includeRecent: true,
    });
    assert.ok(
      unreadable.errors >= 1,
      '存在却读不动（ENOTDIR）必须计入 errors，实际 errors=' + String(unreadable.errors),
    );
    assert.equal(unreadable.removed, 0);

    const missing = await cleanupCaches({
      tmpDir: path.join(d.root, 'no-such-tmp'),
      exportsDir: path.join(d.root, 'no-such-exports'),
      marketCacheRoot: path.join(d.root, 'no-such-cache'),
      marketWorkRoot: path.join(d.root, 'no-such-work'),
    });
    assert.equal(missing.errors, 0, '目录不存在（ENOENT）不得计入 errors');
  } finally {
    await d.cleanup();
  }
});

/**
 * e2e-F3 回归（真机 p9b）：全新安装形态 —— 可选目录 market/cache / market/work 还没被创建，
 * 而本次清理**真的删掉了文件**。修前 errors 恰等于缺失目录数，前端于是弹红色「清理失败 N 项」
 * 而 detail 为空（无可操作信息）。
 */
test('e2e-F3：可选目录不存在时，真删了文件也不得报错', async () => {
  const d = await makeDataDir();
  try {
    await fs.rm(d.marketCacheRoot, { recursive: true, force: true });
    await fs.rm(d.marketWorkRoot, { recursive: true, force: true });
    await fs.writeFile(path.join(d.tmpDir, 'upload-a.zip'), Buffer.alloc(10));
    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      includeRecent: true,
    });
    assert.equal(report.removed, 1, '本次真的删掉了 1 个文件');
    assert.equal(report.errors, 0, '缺失的可选目录不得计入 errors（修前 = 2）');
    assert.equal(report.detail.length, 1, 'detail 只应有真实删除记录');
  } finally {
    await d.cleanup();
  }
});

test('自定义保留期生效（market 保留期缩短 → 较早条目被删）', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const hashDir = path.join(d.marketCacheRoot, 'hash3');
    const itemDir = path.join(hashDir, 'items', 'x');
    await fs.mkdir(itemDir, { recursive: true });
    await touch(itemDir, now - 2 * 60 * 1000); // 2 分钟前

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      marketRetentionMs: 60 * 1000, // 1 分钟保留期
      now: () => now,
    });

    assert.equal(report.removed, 3, '条目 + items + hash 目录全部回收');
    await assert.rejects(() => fs.stat(hashDir));
  } finally {
    await d.cleanup();
  }
});

/* ---------------- m-disk-usage：手动「立即清理」语义 ---------------- */

test('includeRecent：忽略保留期清空可重建区，但**绝不**动导出产物', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    // 保留期内的新文件（自动清理会保留它们）
    const freshTmp = path.join(d.tmpDir, 'upload-fresh.zip');
    const freshIndex = path.join(d.marketCacheRoot, 'h4', 'index.json');
    const freshWork = path.join(d.marketWorkRoot, 'h4');
    const freshExport = path.join(d.exportsDir, 'dsh-config-just-exported.zip');
    const oldExport = path.join(d.exportsDir, 'dsh-config-old.zip');
    await fs.writeFile(freshTmp, Buffer.alloc(11));
    await fs.mkdir(path.dirname(freshIndex), { recursive: true });
    await fs.writeFile(freshIndex, '{}');
    await fs.mkdir(freshWork, { recursive: true });
    await fs.writeFile(freshExport, Buffer.alloc(5));
    await fs.writeFile(oldExport, Buffer.alloc(7));
    await touch(oldExport, now - EXPORTS_RETENTION_DEFAULT_MS - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      includeRecent: true,
      now: () => now,
    });

    // 可重建区：保留期内也照清
    await assert.rejects(() => fs.stat(freshTmp), 'tmp 立即清空');
    await assert.rejects(() => fs.stat(freshIndex), '市场缓存立即清空');
    await assert.rejects(() => fs.stat(freshWork), '市场工作副本立即清空');
    // 导出产物：新文件保留（用户的备份文件绝不「立即清空」），过期文件照旧回收
    assert.equal((await fs.stat(freshExport)).size, 5, '新导出文件必须保留');
    await assert.rejects(() => fs.stat(oldExport), '过期导出文件仍按保留期回收');
    // 结果形状：sections 覆盖四个分区；目录删除计入 freedBytesRecursive
    assert.deepEqual([...report.sections].sort(), ['exports', 'marketCache', 'marketWork', 'tmp']);
    assert.ok(report.freedBytesRecursive >= 11 + 2 + 7, '目录体积按删除前递归统计');
  } finally {
    await d.cleanup();
  }
});

test('缺省（无 includeRecent）仍只清超期项：保留期内的 tmp 文件不动', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const fresh = path.join(d.tmpDir, 'upload-fresh.zip');
    await fs.writeFile(fresh, Buffer.alloc(9));
    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      now: () => now,
    });
    assert.equal(report.removed, 0);
    assert.equal((await fs.stat(fresh)).size, 9, '自动清理必须沿用保留期');
    assert.equal(report.freedBytesRecursive, 0);
  } finally {
    await d.cleanup();
  }
});


test('cross-F1：/disk-usage 报为可回收的 tmp 残留，cleanup 必须真的删掉（界面数字 = 按钮效果）', async () => {
  const d = await makeDataDir();
  try {
    // t33 真实杀进程实验的实际残留命名（导出中断的原子写半成品）+ 常规暂存物
    await fs.writeFile(path.join(d.tmpDir, 'export-plain-dd381e1b.zip.tmp-hso-99d4cf9c5f8e'), Buffer.alloc(14046, 7));
    await fs.writeFile(path.join(d.tmpDir, '.dshcm.demo.json.1504.1bbe1211075cd69d.tmp'), 'partial');
    await fs.mkdir(path.join(d.tmpDir, 'dsh-sync-pull-abc'), { recursive: true });
    await fs.writeFile(path.join(d.tmpDir, 'dsh-sync-pull-abc', 'inner.zip'), 'y');
    await fs.writeFile(path.join(d.tmpDir, 'upload-legacy.zip'), 'z');

    const dirs = {
      dataDir: d.root,
      exportsDir: d.exportsDir,
      snapshotsDir: path.join(d.root, 'snapshots'),
      syncDir: path.join(d.root, 'sync'),
      marketCacheDir: d.marketCacheRoot,
      marketWorkDir: d.marketWorkRoot,
      tmpDir: d.tmpDir,
      logsDir: path.join(d.root, 'logs'),
      bootStateDir: path.join(d.root, 'boot-state'),
      migrationHistoryDir: path.join(d.root, 'migration-history'),
      transactionsDir: path.join(d.root, 'transactions'),
      locksDir: path.join(d.root, 'locks'),
      vaultDir: path.join(d.root, 'vault'),
    };
    const policy = {
      exportsRetentionMs: EXPORTS_RETENTION_DEFAULT_MS,
      marketRetentionMs: MARKET_RETENTION_DEFAULT_MS,
      tmpRetentionMs: TMP_RETENTION_DEFAULT_MS,
    };
    const before = await scanDiskUsage({ dirs, policy });
    assert.equal(before.areas.tmp.policy, 'regenerable');
    assert.ok(before.areas.tmp.sizeBytes > 0, '前置：tmp 有字节');

    const r = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      marketCacheRoot: d.marketCacheRoot,
      marketWorkRoot: d.marketWorkRoot,
      sections: ['tmp'],
      includeRecent: true,
    });
    assert.ok(r.removed >= 4, '清理必须真删（tmp 顶层 4 条：残留半成品 ×2 + sync 临时目录 + 暂存 zip；实际 removed=' + String(r.removed) + '）');

    const after = await scanDiskUsage({ dirs, policy });
    assert.equal(after.areas.tmp.sizeBytes, 0, '/disk-usage 报为可回收的 tmp 字节必须在 cleanup 后全部消失');
    assert.equal(after.areas.tmp.fileCount, 0, '被计数的 tmp 条目也必须是 0');
    assert.deepEqual(await fs.readdir(d.tmpDir), [], 'tmp 目录必须被整块清空');
  } finally {
    await d.cleanup();
  }
});
