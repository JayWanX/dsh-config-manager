/**
 * Qoder 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 四层：
 *  ① 位置真值：`<home>/.qoder/projects`（三平台同形、无 env 覆盖）；
 *  ② **cwd 反解 + 存在性检查**：目录名 = cwd 的 `/`→`-` 编码。反解结果必须是本机真实目录
 *     才落盘（并报 `session-cwd-derived`）；反解不出来**绝不产出**该会话（宁可少搬，也不产出一条
 *     指向不存在目录的会话 —— DSH 启动按「日志位置 == projectKey(cwd)/id」校验）；
 *  ③ 子代理 transcript 本期不迁移 → 只计数并报 `unsupported-session-record`（绝不静默）；
 *  ④ 端到端：sessions + workspaces 同源产出；证据强度与探测面取自 truth-table.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../core/session-select.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import { createQoderSource, qoderSource, QODER_PROVIDER } from './qoder.ts';
import { derivedCwdOf, qoderProjectsDir, readQoderSessions } from './read-qoder.ts';
import type { ForeignImportResult } from './types.ts';

const PLATFORM = normalizePlatform(process.platform);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TARGET_VERSION = 3;

const TRUTH = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'qoder');
if (TRUTH === undefined) throw new Error('真值表缺少 qoder 行');

/**
 * 把本机真实路径编码成 Qoder 的**目录名**形态。
 *
 * 真实编码是 `/`→`-`（`convert/qoder.mjs:3-16`）；但 Windows 的目录名不能含 `:`，
 * 所以测试侧额外把驱动器的 `:` 也换成 `-`（`C--Users-…` 形态），读盘层的两个候选里
 * 恰好也认这一种（见 read-qoder.ts 的 derivedCwdOf）。
 *
 * **探针根必须无连字符**：这种编码是有损的（路径里的 `-` 与分隔符同形），带 `-` 的路径
 * 解不出来 —— 这正是「反解必须过存在性检查」的原因。用例用 `qoderProbe<pid>` 作探针根。
 */
function encodeDirName(absPath: string): string {
  return path.resolve(absPath).split('').map((c) => (c === ':' || c === '/' || c === path.sep ? '-' : c)).join('');
}

/** 无连字符的探针根（避免把有损编码的歧义混进用例） */
const PROBE_BASE = path.join(os.tmpdir(), 'qoderProbe' + String(process.pid));

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

function ctxOf(homeDir: string, env: Record<string, string | undefined> = {}) {
  return { homeDir, env, platform: PLATFORM, targetSessionFormatVersion: TARGET_VERSION };
}

function sessionsOf(result: ForeignImportResult) {
  return result.sections.find((s) => s.sectionId === 'sessions')?.files ?? [];
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：<home>/.qoder/projects 三平台同形，无 env 覆盖', () => {
  assert.equal(qoderProjectsDir({ homeDir: 'C:' + BS + 'u', env: {}, platform: 'win32' }), 'C:' + BS + 'u' + BS + '.qoder' + BS + 'projects');
  assert.equal(qoderProjectsDir({ homeDir: '/home/u', env: {}, platform: 'linux' }), '/home/u/.qoder/projects');
  assert.equal(qoderProjectsDir({ homeDir: '/Users/u', env: {}, platform: 'darwin' }), '/Users/u/.qoder/projects');
});

test('t2 证据强度与探测面取自 truth-table.ts', () => {
  assert.equal(TRUTH.evidence, 'fixture');
  assert.equal(qoderSource.evidence, TRUTH.evidence);
  assert.equal(createQoderSource().evidence, TRUTH.evidence);
  const homeDir = 'C:' + BS + 'probe';
  assert.deepEqual(
    [...qoderSource.probePaths({ homeDir, env: {}, platform: 'win32' })],
    TRUTH.defaults['win32'].map((t) => t.split('<home>').join(homeDir)),
  );
});

/* ---------------- ② cwd 反解 ---------------- */

