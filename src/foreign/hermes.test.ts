/**
 * Hermes 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts 同构）：
 *  ① 位置真值：%LOCALAPPDATA%\Hermes / ~/.hermes / HERMES_HOME 覆盖
 *  ② 翻译与安全不变量：MCP 口径、技能压平、SOUL.md 导入、**MEMORY.md 与 .env 只报告不导入**
 *  ③ 端到端：产物是合法 bundle v1 分区，且**整份 ZIP 字节**里不含记忆正文与凭据值
 *
 * 真机取样（t8）只读 %LOCALAPPDATA%\Hermes，且**只断言键名与计数**，绝不把配置值写进断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpSection } from '../schema/types.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode } from './claude-code.ts';
import { convertHermes } from './hermes.ts';
import { isRecord } from '../utils/guards.ts';
import { readHermes, resolveHermesHome } from './read-hermes.ts';

const enc = new TextEncoder();
const NL = String.fromCharCode(10);

function skillMd(name: string, description: string): Uint8Array {
  return enc.encode('---' + NL + 'name: ' + name + NL + 'description: ' + description + NL + '---' + NL + NL + 'body' + NL);
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：HERMES_HOME 覆盖 > Windows %LOCALAPPDATA%\Hermes > ~/.hermes', () => {
  const win = resolveHermesHome({ homeDir: 'C:/Users/u', env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, platform: 'win32' });
  assert.equal(win.home, path.join('C:/Users/u/AppData/Local', 'Hermes'));
  assert.equal(win.overridden, false);

  // 契约 §8.2 的冻结真值：Windows 就是 %LOCALAPPDATA%\Hermes
  const winNoEnv = resolveHermesHome({ homeDir: 'C:/Users/u', env: {}, platform: 'win32' });
  assert.equal(winNoEnv.home, path.join('C:/Users/u', 'AppData', 'Local', 'Hermes'));

  assert.equal(resolveHermesHome({ homeDir: '/home/u', env: {}, platform: 'darwin' }).home, path.join('/home/u', '.hermes'));
  assert.equal(resolveHermesHome({ homeDir: '/home/u', env: {}, platform: 'linux' }).home, path.join('/home/u', '.hermes'));

  const over = resolveHermesHome({ homeDir: 'C:/Users/u', env: { HERMES_HOME: 'D:/hermes-home' }, platform: 'win32' });
  assert.equal(over.home, 'D:/hermes-home');
  assert.equal(over.overridden, true, 'HERMES_HOME 生效必须可被上报（绝不静默换目录）');
});

/* ---------------- ② 翻译 ---------------- */

test('t2 MCP：stdio 与 url 两类同口径映射；凭据剥离且只留引用名；非映射形态如实报码', () => {
  const result = convertHermes({
    config: {
      mcp_servers: {
        svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: 'ghp_SUPERSECRET', PLAIN: 'ok' }, enabled: true },
        web: { url: 'https://user:pw@mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
        sse: { url: 'https://sse.example.com', type: 'sse' },
        disabled: { command: 'npx', args: ['-y', 'disabled-svc'], enabled: false },
        empty: { enabled: false },
      },
    },
  });
  const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  assert.equal(mcp.servers.length, 4, '既无 command 也无 url 的条目不产出；enabled:false 但有 command 的照常导入');
  assert.equal(mcp.servers.find((s) => s.serverName === 'svc')?.type, 'stdio');
  assert.equal(mcp.servers.find((s) => s.serverName === 'web')?.type, 'streamable-http');
  assert.equal(mcp.servers.find((s) => s.serverName === 'web')?.url, 'https://mcp.example.com/mcp', 'URL userinfo 必须剥离');
  assert.equal(mcp.servers.find((s) => s.serverName === 'svc')?.env?.['GITHUB_TOKEN'], '', '命中凭据的字段值置空、字段名保留');
  assert.equal(mcp.servers.find((s) => s.serverName === 'svc')?.env?.['PLAIN'], 'ok');
  assert.ok(result.credentialRefs.includes('mcp:svc:GITHUB_TOKEN'));
  assert.ok(result.credentialRefs.includes('mcp:web:url'));
  assert.equal(mcp.servers.find((s) => s.serverName === 'disabled')?.type, 'stdio', 'enabled:false 不是丢弃理由：DSH 无对等字段，原样导入由计划逐条取消');
  assert.ok(!result.skipped.some((s) => s.origin === 'disabled'), 'enabled 字段绝不导致静默丢弃');
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'sse'));
  assert.ok(!JSON.stringify(result).includes('ghp_SUPERSECRET'), '结果对象里不得出现凭据明文');
  assert.ok(!JSON.stringify(result).includes('pw@'), 'URL userinfo 也必须剥离');

  const odd = convertHermes({ config: { mcp_servers: ['not', 'a', 'mapping'] } });
  assert.ok(odd.skipped.some((s) => s.code === 'mcp-server-empty' && s.detail === 'not-a-mapping'), '形态对不上必须报码，绝不静默');
  assert.ok(!odd.sections.some((s) => s.sectionId === 'mcp'), '不产出空 mcp 分区');
});

