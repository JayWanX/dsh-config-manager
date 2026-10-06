/**
 * 真 codec 复验门单测（T8 / M1-WS2）。
 *
 * 覆盖：
 *  - 四条结论 verified / decode-failed / finish-failed / unavailable（含 unavailable 的各个细分码）；
 *  - 判定口径固定 strict + transformed、strong(current) 只是增强字段；
 *  - 官方 restore 会原地改写入参 ⇒ 每行必须 structuredClone；
 *  - 解析走 install anchor 口径：代际闸门（currentVersion === 同 anchor 的 SESSION_FORMAT_VERSION）、
 *    API 闸门（只有静态 catalog 时仅当 header.version === currentVersion 可用）、
 *    children-required → unavailable；
 *  - **unavailable 绝不能被当成成功**。
 *
 * 全部用真实 zstd 帧 + 真实文件系统上的假包（真的走 import），不 mock 解析器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  clearSessionVerifyCache,
  defaultDshPackageJsonCandidates,
  isSessionVerifyReason,
  nodeModulesRootsFor,
  verifySessionLogBytes,
  type SessionVerifyCatalog,
  type SessionVerifyResult,
} from './session-verify.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';

const CAPABLE = zstdAvailable();
const HEADER = { type: 'session', version: 4, id: 'session-abc', cwd: 'C:/proj' };
const ROWS = [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 1 }];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-verify-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 一份会话日志：首帧 header 行 + 每行一帧（与 DSH 的拼接容器同形）。 */
function logBytes(header: unknown, rows: readonly unknown[]): Buffer {
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + '\n', 'utf8')));
  return Buffer.concat(parts);
}

/** 一帧一行的原始文本（用来构造非法 header）。 */
function frameOf(text: string): Buffer {
  return encodeZstdFrame(Buffer.from(text, 'utf8'));
}

/** 假包：真的写到磁盘上的 node_modules 布局，让解析器走真 import。 */
async function writeFakePackage(
  dir: string,
  opts: { catalogSource: string; sessionVersion?: string },
): Promise<string> {
  const base = path.join(dir, 'node_modules', '@deepseek-ai');
  await fs.mkdir(path.join(base, 'dsh'), { recursive: true });
  await fs.writeFile(path.join(base, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }));
  if (opts.sessionVersion !== undefined) {
    await fs.mkdir(path.join(base, 'dsh-session', 'lib'), { recursive: true });
    await fs.writeFile(path.join(base, 'dsh-session', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '9.9.9', type: 'module' }));
    await fs.writeFile(path.join(base, 'dsh-session', 'lib', 'index.js'), 'export const SESSION_FORMAT_VERSION = ' + opts.sessionVersion + ';\n');
  }
  await fs.mkdir(path.join(base, 'dsh-session-format-catalog', 'lib'), { recursive: true });
  await fs.writeFile(path.join(base, 'dsh-session-format-catalog', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-format-catalog', version: '9.9.9', type: 'module' }));
  await fs.writeFile(path.join(base, 'dsh-session-format-catalog', 'lib', 'index.js'), opts.catalogSource);
  return path.join(base, 'dsh', 'package.json');
}

/** 只带 children 版装配函数的假 catalog（currentVersion 可配）。 */
function childrenCatalogSource(currentVersion: number): string {
  return [
    'export function createSessionFormatCatalogWithChildren(children) {',
    '  return {',
    '    currentVersion: ' + currentVersion + ',',
    '    createRestore(header, options) {',
    '      let count = 0;',
    '      return {',
    '        decodeRow() { count += 1; },',
    '        finish() { return { header: { version: ' + currentVersion + ' }, events: new Array(count).fill(0) }; },',
    '      };',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

/** 只带静态 catalog（**没有** children 版）的假包。 */
function staticOnlyCatalogSource(currentVersion: number): string {
  return [
    'function build() {',
    '  return {',
    '    currentVersion: ' + currentVersion + ',',
    '    createRestore() {',
    '      let count = 0;',
    '      return { decodeRow() { count += 1; }, finish() { return { header: { version: ' + currentVersion + ' }, events: new Array(count).fill(0) }; } };',
    '    },',
    '  };',
    '}',
    'export const sessionFormatCatalog = build();',
    '',
  ].join('\n');
}

test('session-verify：verified —— strict + transformed 判定；strong(current) 只是增强字段', { skip: !CAPABLE }, async () => {
  const calls: { recovery: string; validation: string }[] = [];
  const seen: unknown[][] = [];
  const catalog: SessionVerifyCatalog = {
    createRestore(_header, options) {
      calls.push({ recovery: options.recovery, validation: options.validation });
      const bucket: unknown[] = [];
      seen.push(bucket);
      return {
        decodeRow(row) { bucket.push(row); },
        finish() { return { header: { version: 4 }, events: new Array(bucket.length).fill(0) }; },
      };
    },
  };
  const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { catalog });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.verified === true ? result.events : -1, 2, 'events 必须是官方 finish() 产物里的数量');
  assert.equal(result.verified === true ? result.strong : undefined, true, 'current 增强校验也通过');
  assert.deepEqual(calls, [
    { recovery: 'strict', validation: 'transformed' },
    { recovery: 'strict', validation: 'current' },
  ], '判定口径必须是 strict + transformed，增强跑 current');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.length, 2);
});

