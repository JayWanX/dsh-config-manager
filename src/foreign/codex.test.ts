/**
 * Codex CLI 来源（读盘 + TOML 子集解析 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts / hermes.test.ts 同构）：
 *  ① 位置真值：CODEX_HOME > ~/.codex（三平台同形）
 *  ② 翻译与安全不变量：TOML 引号/数组/表头三形态、MCP 口径与凭据剥离、AGENTS.override.md 优先级、
 *     嵌套技能压平、非法 frontmatter / 同名 / 畸形 TOML / 缺失文件一律进 skipped 且有稳定机器码
 *  ③ 端到端：产物是合法 bundle v1 分区，既有 Importer 能分析，且**整份 ZIP 字节**不含凭据值
 *  ④ 会话（2026-10-06 起）：rollout JSONL 解析（cwd/id、块归一、工具配对、reasoning 逐类计数）、
 *     双根读盘（sessions/YYYY/MM/DD + archived_sessions）、子代理跳过而 fork 保留、
 *     不安全 id / 缺 cwd / 空 rollout / 条数触顶逐条报码，以及 sessions + workspaces 的端到端
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
import { codexSessionId, codexSubagentMarker, convertCodex, parseCodexRollout } from './codex.ts';
import { parseTomlSubset, readCodex, readCodexSessions, resolveCodexHome } from './read-codex.ts';
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
    // 目标机会话格式版本必须由宿主解析后传入：不给 → 一条都不转（整批报 session-format-version-unknown），
    // 因此这里绝不产出 sessions/workspaces 分区
    assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'));
    assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'));
    if ((read.input.sessions?.length ?? 0) > 0) {
      const versioned = convertCodex({ ...read.input, targetSessionFormatVersion: 3 });
      assert.ok(versioned.sections.some((s) => s.sectionId === 'sessions'), '有版本时读出的会话必须转成 sessions 分区');
      assert.ok(versioned.sections.some((s) => s.sectionId === 'workspaces'), '会话必须连工作区一起产出');
    }
  },
);

/* ---------------- ④ 会话（rollout JSONL）：解析 / 双根读盘 / 转码 ---------------- */

const SESSIONS_HOME = path.join(FIXTURES, 'sessions');
const MAIN_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVED_ID = '22222222-2222-4222-8222-222222222222';
const FORK_ID = '44444444-4444-4444-8444-444444444444';
const ROLLOUT_DIR = path.join(SESSIONS_HOME, '.codex', 'sessions', '2026', '10', '06');
const MAIN_FILE = path.join(ROLLOUT_DIR, 'rollout-2026-10-06T10-00-00-11111111-1111-4111-8111-111111111111.jsonl');

/** JSONL 行构造（夹具写法可读性优先） */
const lineOf = (o: unknown): string => JSON.stringify(o);