test('t2b 与 Claude 同口径：同一份 MCP 定义在两来源产出逐字相同的条目、引用名与机器码', () => {
  const defs = {
    svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: 'ghp_PARITY_SECRET' }, enabled: true },
    web: { url: 'https://user:pw@mcp.example.com/mcp' },
    sse: { url: 'https://sse.example.com/sse', type: 'sse' },
    empty: { enabled: false },
  };
  const hermes = convertHermes({ config: { mcp_servers: defs } });
  const claude = convertClaudeCode({ claudeJson: { mcpServers: defs } });
  const mcpOf = (r: typeof hermes) => r.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  assert.deepEqual(mcpOf(hermes), mcpOf(claude), '两来源的 mcp 分区必须逐字相同（同一内核实现，口径不可能分叉）');
  assert.deepEqual(hermes.credentialRefs, claude.credentialRefs);
  const codes = (r: typeof hermes) => r.skipped.map((s) => s.code + ':' + (s.origin ?? '')).sort();
  assert.deepEqual(codes(hermes), codes(claude), 'transport 判定与 sse/空条目报码必须同口径');
  assert.equal(mcpOf(hermes).servers.find((s) => s.serverName === 'sse')?.type, 'streamable-http');
});

test('t3 技能：两层分类被压平为叶子名并报码；同名先到先得；非法 frontmatter 整体跳过', () => {
  const broken = enc.encode('---' + NL + 'description: great DX: intuitive' + NL + '---' + NL);
  const result = convertHermes({
    skills: [
      { name: 'dogfood', category: 'software-development', files: [{ relativePath: 'SKILL.md', data: skillMd('dogfood', 'dogfood skill') }] },
      { name: 'direct', files: [{ relativePath: 'SKILL.md', data: skillMd('direct', 'own skill') }] },
      { name: 'dogfood', category: 'other-category', files: [{ relativePath: 'SKILL.md', data: skillMd('dogfood', 'duplicate') }] },
      { name: 'broken', category: 'x', files: [{ relativePath: 'SKILL.md', data: broken }] },
    ],
  });
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath).sort(), ['direct/SKILL.md', 'dogfood/SKILL.md'], '压平后是单层 <技能>/SKILL.md');
  assert.ok(result.skipped.some((s) => s.code === 'skill-category-flattened' && s.origin === 'software-development/dogfood'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-id-conflict' && s.origin === 'dogfood'), '同名先到先得，后者跳过并报码');
  assert.ok(result.skipped.some((s) => s.code === 'skill-invalid-frontmatter' && s.origin === 'broken'));
});