test('session-verify：每行 structuredClone —— 增强校验不会吃到被判定趟改写过的行', { skip: !CAPABLE }, async () => {
  const marks: unknown[] = [];
  let pass = 0;
  const catalog: SessionVerifyCatalog = {
    createRestore() {
      pass += 1;
      const current = pass;
      return {
        decodeRow(row) {
          if (current === 1) (row as Record<string, unknown>)['__mutated'] = true;
          else marks.push((row as Record<string, unknown>)['__mutated']);
        },
        finish() { return { header: { version: 4 }, events: [0] }; },
      };
    },
  };
  const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { catalog });
  assert.equal(result.verified, true);
  assert.deepEqual(marks, [undefined, undefined], '官方 restore 会原地改写入参，第二趟必须拿到干净副本');
});

test('session-verify：decode-failed / finish-failed 分别归因，detail 带官方错误文本', { skip: !CAPABLE }, async () => {
  const bytes = logBytes(HEADER, ROWS);
  const decodeFail: SessionVerifyCatalog = {
    createRestore() {
      return { decodeRow() { throw new Error('official row refusal'); }, finish() { return {}; } };
    },
  };
  const badDecode = await verifySessionLogBytes(bytes, { catalog: decodeFail });
  assert.equal(badDecode.verified, false);
  assert.equal(badDecode.verified === false ? badDecode.reason : '', 'decode-failed');
  assert.match(badDecode.verified === false ? String(badDecode.detail) : '', /official row refusal/);

  const createFail: SessionVerifyCatalog = {
    createRestore() { throw new Error('official create refusal'); },
  };
  const badCreate = await verifySessionLogBytes(bytes, { catalog: createFail });
  assert.equal(badCreate.verified, false);
  assert.equal(badCreate.verified === false ? badCreate.reason : '', 'decode-failed');

  const finishFail: SessionVerifyCatalog = {
    createRestore() {
      return { decodeRow() {}, finish() { throw new Error('official finish refusal'); } };
    },
  };
  const badFinish = await verifySessionLogBytes(bytes, { catalog: finishFail });
  assert.equal(badFinish.verified, false);
  assert.equal(badFinish.verified === false ? badFinish.reason : '', 'finish-failed');
  assert.match(badFinish.verified === false ? String(badFinish.detail) : '', /official finish refusal/);
});

test('session-verify：children 相关错误 → unavailable(children-required)（缺的是事实，不是日志有问题）', { skip: !CAPABLE }, async () => {
  const official = 'V3 catalog migration requires explicit historical child facts, including an empty array for a parent without children';
  for (const where of ['create', 'decode', 'finish'] as const) {
    const catalog: SessionVerifyCatalog = {
      createRestore() {
        if (where === 'create') throw new Error(official);
        return {
          decodeRow() { if (where === 'decode') throw new Error(official); },
          finish() { if (where === 'finish') throw new Error(official); return {}; },
        };
      },
    };
    const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { catalog });
    assert.equal(result.verified, false, where);
    assert.equal(result.verified === false ? result.reason : '', 'unavailable', where);
    assert.equal(result.verified === false ? result.detail : '', 'children-required', where);
  }
});

test('session-verify：invalid-header —— 首帧多行 / 非 JSON / 撕裂尾帧 / 非 zstd 容器', { skip: !CAPABLE }, async () => {
  const twoLines = await verifySessionLogBytes(Buffer.concat([frameOf('{\"a\":1}\n{\"b\":2}\n'), frameOf('{}\n')]), { catalog: null });
  assert.equal(twoLines.verified, false);
  assert.equal(twoLines.verified === false ? twoLines.detail : '', 'header-frame-not-one-line');

  const notJson = await verifySessionLogBytes(frameOf('not json\n'), { catalog: null });
  assert.equal(notJson.verified === false ? notJson.detail : '', 'header-not-json');

  const noNewline = await verifySessionLogBytes(frameOf('{\"a\":1}'), { catalog: null });
  assert.equal(noNewline.verified === false ? noNewline.detail : '', 'header-frame-not-one-line');

  const torn = logBytes(HEADER, ROWS).subarray(0, logBytes(HEADER, ROWS).length - 3);
  const tornRes = await verifySessionLogBytes(torn, { catalog: null });
  assert.equal(tornRes.verified, false);
  assert.equal(tornRes.verified === false ? tornRes.reason : '', 'invalid-header');
  assert.equal(tornRes.verified === false ? tornRes.detail : '', 'torn-tail');

  const garbage = await verifySessionLogBytes(Buffer.from('not zstd at all'), { catalog: null });
  assert.equal(garbage.verified === false ? garbage.reason : '', 'invalid-header');
  assert.equal(garbage.verified === false ? garbage.detail : '', 'corrupt-container');
});

