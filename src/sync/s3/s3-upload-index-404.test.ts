/**
 * 回归护栏（audit-sync **sync-N1 覆盖面补全**，t66；base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * 与 WebDAV 同型（t22 的 C7）：`upload()` 此前用单态 `readIndex()`（404 → 空集合）做读改写 —— 远端
 * index.json 缺失但快照文件仍在时，本次 PUT 会把权威索引写成**只有本条目** ⇒ 其余快照从列表整体消失；
 * 随后 delete 新快照 → remaining=[] → GC 回收仍被现存两份快照引用的 blob（不可恢复）。
 *
 * 三态语义（本文件钉 S3 侧，WebDAV 见 ../webdav/webdav-upload-index-404.test.ts）：
 *   ① index 404 + 远端已有内容（blob 仓索引对象存在）→ 不写快照/索引/blob，显式中止；
 *   ② index 404 + 无任何「写过了」的证据（全新远端）→ 照常上传；
 *   ③ index = 200 + []（真空集合）→ 照常合并写回；
 *   ④ index 读操作抛错（500）→ 显式失败、零写入；
 *   ⑤ 正常路径：索引已有其它条目 → 合并保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport } from './s3-transport.ts';
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts';
import type { SyncSnapshot } from '../transport.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const BUCKET = 'demo-bucket';
const PREFIX = 'dsh-config-manager';
const BLOB_HASH = 'a'.repeat(64);
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000;

function res(status: number, bodyText: string): S3Response {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

interface Call { method: string; key: string; body?: string }

function sampleSnapshot(id: string): SyncSnapshot {
  return {
    id,
    createdAt: '2026-10-05T12:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: { settings: { version: 1, namespaces: {} } },
  };
}

/** 外置引用形态（BlobRefsSection）：现存快照引用 BLOB_HASH。 */
const WITH_BLOB_REF = {
  sessions: { version: 1, blobRefs: [{ relativePath: 'p/1.jsonl', blobHash: BLOB_HASH, sizeBytes: 4 }] },
};

function snapOf(id: string, sections: unknown): string {
  return JSON.stringify({
    id,
    createdAt: '2026-10-03T00:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
    sections,
  });
}

function makeRemote(opts: {
  index: string | null;
  indexGetStatus?: number;
  blobsIndex: string | null;
  blobs: string[];
  snapshotFiles: Record<string, string>;
}) {
  const objects = new Map<string, string>();
  if (opts.index !== null) objects.set(PREFIX + '/index.json', opts.index);
  for (const [id, body] of Object.entries(opts.snapshotFiles)) objects.set(PREFIX + '/' + id + '.json', body);
  if (opts.blobsIndex !== null) objects.set(PREFIX + '/blobs-index.json', opts.blobsIndex);
  for (const hash of opts.blobs) objects.set(PREFIX + '/blobs/' + hash, 'AAAA');
  const calls: Call[] = [];
  const deletedBlobs: string[] = [];
  const request: S3RequestFn = async (method, url, o = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')).split('/').slice(1).join('/');
    calls.push({ method, key, ...(o.body !== undefined ? { body: o.body } : {}) });
    if (method === 'GET') {
      if (key === PREFIX + '/index.json' && (opts.indexGetStatus ?? 0) !== 0) return res(opts.indexGetStatus as number, 'boom');
      if (key === PREFIX + '/index.json' && opts.index === null) return res(404, '');
      const v = objects.get(key);
      return v === undefined ? res(404, '') : res(200, v);
    }
    if (method === 'PUT') { objects.set(key, o.body ?? ''); return res(200, ''); }
    if (method === 'DELETE') {
      const had = objects.delete(key);
      if (had && key.startsWith(PREFIX + '/blobs/')) deletedBlobs.push(key.slice((PREFIX + '/blobs/').length));
      return res(had ? 204 : 404, '');
    }
    return res(405, '');
  };
  const puts = (): Call[] => calls.filter((c) => c.method === 'PUT');
  return { objects, calls, puts, request, deletedBlobs };
}

function makeOptions(remote: { request: S3RequestFn }, overrides: Partial<S3TransportOptions> = {}): S3TransportOptions {
  return {
    provider: 'minio',
    endpoint: 'https://minio.example.com:9000',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    pathStyle: true,
    request: remote.request,
    ...overrides,
  };
}

