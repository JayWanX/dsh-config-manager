/**
 * 回归护栏（t90，目录级）：`sync.gist.*` **全部键**在宿主同款 msg 与合并口径下的裸键名计数。
 * 修前 = N/N（core 目录一个都没有）→ 修后 = 0/N。与 `gist-msgkeys.test.ts`（传输层行为）互补。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/msg-types.ts';
import { composeMsg } from '../s3/messages.ts';
import { gistMsg, gistZh } from './messages.ts';

test('t90⑤：修前现场 —— 宿主同款 msg 直查，16 个 sync.gist.* 键全部回退裸键名', () => {
  const hostMsg = makeMsg('zh');
  const keys = Object.keys(gistZh);
  const bare = keys.filter((k) => hostMsg(k) === k);
  assert.ok(keys.length >= 16, '键清单不得被抽空（当前 ' + String(keys.length) + ' 个）');
  assert.equal(bare.length, keys.length, 'core 目录不含 sync.gist.* ⇒ 修前必然全部裸键名');
});

test('t90⑥：合并后裸键名计数为 0 / N（复用 t79 的 composeMsg）', () => {
  const merged = composeMsg(makeMsg('zh'), gistMsg);
  const bare = Object.keys(gistZh).filter((k) => merged(k) === k);
  assert.deepEqual(bare, [], '任何本地键都不该回落成裸键名');
});

test('t90⑦：宿主优先不被反向遮蔽 + 两边都没有才回退键名 + 插值仍生效', () => {
  const hostWins: MsgFunc = (key) => (key === 'sync.gist.gistMissing' ? 'HOST-GIST-MISSING' : makeMsg('zh')(key));
  const merged = composeMsg(hostWins, gistMsg);
  assert.equal(merged('sync.gist.gistMissing', { id: 'x', status: '404' }), 'HOST-GIST-MISSING');
  assert.equal(merged('sync.gist.no.such.key'), 'sync.gist.no.such.key', '两边都没有 ⇒ 仍回退键名（既有边界不变）');
  assert.match(merged('sync.gist.requestFailed', { method: 'GET', url: 'U', status: '500', err: 'E' }), /GET U/);
});
