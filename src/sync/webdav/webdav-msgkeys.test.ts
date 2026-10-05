/**
 * 回归护栏（t79）：**WebDAV 通道的文案键在宿主 msg 下必须解析成文案，绝不露裸键名**。
 *
 * 取证：WebDAV 用到的 13 个 `sync.webdav.*` 键**全部定义在 core 目录**（`src/core/messages.ts`）⇒
 * 宿主同款 msg 能解析它们（这条通道本身没有本地专属键）。但宿主 msg 一旦缺键（部分目录 / 键被改名），
 * makeMsg 的未知键回退就是**键名本身**。t79 起传输层用 `composeMsg(options.msg, zhMsg)` 兜底：
 * 宿主优先、宿主缺键时回退 core zh 文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { WebDavTransport } from './webdav-transport.ts';

function thrownText(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function makeTransport(msg?: MsgFunc): WebDavTransport {
  return new WebDavTransport({
    baseUrl: 'not-a-url',
    username: 'alice',
    credentials: { getPassword: async () => 'pw' },
    ...(msg === undefined ? {} : { msg }),
  });
}

test('t79⑦：宿主目录缺键时回退 core 文案，不露裸键名', () => {
  // 只认得一个键的「部分目录」宿主
  const partial: MsgFunc = (key) => (key === 'sync.webdav.baseUrlRequired' ? 'HOST-REQ' : key);
  assert.equal(partial('sync.webdav.baseUrlInvalid'), 'sync.webdav.baseUrlInvalid', '前提：宿主缺该键时回退键名');
  const thrown = thrownText(() => makeTransport(partial));
  assert.notEqual(thrown, '', '非法 baseUrl 必须抛错');
  assert.equal(thrown.includes('sync.webdav.'), false, '不得把裸键名露给用户: ' + thrown);
  assert.match(thrown, /无法解析|baseUrl/i, '必须给出 core 中文文案: ' + thrown);
});

test('t79⑧：宿主优先 —— 宿主认得的键用宿主文案（合并不得反向遮蔽）', () => {
  const hostWins: MsgFunc = (key) => (key === 'sync.webdav.baseUrlInvalid' ? 'HOST-BASEURL' : makeMsg('zh')(key));
  assert.equal(thrownText(() => makeTransport(hostWins)), 'HOST-BASEURL');
});

test('t79⑨：不传 msg（缺省路径）行为不变：core zh 文案', () => {
  const thrown = thrownText(() => makeTransport());
  assert.equal(thrown.includes('sync.webdav.'), false);
  assert.match(thrown, /无法解析|baseUrl/i);
});
