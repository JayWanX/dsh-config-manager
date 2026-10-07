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
 * t2 / 缺口⑤ 追加覆盖：runtime-anchor 落在 **app.asar 容器**里时走 `utils/asar-read.ts` 的只读抽取
 *  再 import（`via: "asar-extract"`）；权威已装版本优先取自 asar 内的 dsh-session；asar 缺失/畸形
 *  仍如实 unavailable（绝不伪造 verified，也不误判 decode-failed）。合成 asar 在测试内构造。
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
  splitAsarPath,
  verifySessionLogBytes,
  type SessionVerifyCatalog,
  type SessionVerifyResult,
} from './session-verify.ts';
import { encodeZstdFrame, zstdAvailable } from './zstd-frame.ts';
import { applySessionRepair, readSessionRepairLedger } from './session-repair-service.ts';

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

/**
 * 只带静态 catalog（**没有** children 版）的假包。
 *
 * createRestore 对「非本代 header」直接抛（与真 codec 同形：真 0.1.5-rc.2 对 v4 日志抛
 * "stored Session uses newer format v4; this build writes v3"）—— 缓存一旦放它过 v3→v4 边界，
 * 后果就是「v4 被判 decode-failed ⇒ 误回滚」，正是 V2-F1(b) 的现场。
 */
function staticOnlyCatalogSource(currentVersion: number): string {
  return [
    'function build() {',
    '  return {',
    '    currentVersion: ' + currentVersion + ',',
    '    createRestore(header) {',
    '      if (header.version !== ' + currentVersion + ') throw new Error("stored Session uses newer format v" + header.version + "; this build writes v' + currentVersion + '");',
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
    currentVersion: 4,
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
  assert.equal(result.equivalentToReadPath, true, 'header v4 === catalog.currentVersion 4 才算「DSH 现役读盘」');
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
    assert.equal(missing.verified, false);
    const missingDetail = String(missing.verified === false ? missing.detail : '');
    assert.match(missingDetail, /no-installed-version/, '权威已装版本读不到 → 不猜');
    assert.match(missingDetail, /anchor/, 'detail 必须写清试过的来源（不写绝对路径）');

    // 代际对不上：catalog 说 currentVersion=4，同一 anchor 的已装 DSH 说 SESSION_FORMAT_VERSION=3
    const mismatchAnchor = await writeFakePackage(path.join(dir, 'mismatch'), { catalogSource: childrenCatalogSource(4), sessionVersion: '3' });
    clearSessionVerifyCache();
    const mismatch = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [mismatchAnchor] });
    assert.equal(mismatch.verified, false);
    assert.match(String(mismatch.verified === false ? mismatch.detail : ''), /generation-mismatch/);

    // 读不到同一 anchor 的已装版本 → 不猜
    const noSessionPkg = await writeFakePackage(path.join(dir, 'noversion'), { catalogSource: childrenCatalogSource(4) });
    clearSessionVerifyCache();
    const noVersion = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [noSessionPkg] });
    assert.match(String(noVersion.verified === false ? noVersion.detail : ''), /no-installed-version/);
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

test('session-verify：equivalentToReadPath —— 只有 header.version === currentVersion 才是「DSH 现役读盘」', { skip: !CAPABLE }, async () => {
  const makeCatalog = (): SessionVerifyCatalog => ({
    currentVersion: 4,
    createRestore() {
      return { decodeRow() {}, finish() { return { header: { version: 4 }, events: [0, 1] }; } };
    },
  });
  const current = await verifySessionLogBytes(logBytes({ ...HEADER, version: 4 }, ROWS), { catalog: makeCatalog() });
  assert.equal(current.verified, true, JSON.stringify(current));
  assert.equal(current.equivalentToReadPath, true, '本代日志 = DSH 现役读盘路径');

  // pre-v4：走迁移链可还原（verified:true），但**不等价于** DSH 读盘路径（官方 resolveCurrentLog 对 < 本代返回 undefined）
  const historical = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { catalog: makeCatalog() });
  assert.equal(historical.verified, true, JSON.stringify(historical));
  assert.equal(historical.equivalentToReadPath, false, '迁移链 ≠ 现役读盘');

  // 替身不暴露 currentVersion → 无从声称等价，只能如实 false
  const unknown = await verifySessionLogBytes(logBytes(HEADER, ROWS), {
    catalog: { createRestore() { return { decodeRow() {}, finish() { return { header: { version: 4 }, events: [0] }; } }; } },
  });
  assert.equal(unknown.verified, true);
  assert.equal(unknown.equivalentToReadPath, false);
});

