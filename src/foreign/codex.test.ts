/**
 * Codex CLI 来源（读盘 + TOML 子集解析 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts / hermes.test.ts 同构）：
 *  ① 位置真值：CODEX_HOME > ~/.codex（三平台同形）
 *  ② 翻译与安全不变量：TOML 引号/数组/表头三形态、MCP 口径与凭据剥离、AGENTS.override.md 优先级、
 *     嵌套技能压平、非法 frontmatter / 同名 / 畸形 TOML / 缺失文件一律进 skipped 且有稳定机器码
 *  ③ 端到端：产物是合法 bundle v1 分区，既有 Importer 能分析，且**整份 ZIP 字节**不含凭据值
 *
 * 取证强度（契约 §8.2 / §8.7）：~/.codex 与 CODEX_HOME 是**文档取证、未经真机验证**
 * （本机无 ~/.codex）；~/.agents/skills 是**实测取证**（目录存在、本机为空）。真机取样用例
 * 因此必须能 skip，且只断言键名与计数。
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
import { convertCodex } from './codex.ts';
import { parseTomlSubset, readCodex, resolveCodexHome } from './read-codex.ts';
import type { ForeignImportResult } from './types.ts';

const NL = String.fromCharCode(10);
const FIXTURES = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));

function skillMd(name: string, description: string): string {
  return ['---', 'name: ' + name, 'description: ' + description, '---', '', 'body'].join(NL);
}

function asRecord(v: unknown): Record<string, unknown> {
  assert.ok(typeof v === 'object' && v !== null && !Array.isArray(v), '期望普通对象');
  return v as Record<string, unknown>;
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

test('t1 位置：CODEX_HOME 覆盖 > ~/.codex（三平台同形）', () => {
  assert.equal(resolveCodexHome({ homeDir: 'C:/Users/u', env: {} }).home, path.join('C:/Users/u', '.codex'));
  assert.equal(resolveCodexHome({ homeDir: '/home/u', env: {} }).home, path.join('/home/u', '.codex'));
  assert.equal(resolveCodexHome({ homeDir: '/home/u', env: {} }).overridden, false);

  const over = resolveCodexHome({ homeDir: 'C:/Users/u', env: { CODEX_HOME: 'D:/codex-home' } });
  assert.equal(over.home, 'D:/codex-home');
  assert.equal(over.overridden, true, 'CODEX_HOME 生效必须可被上报（绝不静默换目录）');
});

/* ---------------- ② TOML 子集解析（引号 / 数组 / 表头） ---------------- */

test('t2 TOML 子集：引号（基本/字面量/多行）+ 数组（跨行/尾逗号）+ 表头（点分/引号键）三形态全覆盖', () => {
  const parsed = parseTomlSubset([
    '# 注释行',
    'title = "basic \\"quoted\\" string"',
    "literal = 'C:\\Users\\u\\x'",
    'multiline = """',
    '第一行',
    '第二行',
    '"""',
    'count = 1_000',
    'ratio = 2.5',
    'flag = true',
    'when = 2026-10-04T10:00:00Z',
    '',
    '[table.sub]',
    'k = "v"',
    'list = [',
    '  "a",',
    '  "b",',
    ']',
    'inline = { "X-Trace" = "on", n = 3 }',
    'dotted.key = "deep"',
    '',
    "[projects.'D:\\proj\\x']",
    'trust_level = "trusted"',
    '',
    '[[items]]',
    'name = "one"',
    '[[items]]',
    'name = "two"',
    '',
  ].join(NL));
  if (!parsed.ok) assert.fail('TOML 解析失败: ' + parsed.reason);
  const root = parsed.value;
  assert.equal(root['title'], 'basic "quoted" string');
  assert.equal(root['literal'], 'C:\\Users\\u\\x');
  assert.equal(root['multiline'], '第一行' + NL + '第二行' + NL);
  assert.equal(root['count'], 1000, '数字下划线分隔符允许');
  assert.equal(root['ratio'], 2.5);
  assert.equal(root['flag'], true);
  assert.equal(root['when'], '2026-10-04T10:00:00Z', '日期时间不进类型化：原样字符串');

  const sub = asRecord(asRecord(root['table'])['sub']);
  assert.equal(sub['k'], 'v');
  assert.deepEqual(sub['list'], ['a', 'b'], '跨行数组 + 尾逗号');
  assert.deepEqual(sub['inline'], { 'X-Trace': 'on', n: 3 }, '内联表（含引号键）');
  assert.deepEqual(sub['dotted'], { key: 'deep' }, '点分键');

  const projects = asRecord(root['projects']);
  assert.deepEqual(projects['D:\\proj\\x'], { trust_level: 'trusted' }, '字面量引号键里的反斜杠不被解释');

  const items = root['items'];
  assert.ok(Array.isArray(items));
  assert.deepEqual(items.map((x) => asRecord(x)['name']), ['one', 'two'], '[[数组表]] 追加而非覆盖');
});

