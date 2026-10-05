/**
 * 回归护栏（t90）：**gist 通道的本地文案键在宿主同款 msg 下不得露裸键名**。
 *
 * 取证：宿主传入的 msg = `ConfigManagerHostContext.this.msg = makeMsg(ctx 语言)`（src/index.ts:1500/2500/2824），
 * 即 **core 目录**翻译器，未知键回退**键名本身**（core/messages.ts:822）；而 `sync.gist.*` 全部 16 个键
 * 只定义在 `src/sync/gist/messages.ts`（core 目录命中 0）⇒ 修前真机/回执上是一串裸键名。
 * 修法（复用 t79 的共享口径）：`composeMsg(options.msg, gistMsg)` —— 宿主优先 → 本地目录兜底 → 两边都没有才回退键名。
 *
 * 本文件只断言**传输层实际行为**（不 import composeMsg，故它本身在 base 上也能跑出红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { GistTransport } from './gist-transport.ts';
import type { GistResponse, GistTransportOptions } from './gist-transport.ts';

const GIST_ID = 'aa5a315d61ae9438b18d';

function res(status: number, bodyText = ''): GistResponse {
  return { status, ok: status >= 200 && status < 300, async text() { return bodyText; } };
}

function makeOptions(overrides: Partial<GistTransportOptions> = {}): GistTransportOptions {
  return {
    gistId: GIST_ID,
    credentials: { getToken: async () => 'tok' },
    request: async () => res(500, 'boom'), // 任何请求都失败：用于走 requestFailed 文案
    retry: { attempts: 1 },
    ...overrides,
  };
}

function thrownOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test('t90①：宿主同款 msg 下，构造期校验错误必须是文案而不是裸键名', () => {
  const hostMsg = makeMsg('zh');
  assert.equal(hostMsg('sync.gist.gistIdInvalid'), 'sync.gist.gistIdInvalid', '前提：core 目录里没有 sync.gist.* 键（未知键回退键名）');
  const thrown = thrownOf(() => new GistTransport(makeOptions({ msg: hostMsg, gistId: 'not a gist id!' })));
  assert.notEqual(thrown, '', '非法 gistId 必须抛错');
  assert.equal(thrown.includes('sync.gist.'), false, '不得把裸键名露给用户: ' + thrown);
  assert.match(thrown, /gistId/, '必须给出本地化文案: ' + thrown);
});

test('t90②：请求期失败（requestFailed 同样是本地键）也不露裸键名', async () => {
  const t = new GistTransport(makeOptions({ msg: makeMsg('zh') }));
  const thrown = await t.list().then((): string => '', (err: unknown) => (err instanceof Error ? err.message : String(err)));
  assert.notEqual(thrown, '', '恒 500 的请求必须失败');
  assert.equal(thrown.includes('sync.gist.'), false, '不得把裸键名露给用户: ' + thrown);
  assert.match(thrown, /失败|failed|500/i, '必须给出可读文案: ' + thrown);
});

test('t90③：宿主优先 —— 宿主目录里认得的键不得被本地目录遮蔽', () => {
  const hostWins: MsgFunc = (key) => (key === 'sync.gist.gistIdRequired' ? 'HOST-TEXT' : makeMsg('zh')(key));
  const thrown = thrownOf(() => new GistTransport(makeOptions({ msg: hostWins, gistId: '' })));
  assert.equal(thrown, 'HOST-TEXT', '宿主认得的键必须用宿主文案（合并不得反向遮蔽）');
});

test('t90④：不传 msg（引擎/单测缺省路径）行为不变：仍是本地目录文案', () => {
  const thrown = thrownOf(() => new GistTransport(makeOptions({ gistId: 'not a gist id!' })));
  assert.equal(thrown.includes('sync.gist.'), false);
  assert.match(thrown, /gistId/);
});