test('session-verify：detail 只写候选标签 + 原因，绝不回传绝对路径', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const anchor = await writeFakePackage(dir, { catalogSource: childrenCatalogSource(4), sessionVersion: '3' });
    clearSessionVerifyCache();
    const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { dshPackageJsonCandidates: [anchor] });
    assert.equal(result.verified, false);
    const detail = String(result.verified === false ? result.detail : '');
    assert.match(detail, /anchor:generation-mismatch/);
    assert.equal(detail.includes(dir), false, 'detail 不得含绝对路径: ' + detail);
    assert.equal(/[A-Za-z]:[\\/]/.test(detail), false, 'detail 不得含盘符路径: ' + detail);
  });
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

/* ------------------------- t22：V2-F1（缓存不得跳闸门）/ V2-F2（权威已装版本）确定性回归 */

const PROJECT_KEY = '--p--';
const SESSION_ID = 'session-abc';
const LOG_NAME = 'session.v4.jsonl.zstd';
const DUPLICATED = [{ type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'step/start', seq: 1 }, { type: 'turn/end', seq: 2 }];
const later = (): Date => new Date(Date.now() + 120_000);

/** 建一个真实的 v4 会话单元（带重放重复行、mtime 在静止期之外），供服务层回归用。 */
async function makeServiceUnit(dir: string): Promise<{ homeDir: string; dataDir: string; file: string }> {
  const homeDir = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data');
  const unitDir = path.join(homeDir, 'sessions', PROJECT_KEY, SESSION_ID);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(unitDir, LOG_NAME);
  await fs.writeFile(file, logBytes(HEADER, DUPLICATED));
  const old = new Date(Date.now() - 600_000);
  await fs.utimes(file, old, old);
  return { homeDir, dataDir, file };
}

test('t22/V2-F1(a)：同进程连续两次 verify 同一份 v4 日志 → 逐字段一致（缓存不得丢 currentVersion）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const anchor = await writeFakePackage(dir, { catalogSource: childrenCatalogSource(4), sessionVersion: '4' });
    clearSessionVerifyCache();
    const bytes = logBytes(HEADER, ROWS);
    const first = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [anchor] });
    assert.equal(first.verified, true, JSON.stringify(first));
    assert.equal(first.verified === true ? first.equivalentToReadPath : undefined, true, 'v4 日志对 v4 catalog = 现役读盘可读');
    const second = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [anchor] });
    assert.deepEqual(second, first, '同输入同进程第二次必须逐字段一致（尤其 equivalentToReadPath）');
    // 中间插一次 v3-header 复验（会走缓存命中），不得污染后续 v4 的结论
    const v3 = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { dshPackageJsonCandidates: [anchor] });
    assert.equal(v3.verified, true, JSON.stringify(v3));
    const third = await verifySessionLogBytes(bytes, { dshPackageJsonCandidates: [anchor] });
    assert.deepEqual(third, first, 'v3 复验之后 v4 的结论不得翻转');
  });
});

test('t22/V2-F1(b)：先验 v3 日志预热缓存，再对 v4 单元 applySessionRepair → unavailable（不回滚 + 写台账），不得 verify-failed', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    // 「0.1.5 那样」的候选：静态-only catalog（currentVersion 3，非本代直接抛）
    const anchor = await writeFakePackage(path.join(dir, 'anchor'), { catalogSource: staticOnlyCatalogSource(3), sessionVersion: '3' });
    clearSessionVerifyCache();
    const warm = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { dshPackageJsonCandidates: [anchor] });
    assert.equal(warm.verified, true, JSON.stringify(warm));
    assert.equal(warm.verified === true ? warm.equivalentToReadPath : undefined, true);

    const unit = await makeServiceUnit(dir);
    const before = await fs.readFile(unit.file);
    const applied = await applySessionRepair({
      homeDir: unit.homeDir, dataDir: unit.dataDir, unitId: PROJECT_KEY + '/' + SESSION_ID, now: later,
      verify: { dshPackageJsonCandidates: [anchor] },
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.notEqual(applied.reason, 'verify-failed', '缓存命中也不得把 v4 交给 v3 catalog 判确定性失败');
    assert.equal(applied.rolledBack, undefined, 'unavailable 路径不得回滚');
    const verify = applied.verify;
    assert.equal(verify?.verified, false);
    assert.equal(verify !== undefined && verify.verified === false ? verify.reason : '', 'unavailable');
    assert.equal(applied.ledgerRecorded, true, 'unavailable 必须写台账（保住回滚入口）');
    assert.equal((await readSessionRepairLedger(unit.dataDir)).repairs.length, 1);
    assert.equal((await fs.readFile(unit.file)).equals(before), false, '不回滚：写入保持');
  });
});

