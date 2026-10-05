/**
 * GitHub Gist 通道测试（TDD 验收判据）：
 * - 远端布局 <filePrefix>-index.json + <filePrefix>-<id>.json（gist 是扁平文件名空间）
 * - list / upload / download / delete 契约（同 id 覆盖、不存在必抛、删除不存在视为成功）
 * - 快照级跳过（内容未变 → 零 PATCH）
 * - 内容被 GitHub 截断（truncated）→ 回落 raw_url，且 raw 请求**不带 token**
 * - 401/403/404/限流/超时的错误分类；token 绝不进错误消息
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GistTransport, GistTransportError, GIST_DEFAULT_FILE_PREFIX } from './gist-transport.ts';
import type { GistRequestFn, GistResponse, GistTransportOptions } from './gist-transport.ts';
import { computeSnapshotMeta, sectionsEqual, SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import type { SectionData, SectionId } from '../../schema/types.ts';
import { sha256Hex } from '../../utils/hashing.ts';

const GIST_ID = 'aa5a315d61ae9438b18d';
const TOKEN = 'ghp_ExampleTokenValueThatMustNeverLeak123456';

/** 窄化到明文 sections（联合类型上不得直接访问 .settings/.sessions） */
function plain(snapshot: SyncSnapshot): Partial<Record<SectionId, SectionData>> {
  return snapshot.sections as Partial<Record<SectionId, SectionData>>;
}

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-10-05T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'sessions'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      sessions: {
        version: 1,
        files: [{
          relativePath: 'proj/a.jsonl',
          data: new Uint8Array([1, 2, 3, 4]),
          contentHash: sha256Hex(new Uint8Array([1, 2, 3, 4])),
        }],
      },
    },
    ...overrides,
  };
}

interface GistFile {
  filename?: string;
  content?: string;
  raw_url?: string;
  truncated?: boolean;
  size?: number;
}

interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function makeGistMock(init: { files?: Record<string, GistFile>; rawBody?: string; rawRedirects?: number } = {}) {
  const calls: MockCall[] = [];
  const state = {
    files: { ...(init.files ?? {}) } as Record<string, GistFile>,
    patches: 0,
    rawFetches: 0,
    rawRedirectsLeft: init.rawRedirects ?? 0,
    rawBody: init.rawBody ?? '',
  };
  const request: GistRequestFn = async (method, url, options = {}) => {
    const headers = options.headers ?? {};
    calls.push({ method, url, headers, ...(options.body !== undefined ? { body: options.body } : {}) });
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      if (u.pathname === '/gists/' + GIST_ID) {
        if (method === 'GET') return res(200, JSON.stringify({ id: GIST_ID, files: state.files }));
        if (method === 'PATCH') {
          state.patches += 1;
          const body = JSON.parse(options.body ?? '{}') as { files?: Record<string, { content?: string } | null> };
          for (const [name, spec] of Object.entries(body.files ?? {})) {
            if (spec === null) {
              delete state.files[name];
              continue;
            }
            const content = spec.content ?? '';
            state.files[name] = {
              filename: name, content, size: content.length, truncated: false,
              raw_url: 'https://gist.githubusercontent.com/user/' + GIST_ID + '/raw/' + name,
            };
          }
          return res(200, JSON.stringify({ id: GIST_ID, files: state.files }));
        }
      }
      return res(404, '{"message":"Not Found"}');
    }
    // raw 主机
    state.rawFetches += 1;
    if (state.rawRedirectsLeft > 0) {
      state.rawRedirectsLeft -= 1;
      return res(302, '', { location: 'https://cdn.example.test/redirected/' + state.rawFetches });
    }
    return res(200, state.rawBody);
  };
  return { calls, state, request };
}

function res(status: number, bodyText: string, headers?: Record<string, string>): GistResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(headers !== undefined ? { headers } : {}),
    async text() { return bodyText; },
  };
}

function makeOptions(mock: ReturnType<typeof makeGistMock>, overrides: Partial<GistTransportOptions> = {}): GistTransportOptions {
  return {
    gistId: GIST_ID,
    credentials: { getToken: async () => TOKEN },
    request: mock.request,
    retry: { attempts: 1 },
    ...overrides,
  };
}

/* ---------------- 构造校验 ---------------- */

