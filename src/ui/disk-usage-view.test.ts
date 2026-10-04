/**
 * disk-usage-view 测试：报告 → 界面行的纯函数映射（含未统计 / 保留期 / 可回收口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diskUsageViewModel, formatRetention } from './disk-usage-view.ts';
import { makeUiT } from './i18n.ts';
import { formatBytes } from './report.ts';
import type { DiskUsageArea, DiskUsageReport } from '../core/disk-usage.ts';

const DAY = 24 * 60 * 60 * 1000;
const zh = makeUiT('zh');
const en = makeUiT('en');

/** 构造一份完整报告（每区可覆盖） */
function makeReport(overrides: Partial<Record<DiskUsageArea, Record<string, unknown>>> = {}): DiskUsageReport {
  const areas = {} as DiskUsageReport['areas'];
  const base: DiskUsageArea[] = [
    'exports', 'snapshots', 'sync', 'marketCache', 'marketWork', 'tmp',
    'logs', 'bootState', 'migrationHistory', 'transactions', 'locks', 'vault',
  ];
  for (const id of base) {
    areas[id] = {
      sizeBytes: 0,
      fileCount: 0,
      unreadable: false,
      policy: id === 'exports' ? 'retained' : id === 'tmp' || id === 'marketCache' || id === 'marketWork' ? 'regenerable' : 'protected',
      ...(id === 'exports' ? { retentionMs: 7 * DAY, expiredBytes: 0, expiredCount: 0 } : {}),
      ...(overrides[id] ?? {}),
    } as DiskUsageReport['areas'][DiskUsageArea];
  }
  return {
    dataDir: 'C:/home/.dsh/dsh-config-manager',
    totalBytes: 0,
    totalFiles: 0,
    reclaimableBytes: 0,
    expiredBytes: 0,
    areas,
    backupRetention: { keepLast: 10, latestBackupBytes: 0, latestBackupAt: null },
  };
}

test('diskUsageViewModel：null 报告 → null（界面走加载态）', () => {
  assert.equal(diskUsageViewModel(null, { t: zh, formatBytes }), null);
});

test('diskUsageViewModel：全部子区都渲染，未统计区不给 0 字节', () => {
  const vm = diskUsageViewModel(makeReport({
    vault: { unreadable: true },
    exports: { sizeBytes: 2048, fileCount: 3 },
  }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.length, 12);
  assert.equal(vm.summary.anyUnreadable, true);
  assert.equal(vm.summary.total, formatBytes(2048), '合计由已统计的子区现算（未统计区为 0，不虚增）');
  const vault = vm.rows.find((r) => r.id === 'vault');
  assert.ok(vault !== undefined);
  assert.equal(vault.unreadable, true);
  assert.equal(vault.size, '', '未统计不显示体积（绝不显示 0）');
  assert.equal(vault.files, '');
  const exportsRow = vm.rows.find((r) => r.id === 'exports');
  assert.ok(exportsRow !== undefined);
  assert.equal(exportsRow.size, formatBytes(2048));
  assert.equal(exportsRow.files, zh('diskUsage.files', { count: '3' }));
  assert.equal(exportsRow.policy, 'retained');
  assert.equal(exportsRow.retention, zh('diskUsage.retention.days', { count: '7' }));
  assert.equal(exportsRow.reclaimable, false);
});

test('diskUsageViewModel：可立即清理清单只含可重建区；过期导出单列一个动作', () => {
  const vm = diskUsageViewModel(makeReport({
    tmp: { sizeBytes: 100 },
    marketCache: { sizeBytes: 200 },
    marketWork: { sizeBytes: 300 },
    exports: { sizeBytes: 5000, fileCount: 2, expiredBytes: 900, expiredCount: 1 },
  }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.clean.reclaimable, formatBytes(600));
  assert.equal(vm.clean.expired, formatBytes(900));
  const tmpAction = vm.clean.actions.find((a) => a.id === 'tmp-market');
  const expAction = vm.clean.actions.find((a) => a.id === 'expired-exports');
  assert.ok(tmpAction !== undefined && expAction !== undefined);
  assert.equal(tmpAction.bytes, 600);
  assert.equal(tmpAction.label, zh('diskUsage.clean.tmpMarket'));
  assert.equal(expAction.bytes, 900);
  assert.equal(expAction.label, zh('diskUsage.clean.expiredExports'));
  // 可重建区不显示保留期说明（随时可清，给「N 天后自动回收」会误导）
  const tmpRow = vm.rows.find((r) => r.id === 'tmp');
  assert.ok(tmpRow !== undefined);
  assert.equal(tmpRow.retention, '');
  assert.equal(tmpRow.expired, null);
});

test('diskUsageViewModel：过期提示只在有超期项时出现', () => {
  const noExpired = diskUsageViewModel(makeReport(), { t: zh, formatBytes });
  assert.ok(noExpired !== null);
  assert.equal(noExpired.rows.find((r) => r.id === 'exports')?.expired, null);
  const vm = diskUsageViewModel(makeReport({ exports: { expiredBytes: 10, expiredCount: 1 } }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.find((r) => r.id === 'exports')?.expired, formatBytes(10));
});

test('formatRetention：天 / 小时 / 缺失三档（en 与 zh 都走字典）', () => {
  assert.equal(formatRetention(7 * DAY, zh), '7 天');
  assert.equal(formatRetention(24 * 60 * 60 * 1000, zh), '1 天');
  assert.equal(formatRetention(6 * 60 * 60 * 1000, zh), '6 小时');
  assert.equal(formatRetention(30 * 60 * 1000, zh), '30 分钟');
  assert.equal(formatRetention(0, zh), zh('diskUsage.retention.none'));
  assert.equal(formatRetention(2 * DAY, en), '2 day(s)');
});

test('diskUsageViewModel：英文界面下所有标签来自 en 字典（不回落中文）', () => {
  const vm = diskUsageViewModel(makeReport({ tmp: { sizeBytes: 5 } }), { t: en, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.find((r) => r.id === 'tmp')?.label, 'Temporary staging');
  assert.equal(vm.clean.actions.find((a) => a.id === 'tmp-market')?.label, 'Clear temp & marketplace cache');
  assert.equal(vm.summary.files, en('diskUsage.files', { count: '0' }));
});