test('t22/V2-F2：权威「已装版本」来自运行时锚点/installAnchor，不由候选自己那棵树自证', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    // 运行时锚点树：**只有** dsh-session（SESSION_FORMAT_VERSION=4），没有 catalog
    const resources = path.join(dir, 'resources');
    const rt = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
    await fs.mkdir(path.join(rt, 'dsh'), { recursive: true });
    await fs.writeFile(path.join(rt, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }));
    await fs.mkdir(path.join(rt, 'dsh-session', 'lib'), { recursive: true });
    await fs.writeFile(path.join(rt, 'dsh-session', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '9.9.9', type: 'module' }));
    await fs.writeFile(path.join(rt, 'dsh-session', 'lib', 'index.js'), 'export const SESSION_FORMAT_VERSION = 4;\n');
    // profile 树：0.1.5 那样（catalog currentVersion 3 + 同树 dsh-session 3）—— 候选自己就在这棵树里
    const homeDir = path.join(dir, 'home');
    await writeFakePackage(path.join(homeDir, 'profiles'), { catalogSource: staticOnlyCatalogSource(3), sessionVersion: '3' });

    const proc = process as { resourcesPath?: string };
    const had = Object.prototype.hasOwnProperty.call(proc, 'resourcesPath');
    const saved = proc.resourcesPath;
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'DSH_CM_DSH_INSTALL');
    const savedEnv = process.env['DSH_CM_DSH_INSTALL'];
    clearSessionVerifyCache();
    try {
      delete process.env['DSH_CM_DSH_INSTALL']; // 显式安装根锚点会插在运行时锚点之前，本用例要求「没有运行时锚点」
      if (had) delete proc.resourcesPath;
      const byProfileTree = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { homeDir });
      assert.equal(byProfileTree.verified, true, '没有运行时锚点时，权威解析只能落到 profile 树（本机 CLI 的现实情形）');
      clearSessionVerifyCache();
      proc.resourcesPath = resources;
      const byRuntimeAnchor = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { homeDir });
      assert.equal(byRuntimeAnchor.verified, false, JSON.stringify(byRuntimeAnchor));
      assert.match(String(byRuntimeAnchor.verified === false ? byRuntimeAnchor.detail : ''), /generation-mismatch/,
        '权威已装版本是运行时锚点的 4，候选自己那棵树的 3 不得自证');
    } finally {
      if (had) proc.resourcesPath = saved;
      else delete proc.resourcesPath;
      if (hadEnv) process.env['DSH_CM_DSH_INSTALL'] = savedEnv;
      else delete process.env['DSH_CM_DSH_INSTALL'];
      clearSessionVerifyCache();
    }
  });
});

/* ---------------------- t2 / 缺口⑤：asar 容器作为产品路径（合成 asar，不依赖真机 121 MB） */

/** 合成 asar：与真机容器同构（8 字节包长 pickle + 头 pickle + 数据区）。 */
function synthAsar(files: Record<string, string>): Buffer {
  const body: Buffer[] = [];
  let bodyLength = 0;
  const tree: Record<string, unknown> = {};
  for (const [rel, content] of Object.entries(files)) {
    const parts = rel.split('/');
    let cursor = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i] as string;
      if (cursor[segment] === undefined) cursor[segment] = { files: {} };
      cursor = (cursor[segment] as { files: Record<string, unknown> }).files;
    }
    const bytes = Buffer.from(content, 'utf8');
    cursor[parts[parts.length - 1] as string] = { size: bytes.length, offset: String(bodyLength) };
    body.push(bytes);
    bodyLength += bytes.length;
  }
  const json = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  const padded = (json.length + 3) & ~3;
  const payload = Buffer.alloc(4 + padded);
  payload.writeUInt32LE(json.length, 0);
  json.copy(payload, 4);
  const header = Buffer.alloc(4 + payload.length);
  header.writeUInt32LE(payload.length, 0);
  payload.copy(header, 4);
  const out = Buffer.alloc(8 + header.length + bodyLength);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(header.length, 4);
  header.copy(out, 8);
  Buffer.concat(body).copy(out, 8 + header.length);
  return out;
}