test('t4 SOUL.md 进 agentInstructions；MEMORY.md 只报告且正文绝不进结果', () => {
  const result = convertHermes({
    soul: '# 我的主身份' + NL,
    memoryFiles: ['MEMORY.md', 'USER.md'],
  });
  const ins = result.sections.find((s) => s.sectionId === 'agentInstructions');
  const md = ins?.files?.find((f) => f.relativePath === 'AGENTS.md');
  assert.ok(md !== undefined, 'SOUL.md 必须以 AGENTS.md 进 agentInstructions');
  assert.equal(new TextDecoder().decode(md?.data), '# 我的主身份' + NL);
  assert.equal(result.counts['agentInstructions.files'], 1);
  assert.ok(result.skipped.some((s) => s.code === 'memory-report-only' && s.origin === 'MEMORY.md'));
  assert.ok(result.skipped.some((s) => s.code === 'memory-report-only' && s.origin === 'USER.md'));

  // 空 SOUL.md 不产出分区（不生成空载荷）
  assert.ok(!convertHermes({ soul: '   ' }).sections.some((s) => s.sectionId === 'agentInstructions'));
});

test('t5 .env 只报告：值不读、不进结果、不进包', () => {
  const result = convertHermes({ dotEnvPresent: true });
  assert.ok(result.skipped.some((s) => s.code === 'credentials-not-migrated' && s.origin === '.env'));
  assert.deepEqual(result.credentialRefs, [], '连凭据名都没有（.env 根本没被读）');
  assert.deepEqual(result.sections, []);
});

test('t6 会话不迁移：只报码，绝不产出 sessions 分区', () => {
  const result = convertHermes({ config: {}, sessionStore: { present: true, detail: 'state.db' }, soul: 'x' });
  assert.ok(result.skipped.some((s) => s.code === 'sessions-not-migrated' && s.origin === 'state.db'));
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), 'Hermes 的对话在 SQLite 里，本版不迁移');
  assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'));
});

/* ---------------- ③ 读盘 + 端到端 ---------------- */

const MEMORY_SENTINEL = 'MEMORY_SENTINEL_BODY_DO_NOT_SHIP';
const DOTENV_SENTINEL = 'DOTENV_SENTINEL_VALUE_DO_NOT_SHIP';