test('构造：gistId / credentials.getToken / apiBaseUrl 逐项校验', () => {
  const mock = makeGistMock();
  assert.throws(() => new GistTransport(makeOptions(mock, { gistId: '' })), /gistId/);
  assert.throws(() => new GistTransport(makeOptions(mock, { gistId: 'not a gist id!' })), /gistId/);
  assert.throws(() => new GistTransport(makeOptions(mock, { credentials: null as never })), /getToken/);
  assert.throws(() => new GistTransport(makeOptions(mock, { apiBaseUrl: 'not-a-url' })), /API/);
  assert.throws(() => new GistTransport(makeOptions(mock, { apiBaseUrl: 'https://user:pw@api.github.com' })), /API/);
  const t = new GistTransport(makeOptions(mock));
  assert.equal(t.type, 'gist');
  assert.equal(t.indexFileName, GIST_DEFAULT_FILE_PREFIX + '-index.json');
});

/* ---------------- list / upload / download / delete ---------------- */

test('list：空 gist（无索引文件）→ 空列表；有索引 → 按 createdAt 升序', async () => {
  const empty = makeGistMock();
  const t0 = new GistTransport(makeOptions(empty));
  assert.deepEqual(await t0.list(), []);

  const metaB = computeSnapshotMeta(sampleSnapshot({ id: 'snap-b', createdAt: '2026-10-05T02:00:00.000Z' }));
  const metaA = computeSnapshotMeta(sampleSnapshot({ id: 'snap-a', createdAt: '2026-10-05T01:00:00.000Z' }));
  const mock = makeGistMock({ files: { 'dsh-sync-index.json': { content: JSON.stringify([metaB, metaA]) } } });
  const t = new GistTransport(makeOptions(mock));
  assert.deepEqual((await t.list()).map((m) => m.id), ['snap-a', 'snap-b']);
});

test('upload：一次 PATCH 同时写快照与索引；同内容重复上传 → 零 PATCH（快照级跳过）', async () => {
  const mock = makeGistMock();
  const t = new GistTransport(makeOptions(mock));
  const snap = sampleSnapshot();
  const meta = await t.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  assert.equal(mock.state.patches, 1);
  const storedSnapshot = JSON.parse(mock.state.files['dsh-sync-snap-001.json']!.content!) as SyncSnapshot;
  assert.equal(storedSnapshot.id, 'snap-001');
  assert.deepEqual((plain(storedSnapshot).sessions as unknown as { files: { data: Record<string, string> }[] }).files[0]!.data, { $bin: 'AQIDBA==' }, '文件字节以 base64 标记进载荷');
  assert.equal(sectionsEqual(JSON.parse(mock.state.files['dsh-sync-index.json']!.content!)[0], meta), true);

  const again = await t.upload(snap);
  assert.deepEqual(again, meta);
  assert.equal(mock.state.patches, 1, '内容未变不得再发 PATCH');
});

test('download：载荷内内容直接解析；文件字节（base64 标记）往返无损', async () => {
  const mock = makeGistMock();
  const t = new GistTransport(makeOptions(mock));
  await t.upload(sampleSnapshot());
  const back = await t.download('snap-001');
  const files = (plain(back).sessions as unknown as { files: { data: Uint8Array }[] }).files;
  assert.deepEqual(Array.from(files[0]!.data), [1, 2, 3, 4]);
  assert.deepEqual(plain(back).settings, plain(sampleSnapshot()).settings);
});

test('download：文件被 GitHub 截断（truncated）→ 回落 raw_url，且 raw 请求不带 token', async () => {
  const payload = JSON.stringify(sampleSnapshot({ id: 'snap-raw' }));
  const mock = makeGistMock({
    files: {
      'dsh-sync-snap-raw.json': {
        filename: 'dsh-sync-snap-raw.json', truncated: true,
        raw_url: 'https://gist.githubusercontent.com/user/' + GIST_ID + '/raw/dsh-sync-snap-raw.json',
      },
    },
    rawBody: payload,
  });
  const t = new GistTransport(makeOptions(mock));
  const back = await t.download('snap-raw');
  assert.equal(back.id, 'snap-raw');
  assert.equal(mock.state.rawFetches, 1);
  const rawCall = mock.calls.find((c) => c.url.includes('gist.githubusercontent.com'))!;
  assert.equal(rawCall.headers['authorization'], undefined, 'raw 下载（跨源）不得携带 token');
  assert.equal(rawCall.headers['accept'], 'application/vnd.github.raw');
});

test('download：文件不存在 → notfound；索引里没有该 id 也一样', async () => {
  const mock = makeGistMock();
  const t = new GistTransport(makeOptions(mock));
  await assert.rejects(t.download('ghost'), (err: unknown) => {
    assert.ok(err instanceof GistTransportError);
    assert.equal((err as SyncTransportError).kind, 'notfound');
    assert.equal((err as SyncTransportError).retryable, false);
    return true;
  });
});

