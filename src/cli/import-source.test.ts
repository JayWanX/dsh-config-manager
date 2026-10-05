/**
 * `dcm import --from <来源>` 的参数解析与运行层护栏（t22）。
 *
 * 覆盖三件事：
 *  ① 参数形状（--from/--cwd/--out/--dry-run 只属于 import；缺 --from 报错）；
 *  ② 未知来源 → **退出码 1 + 可用来源清单**（绝不回退默认来源）；
 *  ③ dry-run **零写入**（连导出目录都不创建）、真跑产出可自检的 ZIP 且**不含凭据明文**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCli } from './index.ts';
import { runImportSource } from './import-source.ts';
import type { ImportIo } from './import-source.ts';

const HERMES_FIXTURE = path.join(import.meta.dirname, '..', 'foreign', 'fixtures', 'hermes', 'basic');

interface Collected extends ImportIo {
  logs: string[];
  errors: string[];
}

function collector(): Collected {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (s) => logs.push(s), error: (s) => errors.push(s) };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

/* ---------------- ① 参数解析 ---------------- */

test('解析：import 接受 --from/--cwd/--out/--data-dir/--dry-run（含 = 写法）', () => {
  const parsed = parseCli(['import', '--from', 'hermes', '--dry-run', '--cwd', '/proj', '--out', '/tmp/o.zip', '--data-dir', '/tmp/ex']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.options.command, 'import');
  assert.equal(parsed.options.from, 'hermes');
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.cwd, '/proj');
  assert.equal(parsed.options.out, '/tmp/o.zip');
  assert.equal(parsed.options.dataDir, '/tmp/ex');

  const eq = parseCli(['import', '--from=codex', '--dry-run']);
  assert.equal(eq.ok, true);
  if (eq.ok) assert.equal(eq.options.from, 'codex');
});

test('解析：import 缺 --from / 缺值 / 未知参数一律报错', () => {
  assert.equal(parseCli(['import']).ok, false, '缺 --from 必须报错（绝不猜来源）');
  assert.equal(parseCli(['import', '--dry-run']).ok, false);
  assert.equal(parseCli(['import', '--from']).ok, false, '--from 缺值');
  assert.equal(parseCli(['import', '--from', '--dry-run']).ok, false, '值不能是另一个标志');
  assert.equal(parseCli(['import', '--from', 'hermes', '--bogus']).ok, false, '未知参数必须拒绝');
  assert.equal(parseCli(['import', '--from', 'hermes', '--json']).ok, false, '--json 不属于 import');
});

test('解析：--from/--cwd 只属于 import（其余子命令沿用原有拒绝行为）', () => {
  assert.equal(parseCli(['snapshots', '--from', 'hermes']).ok, false);
  assert.equal(parseCli(['backup', '--cwd', '/p']).ok, false);
  assert.equal(parseCli(['verify', '--from', 'hermes']).ok, false);
});

/* ---------------- ② 未知来源 ---------------- */