/** 写一个「打包安装」形态的合成 resources：<resources>/app.asar/dsh/node_modules/… */
async function writeSynthInstall(resources: string, opts: { catalogSource: string; sessionVersion: string }): Promise<void> {
  const files: Record<string, string> = {
    'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
    'dsh/node_modules/@deepseek-ai/dsh-session/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '9.9.9', type: 'module' }),
    'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js': 'export const SESSION_FORMAT_VERSION = ' + opts.sessionVersion + ';\n',
    'dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-session-format-catalog', version: '9.9.9', type: 'module', main: 'lib/index.js' }),
    'dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js': opts.catalogSource,
  };
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'app.asar'), synthAsar(files));
}

/** 临时替换 process.resourcesPath 并屏蔽显式环境变量锚点，跑完还原。 */
async function withResources<T>(resources: string, fn: () => Promise<T>): Promise<T> {
  const proc = process as { resourcesPath?: string };
  const had = Object.prototype.hasOwnProperty.call(proc, 'resourcesPath');
  const saved = proc.resourcesPath;
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'DSH_CM_DSH_INSTALL');
  const savedEnv = process.env['DSH_CM_DSH_INSTALL'];
  clearSessionVerifyCache();
  try {
    delete process.env['DSH_CM_DSH_INSTALL'];
    proc.resourcesPath = resources;
    return await fn();
  } finally {
    if (had) proc.resourcesPath = saved;
    else delete proc.resourcesPath;
    if (hadEnv) process.env['DSH_CM_DSH_INSTALL'] = savedEnv;
    else delete process.env['DSH_CM_DSH_INSTALL'];
    clearSessionVerifyCache();
  }
}

test('t2/缺口⑤：app.asar 内的官方 catalog 走 asar-extract 真解析 —— v4 verified + equivalentToReadPath，且 via 可见', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const resources = path.join(dir, 'resources');
    await writeSynthInstall(resources, { catalogSource: childrenCatalogSource(4), sessionVersion: '4' });
    const homeDir = path.join(dir, 'home'); // 空 profile 树：权威版本只能来自 asar 里的 dsh-session
    await fs.mkdir(homeDir, { recursive: true });
    const cacheDir = path.join(dir, 'cache');

    await withResources(resources, async () => {
      const first = await verifySessionLogBytes(logBytes(HEADER, ROWS), { homeDir, asarCacheDir: cacheDir });
      assert.equal(first.verified, true, JSON.stringify(first));
      assert.equal(first.verified === true ? first.events : -1, 2);
      assert.equal(first.verified === true ? first.via : undefined, 'asar-extract', '结果必须标出这条解析走了 asar 抽取');
      assert.equal(first.equivalentToReadPath, true, 'asar 里的 currentVersion 4 === header 4 === 权威已装版本 4');
      const second = await verifySessionLogBytes(logBytes(HEADER, ROWS), { homeDir, asarCacheDir: cacheDir });
      assert.deepEqual(second, first, '缓存命中路径必须逐字段一致');
      const leftovers = (await fs.readdir(cacheDir)).filter((name) => name.startsWith('.tmp-'));
      assert.deepEqual(leftovers, [], '原子发布后不得留临时目录');
      const historical = await verifySessionLogBytes(logBytes({ ...HEADER, version: 3 }, ROWS), { homeDir, asarCacheDir: cacheDir });
      assert.equal(historical.verified, true, JSON.stringify(historical));
      assert.equal(historical.equivalentToReadPath, false, '迁移链 ≠ 现役读盘（判据不放宽）');
    });
  });
});

test('t2/缺口⑤：权威「已装版本」优先取 asar 内的 dsh-session（profile 树仍是旧代际也不自证）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const resources = path.join(dir, 'resources');
    await writeSynthInstall(resources, { catalogSource: childrenCatalogSource(4), sessionVersion: '4' });
    const homeDir = path.join(dir, 'home');
    await writeFakePackage(path.join(homeDir, 'profiles'), { catalogSource: staticOnlyCatalogSource(3), sessionVersion: '3' });
    await withResources(resources, async () => {
      const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { homeDir, asarCacheDir: path.join(dir, 'cache') });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.verified === true ? result.via : undefined, 'asar-extract');
      assert.equal(result.equivalentToReadPath, true, '权威版本必须来自 asar 的 4，不能由 profile 树的 3 自证');
    });
  });
});