test('delete：PATCH 里把快照文件置 null 并写回摘除后的索引；本就不存在 → 不发 PATCH', async () => {
  const mock = makeGistMock();
  const t = new GistTransport(makeOptions(mock));
  await t.upload(sampleSnapshot());
  await t.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-10-05T03:00:00.000Z' }));
  await t.delete('snap-001');
  assert.equal(mock.state.files['dsh-sync-snap-001.json'], undefined);
  assert.deepEqual((await t.list()).map((m) => m.id), ['snap-002']);
  const patches = mock.state.patches;
  await t.delete('never-existed');
  assert.equal(mock.state.patches, patches, '本就不存在的 id 不得发 PATCH');
});

test('raw 重定向：跟随 Location（上限 3 跳），超出 → protocol 错误', async () => {
  const payload = JSON.stringify(sampleSnapshot({ id: 'snap-red' }));
  const followed = makeGistMock({
    files: { 'dsh-sync-snap-red.json': { truncated: true, raw_url: 'https://gist.githubusercontent.com/r' } },
    rawBody: payload,
    rawRedirects: 1,
  });
  const t1 = new GistTransport(makeOptions(followed));
  assert.equal((await t1.download('snap-red')).id, 'snap-red');
  assert.equal(followed.state.rawFetches, 2, '一次 302 后跟随到最终 200');

  const looped = makeGistMock({
    files: { 'dsh-sync-snap-red.json': { truncated: true, raw_url: 'https://gist.githubusercontent.com/r' } },
    rawBody: payload,
    rawRedirects: 99,
  });
  const t2 = new GistTransport(makeOptions(looped));
  await assert.rejects(t2.download('snap-red'), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.equal((err as SyncTransportError).kind, 'protocol');
    assert.match(String((err as Error).message), /重定向|redirect/i);
    return true;
  });
});

/* ---------------- 错误分类 / 密钥纪律 ---------------- */

test('错误分类：gist 404 → notfound；401 → auth；403 限流 → server 且可重试', async () => {
  const failing404: GistRequestFn = async () => res(404, '{"message":"Not Found"}');
  const t404 = new GistTransport(makeOptions(makeGistMock(), { gistId: 'deadbeef00', request: failing404 }));
  await assert.rejects(t404.list(), (err: unknown) => {
    assert.equal((err as SyncTransportError).kind, 'notfound');
    assert.match(String((err as Error).message), /deadbeef00|不存在/);
    return true;
  });

  const unauthorized: GistRequestFn = async () => res(401, '{"message":"Bad credentials"}');
  const t401 = new GistTransport(makeOptions(makeGistMock(), { request: unauthorized }));
  await assert.rejects(t401.list(), (err: unknown) => {
    assert.equal((err as SyncTransportError).kind, 'auth');
    assert.equal((err as SyncTransportError).retryable, false);
    return true;
  });

  const limited: GistRequestFn = async () => res(403, '{"message":"API rate limit exceeded"}');
  const t403 = new GistTransport(makeOptions(makeGistMock(), { request: limited }));
  await assert.rejects(t403.list(), (err: unknown) => {
    assert.equal((err as SyncTransportError).kind, 'server');
    assert.equal((err as SyncTransportError).retryable, true, '限流是瞬时的，应可重试');
    return true;
  });
});

test('密钥纪律：token 绝不进错误消息（响应体里的 token 被脱敏）', async () => {
  const echoing: GistRequestFn = async () => res(500, '{"message":"bad token ' + TOKEN + '"}');
  const t = new GistTransport(makeOptions(makeGistMock(), { request: echoing }));
  await assert.rejects(t.list(), (err: unknown) => {
    const message = String((err as Error).message);
    assert.equal(message.includes(TOKEN), false, 'token 绝不能出现在错误消息里');
    assert.match(message, /\[REDACTED\]/);
    return true;
  });
});

test('网络错误/超时归一：注入超时 → kind=timeout 可重试', async () => {
  const timeoutRequest: GistRequestFn = async () => {
    const err = new Error('Request timed out after 100ms');
    err.name = 'TimeoutError';
    throw err;
  };
  const t = new GistTransport(makeOptions(makeGistMock(), { request: timeoutRequest }));
  await assert.rejects(t.list(), (err: unknown) => {
    assert.equal((err as SyncTransportError).kind, 'timeout');
    assert.equal((err as SyncTransportError).retryable, true);
    return true;
  });
});