async function makeHermesHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-home-'));
  await fs.writeFile(path.join(home, 'config.yaml'), [
    'model: gpt-x',
    'mcp_servers:',
    '  svc:',
    '    command: npx',
    '    args:',
    '      - -y',
    '      - svc',
    '    env:',
    '      GITHUB_TOKEN: ghp_FIXTURE_LEAK',
    '    enabled: true',
    '  web:',
    "    url: 'https://user:pw@mcp.example.com/mcp'",
    '',
  ].join(NL));
  await fs.writeFile(path.join(home, 'SOUL.md'), '# 主身份' + NL);
  await fs.mkdir(path.join(home, 'memories'), { recursive: true });
  await fs.writeFile(path.join(home, 'memories', 'MEMORY.md'), MEMORY_SENTINEL + NL);
  await fs.writeFile(path.join(home, 'memories', 'USER.md'), 'user profile' + NL);
  await fs.writeFile(path.join(home, '.env'), 'DOTENV_SENTINEL=' + DOTENV_SENTINEL + NL);
  await fs.writeFile(path.join(home, 'state.db'), 'SQLite format 3' + String.fromCharCode(0));
  await fs.mkdir(path.join(home, 'skills', 'software-development', 'dogfood'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'software-development', 'dogfood', 'SKILL.md'), skillMd('dogfood', 'flattened skill'));
  await fs.writeFile(path.join(home, 'skills', 'software-development', 'dogfood', 'ref.md'), 'ref');
  await fs.mkdir(path.join(home, 'skills', 'se-team-design'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'se-team-design', 'SKILL.md'), skillMd('se-team-design', 'category level skill'));
  await fs.mkdir(path.join(home, 'skills', '.hub'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', '.hub', 'lock.json'), '{}');
  return home;
}

test('t7 端到端：读盘 → 翻译 → 标准 bundle v1；整份 ZIP 字节不含 MEMORY.md 正文与 .env 值', async () => {
  const home = await makeHermesHome();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-zip-'));
  try {
    const read = await readHermes({ homeDir: 'C:/Users/u', env: { HERMES_HOME: home }, platform: 'win32' });
    assert.equal(read.found, true);
    assert.equal(read.locationOverridden, true);
    assert.ok(read.input.readFindings?.some((s) => s.code === 'source-location-overridden'), 'HERMES_HOME 生效必须可上报');
    assert.deepEqual(read.input.memoryFiles, ['MEMORY.md', 'USER.md']);
    assert.equal(read.input.dotEnvPresent, true);
    assert.deepEqual(read.input.sessionStore, { present: true, detail: 'state.db' });
    const inputJson = JSON.stringify(read.input);
    assert.ok(!inputJson.includes(DOTENV_SENTINEL), '.env 只 stat 不读：其值连读盘结果对象都不许进');
    assert.ok(!inputJson.includes(MEMORY_SENTINEL), '记忆只列名不读内容：正文连读盘结果对象都不许进');
    assert.deepEqual(
      (read.input.skills ?? []).map((s) => s.name + '@' + (s.category ?? '-')).sort(),
      ['dogfood@software-development', 'se-team-design@-'],
      '两层分类的技能取叶子名；分类目录自己带 SKILL.md 时它自己就是技能',
    );

    const result = convertHermes(read.input);
    const zipPath = path.join(tmp, 'hermes.zip');
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
      'custom/skills/dogfood/SKILL.md',
      'custom/skills/dogfood/ref.md',
      'custom/skills/se-team-design/SKILL.md',
      'mcp/servers.json',
    ], '包内路径不得含分类目录（压平），也不得含任何记忆/凭据文件');

    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from(MEMORY_SENTINEL, 'utf8')), 'ZIP 字节里不得出现 MEMORY.md 正文');
    assert.ok(!buf.includes(Buffer.from(DOTENV_SENTINEL, 'utf8')), 'ZIP 字节里不得出现 .env 的值');
    assert.ok(!buf.includes(Buffer.from('ghp_FIXTURE_LEAK', 'utf8')), 'ZIP 字节里不得出现 MCP env 的凭据值');
    assert.ok(!buf.includes(Buffer.from('pw@', 'utf8')), 'ZIP 字节里不得出现 URL userinfo');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7b 0 字节 config.yaml：报 source-empty-file，绝不抛、绝不产出空分区', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-empty-'));
  try {
    await fs.writeFile(path.join(home, 'config.yaml'), '');
    const read = await readHermes({ homeDir: 'C:/Users/u', env: { HERMES_HOME: home }, platform: 'win32' });
    assert.equal(read.found, true);
    assert.ok(read.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'config.yaml'));
    assert.deepEqual(convertHermes(read.input).sections, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

/* ---------------- ④ 入库 fixture（形态取自真机；不依赖本机是否装了 Hermes） ---------------- */

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'fixtures', 'hermes');

/**
 * 真机 config.yaml 的**顶层键名**（2026-10-04 本机只读取样；键名不是配置值，可以入库）。
 * 值一律不进断言：配置值可能含 token/路径/账号，写进测试就等于把机器身份写进仓库。
 */
const REAL_TOP_LEVEL_KEYS = [
  '_config_version', 'agent', 'approvals', 'auxiliary', 'browser', 'code_execution', 'compression',
  'custom_providers', 'delegation', 'display', 'group_sessions_per_user', 'mcp_servers', 'memory', 'moa',
  'model',
  'platform_toolsets', 'platforms', 'plugins', 'prompt_caching', 'providers', 'session_reset', 'skills',
  'streaming', 'stt', 'telemetry', 'terminal', 'tool_loop_guardrails', 'updates', 'voice',
];

