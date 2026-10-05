/**
 * 回归护栏（audit-sync **sync-F4**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * sync-F4（P2）：保留策略「三层全关」（keepLast=0 / keepMonthly=0 / keepYearly=0，UI 允许：
 * RETENTION_LIMITS.keepLast.min=0）时，本地定时备份的清理会删掉**刚生成的那一份**（乃至全部），
 * 而 retentionPolicySummary 自述「三层均未启用 = 策略等价于不自动清理」、远端 prune 还额外有
 * 「刚 push 的恒保留」硬保护 —— 两条 prune 口径必须一致：三层全关 = 不自动清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AUTO_BACKUP_PREFIX, pruneAutoBackupsByPolicy } from './backup-files.ts';

async function makeExportsDir(): Promise<{ dir: string; names: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-f4-'));
  const names = ['aaa', 'bbb', 'ccc'].map((s, i) => AUTO_BACKUP_PREFIX + '2026100' + (i + 1) + '-000000-' + s + '.zip');
  const base = Date.now();
  for (let i = 0; i < names.length; i++) {
    const p = path.join(dir, names[i]!);
    await fs.writeFile(p, 'zip');
    const t = (base - (names.length - i) * 60_000) / 1000;
    await fs.utimes(p, t, t);
  }
  return { dir, names };
}

test('sync-F4：三层全关（0/0/0）→ 不自动清理，刚生成的备份必须存活', async () => {
  const { dir, names } = await makeExportsDir();
  try {
    const removed = await pruneAutoBackupsByPolicy(dir, { keepLast: 0, keepMonthly: 0, keepYearly: 0 });
    assert.deepEqual(removed, [], '三层全关 = 不自动清理（此前会删光全部 auto 产物）');
    assert.deepEqual((await fs.readdir(dir)).sort(), [...names].sort(), '全部备份必须原样保留');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sync-F4 对照：keepLast=1 仍按策略只留最新 1 份（三层全关不得退化成永不清理）', async () => {
  const { dir, names } = await makeExportsDir();
  try {
    const removed = await pruneAutoBackupsByPolicy(dir, { keepLast: 1, keepMonthly: 0, keepYearly: 0 });
    assert.deepEqual((await fs.readdir(dir)).sort(), [names[2]!], '只保留最新 1 份');
    assert.equal(removed.length, 2, '删掉两份更旧的');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
