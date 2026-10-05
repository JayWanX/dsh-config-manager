/**
 * e2e-F1（P1）回归：加密备份的**凭据载荷为空**时必须仍然可以导入。
 *
 * 修前实测（base sha 3f42a8b1，真机 p19/p20）：
 *   导出机没有可导出的凭据值 → secrets.enc 里是 0 字节明文 → 宿主 tryDecryptCredentials 走
 *   `yaml.load('') → throw → catch { return undefined }` → analyzer 的安全阀把「解密成功但没有凭据」
 *   当成「没解密」→ `/execute` 400 `import.encryptedPasswordRequired`（密码明明是对的、容器已过 GCM 认证）。
 * 同仓同步侧 fromYaml('') 已经是「空 Map」语义（security/credentials-yaml.test.ts:93），两处必须同口径。
 *
 * 第二道门（不得放宽）：归档**声明**携带凭据值（containsSecrets=true）却一条 ref 都解不出来时，
 * 必须显式告警 ——「读不到 ≠ 没有凭据」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import { createEncryptionProvider } from '../../src/security/encryption.ts';
import { createSecretScanner } from '../../src/security/secret-scanner.ts';
import { tryDecryptCredentials } from '../../src/index.ts';

const PASSWORD = 'audit-pass-123';
const DECISIONS = { strategy: 'merge' as const, resolutions: {}, pathMappings: [] };

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-enc-empty-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function exportEncrypted(src: MockHostContext, zipPath: string): Promise<void> {
  await new Exporter({
    ctx: src,
    adapters: createAdapters({ namespaces: ['general'] }),
    scanner: createSecretScanner(),
    encryption: createEncryptionProvider(PASSWORD),
    now: () => new Date('2026-10-05T00:00:00.000Z'),
  }).export({ includeSecrets: true, outPath: zipPath });
}

function mkImporter(home: string): Importer {
  return new Importer({
    ctx: makeContext('linux', home),
    adapters: createAdapters({ namespaces: ['general'] }),
    snapshotStore: new MemSnapshotStore(),
  });
}

test('e2e-F1：凭据载荷为空 → 宿主解出空 Map（不是 undefined），且带正确密码可正常 execute', async () => {
  await withTmp(async (dir) => {
    // A 机：全新 home（没有 .credentials.yaml）→ 导出时明文为空 → secrets.enc 存在但内容 0 字节，
    // manifest.security.encrypted=true、containsSecrets=false（exporter.ts:449）。
    const src = makeContext('linux', path.join(dir, 'home-a'));
    const zipPath = path.join(dir, 'enc-empty.zip');
    await exportEncrypted(src, zipPath);

    const decrypted = await tryDecryptCredentials(zipPath, PASSWORD);
    assert.ok(decrypted !== undefined, '解密成功（密文已 GCM 认证）⇒ 必须是空 Map，而不是 undefined');
    assert.equal(decrypted?.size, 0, '空载荷 = 0 条 ref');

    const importer = mkImporter(path.join(dir, 'home-b'));
    const plan = await importer.createImportPlan(zipPath, DECISIONS, { decryptedCredentials: decrypted });
    const res = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: decrypted });
    assert.equal(res.ok, true, '密码正确 + 凭据载荷为空 ⇒ 必须能导入（修前抛 import.encryptedPasswordRequired）');
    assert.deepEqual(res.missingSecrets, []);
  });
});

test('e2e-F1 第二道门：归档声明携带凭据值却解不出任何 ref → 必须显式告警', async () => {
  await withTmp(async (dir) => {
    // A 机带真实凭据值导出 → containsSecrets=true
    const src = makeContext('linux', path.join(dir, 'home-a'));
    await src.fs.writeFile(path.join(src.homeDir, '.credentials.yaml'), Buffer.from('DEEPSEEK_API_KEY: sk-real-value\n', 'utf8'));
    src.credentials.values.set('DEEPSEEK_API_KEY', 'sk-real-value');
    const zipPath = path.join(dir, 'enc-with-secrets.zip');
    await exportEncrypted(src, zipPath);

    // 场景：调用方拿到了密码但解不出任何 ref（布局不识别 / 载荷读不到）
    const blind = await mkImporter(path.join(dir, 'home-b')).analyzeImport(zipPath, { decryptedCredentials: new Map() });
    const creds = blind.credentials;
    assert.ok(creds, '分析必须回传 credentials 摘要');
    assert.equal(creds.inArchive, true, '包内确实声明携带凭据值');
    assert.deepEqual(creds.refs, []);
    assert.ok(
      blind.warnings.some((w) => w.includes('凭据清单为空')),
      '读不到 ≠ 没有凭据：必须显式告警（修前零告警）',
    );

    // 对照：真的解出了 ref 就不得告警（防误报）
    const informed = await mkImporter(path.join(dir, 'home-c')).analyzeImport(zipPath, {
      decryptedCredentials: new Map([['DEEPSEEK_API_KEY', 'sk-real-value']]),
    });
    assert.ok(!informed.warnings.some((w) => w.includes('凭据清单为空')), '解出 ref 时不得误报');
  });
});
