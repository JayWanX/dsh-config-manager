/**
 * GitHub Copilot CLI 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts / hermes.test.ts / codex.test.ts 同构）：
 *  ① 位置真值：COPILOT_HOME > ~/.copilot（三平台同形）
 *  ② 翻译与安全不变量：mcp-config.json 口径与凭据剥离、指令文件**合并且可见**、
 *     skills 一层直取 / 手工嵌套压平、非法 frontmatter、0 字节与畸形 JSON 进 skipped
 *  ③ 端到端：产物是合法 bundle v1 分区，既有 Importer 能分析，且**整份 ZIP 字节**不含凭据值
 *
 * 取证强度（契约 §8.2 / §8.7）：**文档取证、未经真机验证**（本机无 ~/.copilot）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdapters } from '../adapters/index.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import type { McpSection, SectionId } from '../schema/types.ts';
import { Importer } from '../core/importer.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertCopilot } from './copilot.ts';
import { readCopilot, resolveCopilotHome } from './read-copilot.ts';
import type { ForeignImportResult } from './types.ts';

const NL = String.fromCharCode(10);
const FIXTURES = fileURLToPath(new URL('./fixtures/copilot/', import.meta.url));

function skillMd(name: string, description: string): string {
  return ['---', 'name: ' + name, 'description: ' + description, '---', '', 'body'].join(NL);
}

function fileText(result: ForeignImportResult, sectionId: SectionId, rel: string): string | null {
  const f = result.sections.find((s) => s.sectionId === sectionId)?.files?.find((x) => x.relativePath === rel);
  return f === undefined ? null : new TextDecoder().decode(f.data);
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：COPILOT_HOME 覆盖 > ~/.copilot（三平台同形）', () => {
  assert.equal(resolveCopilotHome({ homeDir: 'C:/Users/u', env: {} }).home, path.join('C:/Users/u', '.copilot'));
  assert.equal(resolveCopilotHome({ homeDir: '/home/u', env: {} }).home, path.join('/home/u', '.copilot'));
  assert.equal(resolveCopilotHome({ homeDir: '/home/u', env: {} }).overridden, false);

  const over = resolveCopilotHome({ homeDir: 'C:/Users/u', env: { COPILOT_HOME: 'D:/copilot-home' } });
  assert.equal(over.home, 'D:/copilot-home', 'COPILOT_HOME 必须整体替换配置目录');
  assert.equal(over.overridden, true, '命中覆盖必须可被上报（绝不静默换目录）');
});

test('t2 COPILOT_HOME 覆盖：读盘真的读覆盖目录，并报 source-location-overridden', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-over-'));
  try {
    await writeAt(tmp, 'mcp-config.json', JSON.stringify({ mcpServers: { fromOverride: { command: 'node', args: ['x.js'] } } }));
    await writeAt(tmp, 'copilot-instructions.md', '# 来自覆盖目录的指令' + NL);

    // homeDir 下**故意没有** .copilot —— 若实现没尊重 COPILOT_HOME，这里会是 found:false
    const read = await readCopilot({ homeDir: path.join(tmp, 'no-such-home'), env: { COPILOT_HOME: tmp } });
    assert.equal(read.found, true, '必须读 COPILOT_HOME 指向的目录');
    assert.equal(read.locationOverridden, true);
    assert.ok(read.input.readFindings?.some((s) => s.code === 'source-location-overridden' && s.origin === 'COPILOT_HOME'));

    const result = convertCopilot(read.input);
    assert.equal(result.source, 'copilot');
    assert.ok(result.skipped.some((s) => s.code === 'source-location-overridden'), '覆盖必须在结果里可见');
    const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
    assert.deepEqual(mcp.servers.map((s) => s.serverName), ['fromOverride'], '条目必须来自覆盖目录');
    assert.ok((fileText(result, 'agentInstructions', 'AGENTS.md') ?? '').includes('来自覆盖目录的指令'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ② MCP 翻译 ---------------- */

