/**
 * 回归护栏（t79）：**S3 通道的本地文案键在宿主同款 msg 下不得露裸键名**。
 *
 * 取证：宿主传入的 msg = `ConfigManagerHostContext.this.msg = makeMsg(ctx 语言)`（src/index.ts:1500/2500/2810），
 * 它是 **core 目录**的翻译器，未知键回退**键名本身**（core/messages.ts:822）。而 `sync.s3.*` 全部 18 个键
 * 只定义在 `src/sync/s3/messages.ts`（core 目录里一个都没有）⇒ 修前真机/回执上看到的是一串裸键名。
 * 修法：传输层用 `composeMsg(options.msg, s3Msg)` 合并 —— **宿主优先**（它掌握 core 键与语言）、
 * 宿主查不到的键回退本地目录、两边都没有才回退键名（既有边界不变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { composeMsg, s3Msg, s3Zh } from './messages.ts';
import { S3Transport } from './s3-transport.ts';
import type { S3RequestFn, S3Response, S3TransportOptions } from './s3-transport.ts';
import type { SyncSnapshot } from '../transport.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

function res(status: number): S3Response {
  return { status, ok: status >= 200 && status < 300, async text() { return ''; } };
}

function makeOptions(overrides: Partial<S3TransportOptions> = {}): S3TransportOptions {
  const request: S3RequestFn = async () => res(500); // 任何请求都失败：用于走 requestFailed 文案
  return {
    provider: 'minio',
    endpoint: 'https://minio.example.com:9000',
    region: 'us-east-1',
    bucket: 'demo-bucket',
    accessKeyId: ACCESS_KEY_ID,
    credentials: { getSecretAccessKey: async () => SECRET },
    pathStyle: true,
    request,
    ...overrides,
  };
}

function sampleSnapshot(id: string): SyncSnapshot {
  return {
    id,
    createdAt: '2026-10-05T12:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: { settings: { version: 1, namespaces: {} } },
  };
}

function thrownText(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test('t79①：宿主同款 msg（core makeMsg）下，构造期校验错误必须是文案而不是裸键名', () => {
  const hostMsg = makeMsg('zh');
  assert.equal(hostMsg('sync.s3.prefixInvalid'), 'sync.s3.prefixInvalid', '前提：core 目录里没有 sync.s3.* 键（未知键回退键名）');
  const thrown = thrownText(() => new S3Transport(makeOptions({ msg: hostMsg, prefix: '../evil' })));
  assert.notEqual(thrown, '', '非法前缀必须抛错');
  assert.equal(thrown.includes('sync.s3.'), false, '不得把裸键名露给用户: ' + thrown);
  assert.match(thrown, /前缀|prefix/i, '必须给出本地化文案: ' + thrown);
});

test('t79②：请求期失败（requestFailed 同样是本地键）也不露裸键名', async () => {
  const t = new S3Transport(makeOptions({ msg: makeMsg('zh') }));
  const thrown = await t.upload(sampleSnapshot('sync-msg-1')).then(() => '', (err: unknown) => (err instanceof Error ? err.message : String(err)));
  assert.notEqual(thrown, '', '恒 500 的请求必须失败');
  assert.equal(thrown.includes('sync.s3.'), false, '不得把裸键名露给用户: ' + thrown);
  assert.match(thrown, /失败|failed|500/i, '必须给出可读文案: ' + thrown);
});

test('t79③：宿主优先 —— 宿主目录里认得的键不得被本地目录遮蔽', () => {
  const hostWins: MsgFunc = (key, params) =>
    key === 'sync.s3.prefixInvalid' ? 'HOST-TEXT' : makeMsg('zh')(key, params);
  const thrown = thrownText(() => new S3Transport(makeOptions({ msg: hostWins, prefix: '../evil' })));
  assert.equal(thrown, 'HOST-TEXT', '宿主认得的键必须用宿主文案（合并不得反向遮蔽）');
});

test('t79④：合并边界 —— 两边都没有的键仍回退键名（makeMsg 既有语义不变）', () => {
  const merged = composeMsg(makeMsg('zh'), s3Msg);
  assert.equal(merged('sync.s3.no.such.key'), 'sync.s3.no.such.key');
  assert.match(merged('sync.s3.prefixInvalid', { prefix: 'x' }), /x/, '插值参数必须继续生效');
});

test('t79⑤：本地目录全部键在宿主同款 msg 下都不得回落成键名', () => {
  const merged = composeMsg(makeMsg('zh'), s3Msg);
  const bare = Object.keys(s3Zh).filter((k) => merged(k) === k);
  assert.deepEqual(bare, [], '任何本地键都不该回落成裸键名');
  assert.ok(Object.keys(s3Zh).length >= 15, '本地键清单不得被抽空（当前 ' + String(Object.keys(s3Zh).length) + ' 个）');
});

test('t79⑥：不传 msg（引擎/单测缺省路径）行为不变：仍是本地目录文案', () => {
  const thrown = thrownText(() => new S3Transport(makeOptions({ prefix: '../evil' })));
  assert.equal(thrown.includes('sync.s3.'), false);
  assert.match(thrown, /前缀|prefix/i);
});