test('t9 fixture：真机键名形态 + 两层技能压平 + 记忆与凭据零进包（整份 ZIP 字节断言）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-fixture-'));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-fixture-zip-'));
  try {
    await fs.cp(path.join(FIXTURE_ROOT, 'basic'), home, { recursive: true });
    // .env 被仓库 .gitignore 排除 → fixture 里叫 dotenv.fixture，读之前改回真名
    await fs.rename(path.join(home, 'dotenv.fixture'), path.join(home, '.env'));

    const read = await readHermes({ homeDir: 'C:/Users/u', env: { HERMES_HOME: home }, platform: 'win32' });
    assert.equal(read.found, true);
    const cfg = read.input.config;
    assert.ok(isRecord(cfg), 'fixture 的 config.yaml 必须能解析出结构');
    assert.deepEqual(Object.keys(cfg).sort(), REAL_TOP_LEVEL_KEYS, '只断言顶层键名（真机实测形态），不含任何配置值');
    assert.deepEqual(
      (read.input.skills ?? []).map((s) => s.name + '@' + (s.category ?? '-')).sort(),
      ['dogfood@software-development', 'se-team-design@-'],
      '叶子名成技能；分类目录自带 SKILL.md 时它自己就是技能',
    );
    const catSkill = (read.input.skills ?? []).find((s) => s.name === 'se-team-design');
    assert.ok(
      catSkill?.files.some((f) => f.relativePath === 'examples/usage.md'),
      '分类级别技能（分类目录自带 SKILL.md）的子目录只作资产，随该技能进包、不另成技能',
    );
    assert.deepEqual(read.input.memoryFiles, ['MEMORY.md', 'USER.md']);
    assert.equal(read.input.dotEnvPresent, true);
    assert.deepEqual(read.input.sessionStore, { present: true, detail: 'state.db' });

    const result = convertHermes(read.input);
    const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
    assert.equal(mcp.servers.length, 3, '既无 command 也无 url 的条目绝不产出');
    assert.equal(mcp.servers.find((s) => s.serverName === 'svc')?.type, 'stdio');
    assert.equal(mcp.servers.find((s) => s.serverName === 'web')?.type, 'streamable-http');
    assert.equal(mcp.servers.find((s) => s.serverName === 'legacy-sse')?.type, 'streamable-http');
    assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced'));
    assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
    assert.ok(result.skipped.some((s) => s.code === 'sessions-not-migrated' && s.origin === 'state.db'));
    assert.ok(result.skipped.some((s) => s.code === 'memory-report-only' && s.origin === 'MEMORY.md'));
    assert.ok(!result.sections.some((s) => s.sectionId === 'sessions' || s.sectionId === 'workspaces'));

    const zipPath = path.join(tmp, 'fixture.zip');
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
    assert.ok(!written.entryNames.some((n) => n.includes('memories')), '记忆目录绝不进包');
    assert.ok(!written.entryNames.some((n) => n.endsWith('/.env')), '.env 绝不进包');
    assert.ok(
      !written.entryNames.some((n) => n.startsWith('custom/skills/software-development/')),
      '压平后包内路径不得出现分类目录',
    );
    assert.ok(written.entryNames.includes('custom/skills/se-team-design/examples/usage.md'), '资产子目录随技能进包');
    assert.ok(
      !written.entryNames.some((n) => n.includes('/examples/usage.md') && !n.startsWith('custom/skills/se-team-design/')),
      '资产子目录绝不自成技能',
    );
    const buf = await fs.readFile(zipPath);
    for (const sentinel of [
      'MEMORY_SENTINEL_BODY_DO_NOT_SHIP',
      'DOTENV_SENTINEL_VALUE_DO_NOT_SHIP',
      'ghp_FIXTURE_TOKEN_DO_NOT_SHIP',
      'pw@',
    ]) {
      assert.ok(!buf.includes(Buffer.from(sentinel, 'utf8')), 'ZIP 字节里不得出现：' + sentinel);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t9b fixture：0 字节 config.yaml 用例只报码、绝不抛（空分区也不产出）', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hermes-empty-fixture-'));
  try {
    await fs.cp(path.join(FIXTURE_ROOT, 'empty'), home, { recursive: true });
    const read = await readHermes({ homeDir: 'C:/Users/u', env: { HERMES_HOME: home }, platform: 'win32' });
    assert.equal(read.found, true);
    assert.ok(
      read.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'config.yaml'),
      '0 字节必须报 source-empty-file',
    );
    assert.deepEqual(convertHermes(read.input).sections, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

/* ---------------- 真机取样（只读；本机没有就 skip） ---------------- */

const REAL_HOME = resolveHermesHome({ homeDir: os.homedir(), env: process.env, platform: process.platform });
const realStat = await fs.stat(REAL_HOME.home).catch(() => null);
const REAL_SKIP = realStat === null ? '本机无 Hermes 数据目录' : false;

test('t8 真机取样：读得动本机 Hermes 数据目录（只断言键名与计数，不含任何配置值）', { skip: REAL_SKIP }, async () => {
  const read = await readHermes({
    homeDir: os.homedir(),
    env: process.env,
    platform: process.platform,
    maxSkills: 5,
    maxSkillFiles: 20,
  });
  assert.equal(read.found, true);
  assert.ok(Array.isArray(read.input.memoryFiles));
  assert.ok((read.input.skills ?? []).length > 0, '本机 skills/ 应能读出技能单元');
  for (const s of read.input.skills ?? []) {
    assert.ok(s.files.some((f) => f.relativePath === 'SKILL.md'), '每个技能单元必须自带 SKILL.md：' + s.name);
  }
  // 结构性断言（不读任何配置值）：记忆正文根本没有承载字段
  assert.deepEqual(Object.keys(read.input).filter((k) => /memory/i.test(k)), ['memoryFiles']);

  const result = convertHermes(read.input);
  assert.ok(result.sections.length > 0, '真机产物必须至少有一个分区');
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), 'Hermes 会话不迁移');
  assert.ok(result.skipped.some((s) => s.code === 'sessions-not-migrated'), '会话不迁移必须可见');
});