test('t3 cwd 反解：只认**本机真实存在**的目录；不存在的解码结果一律 undefined', async () => {
  await fs.mkdir(PROBE_BASE, { recursive: true });
  try {
    // 不存在的解码结果 → undefined（绝不猜）
    assert.equal(await derivedCwdOf(encodeDirName(path.join(PROBE_BASE, 'nope')), PLATFORM), undefined);
    assert.equal(await derivedCwdOf('-definitely-not-a-real-dir-42', PLATFORM), undefined);

    // 真实存在的解码结果 → 返回该目录（本机归一后相等）
    const real = path.join(PROBE_BASE, 'real');
    await fs.mkdir(real, { recursive: true });
    const decoded = await derivedCwdOf(encodeDirName(real), PLATFORM);
    assert.ok(decoded !== undefined, '探针根无连字符时反解必须命中：' + encodeDirName(real));
    assert.equal(path.resolve(decoded), path.resolve(real));
  } finally {
    await fs.rm(PROBE_BASE, { recursive: true, force: true });
  }
});

/* ---------------- ③ 端到端：反解 / 子代理 / 缺 cwd ---------------- */

test('t4 build：反解出的 cwd 落盘并报 session-cwd-derived；子代理只计数；反解失败按缺 cwd 跳过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qoderProbe' + String(process.pid) + 'Home'));
  try {
    const encoded = encodeDirName(tmp);
    // 记录里没有 cwd → 靠目录名反解（反解 = 本机真实目录 tmp）
    await writeAt(tmp, '.qoder/projects/' + encoded + '/s1.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
    ].join(NL));
    // 子代理 transcript：本期不迁移
    await writeAt(tmp, '.qoder/projects/' + encoded + '/s1/subagents/sub-1.jsonl', JSON.stringify({ type: 'user', content: '子代理' }));
    // 反解不出来的项目目录（没有对应真实目录）→ 该会话不得产出
    await writeAt(tmp, '.qoder/projects/-no-such-project-dir-9e8d7c/s2.jsonl', JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '没有 cwd' },
    }));

    const read = await readQoderSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files.length, 2);
    const derived = read.files.find((f) => f.id === 's1');
    assert.ok(derived !== undefined);
    const cwd = derived.parsed.cwd ?? '';
    assert.equal(path.resolve(cwd), path.resolve(tmp));
    assert.ok(read.readFindings?.some((s) => s.code === 'session-cwd-derived' && s.origin === 's1'));
    assert.deepEqual(read.extraCounts?.['qoder.subagentTranscripts'], 1);
    assert.ok(read.extraSkips?.some((s) => s.code === 'unsupported-session-record' && s.detail === 'subagent-transcript'));

    const result = await qoderSource.build(ctxOf(tmp));
    const files = sessionsOf(result);
    assert.equal(files.length, 1, '反解失败的会话绝不产出');
    assert.equal(files[0]?.relativePath, projectKeyOf(cwd) + '/s1/' + dshSessionLogName(TARGET_VERSION));
    const wsData = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
      | { workspaces: { path: string; sessionIds: string[] }[] }
      | undefined;
    assert.deepEqual(wsData?.workspaces.map((w) => w.sessionIds), [['s1']]);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === 's2'));
    assert.ok(result.skipped.some((s) => s.code === 'unsupported-session-record' && s.detail === 'subagent-transcript'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t5 记录里带 cwd 时优先采信记录（不报 session-cwd-derived）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qoder-rec-cwd-'));
  try {
    await writeAt(tmp, '.qoder/projects/-whatever-abc/s1.jsonl', JSON.stringify({
      type: 'user',
      cwd: '/from/record',
      message: { role: 'user', content: '你好' },
    }));
    const read = await readQoderSessions({ homeDir: tmp, env: {}, platform: PLATFORM });
    assert.equal(read.files[0]?.parsed.cwd, '/from/record');
    assert.ok(!read.readFindings?.some((s) => s.code === 'session-cwd-derived'));
    assert.equal(QODER_PROVIDER, 'qoder');
    assert.equal(joinFor('linux', '/a', 'b'), '/a/b');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