/* ---------------- ② MCP 翻译 ---------------- */

test('t3 MCP：从 fixture 的 [mcp_servers.*] 映射（stdio/http 两类），凭据剥离且只留引用名，非映射如实报码', async () => {
  const read = await readCodex({ homeDir: path.join(FIXTURES, 'basic'), env: {} });
  assert.equal(read.found, true);
  assert.equal(read.locationOverridden, false);
  assert.deepEqual(read.unreadable, []);

  const result = convertCodex(read.input);
  const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  assert.equal(mcp.servers.length, 3, '既无 command 也无 url 的条目不产出');
  assert.equal(result.counts['mcp.servers'], 3);

  const stdio = mcp.servers.find((s) => s.serverName === 'gitnexus');
  assert.equal(stdio?.type, 'stdio');
  assert.equal(stdio?.command, 'npx');
  assert.deepEqual(stdio?.args, ['-y', 'gitnexus']);
  assert.equal(stdio?.env?.['GITHUB_TOKEN'], '', '命中凭据的字段值置空、字段名保留');
  assert.equal(stdio?.env?.['PLAIN'], 'ok');
  assert.deepEqual(
    Object.keys(stdio ?? {}).sort(),
    ['args', 'command', 'env', 'serverName', 'type'],
    '只带 DSH 有对等字段的键；Codex 专属字段（startup_timeout_sec 等）不硬塞进包',
  );

  const remote = mcp.servers.find((s) => s.serverName === 'remote');
  assert.equal(remote?.type, 'streamable-http');
  assert.equal(remote?.url, 'https://mcp.example.com/mcp', 'URL userinfo 必须剥离');
  assert.deepEqual(remote?.headers, { 'X-Trace': 'on' });

  assert.ok(result.credentialRefs.includes('mcp:gitnexus:GITHUB_TOKEN'));
  assert.ok(result.credentialRefs.includes('mcp:remote:url'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'legacy-sse'));
  assert.ok(!JSON.stringify(result).includes('ghp_FIXTURE_TOKEN_DO_NOT_SHIP'), '结果对象里不得出现凭据明文');
  assert.ok(!JSON.stringify(result).includes('pw@'), 'URL userinfo 也必须剥离');

  const odd = convertCodex({ config: { mcp_servers: ['not', 'a', 'mapping'] } });
  assert.ok(odd.skipped.some((s) => s.code === 'mcp-server-empty' && s.detail === 'not-a-mapping'), '形态对不上必须报码，绝不静默');
  assert.ok(!odd.sections.some((s) => s.sectionId === 'mcp'), '不产出空 mcp 分区');
});

/* ---------------- ② AGENTS.md 发现层级 ---------------- */

test('t4 AGENTS.md 发现层级：override 优先并报码；无 override 用 AGENTS.md；都没有则不产出分区', async () => {
  const over = await readCodex({ homeDir: path.join(FIXTURES, 'override'), env: {} });
  assert.equal(over.found, true);
  const overResult = convertCodex(over.input);
  const overText = fileText(overResult, 'agentInstructions', 'AGENTS.md') ?? '';
  assert.ok(overText.includes('覆盖指令'), '必须选 AGENTS.override.md 的正文：' + overText);
  assert.ok(!overText.includes('基础指令'), '低优先级文件绝不能被选中');
  assert.ok(
    overResult.skipped.some((s) => s.code === 'instructions-override-selected' && s.origin === 'AGENTS.override.md'),
    '命中 override 必须报码（否则用户不知道哪份指令生效了）',
  );

  const base = await readCodex({ homeDir: path.join(FIXTURES, 'basic'), env: {} });
  const baseResult = convertCodex(base.input);
  const baseText = fileText(baseResult, 'agentInstructions', 'AGENTS.md') ?? '';
  assert.ok(baseText.includes('Codex 全局指令'));
  assert.ok(!baseResult.skipped.some((s) => s.code === 'instructions-override-selected'));

  assert.ok(!convertCodex({}).sections.some((s) => s.sectionId === 'agentInstructions'), '无指令文件不产出空分区');
  assert.ok(!convertCodex({ instructions: '   ' }).sections.some((s) => s.sectionId === 'agentInstructions'));
});

