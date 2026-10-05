/**
 * 回归护栏（audit-sync **sync-N1 覆盖面补全**，t66；base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * t22 的 C7 现场：`upload()` 此前用单态 `readIndex()`（404 → 空集合）做读改写 —— 远端 index.json 缺失
 * 但快照文件仍在时，本次 PUT 会把权威索引写成**只有本条目** ⇒ 其余快照从列表整体消失；随后
 * delete 新快照 → remaining=[] → GC 回收**仍被现存两份快照引用的 blob**（不可恢复）。
 *
 * 本文件钉 WebDAV 侧的三态语义（S3 同型见 ../s3/s3-upload-index-404.test.ts）：
 *   ① index 404 + 远端已有内容（blob 仓索引存在）→ **不写快照/索引/blob**，显式中止本次上传；
 *   ② index 404 + 没有任何「写过了」的证据（全新远端）→ 照常上传（首次推送行为不变）；
 *   ③ index = 200 + []（真空集合，索引仍是权威）→ 照常合并写回；
 *   ④ index 读操作抛错（500）→ 显式失败、零写入（F1 语义）；
 *   ⑤ 正常路径：索引里已有其它条目 → 合并保留，绝不覆盖别人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebDavTransport } from './webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse } from './webdav-transport.ts';
import type { SyncSnapshot } from '../transport.ts';

const COL = 'https://dav.example.com/dav/dsh-config-manager';
const BLOB_HASH = 'a'.repeat(64);
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000;

function mkRes(status: number, text = ''): WebDavResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
}

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
  const files = new Map<string, string>(Object.entries(opts.snapshotFiles).map(([id, body]) => [id + '.json', body]));
  const blobs = new Set<string>(opts.blobs);
  const putIndex: string[] = [];
  const putSnapshot: string[] = [];
  const deletedBlobs: string[] = [];
  const all: string[] = [];

  const request: WebDavRequestFn = async (method, url, options) => {
    all.push(method + ' ' + url);
    if (url === COL + '/index.json') {
      if (method === 'GET') {
        if ((opts.indexGetStatus ?? 0) !== 0) return mkRes(opts.indexGetStatus as number, 'boom');
        if (opts.index === null) return mkRes(404);
        return mkRes(200, opts.index);
      }
      if (method === 'PUT') { putIndex.push(options?.body ?? ''); return mkRes(201); }
      return mkRes(405);
    }
    if (url === COL + '/blobs-index.json') {
      if (method === 'GET') return opts.blobsIndex === null ? mkRes(404) : mkRes(200, opts.blobsIndex);
      if (method === 'PUT') return mkRes(201);
      return mkRes(405);
    }
    if (url.startsWith(COL + '/blobs/')) {
      const hash = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'GET') return blobs.has(hash) ? mkRes(200, 'AAAA') : mkRes(404);
      if (method === 'PUT') { blobs.add(hash); return mkRes(201); }
      if (method === 'DELETE') { deletedBlobs.push(hash); blobs.delete(hash); return mkRes(204); }
      return mkRes(405);
    }
    const m = /^https:\/\/dav\.example\.com\/dav\/dsh-config-manager\/([^/]+)\.json$/.exec(url);
    if (m !== null) {
      const id = m[1] as string;
      if (method === 'GET') {
        const body = files.get(id + '.json');
        return body === undefined ? mkRes(404) : mkRes(200, body);
      }
      if (method === 'PUT') { putSnapshot.push(id); files.set(id + '.json', options?.body ?? ''); return mkRes(201); }
      if (method === 'DELETE') { const had = files.delete(id + '.json'); return mkRes(had ? 204 : 404); }
    }
    if (method === 'MKCOL') return mkRes(201);
    return mkRes(404);
  };
  return { files, blobs, putIndex, putSnapshot, deletedBlobs, all, request };
}

function transportWith(request: WebDavRequestFn): WebDavTransport {
  return new WebDavTransport({
    baseUrl: 'https://dav.example.com/dav',
    username: 'alice',
    credentials: { getPassword: async () => 'pw' },
    request,
  });
}

test('t66①/C7：index 404 且远端已有内容 → upload 显式中止（不写快照/索引/blob）；随后 delete 也不回收被引用的 blob', async () => {
  const r = makeRemote({
    index: null,
    blobsIndex: JSON.stringify({ [BLOB_HASH]: OLD_BLOB_MS }),
    blobs: [BLOB_HASH],
    snapshotFiles: { 'sync-aaa-111': snapOf('sync-aaa-111', WITH_BLOB_REF), 'sync-bbb-222': snapOf('sync-bbb-222', WITH_BLOB_REF) },
  });
  const t = transportWith(r.request);
  await assert.rejects(() => t.upload(sampleSnapshot('sync-new-999')), /404|index/i);
  assert.deepEqual(r.putIndex, [], '不得 PUT 权威索引（base 上会写成只有新条目 ⇒ 其余快照从列表整体消失）');
  assert.deepEqual(r.putSnapshot, [], '中止必须发生在写任何字节之前（快照文件也不得写）');
  await t.delete('sync-new-999');
  assert.deepEqual(r.putIndex, [], 'C7 第二步：delete 也不得写回索引');
  assert.deepEqual(r.deletedBlobs, [], 'C7 第二步：delete 也不得回收 blob');
  assert.equal(r.blobs.has(BLOB_HASH), true, '仍被现存两份快照文件引用的 blob 必须完好');
  assert.equal(r.files.has('sync-aaa-111.json'), true, '现存快照文件必须完好');
  assert.equal(r.files.has('sync-bbb-222.json'), true, '现存快照文件必须完好');
});

test('t66②：全新远端（索引与 blob 仓索引都不存在）→ 照常上传（首次推送行为不变）', async () => {
  const r = makeRemote({ index: null, blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = transportWith(r.request);
  const meta = await t.upload(sampleSnapshot('sync-first-001'));
  assert.equal(meta.id, 'sync-first-001');
  assert.equal(r.putSnapshot.includes('sync-first-001'), true, '快照文件照常写入');
  assert.equal(r.putIndex.length, 1);
  assert.equal((JSON.parse(r.putIndex[0] ?? '[]') as { id: string }[])[0]?.id, 'sync-first-001');
});

test('t66③：index = 200 + []（真空集合，索引仍是权威）→ 照常合并写回', async () => {
  const r = makeRemote({ index: '[]', blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = transportWith(r.request);
  await t.upload(sampleSnapshot('sync-new-002'));
  assert.equal(r.putIndex.length, 1);
  assert.deepEqual((JSON.parse(r.putIndex[0] ?? '[]') as { id: string }[]).map((m) => m.id), ['sync-new-002']);
});

test('t66④：index 读操作抛错（500）→ 显式失败、零写入', async () => {
  const r = makeRemote({ index: null, indexGetStatus: 500, blobsIndex: null, blobs: [], snapshotFiles: {} });
  const t = transportWith(r.request);
  await assert.rejects(() => t.upload(sampleSnapshot('sync-new-003')), /500|index\.json/i);
  assert.deepEqual(r.putIndex, []);
  assert.deepEqual(r.putSnapshot, []);
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
  const t = transportWith(r.request);
  await t.upload(sampleSnapshot('sync-new-004'));
  const ids = (JSON.parse(r.putIndex[0] ?? '[]') as { id: string }[]).map((m) => m.id).sort();
  assert.deepEqual(ids, ['sync-aaa-111', 'sync-new-004'], '既有条目必须保留（合并写回）');
});