test('t10 rollout 解析：cwd/id 取 session_meta、块归一、工具调用与结果按 call_id 配对、reasoning 逐类计数、坏行只计数', async () => {
  const rollout = parseCodexRollout(await fs.readFile(MAIN_FILE, 'utf8'), path.basename(MAIN_FILE));
  assert.equal(rollout.id, MAIN_ID);
  assert.equal(rollout.subagent, null);
  assert.equal(rollout.parsed.cwd, 'D:/proj/alpha');
  assert.equal(rollout.parsed.createdAt, Date.parse('2026-10-06T10:00:00.000Z'));
  assert.equal(rollout.parsed.raw, 14, '原始行数含被忽略的（元数据 / event_msg / developer）');
  assert.equal(rollout.parsed.bad, 1, '坏行只计入 bad，绝不抛');

  const records = rollout.parsed.records;
  assert.equal(records.length, 6, 'user + assistant + 两次工具调用 + 两次结果 = 6 条归一记录');
  assert.deepEqual(
    records.map((r) => r.role),
    ['user', 'assistant', 'assistant', 'user', 'assistant', 'user'],
    'function_call 挂 assistant 侧、function_call_output 挂 user 侧（合成器据此发 tool/call 与 tool/result）',
  );

  // user 消息：harness 注入块被过滤，首条人类提问留下 → 会话标题来自它
  const userBlock = records[0]?.blocks[0];
  assert.ok(userBlock !== undefined && userBlock.type === 'text');
  assert.ok(userBlock.text.includes('FIXTURE_CODEX_QUESTION_DO_NOT_SHIP'));
  assert.ok(!JSON.stringify(records).includes('<environment_context>'), 'harness 注入块绝不能进正文（否则标题会变成环境块）');
  assert.equal(rollout.parsed.title, 'FIXTURE_CODEX_QUESTION_DO_NOT_SHIP 帮我看下这个仓库');

  // assistant 正文 + turn_context 的模型落到其后开的记录上
  const assistantBlock = records[1]?.blocks[0];
  assert.ok(assistantBlock !== undefined && assistantBlock.type === 'text');
  assert.ok(assistantBlock.text.includes('FIXTURE_CODEX_ASSISTANT_DO_NOT_SHIP'));
  assert.equal(records[1]?.model, 'gpt-5-codex');

  // function_call → 工具调用块；arguments 是 JSON 字符串时解析成对象
  const call = records[2]?.blocks[0];
  assert.ok(call !== undefined && call.type === 'tool_call');
  assert.equal(call.id, 'call_fixture_1');
  assert.equal(call.name, 'shell');
  assert.deepEqual(call.input, { command: ['ls', '-la'] });

  // function_call_output → 工具结果块，按同一个 call_id 配对，正文取 envelope 里的 output
  const toolResult = records[3]?.blocks[0];
  assert.ok(toolResult !== undefined && toolResult.type === 'tool_result');
  assert.equal(toolResult.id, 'call_fixture_1');
  assert.equal(toolResult.text, 'file-a.txt' + NL + 'file-b.txt');
  assert.equal(toolResult.isError, false);

  // custom_tool_call（apply_patch）：JS 形参不做 JS→JSON 转换，原样字符串（绝不猜）
  const patch = records[4]?.blocks[0];
  assert.ok(patch !== undefined && patch.type === 'tool_call');
  assert.equal(patch.name, 'apply_patch');
  assert.equal(patch.input, 'tools.apply_patch({"patch":"*** Begin Patch"})');

  // 块数组形态的输出：文本块拼接；图片块在本共享 IR 里没有承载块 → 计数
  const blockResult = records[5]?.blocks[0];
  assert.ok(blockResult !== undefined && blockResult.type === 'tool_result');
  assert.equal(blockResult.id, 'call_fixture_3');
  assert.equal(blockResult.text, 'FIXTURE_CODEX_TOOL_BLOCK_DO_NOT_SHIP');

  // 未迁移记录逐类计数（reasoning 绝不伪装成正文；event_msg 是 response_item 的重复 → 不记账）
  assert.deepEqual(rollout.parsed.ignored, {
    'injected-block': 1,
    reasoning: 1,
    compacted: 1,
    'response_item:local_shell_call': 1,
    'message-role:developer': 1,
    'tool-output:input_image': 1,
  });
  assert.ok(!JSON.stringify(records).includes('FIXTURE_CODEX_REASONING_DO_NOT_SHIP'), 'reasoning 摘要绝不进正文');
  assert.ok(!JSON.stringify(records).includes('FIXTURE_CODEX_DUPLICATE_DO_NOT_SHIP'), 'event_msg 与 response_item 重复 → 绝不重复计数');

  // 子代理标记与 id 口径（fork 不是子代理）
  assert.equal(codexSubagentMarker({ thread_source: 'subagent' }), 'thread_source=subagent');
  assert.equal(codexSubagentMarker({ source: { subagent: {} } }), 'source.subagent');
  assert.equal(codexSubagentMarker({ forked_from_id: 'x', parent_thread_id: 'y' }), null, 'fork 会话必须保留');
  assert.equal(codexSubagentMarker({}), null);
  assert.equal(codexSessionId('bad/id', 'rollout-x.jsonl'), 'rollout-x', '不安全 id 回落文件名');
  assert.equal(codexSessionId('ok-id', 'rollout-x.jsonl'), 'ok-id');
});