/** 只写「权威版本」不写 catalog 的 profile 树（把候选面收窄到 asar 一条路上）。 */
async function writeVersionOnlyProfileTree(homeDir: string, version: number): Promise<void> {
  const base = path.join(homeDir, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-session');
  await fs.mkdir(path.join(base, 'lib'), { recursive: true });
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '9.9.9', type: 'module' }));
  await fs.writeFile(path.join(base, 'lib', 'index.js'), 'export const SESSION_FORMAT_VERSION = ' + version + ';\n');
}

test('t2/缺口⑤：asar 缺失 / 畸形 → 仍如实 unavailable（绝不伪造 verified，也不误判 decode-failed）', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const bytes = logBytes(HEADER, ROWS);
    const homeDir = path.join(dir, 'home');
    // profile 树只提供权威版本（4），**不提供任何 catalog**：候选面只剩 asar 那一条
    await writeVersionOnlyProfileTree(homeDir, 4);

    const emptyResources = path.join(dir, 'empty-resources');
    await fs.mkdir(emptyResources, { recursive: true });
    await withResources(emptyResources, async () => {
      const missing = await verifySessionLogBytes(bytes, { homeDir, asarCacheDir: path.join(dir, 'cache') });
      assert.equal(missing.verified, false, JSON.stringify(missing));
      assert.equal(missing.verified === false ? missing.reason : '', 'unavailable');
      assert.equal(missing.equivalentToReadPath, false);
    });

    const badResources = path.join(dir, 'bad-resources');
    await fs.mkdir(badResources, { recursive: true });
    await fs.writeFile(path.join(badResources, 'app.asar'), Buffer.alloc(64, 0xff));
    await withResources(badResources, async () => {
      const malformed = await verifySessionLogBytes(bytes, { homeDir, asarCacheDir: path.join(dir, 'cache') });
      assert.equal(malformed.verified, false, JSON.stringify(malformed));
      assert.equal(malformed.verified === false ? malformed.reason : '', 'unavailable');
      assert.match(String(malformed.verified === false ? malformed.detail : ''), /asar-extract-failed/);
      const detail = String(malformed.verified === false ? malformed.detail : '');
      assert.equal(detail.includes(dir), false, 'detail 不得含绝对路径: ' + detail);
      assert.equal(/[A-Za-z]:[\\/]/.test(detail), false, 'detail 不得含盘符路径: ' + detail);
    });
  });
});

test('t2/缺口⑤：显式 candidates 指向 asar 内 dsh/package.json 与默认运行时锚点同结论', { skip: !CAPABLE }, async () => {
  await withTmp(async (dir) => {
    const resources = path.join(dir, 'resources');
    await writeSynthInstall(resources, { catalogSource: childrenCatalogSource(4), sessionVersion: '4' });
    const candidate = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    await withResources(path.join(dir, 'unused-resources'), async () => {
      clearSessionVerifyCache();
      const result = await verifySessionLogBytes(logBytes(HEADER, ROWS), { dshPackageJsonCandidates: [candidate], asarCacheDir: path.join(dir, 'cache') });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.verified === true ? result.via : undefined, 'asar-extract');
      assert.equal(result.equivalentToReadPath, true);
    });
  });
});

test('t2/缺口⑤：splitAsarPath 只认 .asar 段（app.asar.unpacked 走普通目录路径）', () => {
  assert.deepEqual(splitAsarPath(path.join('D:', 'res', 'app.asar', 'dsh', 'node_modules')), { asarPath: 'D:/res/app.asar', innerPrefix: 'dsh/node_modules' });
  assert.deepEqual(splitAsarPath(path.join('D:', 'res', 'app.asar')), { asarPath: 'D:/res/app.asar', innerPrefix: '' });
  assert.equal(splitAsarPath(path.join('D:', 'res', 'app.asar.unpacked', 'dsh', 'node_modules')), undefined);
  assert.equal(splitAsarPath(path.join('D:', 'res', 'app', 'dsh', 'node_modules')), undefined);
});