/**
 * t14 / core-F2 回归：凭据「值的有无」必须在**计划、执行、结果**三处同源。
 *
 * 修前实测（base sha 3f42a8b1）：归档里 ref 的值是空串时 ——
 *   计划项说「随加密备份恢复（导入时写回本机）」；
 *   执行期却按「值不可用」跳过（status=skipped）；
 *   result.missingSecrets 因用 Map.has() 判「有值」而把该 ref 过滤掉，
 *   credentialsRestored 又把它算成「已从归档写回 1 条」。
 * 结果：用户看到「导入完成」，那条凭据其实没写进去，且没有任何提示（静默 no-op）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Importer } from './importer.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { writeZip } from '../utils/zip.ts';
import { buildManifest } from '../schema/manifest.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { SECTION_IDS } from '../schema/config.ts';
import type { SectionId } from '../schema/types.ts';

const SETTINGS = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'deepseek-chat' }, revision: 1, secrets: [] } } });
const DECISIONS = { strategy: 'merge' as const, resolutions: {}, pathMappings: [] };

/** 只含 settings 分区的最小合法包（checksums 覆盖除 manifest 自身外的全部条目）。 */
async function buildBundle(): Promise<{ zipPath: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-t14-f2-'));
  const flags: Record<string, boolean> = {};
  for (const sid of SECTION_IDS) flags[sid] = false;
  flags['settings'] = true;
  const manifest = buildManifest({
    exporterVersion: '0.1.0',
    dshVersion: '0.1.54',
    platform: 'win32',
    arch: 'x64',
    sections: flags as Record<SectionId, boolean>,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
  });
  const entries = [{ name: 'config/settings.json', data: Buffer.from(SETTINGS, 'utf8') }];
  const checksums = buildChecksums(entries);
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') });
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums), 'utf8') });
  const zipPath = path.join(tmp, 'bundle.zip');
  await writeZip(zipPath, entries);
  return { zipPath, tmp };
}

function mkImporter(): Importer {
  return new Importer({
    ctx: makeContext('linux', '/home/bob'),
    adapters: createAdapters({ namespaces: ['llm'] }),
    snapshotStore: new MemSnapshotStore(),
  });
}

test('core-F2：空值凭据不得声称「随归档写回」；执行后必须如实报缺失（不得静默 no-op）', async () => {
  const { zipPath, tmp } = await buildBundle();
  try {
    // 归档里的 ref 值为空串（用户清空过值 / 写入侧产生空值）
    const emptyInArchive = new Map<string, string>([['DEMO_KEY', '']]);
    const importer = mkImporter();
    const plan = await importer.createImportPlan(zipPath, DECISIONS, { decryptedCredentials: emptyInArchive });
    assert.ok(plan.items.some((i) => i.id === 'secret:DEMO_KEY'), '空值 ref 也必须进计划（不能凭空消失）');

    const res = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: emptyInArchive });
    // 空值 = 没有值：本机也没配置 ⇒ 必须如实报「未满足」，否则用户看不到它没写进去
    assert.deepEqual(res.missingSecrets, ['DEMO_KEY'], '空值凭据没被写回 → 必须进 missingSecrets');
    assert.equal(res.credentialsRestored, undefined, '不得声称「从归档恢复了凭据」（一条都没写）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('core-F2 对照：非空值凭据照旧从归档写回、且不进 missingSecrets', async () => {
  const { zipPath, tmp } = await buildBundle();
  try {
    const withValue = new Map<string, string>([['DEMO_KEY', 'real-secret-value']]);
    const importer = mkImporter();
    const plan = await importer.createImportPlan(zipPath, DECISIONS, { decryptedCredentials: withValue });
    const res = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: withValue });
    assert.deepEqual(res.missingSecrets, [], '有值且已写回 ⇒ 不得再报「缺密钥」');
    assert.equal(res.credentialsRestored, 1, '有值 ⇒ 如实报告「从归档恢复了 1 条」');
    assert.equal(res.executed.find((e) => e.itemId === 'secret:DEMO_KEY')?.status, 'ok', '写回必须真的成功');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
