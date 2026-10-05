/**
 * 云端点通道配置（sync-config.ts 的批次3 段）测试：
 * - 每通道独立保存 endpoint/region/bucket/前缀/gistId（照 cloud-sync 的 savedProviders 模式）
 * - **密钥只写不回读**：值只经 CloudSecretWriter.set() 进 credentials，文件里只留 secretStored 标记，
 *   回传视图只带布尔标记；读侧即使遇到手写进文件的密钥字段也一律丢弃
 * - 稳定错误码（不含用户文案）；断开通道的幂等语义
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CLOUD_SYNC_CONFIG_FILE, CLOUD_SYNC_PROVIDERS, S3_COMPAT_PROVIDERS, CloudConfigError,
  clearCloudChannelConfig, cloudChannelView, cloudSecretRef, isCloudSyncProvider, isGistProvider,
  isS3CompatProvider, listCloudConfiguredProviders, readCloudChannelConfig, readCloudSyncConfig,
  validateCloudBucket, validateCloudChannelInput, validateCloudEndpoint, validateCloudPrefix,
  validateGistId, writeCloudChannelConfig,
} from '../sync-config.ts';
import type { CloudGistChannelView, CloudS3ChannelView, CloudSecretWriter } from '../sync-config.ts';

const SECRET = 'AKIA-super-secret-access-key-42';
const TOKEN = 'ghp_TokenValueThatMustNeverLeak';

/** 只写端口：记录写入的值，has() 按内存集合回答（**没有** get()，结构上无法回读） */
function makeWriter(initial: string[] = []) {
  const written = new Map<string, string>();
  for (const ref of initial) written.set(ref, '(pre-existing)');
  const writer: CloudSecretWriter = {
    set: async (ref, value) => { written.set(ref, value); },
    has: async (ref) => written.has(ref),
  };
  return { writer, written };
}

async function makeDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-cloud-cfg-'));
}

/* ---------------- 枚举 / 密钥引用 ---------------- */

test('云端点通道枚举唯一：S3 兼容系五家 + gist；守卫各归其位', () => {
  assert.deepEqual([...S3_COMPAT_PROVIDERS], ['s3', 'oss', 'cos', 'minio', 'kodo']);
  assert.deepEqual([...CLOUD_SYNC_PROVIDERS], ['s3', 'oss', 'cos', 'minio', 'kodo', 'gist']);
  for (const p of CLOUD_SYNC_PROVIDERS) assert.equal(isCloudSyncProvider(p), true);
  for (const p of S3_COMPAT_PROVIDERS) {
    assert.equal(isS3CompatProvider(p), true);
    assert.equal(isGistProvider(p), false);
  }
  assert.equal(isS3CompatProvider('gist'), false);
  assert.equal(isGistProvider('gist'), true);
  assert.equal(isCloudSyncProvider('ftp'), false);
  assert.equal(isCloudSyncProvider(undefined), false);
});

test('密钥槽位引用按通道唯一（值只写不回读）', () => {
  const refs = CLOUD_SYNC_PROVIDERS.map((p) => cloudSecretRef(p));
  assert.deepEqual(refs, [
    'DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY',
    'DSH_CONFIG_MANAGER_SYNC_OSS_SECRET_ACCESS_KEY',
    'DSH_CONFIG_MANAGER_SYNC_COS_SECRET_ACCESS_KEY',
    'DSH_CONFIG_MANAGER_SYNC_MINIO_SECRET_ACCESS_KEY',
    'DSH_CONFIG_MANAGER_SYNC_KODO_SECRET_ACCESS_KEY',
    'DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN',
  ]);
  assert.equal(new Set(refs).size, refs.length, '不同通道不得共用槽位');
});

/* ---------------- 写入：密钥只写不回读 ---------------- */