test('session-verify：unavailable —— catalog-disabled / no-catalog / 代际对不上 / 读不到已装版本', { skip: !CAPABLE }, async () => {
  const bytes = logBytes(HEADER, ROWS);
  const disabled = await verifySessionLogBytes(bytes, { catalog: null });
  assert.equal(disabled.verified, false);
  assert.equal(disabled.verified === false ? disabled.reason : '', 'unavailable');
  assert.equal(disabled.verified === false ? disabled.detail : '', 'catalog-disabled');

  await withTmp(async (dir) => {
    const missing = await verifySessionLogBytes(bytes, {
      dshPackageJsonCandidates: [path.join(dir, 'nowhere', '@deepseek-ai', 'dsh', 'package.json')],
    });
    assert.equal(missing.verified === false ? missing.detail : '', 'no-catalog');

    // 代际对不上：catalog 说 currentVersion=4，同一 anchor 的已装 DSH 说 SESSION_FORMAT_VERSION=3
    const mismatchAnchor = await writeFakePackage(path.join(dir, 'mismatch'), { catalogSource: childrenCatalogSource(4), sessionVersion: '3' });
    clearSessionVerifyCache();
    const mismatch = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [mismatchAnchor] });
    assert.equal(mismatch.verified, false);
    assert.equal(mismatch.verified === false ? mismatch.detail : '', 'generation-mismatch');

    // 读不到同一 anchor 的已装版本 → 不猜
    const noSessionPkg = await writeFakePackage(path.join(dir, 'noversion'), { catalogSource: childrenCatalogSource(4) });
    clearSessionVerifyCache();
    const noVersion = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [noSessionPkg] });
    assert.equal(noVersion.verified === false ? noVersion.detail : '', 'no-installed-version');
  });
});

test('session-verify：真解析（假包真 import）—— children 版可用；静态版仅当 header.version === currentVersion', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const anchor = await writeFakePackage(dir, { catalogSource: childrenCatalogSource(4), sessionVersion: '4' });
    clearSessionVerifyCache();
    const ok = await verifySessionLogBytes(logBytes(HEADER, ROWS), { dshPackageJsonCandidates: [anchor] });
    assert.equal(ok.verified, true, JSON.stringify(ok));
    assert.equal(ok.verified === true ? ok.events : -1, 2);

    // 缓存命中也要保持一致
    const cached = await verifySessionLogBytes(logBytes(HEADER, ROWS), { dshPackageJsonCandidates: [anchor] });
    assert.equal(cached.verified, true);
  });

  await withTmp(async (dir) => {
    // 静态 catalog（currentVersion=3）对 v4 日志：过不了 v3→v4 边界又绑不了 children → unavailable
    const anchor3 = await writeFakePackage(path.join(dir, 'v3'), { catalogSource: staticOnlyCatalogSource(3), sessionVersion: '3' });
    clearSessionVerifyCache();
    const v4 = await verifySessionLogBytes(logBytes(HEADER, ROWS), { dshPackageJsonCandidates: [anchor3] });
    assert.equal(v4.verified, false);
    assert.equal(v4.verified === false ? v4.reason : '', 'unavailable');
    assert.equal(v4.verified === false ? v4.detail : '', 'children-required');
    // 同一份静态 catalog 对本代（v3）日志就是可信读盘
    const v3 = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { dshPackageJsonCandidates: [anchor3] });
    assert.equal(v3.verified, true, JSON.stringify(v3));
  });
});

test('session-verify：unavailable 绝不能被当成成功（调用方必须据 verify 区分「未验证」）', { skip: !CAPABLE }, async () => {
  const bytes = logBytes(HEADER, ROWS);
  const cases: SessionVerifyResult[] = [
    await verifySessionLogBytes(bytes, { catalog: null }),
    await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [] }),
    await verifySessionLogBytes(bytes, { catalog: { createRestore() { throw new Error('historical child facts missing'); } } }),
  ];
  for (const result of cases) {
    assert.equal(result.verified, false, JSON.stringify(result));
    assert.equal(result.verified === false ? result.reason : '', 'unavailable');
  }
  // 四种结论只有 verified 一种带 verified:true
  const verified = await verifySessionLogBytes(bytes, {
    catalog: { createRestore() { return { decodeRow() {}, finish() { return { header: { version: 4 }, events: [0, 1] }; } }; } },
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.verified === true ? verified.events : -1, 2);
});

test('session-verify：候选布局与两处根（hoisted + pnpm 嵌套）与 session-format.ts 同款', () => {
  const candidate = path.join('X:', 'nm', '@deepseek-ai', 'dsh', 'package.json');
  assert.deepEqual(nodeModulesRootsFor([candidate]), [
    path.join('X:', 'nm'),
    path.join('X:', 'nm', '@deepseek-ai', 'dsh', 'node_modules'),
  ]);
  assert.deepEqual(nodeModulesRootsFor([]), []);
  const home = path.join('H:', 'home');
  const defaults = defaultDshPackageJsonCandidates(home, 'web');
  assert.ok(defaults.some((p) => p === path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  assert.ok(defaults.some((p) => p === path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  assert.ok(isSessionVerifyReason('unavailable') && isSessionVerifyReason('finish-failed'));
  assert.equal(isSessionVerifyReason('nope'), false);
  assert.equal(isSessionVerifyReason(3), false);
});
