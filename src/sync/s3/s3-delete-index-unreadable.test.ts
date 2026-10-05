/**
 * 回归护栏（audit-sync **sync-F2** / **sync-F7**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * sync-F2（P0）：S3 兼容系与 WebDAV 同型 —— \`GET index.json\` 读不出来时 delete() 按空索引继续，
 *   把 index.json 覆盖成 []（其余快照从列表消失）并让 blob GC 删掉仍被引用的会话 blob。
 * sync-F7（P2）：objectUrl（实际发送路径）与 signRequest 的 canonicalUri 编码口径不一致，
 *   前缀含 ! ' ( ) * 时「发出的 path ≠ 签名的规范化 URI」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { S3Transport } from './s3-transport.ts';
import type { S3RequestFn, S3Response } from './s3-transport.ts';
import { indexKey, objectUrl, resolveS3Target } from './s3-providers.ts';
import { signRequest } from './sigv4.ts';
import type { SyncSnapshotMeta } from '../transport.ts';

const PREFIX = 'dsh-config-manager';
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000;
const BLOB_HASH = 'b'.repeat(64);

function mkRes(status: number, text = ''): S3Response {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
}

function meta(id: string, day: string): SyncSnapshotMeta {
  return {
    id,
    createdAt: '2026-10-0' + day + 'T00:00:00.000Z',
    sections: { settings: 'h' + id },
    manifest: {
      schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
      sectionIds: ['settings'], containsSecrets: false,
    },
  };
}

function keyOf(url: string): string {
  return new URL(url).pathname.replace(/^\/mybucket\//, '');
}

/** 远端 3 份快照 + 1 个被 snap-3 引用的旧 blob；\`GET index.json\` 一律 500。 */
function makeRemoteWithUnreadableIndex() {
  const state = {
    objects: new Map<string, string>(),
    blobsIndex: { [BLOB_HASH]: OLD_BLOB_MS } as Record<string, number>,
  };
  const snap = (id: string, sections: unknown) => JSON.stringify({
    id, createdAt: '2026-10-03T00:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
    sections,
  });
  state.objects.set(PREFIX + '/index.json', JSON.stringify([meta('sync-aaa-111', '1'), meta('sync-bbb-222', '2'), meta('sync-ccc-333', '3')]));
  state.objects.set(PREFIX + '/sync-aaa-111.json', snap('sync-aaa-111', { settings: { version: 1, namespaces: {} } }));
  state.objects.set(PREFIX + '/sync-bbb-222.json', snap('sync-bbb-222', { settings: { version: 1, namespaces: {} } }));
  state.objects.set(PREFIX + '/sync-ccc-333.json', snap('sync-ccc-333', {
    sessions: { version: 1, blobRefs: [{ relativePath: 'p/1.jsonl', blobHash: BLOB_HASH, sizeBytes: 4 }] },
  }));
  state.objects.set(PREFIX + '/blobs-index.json', JSON.stringify(state.blobsIndex));
  state.objects.set(PREFIX + '/blobs/' + BLOB_HASH, 'AAAA');

  const seen = { putIndex: [] as string[], deletedBlobs: [] as string[], all: [] as string[] };
  const request: S3RequestFn = async (method, url, options) => {
    const key = keyOf(url);
    seen.all.push(method + ' ' + key);
    if (key === PREFIX + '/index.json') {
      if (method === 'GET') return mkRes(500, 'InternalError');
      if (method === 'PUT') { seen.putIndex.push(options?.body ?? ''); return mkRes(200); }
    }
    if (key === PREFIX + '/blobs-index.json') {
      if (method === 'GET') return mkRes(200, JSON.stringify(state.blobsIndex));
      if (method === 'PUT') { state.blobsIndex = JSON.parse(options?.body ?? '{}'); return mkRes(200); }
    }
    if (key.startsWith(PREFIX + '/blobs/')) {
      const hash = key.slice((PREFIX + '/blobs/').length);
      if (method === 'DELETE') { seen.deletedBlobs.push(hash); state.objects.delete(key); return mkRes(204); }
      return state.objects.has(key) ? mkRes(200, state.objects.get(key)!) : mkRes(404);
    }
    if (method === 'GET') return state.objects.has(key) ? mkRes(200, state.objects.get(key)!) : mkRes(404);
    if (method === 'PUT') { state.objects.set(key, options?.body ?? ''); return mkRes(200); }
    if (method === 'DELETE') { state.objects.delete(key); return mkRes(204); }
    return mkRes(404);
  };
  return { state, seen, request };
}

function transportWith(request: S3RequestFn): S3Transport {
  return new S3Transport({
    provider: 's3',
    bucket: 'mybucket',
    accessKeyId: 'AKIAEXAMPLE',
    region: 'us-east-1',
    pathStyle: true,
    credentials: { getSecretAccessKey: async () => 'secret' },
    request,
  });
}

test('sync-F2：GET index.json 失败 → delete() 必须中止（绝不按空索引删对象）', async () => {
  const { request } = makeRemoteWithUnreadableIndex();
  const t = transportWith(request);
  await assert.rejects(
    () => t.delete('sync-aaa-111'),
    (err: unknown) => err instanceof Error && /index\.json/.test(err.message),
    '索引读不出来时删除必须显式失败',
  );
});

test('sync-F2：索引读不出来时绝不重写 index.json、绝不删除被引用的 blob', async () => {
  const { state, seen, request } = makeRemoteWithUnreadableIndex();
  const t = transportWith(request);
  await t.delete('sync-aaa-111').catch(() => undefined);

  assert.equal(seen.putIndex.length, 0, '禁止在索引不可读时写回 index.json');
  assert.deepEqual(seen.deletedBlobs, [], '禁止触发 blob GC');
  assert.equal(state.objects.has(PREFIX + '/sync-bbb-222.json'), true);
  assert.deepEqual(Object.keys(state.blobsIndex), [BLOB_HASH]);
  assert.equal(state.objects.has(PREFIX + '/blobs/' + BLOB_HASH), true);
});

test('sync-F7：前缀含 ! 或引号或括号或星号时，发出的 path 必须等于签名的 canonicalURI', () => {
  const prefixes = ['a!b', "a'b", 'a(b)', 'a*b'];
  for (const prefix of prefixes) {
    const resolved = resolveS3Target({ provider: 's3', bucket: 'mybucket', region: 'us-east-1', prefix, pathStyle: true });
    assert.equal(resolved.ok, true, prefix + ' 必须是合法前缀（validateCloudPrefix 放行）');
    if (!resolved.ok) continue;
    const url = objectUrl(resolved.target, indexKey(resolved.target.prefix));
    const signed = signRequest({
      method: 'GET',
      url,
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: resolved.target.region,
      service: resolved.target.service,
      dialect: resolved.target.dialect,
      now: new Date('2026-10-05T00:00:00Z'),
    });
    assert.equal(new URL(url).pathname, signed.canonicalRequest.split('\n')[1],
      '前缀 ' + prefix + '：发送路径必须与签名规范化 URI 一致');
  }
});