/* ---------------- ② 畸形 / 缺失 / 空文件 ---------------- */

test('t5 畸形 TOML：进 skipped（source-unreadable + detail=toml-error），不抛、绝不产出空 mcp 分区', async () => {
  const read = await readCodex({ homeDir: path.join(FIXTURES, 'malformed'), env: {} });
  assert.equal(read.found, true);
  assert.equal(read.input.config, undefined);
  assert.deepEqual(read.unreadable, ['config.toml']);

  const result = convertCodex(read.input);
  assert.ok(result.skipped.some((s) => s.code === 'source-unreadable' && s.origin === 'config.toml' && s.detail === 'toml-error'));
  assert.ok(!result.sections.some((s) => s.sectionId === 'mcp'), '解析失败绝不产出空分区');

  // 解析器本身也绝不抛：结构畸形一律 ok:false + 稳定 reason
  const bad = ['key =', 'args = ["-y", "x"', '[unclosed', 'a = 1 b = 2', 'a = "x\\q"'];
  for (const src of bad) {
    const p = parseTomlSubset(src);
    assert.equal(p.ok, false, '必须返回 ok:false 而不是抛异常：' + src);
    if (!p.ok) assert.equal(typeof p.reason, 'string');
  }
  assert.equal(parseTomlSubset('').ok, true, '空文件不是畸形：解析成空表');
});

