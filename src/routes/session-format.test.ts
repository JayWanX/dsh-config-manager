/**
 * 会话格式处置（T1）的路由侧接线单测：
 *  - 处置解析优先级（请求体 > 插件配置项 ui-prefs.json > 缺省 abort）；
 *  - 配置项损坏/非法一律回退缺省（绝不猜，也绝不放行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveSessionFormatDisposition } from './session-format.ts';
import { writeUiPrefs } from '../sync/ui-prefs.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-format-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('T1：请求体显式给了处置 → 一律以它为准（不读配置）', async () => {
  await withTmp(async (dir) => {
    // 配置文件里写着 skip，但请求说 guide：请求必须赢
    await writeUiPrefs(dir, { schemaVersion: 1, sessionFormatDisposition: 'skip' });
    assert.equal(await resolveSessionFormatDisposition(dir, 'guide'), 'guide');
    assert.equal(await resolveSessionFormatDisposition(dir, 'abort'), 'abort');
  });
});

test('T1：请求体缺省 → 读插件级配置项；再缺省才是 abort', async () => {
  await withTmp(async (dir) => {
    // 无文件（首次启动）：缺省 abort（安全侧）
    assert.equal(await resolveSessionFormatDisposition(dir, undefined), 'abort');
    // 配置项存在 → 用它
    await writeUiPrefs(dir, { schemaVersion: 1, sessionFormatDisposition: 'skip' });
    assert.equal(await resolveSessionFormatDisposition(dir, undefined), 'skip');
    // 非法/畸形的请求值不能覆盖配置项（parse 返回 undefined → 走配置）
    for (const bad of ['', 'ABORT', 0, {}, [], null]) {
      assert.equal(await resolveSessionFormatDisposition(dir, bad), 'skip', '非法值不得被当成显式选择：' + JSON.stringify(bad));
    }
  });
});

test('T1：配置文件损坏 / 写入非法值 → 一律回退缺省 abort（读不到就绝不放过）', async () => {
  await withTmp(async (dir) => {
    // 损坏的 JSON
    await fs.writeFile(path.join(dir, 'ui-prefs.json'), '{ not json', 'utf8');
    assert.equal(await resolveSessionFormatDisposition(dir, undefined), 'abort');
    // 合法 JSON 但字段非法（手改过的配置文件）
    await fs.writeFile(path.join(dir, 'ui-prefs.json'), JSON.stringify({ schemaVersion: 1, sessionFormatDisposition: 'BLOCK' }), 'utf8');
    assert.equal(await resolveSessionFormatDisposition(dir, undefined), 'abort');
    // schema 版本不认识 → readUiPrefs 整体回退缺省
    await fs.writeFile(path.join(dir, 'ui-prefs.json'), JSON.stringify({ schemaVersion: 99, sessionFormatDisposition: 'skip' }), 'utf8');
    assert.equal(await resolveSessionFormatDisposition(dir, undefined), 'abort');
  });
});