test('t66①/C7：index 404 且远端已有内容 → upload 显式中止（不写快照/索引/blob）；随后 delete 也不回收被引用的 blob', async () => {
  const r = makeRemote({
    index: null,
    blobsIndex: JSON.stringify({ [BLOB_HASH]: OLD_BLOB_MS }),
    blobs: [BLOB_HASH],
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', WITH_BLOB_REF), 'sync-bbb-222': snapOf('sync-bbb-222', WITH_BLOB_REF) },
  });
  const t = new S3Transport(makeOptions(r));
  await assert.rejects(() => t.upload(sampleSnapshot('sync-new-999')), /404|index/i);
  assert.equal(r.puts().some((c) => c.key === PREFIX + '/index.json'), false, '不得 PUT 权威索引');
  assert.equal(r.puts().some((c) => c.key === PREFIX + '/sync-new-999.json'), false, '中止必须发生在写任何字节之前');
  await t.delete('sync-new-999');
  assert.equal(r.puts().some((c) => c.key === PREFIX + '/index.json'), false, 'C7 第二步：delete 也不得写回索引');
  assert.deepEqual(r.deletedBlobs, [], 'C7 第二步：delete 也不得回收 blob');
  assert.equal(r.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true, '仍被现存两份快照文件引用的 blob 必须完好');
  assert.equal(r.objects.has(PREFIX + '/sync-aaa-111.json'), true);
  assert.equal(r.objects.has(PREFIX + '/sync-bbb-222.json'), true);
});

test('t66②：全新远端（索引与 blob 仓索引都不存在）→ 照常上传（首次推送行为不变）', async () => {
  const r = makeRemote({ index: null, blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = new S3Transport(makeOptions(r));
  const meta = await t.upload(sampleSnapshot('sync-first-001'));
  assert.equal(meta.id, 'sync-first-001');
  const putIdx = r.puts().filter((c) => c.key === PREFIX + '/index.json');
  assert.equal(putIdx.length, 1);
  assert.equal((JSON.parse(putIdx[0]?.body ?? '[]') as { id: string }[])[0]?.id, 'sync-first-001');
  assert.equal(r.objects.has(PREFIX + '/sync-first-001.json'), true, '快照对象照常写入');
});

test('t66③：index = 200 + []（真空集合，索引仍是权威）→ 照常合并写回', async () => {
  const r = makeRemote({ index: '[]', blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = new S3Transport(makeOptions(r));
  await t.upload(sampleSnapshot('sync-new-002'));
  const putIdx = r.puts().filter((c) => c.key === PREFIX + '/index.json');
  assert.equal(putIdx.length, 1);
  assert.deepEqual((JSON.parse(putIdx[0]?.body ?? '[]') as { id: string }[]).map((m) => m.id), ['sync-new-002']);
});

test('t66④：index 读操作抛错（500）→ 显式失败、零写入', async () => {
  const r = makeRemote({ index: null, indexGetStatus: 500, blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = new S3Transport(makeOptions(r));
  await assert.rejects(() => t.upload(sampleSnapshot('sync-new-003')), /500|index\.json/i);
  assert.deepEqual(r.puts().map((c) => c.key), []);
});

test('t66⑤：正常路径不受影响 —— 索引已有其它条目时合并保留（不覆盖别人）', async () => {
  const other = {
    id: 'sync-aaa-111',
    createdAt: '2026-10-01T00:00:00.000Z',
    sections: { settings: 'h1' },
    manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
  };
  const r = makeRemote({
    index: JSON.stringify([other]),
    blobsIndex: null,
    blobs: [],
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', { settings: { version: 1, namespaces: {} } }) },
  });
  const t = new S3Transport(makeOptions(r));
  await t.upload(sampleSnapshot('sync-new-004'));
  const putIdx = r.puts().filter((c) => c.key === PREFIX + '/index.json');
  const ids = (JSON.parse(putIdx[0]?.body ?? '[]') as { id: string }[]).map((m) => m.id).sort();
  assert.deepEqual(ids, ['sync-aaa-111', 'sync-new-004'], '既有条目必须保留（合并写回）');
});