test('t11 双根读盘：sessions/YYYY/MM/DD + archived_sessions 都读；子代理 rollout 剔除并报码；非 rollout jsonl 不读', async () => {
  const read = await readCodex({ homeDir: SESSIONS_HOME, env: {} });
  assert.equal(read.found, true);
  const files = read.input.sessions ?? [];
  assert.deepEqual(
    files.map((f) => f.id).sort(),
    [MAIN_ID, ARCHIVED_ID, FORK_ID].sort(),
    'fork 会话必须保留；两个子代理 rollout（thread_source / source.subagent）必须被剔除',
  );
  const raw = JSON.stringify(read.input);
  assert.ok(!raw.includes('FIXTURE_CODEX_SUBAGENT_A_DO_NOT_SHIP'));
  assert.ok(!raw.includes('FIXTURE_CODEX_SUBAGENT_B_DO_NOT_SHIP'));
  assert.ok(!raw.includes('FIXTURE_CODEX_NOT_A_ROLLOUT_DO_NOT_SHIP'), '非 rollout-*.jsonl 绝不读（读了就是造垃圾会话）');

  const subagentFindings = (read.input.readFindings ?? []).filter((s) => (s.detail ?? '').startsWith('codex-subagent:'));
  assert.deepEqual(
    subagentFindings.map((s) => s.detail).sort(),
    ['codex-subagent:source.subagent', 'codex-subagent:thread_source=subagent'],
    '两种子代理标记都必须如实报码',
  );
  assert.ok(subagentFindings.every((s) => s.code === 'unsupported-session-record'));

  // archived 根的 Windows 反斜杠 cwd 原样保留（归位由转码期的 projectKey 负责）
  assert.equal(files.find((f) => f.id === ARCHIVED_ID)?.parsed.cwd, 'D:\\proj\\beta');
});

test('t12 转码：会话 + 工作区同源产出（同 cwd 归并一条工作区）；缺目标机版本时一条都不转', async () => {
  const read = await readCodex({ homeDir: SESSIONS_HOME, env: {} });

  const none = convertCodex(read.input);
  assert.ok(!none.sections.some((s) => s.sectionId === 'sessions'), '缺目标机版本时一条都不转');
  assert.ok(none.skipped.some((s) => s.code === 'session-format-version-unknown' && s.count === 3));

  const result = convertCodex({ ...read.input, targetSessionFormatVersion: 3 });
  assert.equal(result.counts['sessions.files'], 3);
  assert.equal(result.counts['sessions.transcoded'], 3);
  const sessionSection = result.sections.find((s) => s.sectionId === 'sessions');
  const main = (sessionSection?.files ?? []).find((f) => f.relativePath.includes(MAIN_ID));
  assert.match(
    main?.relativePath ?? '',
    /^--D-proj-alpha--\/11111111-1111-4111-8111-111111111111\/session\.v3\.jsonl\.zstd$/,
    '会话必须按 projectKey(cwd)/id 归位',
  );
  assert.ok((main?.data.length ?? 0) > 0, '必须真的产出会话字节');

  // workspaces：alpha 下两个会话（main + fork）归并成一条，beta 一条
  const workspaces = result.sections.find((s) => s.sectionId === 'workspaces')?.data as
    | { workspaces: { id: string; sessionIds: string[] }[] }
    | undefined;
  assert.equal(workspaces?.workspaces.length, 2, '同 cwd 的多个会话必须归并成一条工作区记录');
  assert.equal(workspaces?.workspaces.find((w) => w.sessionIds.includes(FORK_ID))?.sessionIds.length, 2);

  // 未迁移记录逐类报码（reasoning / 注入块 / 坏行都要在报告里可见）
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-session-record' && s.detail === 'reasoning' && s.count === 1));
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-session-record' && s.detail === 'injected-block'));
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-session-record' && s.detail === 'unparsable' && s.count === 1));
});