test('写入 S3 通道：密钥只进 credentials（文件只留标记），回传视图不含任何值', async () => {
  const dir = await makeDir();
  try {
    const { writer, written } = makeWriter();
    const view = await writeCloudChannelConfig(dir, 's3', {
      endpoint: 'https://s3.us-east-1.amazonaws.com/',
      region: ' us-east-1 ',
      bucket: 'demo-bucket',
      prefix: '/dsh-config-manager/',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secret: SECRET,
    }, writer);

    assert.deepEqual(written.get(cloudSecretRef('s3')), SECRET, '值必须写进该通道的凭据槽位');
    assert.deepEqual(Object.keys(view).sort(), ['accessKeyId', 'bucket', 'endpoint', 'pathStyle', 'prefix', 'provider', 'region', 'secretStored'].sort());
    assert.equal((view as CloudS3ChannelView).secretStored, true);
    assert.equal(JSON.stringify(view).includes(SECRET), false, '回传视图绝不含密钥值');
    assert.equal((view as CloudS3ChannelView).endpoint, 'https://s3.us-east-1.amazonaws.com');
    assert.equal((view as CloudS3ChannelView).region, 'us-east-1');
    assert.equal((view as CloudS3ChannelView).prefix, 'dsh-config-manager');

    const raw = await fs.readFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), 'utf8');
    assert.equal(raw.includes(SECRET), false, '配置文件里绝不能出现密钥值');
    assert.equal(raw.includes('"secret"'), false);
    assert.equal(JSON.parse(raw).savedProviders.s3.secretStored, true);

    const read = await readCloudChannelConfig(dir, 's3');
    assert.equal(JSON.stringify(read).includes(SECRET), false, '读侧绝不回读密钥');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('未提供密钥：只更新非密字段；标记按 has() 现算（或沿用磁盘标记），值一律不落文件', async () => {
  const dir = await makeDir();
  try {
    const { writer } = makeWriter();
    await writeCloudChannelConfig(dir, 'gist', { gistId: 'aa5a315d61ae9438b18d', secret: TOKEN }, writer);
    const updated = await writeCloudChannelConfig(dir, 'gist', { gistId: 'aa5a315d61ae9438b18d', filePrefix: 'team-sync' }, writer);
    assert.equal((updated as CloudGistChannelView).filePrefix, 'team-sync');
    assert.equal((updated as CloudGistChannelView).secretStored, true, 'has() 说还在 → 标记保持 true');

    // 没有 writer（纯读盘路径）：只信磁盘上的标记
    const noWriter = await writeCloudChannelConfig(dir, 'gist', { gistId: 'aa5a315d61ae9438b18d' });
    assert.equal((noWriter as CloudGistChannelView).secretStored, true);

    const raw = await fs.readFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), 'utf8');
    assert.equal(raw.includes(TOKEN), false, 'token 绝不落文件');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('提供密钥但没有 writer → 明确报错（绝不静默丢密钥/明文落盘）', async () => {
  const dir = await makeDir();
  try {
    await assert.rejects(
      writeCloudChannelConfig(dir, 's3', {
        endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'demo-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secret: SECRET,
      }),
      (err: unknown) => {
        assert.ok(err instanceof CloudConfigError);
        assert.equal((err as CloudConfigError).code, 'cloud.secretWriterRequired');
        return true;
      },
    );
    // 失败时不得留下任何文件
    await assert.rejects(fs.stat(path.join(dir, CLOUD_SYNC_CONFIG_FILE)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

/* ---------------- savedProviders：多通道并存 / 断开 ---------------- */

test('多通道并存：写第二个通道不丢第一个（切换通道能自动回填）', async () => {
  const dir = await makeDir();
  try {
    const { writer } = makeWriter();
    await writeCloudChannelConfig(dir, 's3', {
      endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'bucket-a',
      accessKeyId: 'AKIA-A', secret: SECRET,
    }, writer);
    await writeCloudChannelConfig(dir, 'minio', {
      endpoint: 'https://minio.example.com:9000', region: 'us-east-1', bucket: 'bucket-b',
      accessKeyId: 'MINIO-A', secret: SECRET,
    }, writer);
    await writeCloudChannelConfig(dir, 'gist', { gistId: 'aa5a315d61ae9438b18d', secret: TOKEN }, writer);

    const all = await readCloudSyncConfig(dir);
    assert.notEqual(all, null);
    assert.deepEqual(Object.keys(all!.savedProviders).sort(), ['gist', 'minio', 's3']);
    assert.equal(all!.savedProviders.s3?.bucket, 'bucket-a');
    assert.equal(all!.savedProviders.minio?.bucket, 'bucket-b');
    assert.deepEqual(await listCloudConfiguredProviders(dir), ['s3', 'minio', 'gist']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('断开通道：先删一个保留其余；删到最后一个 → 整个文件删除；删未配置 → 幂等不动文件', async () => {
  const dir = await makeDir();
  try {
    const { writer } = makeWriter();
    await writeCloudChannelConfig(dir, 's3', {
      endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'bucket-a',
      accessKeyId: 'AKIA-A', secret: SECRET,
    }, writer);
    await writeCloudChannelConfig(dir, 'gist', { gistId: 'aa5a315d61ae9438b18d', secret: TOKEN }, writer);

    assert.deepEqual(await clearCloudChannelConfig(dir, 's3'), { removed: true, hasRemaining: true });
    const afterFirst = await readCloudSyncConfig(dir);
    assert.equal(afterFirst?.savedProviders.s3, undefined);
    assert.equal(afterFirst?.savedProviders.gist?.gistId, 'aa5a315d61ae9438b18d');

    const before = await fs.readFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), 'utf8');
    assert.deepEqual(await clearCloudChannelConfig(dir, 'oss'), { removed: false, hasRemaining: true });
    assert.equal(await fs.readFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), 'utf8'), before, '未配置的通道 → 逻辑删除，不得改写文件');

    assert.deepEqual(await clearCloudChannelConfig(dir, 'gist'), { removed: true, hasRemaining: false });
    await assert.rejects(fs.stat(path.join(dir, CLOUD_SYNC_CONFIG_FILE)), '一条不剩必须删掉整个文件');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

/* ---------------- 读侧防御：手写进文件的密钥字段一律丢弃 ---------------- */

test('读侧防御：文件里若混进 secretAccessKey/token/secret 字段 → 一律丢弃，绝不回读', async () => {
  const dir = await makeDir();
  try {
    await fs.writeFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), JSON.stringify({
      schemaVersion: 1,
      savedProviders: {
        s3: {
          endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'demo-bucket',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: SECRET, secret: SECRET,
        },
        gist: { gistId: 'aa5a315d61ae9438b18d', token: TOKEN, secret: TOKEN },
      },
    }), 'utf8');

    const all = await readCloudSyncConfig(dir);
    assert.notEqual(all, null);
    assert.equal(JSON.stringify(all).includes(SECRET), false, '密钥值绝不能被读回来');
    assert.equal(JSON.stringify(all).includes(TOKEN), false, 'token 绝不能被读回来');
    const s3 = await readCloudChannelConfig(dir, 's3');
    assert.deepEqual(s3, {
      provider: 's3',
      config: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'demo-bucket', accessKeyId: 'AKIAIOSFODNN7EXAMPLE' },
    });
    const view = cloudChannelView(s3!, false);
    assert.deepEqual(Object.keys(view).sort(), ['accessKeyId', 'bucket', 'endpoint', 'pathStyle', 'prefix', 'provider', 'region', 'secretStored'].sort());
    assert.equal(view.secretStored, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('读侧：文件不存在 / 损坏 / schema 不支持 → null（视为未配置，不抛错）', async () => {
  const dir = await makeDir();
  try {
    assert.equal(await readCloudSyncConfig(dir), null);
    await fs.writeFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), '{ not json', 'utf8');
    assert.equal(await readCloudSyncConfig(dir), null);
    await fs.writeFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), JSON.stringify({ schemaVersion: 99, savedProviders: {} }), 'utf8');
    assert.equal(await readCloudSyncConfig(dir), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

/* ---------------- 校验：稳定错误码（不是用户文案） ---------------- */

test('校验码：端点 / region / 桶名 / 前缀 / gistId 各返回稳定码', () => {
  assert.equal(validateCloudEndpoint(''), 'cloud.endpointRequired');
  assert.equal(validateCloudEndpoint('nope'), 'cloud.endpointInvalid');
  assert.equal(validateCloudEndpoint('ftp://x.example.com'), 'cloud.endpointInvalid');
  assert.equal(validateCloudEndpoint('https://user:pw@x.example.com'), 'cloud.endpointUserinfo');
  assert.equal(validateCloudEndpoint('https://x.example.com/bucket?a=1'), 'cloud.endpointInvalid');
  assert.equal(validateCloudEndpoint('https://s3.us-east-1.amazonaws.com/'), null);

  assert.equal(validateCloudBucket(''), 'cloud.bucketRequired');
  assert.equal(validateCloudBucket('Bad_Bucket'), 'cloud.bucketInvalid');
  assert.equal(validateCloudBucket('ab'), 'cloud.bucketInvalid');
  assert.equal(validateCloudBucket('a..b'), 'cloud.bucketInvalid');
  assert.equal(validateCloudBucket('demo-bucket.2026'), null);

  assert.equal(validateCloudPrefix(''), null);
  assert.equal(validateCloudPrefix('../evil'), 'cloud.prefixInvalid');
  assert.equal(validateCloudPrefix('/abs'), null, '首尾斜杠属书写噪声，先归一再判定');
  assert.equal(validateCloudPrefix('a//b'), 'cloud.prefixInvalid');
  assert.equal(validateCloudPrefix('a/b/'), null);
  assert.equal(validateCloudPrefix('a\\b'), 'cloud.prefixInvalid');

  assert.equal(validateGistId(''), 'cloud.gistIdRequired');
  assert.equal(validateGistId('not-hex!'), 'cloud.gistIdInvalid');
  assert.equal(validateGistId('aa5a315d61ae9438b18d'), null);

  assert.equal(validateCloudChannelInput('s3', { endpoint: '', region: 'r', bucket: 'demo-bucket', accessKeyId: 'k' }), 'cloud.endpointRequired');
  assert.equal(validateCloudChannelInput('s3', { endpoint: 'https://x.example.com', region: '', bucket: 'demo-bucket', accessKeyId: 'k' }), 'cloud.regionRequired');
  assert.equal(validateCloudChannelInput('s3', { endpoint: 'https://x.example.com', region: 'r', bucket: 'ab', accessKeyId: 'k' }), 'cloud.bucketInvalid');
  assert.equal(validateCloudChannelInput('s3', { endpoint: 'https://x.example.com', region: 'r', bucket: 'demo-bucket', accessKeyId: '' }), 'cloud.accessKeyIdRequired');
  assert.equal(validateCloudChannelInput('oss', { endpoint: 'https://x.example.com', region: 'cn-hangzhou', bucket: 'demo-bucket', accessKeyId: 'k', prefix: '../x' }), 'cloud.prefixInvalid');
  assert.equal(validateCloudChannelInput('gist', { gistId: 'zz' }), 'cloud.gistIdInvalid');
  assert.equal(validateCloudChannelInput('gist', { gistId: 'aa5a315d61ae9438b18d', apiBaseUrl: 'nope' }), 'cloud.apiBaseUrlInvalid');
  assert.equal(validateCloudChannelInput('gist', { gistId: 'aa5a315d61ae9438b18d' }), null);
  assert.equal(validateCloudChannelInput('ftp' as never, {}), 'cloud.providerUnknown');
});

test('写入非法入参 → CloudConfigError 且文件不产生', async () => {
  const dir = await makeDir();
  try {
    await assert.rejects(
      writeCloudChannelConfig(dir, 's3', { endpoint: '', region: 'r', bucket: 'demo-bucket', accessKeyId: 'k' }),
      (err: unknown) => {
        assert.ok(err instanceof CloudConfigError);
        assert.equal((err as CloudConfigError).code, 'cloud.endpointRequired');
        assert.match(String((err as Error).message), /^cloud\.endpointRequired/, '错误消息只带码，不带用户文案');
        return true;
      },
    );
    await assert.rejects(fs.stat(path.join(dir, CLOUD_SYNC_CONFIG_FILE)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