test('t6 缺失文件 / 0 字节 / 超限：一律进 skipped 或如实计数，绝不抛、绝不截断', async () => {
  const missing = await readCodex({ homeDir: path.join(FIXTURES, 'does-not-exist'), env: {} });
  assert.equal(missing.found, false, '未安装是正常状态，不是错误');
  assert.deepEqual(convertCodex(missing.input).sections, []);
  assert.deepEqual(missing.unreadable, []);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-edge-'));
  try {
    // 只有 ~/.agents/skills、没有 ~/.codex：仍应 found（不许因缺 .codex 而报错）
    await writeAt(tmp, '.agents/skills/solo/SKILL.md', skillMd('solo', 'skills-only home'));
    const onlySkills = await readCodex({ homeDir: tmp, env: {} });
    assert.equal(onlySkills.found, true);
    assert.deepEqual(onlySkills.input.skills?.map((s) => s.name), ['solo']);
    assert.deepEqual(convertCodex(onlySkills.input).sections.map((s) => s.sectionId), ['skills']);

    // 0 字节 config.toml
    await fs.mkdir(path.join(tmp, '.codex'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.codex', 'config.toml'), '');
    const empty = await readCodex({ homeDir: tmp, env: {} });
    assert.ok(empty.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'config.toml'));
    assert.ok(!convertCodex(empty.input).sections.some((s) => s.sectionId === 'mcp'), '0 字节绝不产出空 mcp 分区');

    // 超限：不读、不截断，如实进 unreadable
    await fs.writeFile(path.join(tmp, '.codex', 'config.toml'), '[mcp_servers.x]' + NL + 'command = "npx"' + NL);
    const big = await readCodex({ homeDir: tmp, env: {}, maxFileBytes: 8 });
    assert.deepEqual(big.unreadable, ['config.toml']);
    assert.ok(big.input.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'too-large'));
    assert.equal(big.input.config, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ② skills ---------------- */

test('t7 skills：一层直取、嵌套压平报码、非法 frontmatter 跳过、同名先到先得', async () => {
  const read = await readCodex({ homeDir: path.join(FIXTURES, 'basic'), env: {} });
  assert.deepEqual(
    (read.input.skills ?? []).map((s) => s.name + '@' + (s.category ?? '-')).sort(),
    ['hello@-', 'nested@wrapper'],
    '自帯 SKILL.md 的目录就是技能；不带的下钻一层，技能名取叶子名',
  );
  const result = convertCodex(read.input);
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath).sort(), ['hello/SKILL.md', 'nested/SKILL.md'], '必须是单层 <技能>/SKILL.md');
  assert.ok(result.skipped.some((s) => s.code === 'skill-category-flattened' && s.origin === 'wrapper/nested'));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-skills-'));
  try {
    await writeAt(tmp, '.agents/skills/a/dup/SKILL.md', skillMd('dup', 'first wins'));
    await writeAt(tmp, '.agents/skills/b/dup/SKILL.md', skillMd('dup', 'second loses'));
    await writeAt(tmp, '.agents/skills/broken/SKILL.md', ['---', 'description: great DX: intuitive', '---', 'body'].join(NL));
    await writeAt(tmp, '.agents/skills/no-md/assets.md', 'not a skill dir');
    const edge = convertCodex((await readCodex({ homeDir: tmp, env: {} })).input);
    const edgeFiles = edge.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
    assert.deepEqual(edgeFiles.map((f) => f.relativePath), ['dup/SKILL.md'], '同名只保留先到的一个');
    assert.ok(edge.skipped.some((s) => s.code === 'skill-id-conflict' && s.origin === 'dup'), '同名先到先得，后者跳过并报码');
    assert.ok(edge.skipped.some((s) => s.code === 'skill-invalid-frontmatter' && s.origin === 'broken'), 'DSH 会静默丢弃，所以这里必须报');
    assert.ok(!edge.skipped.some((s) => s.origin === 'no-md'), '不带 SKILL.md 的目录是资产，既不产出也不报错');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ③ 端到端 ---------------- */

test('t8 端到端：fixture → 标准 bundle v1（既有 Importer 能分析），整份 ZIP 字节不含凭据值', async () => {
  const read = await readCodex({ homeDir: path.join(FIXTURES, 'basic'), env: {} });
  const result = convertCodex(read.input);
  assert.deepEqual([...result.sections.map((s) => s.sectionId)].sort(), ['agentInstructions', 'mcp', 'skills']);
  assert.equal(result.source, 'codex');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-e2e-'));
  try {
    const zipPath = path.join(tmp, 'codex.zip');
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
      'custom/skills/nested/SKILL.md',
      'mcp/servers.json',
    ], '包内路径不得含嵌套外层目录（压平），也不得含任何额外文件');

    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from('ghp_FIXTURE_TOKEN_DO_NOT_SHIP', 'utf8')), 'ZIP 字节里不得出现 MCP env 凭据值');
    assert.ok(!buf.includes(Buffer.from('pw@', 'utf8')), 'ZIP 字节里不得出现 URL userinfo');

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

/* ---------------- 真机取样（只读；本机没有就 skip） ---------------- */

const REAL_HOME = resolveCodexHome({ homeDir: os.homedir(), env: process.env });
const realCodexStat = await fs.stat(REAL_HOME.home).catch(() => null);
const realSkillsStat = await fs.stat(path.join(os.homedir(), '.agents', 'skills')).catch(() => null);

test(
  't9 真机取样：读得动本机 Codex / agents-skills 目录（只断言键名与计数，不含任何配置值）',
  { skip: realCodexStat === null && realSkillsStat === null ? '本机无 ~/.codex 也无 ~/.agents/skills（契约 §8.2 标注：文档取证、未经真机验证）' : false },
  async () => {
    const read = await readCodex({ homeDir: os.homedir(), env: process.env, maxSkills: 5, maxSkillFiles: 10 });
    assert.equal(read.found, true);
    for (const s of read.input.skills ?? []) {
      assert.ok(s.files.some((f) => f.relativePath === 'SKILL.md'), '每个技能单元必须自带 SKILL.md：' + s.name);
    }
    const result = convertCodex(read.input);
    assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), 'Codex 会话不在本期范围（绝不产出 sessions 分区）');
    assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'));
  },
);