test('t13 边界：不安全 id 回落文件名、文件名也不安全则报 session-unsafe-id、缺 cwd / 空 rollout 逐条报码、条数触顶可见', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-sessions-'));
  const day = '.codex/sessions/2026/10/06/';
  const userLine = lineOf({
    timestamp: '2026-10-06T13:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FIXTURE_CODEX_EDGE_DO_NOT_SHIP' }] },
  });
  try {
    // ① payload.id 不安全（含 '/'）→ 回落 rollout 文件名（安全）→ 仍能导入
    await writeAt(home, day + 'rollout-2026-10-06T13-00-00-66666666-6666-4666-8666-666666666666.jsonl', [
      lineOf({ timestamp: '2026-10-06T13:00:00.000Z', type: 'session_meta', payload: { id: 'bad/id', cwd: 'D:/proj/alpha' } }),
      userLine,
    ].join(NL));
    // ② 文件名也不安全（带空格）→ 转码期必须报 session-unsafe-id，绝不静默改名
    await writeAt(home, day + 'rollout-bad id.jsonl', [
      lineOf({ timestamp: '2026-10-06T13:10:00.000Z', type: 'session_meta', payload: { cwd: 'D:/proj/alpha' } }),
      userLine,
    ].join(NL));
    // ③ 缺 cwd
    await writeAt(home, day + 'rollout-2026-10-06T14-00-00-77777777-7777-4777-8777-777777777777.jsonl', [
      lineOf({ timestamp: '2026-10-06T14:00:00.000Z', type: 'session_meta', payload: { id: '77777777-7777-4777-8777-777777777777' } }),
      userLine,
    ].join(NL));
    // ④ 只有坏行 → raw = 0 → session-empty
    await writeAt(home, day + 'rollout-2026-10-06T15-00-00-88888888-8888-4888-8888-888888888888.jsonl', 'NOT_JSON' + NL);

    const read = await readCodex({ homeDir: home, env: {} });
    const files = read.input.sessions ?? [];
    assert.equal(files.length, 4, '读得出 4 条（能不能迁移由转码期判定）');
    assert.equal(
      files.find((f) => f.parsed.cwd === 'D:/proj/alpha' && f.id !== 'rollout-bad id')?.id,
      'rollout-2026-10-06T13-00-00-66666666-6666-4666-8666-666666666666',
      '不安全 payload.id 回落安全文件名',
    );

    const result = convertCodex({ ...read.input, targetSessionFormatVersion: 3 });
    assert.equal(result.counts['sessions.files'], 1, '只有 ① 能转码成功');
    assert.ok(result.skipped.some((s) => s.code === 'session-unsafe-id' && s.origin === 'rollout-bad id'));
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd'));
    assert.ok(result.skipped.some((s) => s.code === 'session-empty'));

    // ⑤ 条数触顶必须可见（多收一个用来判定「还有没读完的」）
    const capped = await readCodexSessions(path.join(home, '.codex'), 1, 8 * 1024 * 1024);
    assert.equal(capped.files.length, 1);
    assert.ok(capped.readFindings.some((s) => s.code === 'source-unreadable' && s.detail === 'max-sessions-reached'));

    // ⑥ 单文件超限：必须是 too-large（报成 read-error 会把「文件太大没读」说成「读失败」）
    const tooBig = await readCodexSessions(path.join(home, '.codex'), 10, 8);
    assert.equal(tooBig.files.length, 0);
    assert.ok(tooBig.readFindings.some((s) => s.code === 'source-unreadable' && s.detail === 'too-large'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('t14 端到端：会话 fixture → 标准 bundle v1（sessions + workspaces 进包，既有 Importer 能分析）', async () => {
  const read = await readCodex({ homeDir: SESSIONS_HOME, env: {} });
  const result = convertCodex({ ...read.input, targetSessionFormatVersion: 3 });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-sessions-e2e-'));
  try {
    const zipPath = path.join(tmp, 'codex-sessions.zip');
    const written = await writeForeignBundle({
      result,
      outPath: zipPath,
      exporterVersion: '0.0.0-test',
      dshVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      exportedAt: '2026-10-06T00:00:00.000Z',
    });
    assert.ok(written.sections.includes('sessions'));
    assert.ok(written.sections.includes('workspaces'));
    assert.ok(
      written.entryNames.some((e) => e.startsWith('sessions/--D-proj-alpha--/')),
      '会话文件必须按 projectKey/id 进包：' + written.entryNames.join(', '),
    );

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters(), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '产物必须是合法 bundle：' + JSON.stringify(analysis.errors));
    assert.ok(analysis.sectionsInZip.includes('sessions'));
    assert.ok(analysis.sectionsInZip.includes('workspaces'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