test('t8c 真机取样：config.yaml 只做「键名 + 计数」断言（绝不落任何配置值）', { skip: REAL_SKIP }, async () => {
  // 只为取 config.yaml 的结构：技能侧给很小的上限（本用例不断言技能，只省读盘时间）
  const read = await readHermes({ homeDir: os.homedir(), env: process.env, platform: process.platform, maxSkills: 2, maxSkillFiles: 4 });
  assert.equal(read.found, true);
  const cfgStat = await fs.stat(path.join(read.home, 'config.yaml')).catch(() => null);
  if (cfgStat === null) return; // 本机没有 config.yaml：结构无从取样（不是失败）
  if (cfgStat.size === 0) {
    assert.ok(
      read.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'config.yaml'),
      '0 字节必须报 source-empty-file',
    );
    return;
  }
  const cfg = read.input.config;
  if (!isRecord(cfg)) {
    assert.ok(
      read.input.readFindings?.some((s) => s.code === 'source-unreadable' && s.origin === 'config.yaml'),
      '解析不出结构就必须报码，绝不静默',
    );
    return;
  }
  const keys = Object.keys(cfg);
  assert.ok(keys.length > 0, '真实 config.yaml 应能解析出至少一个顶层键');
  for (const key of keys) {
    assert.equal(key.trim(), key, '顶层键名不得带首尾空白');
    assert.ok(key !== '' && !key.includes('/') && key.includes('\\') === false, '顶层键名必须是单个段');
  }
  // 计数口径：mcp_servers 若存在必须是「名字 → 定义」映射，产出条目不得多于外部条目
  const mcpRaw = cfg['mcp_servers'];
  const result = convertHermes(read.input);
  if (mcpRaw !== undefined) {
    assert.ok(isRecord(mcpRaw), 'mcp_servers 必须是映射形态');
    const names = Object.keys(mcpRaw);
    const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection | undefined;
    assert.ok(mcp === undefined || mcp.servers.length <= names.length, '产出条目数不得超过外部条目数');
    for (const s of mcp?.servers ?? []) {
      assert.ok(names.includes(s.serverName), 'serverName 必须来自外部键名');
      assert.ok(s.type === 'stdio' || s.type === 'streamable-http', 'transport 只有两种合法取值');
    }
  }
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), '真机取样也不得产出 sessions 分区');
  assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'), '真机取样也不得产出 workspaces 分区');
});