test('运行：未知来源 → 退出码 1 且打印全部可用来源（30 个）', async () => {
  const io = collector();
  const dir = await tempDir('dcm-import-unknown-');
  try {
    const code = await runImportSource(
      { from: 'nonexistent-source', dryRun: true, exportsDir: path.join(dir, 'exports') },
      io,
      { HERMES_HOME: HERMES_FIXTURE },
      { userHome: dir },
    );
    assert.equal(code, 1);
    assert.ok(io.errors.some((e) => e.includes('nonexistent-source')), '必须点名未知来源');
    const available = io.errors.find((e) => e.includes('可用来源'));
    assert.ok(available !== undefined, '必须给出可用来源清单');
    for (const id of [
      'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
      'gemini', 'reasonix', 'opencode', 'mimocode', 'zcode', 'grokbuild', 'openclaw', 'pi',
      'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline',
      'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
    ]) {
      assert.ok(available.includes(id), '可用来源清单必须含 ' + id);
    }
    assert.deepEqual(io.logs, [], '未知来源不得打印任何"成功"摘要');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- ③ dry-run 零写入 / 真跑 ---------------- */

test('运行：--dry-run 打印分区摘要且零写入（导出目录都不创建）', async () => {
  const io = collector();
  const dir = await tempDir('dcm-import-dry-');
  const exportsDir = path.join(dir, 'exports');
  try {
    const code = await runImportSource(
      { from: 'hermes', dryRun: true, exportsDir },
      io,
      { HERMES_HOME: HERMES_FIXTURE },
      { userHome: dir },
    );
    assert.equal(code, 0);
    assert.deepEqual(io.errors, []);
    const out = io.logs.join('\n');
    assert.match(out, /来源 \/ source: hermes/);
    assert.match(out, /待导入分区 \/ sections（3）/);
    assert.match(out, /mcp: JSON（mcp\.servers=\d+）/);
    assert.match(out, /agentInstructions: 1 个文件/);
    assert.match(out, /冲突策略 \/ conflict policy: skip-no-overwrite/);
    assert.match(out, /零写入/);
    assert.ok(!out.includes('ghp_FIXTURE_TOKEN_DO_NOT_SHIP'), '摘要里绝不出现凭据值');
    await assert.rejects(fsp.stat(exportsDir), 'dry-run 绝不创建导出目录');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('运行：真跑产出可自检的 ZIP，且整份字节不含凭据明文', async () => {
  const io = collector();
  const dir = await tempDir('dcm-import-write-');
  const exportsDir = path.join(dir, 'exports');
  try {
    const code = await runImportSource(
      { from: 'hermes', dryRun: false, exportsDir },
      io,
      { HERMES_HOME: HERMES_FIXTURE },
      { userHome: dir },
    );
    assert.equal(code, 0, io.errors.join(' | '));
    assert.deepEqual(io.errors, []);
    assert.ok(io.logs.some((l) => l.includes('自检通过')), '落盘后必须自检通过');
    const files = (await fsp.readdir(exportsDir)).filter((f) => f.endsWith('.zip'));
    assert.equal(files.length, 1, '恰好产出一份 ZIP');
    const bytes = await fsp.readFile(path.join(exportsDir, files[0] as string));
    assert.ok(!bytes.includes(Buffer.from('ghp_FIXTURE_TOKEN_DO_NOT_SHIP')), 'ZIP 字节里绝不出现凭据明文');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('运行：来源在但一个分区都产不出来 → 退出码 1（绝不静默成功一个空包）', async () => {
  const io = collector();
  const dir = await tempDir('dcm-import-empty-');
  const exportsDir = path.join(dir, 'exports');
  const emptyHermes = path.join(import.meta.dirname, '..', 'foreign', 'fixtures', 'hermes', 'empty');
  try {
    const code = await runImportSource(
      { from: 'hermes', dryRun: false, exportsDir },
      io,
      { HERMES_HOME: emptyHermes },
      { userHome: dir },
    );
    assert.equal(code, 1);
    assert.ok(io.errors.some((e) => e.includes('没有可导入的内容')), '必须明确报「没有可导入的内容」');
    await assert.rejects(fsp.stat(exportsDir), '绝不写出空 ZIP');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('运行：--out 命中既有文件时自动改名，绝不覆盖', async () => {
  const io = collector();
  const dir = await tempDir('dcm-import-out-');
  try {
    const out = path.join(dir, 'fixed.zip');
    await fsp.writeFile(out, 'PRE-EXISTING-DO-NOT-OVERWRITE', 'utf8');
    const first = collector();
    const code = await runImportSource(
      { from: 'hermes', dryRun: false, exportsDir: dir, out },
      first,
      { HERMES_HOME: HERMES_FIXTURE },
      { userHome: dir },
    );
    assert.equal(code, 0, first.errors.join(' | '));
    assert.equal(await fsp.readFile(out, 'utf8'), 'PRE-EXISTING-DO-NOT-OVERWRITE', '既有文件必须原样保留');
    const names = await fsp.readdir(dir);
    assert.ok(names.includes('fixed-1.zip'), '改名为 fixed-1.zip，实际: ' + names.join(', '));
    void io;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
