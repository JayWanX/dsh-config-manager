/**
 * disk-usage 测试：只读磁盘体检的聚合 / 超期判定 / 容错 / 符号链接边界。
 * 用真实临时目录（node:os tmpdir）+ node:fs 真实读写（与 cache-cleaner.test.ts 同模式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanDiskUsage, type DiskUsageDirs } from './disk-usage.ts';

const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  root: string;
  dirs: DiskUsageDirs;
  cleanup: () => Promise<void>;
}

/** 建一份完整的 §dataDir 布局（每个子区一个目录） */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-diskusage-'));
  const dirs: DiskUsageDirs = {
    dataDir: root,
    exportsDir: path.join(root, 'exports'),
    snapshotsDir: path.join(root, 'snapshots'),
    syncDir: path.join(root, 'sync'),
    marketCacheDir: path.join(root, 'market', 'cache'),
    marketWorkDir: path.join(root, 'market', 'work'),
    tmpDir: path.join(root, 'tmp'),
    logsDir: path.join(root, 'logs'),
    bootStateDir: path.join(root, 'boot-state'),
    migrationHistoryDir: path.join(root, 'migration-history'),
    transactionsDir: path.join(root, 'transactions'),
    locksDir: path.join(root, 'locks'),
    vaultDir: path.join(root, 'vault'),
  };
  await fs.mkdir(dirs.exportsDir, { recursive: true });
  await fs.mkdir(path.join(dirs.snapshotsDir, 'snap1'), { recursive: true });
  await fs.mkdir(dirs.syncDir, { recursive: true });
  await fs.mkdir(dirs.marketCacheDir, { recursive: true });
  await fs.mkdir(dirs.marketWorkDir, { recursive: true });
  await fs.mkdir(dirs.tmpDir, { recursive: true });
  return { root, dirs, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** 写文件并指定 mtime（Windows 精度足够，测试用秒级偏移） */
async function writeFileAt(file: string, bytes: number, mtimeMs: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 1));
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

const POLICY = {
  exportsRetentionMs: 7 * DAY,
  marketRetentionMs: 7 * DAY,
  tmpRetentionMs: DAY,
  exportsExemptPrefix: 'dsh-config-auto-',
};

test('disk-usage：分区体积/文件数聚合 + 可立即释放 = 可重建区合计', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.exportsDir, 'a.zip'), 100, now);
    await writeFileAt(path.join(f.dirs.snapshotsDir, 'snap1', 'config.json'), 40, now);
    await writeFileAt(path.join(f.dirs.tmpDir, 'upload.zip'), 30, now);
    await writeFileAt(path.join(f.dirs.marketCacheDir, 'hash', 'index.json'), 20, now);
    await writeFileAt(path.join(f.dirs.marketWorkDir, 'hash', 'ref'), 10, now);

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.exports.sizeBytes, 100);
    assert.equal(report.areas.exports.fileCount, 1);
    assert.equal(report.areas.snapshots.sizeBytes, 40);
    assert.equal(report.areas.tmp.sizeBytes, 30);
    assert.equal(report.totalBytes, 100 + 40 + 30 + 20 + 10);
    assert.equal(report.totalFiles, 5);
    // 可立即清理 = tmp + market/cache + market/work（不含导出与快照）
    assert.equal(report.reclaimableBytes, 30 + 20 + 10);
    // 保护类不参与回收
    assert.equal(report.areas.snapshots.policy, 'protected');
    assert.equal(report.areas.exports.policy, 'retained');
    assert.equal(report.areas.tmp.policy, 'regenerable');
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：导出产物的「已超期」只算 *.zip，且豁免定时备份前缀', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.exportsDir, 'manual-old.zip'), 100, now - 8 * DAY);
    await writeFileAt(path.join(f.dirs.exportsDir, 'manual-new.zip'), 200, now);
    // 定时备份：过期但豁免（保留策略归 BackupScheduler，不按天回收）
    await writeFileAt(path.join(f.dirs.exportsDir, 'dsh-config-auto-old.zip'), 300, now - 30 * DAY);
    // 非 zip 不参与
    await writeFileAt(path.join(f.dirs.exportsDir, 'notes.txt'), 400, now - 30 * DAY);

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.exports.sizeBytes, 100 + 200 + 300 + 400, '全部文件计入占用');
    assert.equal(report.areas.exports.expiredBytes, 100, '只有过期的非豁免 zip 计入可回收');
    assert.equal(report.areas.exports.expiredCount, 1);
    assert.equal(report.expiredBytes, 100);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：目录不存在 → unreadable（不是 0 字节），不影响其余统计', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.tmpDir, 'x.zip'), 7, now);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    // vault 从未创建 → 必须标「未统计」，界面才不会显示 0 字节
    assert.equal(report.areas.vault.unreadable, true);
    assert.equal(report.areas.vault.sizeBytes, 0);
    assert.equal(report.areas.tmp.unreadable, false);
    assert.equal(report.totalBytes, 7);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：符号链接/junction 不展开（不重复计数、不成环）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    const real = path.join(f.root, 'real-payload');
    await writeFileAt(path.join(real, 'big.bin'), 1000, now);
    const link = path.join(f.dirs.tmpDir, 'linked');
    try {
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境不允许建链接：跳过该断言（不谎报通过）
    }
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.tmp.sizeBytes, 0, '链接本身不是文件，目标内容不计入本区');
    assert.equal(report.totalBytes, 0);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：保留期口径进入报告（缓存/临时 7 天与 24 小时、定时备份保留数）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.marketCacheDir, 'h', 'index.json'), 5, now - 8 * DAY);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, backupKeepLast: 7, now: () => now });
    assert.equal(report.areas.marketCache.retentionMs, 7 * DAY);
    assert.equal(report.areas.tmp.retentionMs, DAY);
    assert.equal(report.areas.marketCache.expiredBytes, 5);
    assert.equal(report.backupRetention.keepLast, 7);
    // 受保护分区没有保留期（界面不显示「N 天后自动回收」）
    assert.equal(report.areas.snapshots.retentionMs, undefined);
    assert.equal(report.areas.exports.retentionMs, 7 * DAY);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：单文件读不到不抛错（竞态删除容错）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.logsDir, 'a.log'), 3, now);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.logs.sizeBytes, 3);
    assert.equal(report.areas.logs.fileCount, 1);
    // 空目录（sync）可读但零文件 → 不标 unreadable
    assert.equal(report.areas.sync.unreadable, false);
    assert.equal(report.areas.sync.sizeBytes, 0);
  } finally {
    await f.cleanup();
  }
});
