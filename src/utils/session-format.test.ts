/**
 * 会话格式体检单测（2026-09，对应 known-gaps G-23）。
 *
 * 钉住的语义：
 *  - 格式常量只从 DSH 源码文本里解析，读不到就是 undefined（**绝不**拿 DSH 的 semver 猜）；
 *  - 候选根顺序与 `resolveDshVersion` 同源（installAnchor 优先，其次档案依赖树），
 *    pnpm 的嵌套布局也要认；
 *  - 探针：每个会话单元只体检一条日志（多 generation 不重复计数）、读不出 header 的如实计入
 *    `unreadable`、抽样超限计入 `skipped`（绝不静默当成「全都检查过了」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeZstdFrame } from './zstd-frame.ts';
import {
  MAX_PROBED_SESSION_LOGS, parseSessionFormatVersion, probeSessionFormats,
  readSessionFormatVersionAt, resolveSessionFormatVersion,
} from './session-format.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-session-format-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 造一条日志的首帧（version 缺省 = 不写该字段）。 */
function logBytes(version: number | undefined, id = 'session-a'): Uint8Array {
  const header: Record<string, unknown> = { id };
  if (version !== undefined) header['version'] = version;
  return new Uint8Array(encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8')));
}

/** 在给定 node_modules 下写出一个假 dsh-session 包。 */
async function writeDshSessionPackage(nodeModulesDir: string, source: string): Promise<void> {
  const dir = path.join(nodeModulesDir, '@deepseek-ai', 'dsh-session', 'lib');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), source);
}

test('parseSessionFormatVersion：只认 "SESSION_FORMAT_VERSION = <整数>"，其余 undefined', () => {
  assert.equal(parseSessionFormatVersion('const SESSION_FORMAT_VERSION = 4;'), 4);
  assert.equal(parseSessionFormatVersion('export const SESSION_FORMAT_VERSION=3\n'), 3);
  assert.equal(parseSessionFormatVersion('SESSION_FORMAT_VERSION = 0;'), 0, '0 是合法版本（v0 = 最早格式）');
  assert.equal(parseSessionFormatVersion('// nothing here'), undefined);
  assert.equal(parseSessionFormatVersion('SESSION_FORMAT_VERSIONX = 4;'), undefined, '词边界：近似名字不得误命中');
  assert.equal(parseSessionFormatVersion('SESSION_FORMAT_VERSION = "4";'), undefined, '字符串不算');
  assert.equal(parseSessionFormatVersion('SESSION_FORMAT_VERSION = 99999999999999999999;'), undefined, '超出安全整数 → 不猜');
  assert.equal(parseSessionFormatVersion('SESSION_FORMAT_VERSION = -1;'), undefined);
});

test('readSessionFormatVersionAt：读 node_modules 里的 dsh-session；缺失 → undefined', async () => {
  await withTmp(async (dir) => {
    const nm = path.join(dir, 'node_modules');
    await writeDshSessionPackage(nm, 'const SESSION_FORMAT_VERSION = 4;\n');
    assert.equal(readSessionFormatVersionAt(nm), 4);
    assert.equal(readSessionFormatVersionAt(path.join(dir, 'nope')), undefined, '目录不存在 → undefined（不抛）');

    await writeDshSessionPackage(nm, 'const SESSION_FORMAT_VERSION_X = 9;\n');
    assert.equal(readSessionFormatVersionAt(nm), undefined, '解析不到常量 → undefined（绝不猜）');
  });
});

test('resolveSessionFormatVersion：按候选找同树常量；pnpm 嵌套布局也认；都没有 → undefined', async () => {
  await withTmp(async (dir) => {
    const home = path.join(dir, 'home');
    const anchor = path.join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const nested = path.join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules');
    await writeDshSessionPackage(nested, 'const SESSION_FORMAT_VERSION = 4;\n');
    // 候选的第一项存在但解析不到 → 继续往后找（这里后面只有不存在的位置）
    assert.equal(resolveSessionFormatVersion([path.join(dir, 'missing', 'package.json'), anchor]), 4, 'pnpm 嵌套布局必须认');

    assert.equal(resolveSessionFormatVersion([]), undefined);
    assert.equal(resolveSessionFormatVersion([path.join(dir, 'missing', 'package.json')]), undefined);
  });
});

test('probeSessionFormats：每会话一条、读不出如实计数、抽样上限可见', () => {
  const files = [
    // 同一会话的两个 generation：只体检第一条
    { relativePath: '--P--/s1/session.v3.jsonl.zstd', data: logBytes(3, 's1') },
    { relativePath: '--P--/s1/session.v4.jsonl.zstd', data: logBytes(4, 's1') },
    { relativePath: '--P--/s2/session.jsonl.zstd', data: logBytes(4, 's2') },
    { relativePath: '--P--/s3/session.jsonl.zstd', data: new Uint8Array(Buffer.from('not zstd', 'utf8')) },
    { relativePath: '--P--/readme.txt', data: new Uint8Array(Buffer.from('ignore me', 'utf8')) },
  ];
  const probe = probeSessionFormats(files);
  assert.deepEqual(probe.versions.sort((a, b) => a - b), [3, 4], '两个会话各一条，重复 generation 不重复计数');
  assert.equal(probe.sampled, 2);
  assert.equal(probe.unreadable, 1, '解不出 header 的日志必须如实计数（不得当作没问题）');
  assert.equal(probe.skipped, 0);
});

test('probeSessionFormats：超过抽样上限的会话计入 skipped', () => {
  const files = Array.from({ length: MAX_PROBED_SESSION_LOGS + 2 }, (_, i) => ({
    relativePath: `--P--/s${String(i)}/session.jsonl.zstd`,
    data: logBytes(3, `s${String(i)}`),
  }));
  const probe = probeSessionFormats(files);
  assert.equal(probe.sampled, MAX_PROBED_SESSION_LOGS);
  assert.equal(probe.skipped, 2, '没检查的必须报出来，不能假装全检过');
});