test('t3 MCP：mcp-config.json 映射（stdio/http 两类）+ 凭据剥离只留引用名 + 非映射如实报码', async () => {
  // fixture 目录本身不是 .copilot，所以显式用 COPILOT_HOME 指向它 —— 这同时验证了覆盖路径
  const read = await readCopilot({ homeDir: path.join(FIXTURES, 'basic'), env: { COPILOT_HOME: path.join(FIXTURES, 'basic') } });
  assert.equal(read.found, true);
  assert.equal(read.locationOverridden, true, '走 COPILOT_HOME 就是命中覆盖，必须如实上报');
  assert.deepEqual(read.unreadable, []);

  const result = convertCopilot(read.input);
  const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  assert.equal(mcp.servers.length, 2, '既无 command 也无 url 的条目不产出');
  assert.equal(result.counts['mcp.servers'], 2);

  const stdio = mcp.servers.find((s) => s.serverName === 'github');
  assert.equal(stdio?.type, 'stdio');
  assert.equal(stdio?.command, 'npx');
  assert.deepEqual(stdio?.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(stdio?.env?.['GITHUB_TOKEN'], '', '命中凭据的字段值置空、字段名保留');
  assert.equal(stdio?.env?.['PLAIN'], 'ok');

  const remote = mcp.servers.find((s) => s.serverName === 'docs');
  assert.equal(remote?.type, 'streamable-http');
  assert.equal(remote?.url, 'https://mcp.example.com/mcp', 'URL userinfo 必须剥离');
  assert.deepEqual(remote?.headers, { 'X-Trace': 'on' });

  assert.ok(result.credentialRefs.includes('mcp:github:GITHUB_TOKEN'));
  assert.ok(result.credentialRefs.includes('mcp:docs:url'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(!JSON.stringify(result).includes('ghp_FIXTURE_TOKEN_DO_NOT_SHIP'), '结果对象里不得出现凭据明文');

  // 形态对不上：顶层没有 mcpServers/servers 容器 → 必须报码，绝不静默少一片
  const odd = convertCopilot({ mcpConfig: { somethingElse: [] } });
  assert.ok(odd.skipped.some((s) => s.code === 'mcp-server-empty' && s.detail === 'no-servers-container'));
  assert.ok(!odd.sections.some((s) => s.sectionId === 'mcp'), '不产出空 mcp 分区');
  assert.ok(!convertCopilot({}).sections.some((s) => s.sectionId === 'mcp'));

  // 数组形态（部分版本给出 [{name, command}]）也接受，名字取自条目 name
  const arr = convertCopilot({ mcpConfig: { mcpServers: [{ name: 'arr', command: 'node', args: ['a.js'] }] } });
  assert.deepEqual((arr.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection).servers.map((s) => s.serverName), ['arr']);
});

/* ---------------- ② 指令文件 ---------------- */

test('t4 指令：copilot-instructions.md 与 instructions/*.instructions.md 合并为单个 AGENTS.md 并报码', async () => {
  const read = await readCopilot({ homeDir: path.join(FIXTURES, 'basic'), env: { COPILOT_HOME: path.join(FIXTURES, 'basic') } });
  const result = convertCopilot(read.input);
  const text = fileText(result, 'agentInstructions', 'AGENTS.md') ?? '';
  assert.ok(text.includes('Copilot 全局指令'), '基础指令必须在产物里');
  assert.ok(text.includes('仓库级指令'), 'instructions/*.instructions.md 也必须被合并进来（DSH 只读一个指令文件）');
  assert.ok(text.indexOf('Copilot 全局指令') < text.indexOf('仓库级指令'), '合并顺序确定：基础指令在前');
  assert.equal(result.counts['agentInstructions.files'], 1, '至多一个指令文件');
  assert.ok(result.skipped.some((s) => s.code === 'instructions-merged' && s.count === 2), '合并必须可见（绝不静默）');
  assert.ok(!text.includes('empty.instructions.md'), '空指令文件不进合并');

  // 只有一份指令时不报合并码
  const single = convertCopilot({ instructions: '# only one' + NL });
  assert.ok(!single.skipped.some((s) => s.code === 'instructions-merged'));
  assert.equal(fileText(single, 'agentInstructions', 'AGENTS.md'), '# only one' + NL);

  // 两份都不存在 → 不产出分区（绝不凭空造分区）
  assert.ok(!convertCopilot({}).sections.some((s) => s.sectionId === 'agentInstructions'));
  assert.ok(!convertCopilot({ instructions: '   ' }).sections.some((s) => s.sectionId === 'agentInstructions'));
});

/* ---------------- ② skills / 畸形 / 缺失 ---------------- */

test('t5 skills：一层直取；手工嵌套压平报码；非法 frontmatter 跳过；同名先到先得', async () => {
  const read = await readCopilot({ homeDir: path.join(FIXTURES, 'basic'), env: { COPILOT_HOME: path.join(FIXTURES, 'basic') } });
  const result = convertCopilot(read.input);
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath), ['hello/SKILL.md'], '个人技能一层直取目录名');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-skills-'));
  try {
    await writeAt(tmp, 'skills/a/dup/SKILL.md', skillMd('dup', 'first wins'));
    await writeAt(tmp, 'skills/b/dup/SKILL.md', skillMd('dup', 'second loses'));
    await writeAt(tmp, 'skills/broken/SKILL.md', ['---', 'description: great DX: intuitive', '---', 'body'].join(NL));
    await writeAt(tmp, 'skills/no-md/assets.md', 'not a skill dir');
    const edge = convertCopilot((await readCopilot({ homeDir: tmp, env: { COPILOT_HOME: tmp } })).input);
    const edgeFiles = edge.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
    assert.deepEqual(edgeFiles.map((f) => f.relativePath), ['dup/SKILL.md'], '同名只保留先到的一个');
    assert.ok(edge.skipped.some((s) => s.code === 'skill-id-conflict' && s.origin === 'dup'));
    assert.ok(edge.skipped.some((s) => s.code === 'skill-invalid-frontmatter' && s.origin === 'broken'), 'DSH 会静默丢弃，所以这里必须报');
    assert.ok(edge.skipped.some((s) => s.code === 'skill-category-flattened' && s.origin === 'a/dup'), '手工嵌套必须压平且可见');
    assert.ok(!edge.skipped.some((s) => s.origin === 'no-md'), '不带 SKILL.md 的目录是资产，既不产出也不报错');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6 0 字节 / 畸形 JSON / 缺失目录：进 skipped 且有稳定机器码，绝不抛、绝不产出空分区', async () => {
  const missing = await readCopilot({ homeDir: path.join(FIXTURES, 'does-not-exist'), env: {} });
  assert.equal(missing.found, false, '未安装是正常状态，不是错误');
  assert.deepEqual(convertCopilot(missing.input).sections, []);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-edge-'));
  try {
    await fs.mkdir(path.join(tmp, 'mcp-config.json.tmp').replace('mcp-config.json.tmp', ''), { recursive: true });
    await writeAt(tmp, 'mcp-config.json', '');
    const empty = await readCopilot({ homeDir: tmp, env: { COPILOT_HOME: tmp } });
    assert.equal(empty.found, true);
    assert.ok(empty.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'mcp-config.json'));
    assert.ok(!convertCopilot(empty.input).sections.some((s) => s.sectionId === 'mcp'), '0 字节绝不产出空 mcp 分区');

    await writeAt(tmp, 'mcp-config.json', '{ "mcpServers": { "x": { "command": "node" } }');
    const broken = await readCopilot({ homeDir: tmp, env: { COPILOT_HOME: tmp } });
    assert.deepEqual(broken.unreadable, ['mcp-config.json']);
    assert.ok(broken.input.readFindings?.some((s) => s.code === 'source-unreadable' && s.origin === 'mcp-config.json' && s.detail === 'json-error'));
    assert.ok(!convertCopilot(broken.input).sections.some((s) => s.sectionId === 'mcp'), '解析失败绝不产出分区');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ③ 端到端 ---------------- */

test('t7 端到端：fixture → 标准 bundle v1（既有 Importer 能分析），整份 ZIP 字节不含凭据值', async () => {
  const read = await readCopilot({ homeDir: path.join(FIXTURES, 'basic'), env: { COPILOT_HOME: path.join(FIXTURES, 'basic') } });
  const result = convertCopilot(read.input);
  assert.deepEqual([...result.sections.map((s) => s.sectionId)].sort(), ['agentInstructions', 'mcp', 'skills']);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-e2e-'));
  try {
    const zipPath = path.join(tmp, 'copilot.zip');
    const written = await writeForeignBundle({
      result,
      outPath: zipPath,
      exporterVersion: '0.0.0-test',
      dshVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      exportedAt: '2026-10-04T00:00:00.000Z',
    });
    assert.deepEqual([...written.sections].sort(), ['agentInstructions', 'mcp', 'skills']);
    assert.deepEqual([...written.entryNames].sort(), [
      'custom/agent-instructions/AGENTS.md',
      'custom/skills/hello/SKILL.md',
      'mcp/servers.json',
    ]);

    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from('ghp_FIXTURE_TOKEN_DO_NOT_SHIP', 'utf8')), 'ZIP 字节里不得出现凭据值');
    assert.ok(!buf.includes(Buffer.from('pw@', 'utf8')), 'ZIP 字节里不得出现 URL userinfo');
    assert.ok(!buf.includes(Buffer.from('session-store.db', 'utf8')), '未迁移的文件绝不进包');

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters(), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '产物必须是合法 bundle：' + JSON.stringify(analysis.errors));
    for (const sid of ['mcp', 'skills', 'agentInstructions'] as SectionId[]) {
      assert.ok(analysis.sectionsInZip.includes(sid), '缺少分区 ' + sid);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- 范围与真机取样 ---------------- */

test('t8 范围：Copilot 会话与其它未迁移文件绝不产出 sessions/workspaces 分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-scope-'));
  try {
    // 造出官方列出的、但本期**不搬**的文件
    await writeAt(tmp, 'session-store.db', 'SQLite format 3' + String.fromCharCode(0));
    await writeAt(tmp, 'session-state/1.json', '{}');
    await writeAt(tmp, 'config.json', '{"theme":"dark"}');
    await writeAt(tmp, 'permissions-config.json', '{}');
    await writeAt(tmp, 'agents/agent.md', '# agent');
    await writeAt(tmp, 'mcp-config.json', JSON.stringify({ mcpServers: { only: { command: 'node' } } }));
    const read = await readCopilot({ homeDir: tmp, env: { COPILOT_HOME: tmp } });
    const result = convertCopilot(read.input);
    assert.deepEqual(result.sections.map((s) => s.sectionId), ['mcp'], '只搬冻结范围内的三个来源面');
    assert.deepEqual(result.credentialRefs, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

const REAL_HOME = resolveCopilotHome({ homeDir: os.homedir(), env: process.env });
const realStat = await fs.stat(REAL_HOME.home).catch(() => null);

test(
  't9 真机取样：读得动本机 Copilot 配置目录（只断言键名与计数，不含任何配置值）',
  { skip: realStat === null ? '本机无 ~/.copilot（契约 §8.2 标注：文档取证、未经真机验证）' : false },
  async () => {
    const read = await readCopilot({ homeDir: os.homedir(), env: process.env, maxSkills: 5, maxSkillFiles: 10 });
    assert.equal(read.found, true);
    const result = convertCopilot(read.input);
    assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), 'Copilot 会话不在本期范围');
    assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'));
  },
);
