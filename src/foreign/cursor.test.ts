/**
 * Cursor 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts / hermes.test.ts / codex.test.ts 同构）：
 *  ① 位置真值：<home>/.cursor（三平台同形）+ 可选项目级 <项目>/.cursor
 *  ② 翻译与安全不变量：MCP 两类映射与凭据剥离、规则四类激活分类与计数、两层 skills 压平、
 *     旧式 .cursorrules **只报告不导入**
 *  ③ 端到端：产物是合法 bundle v1 分区，且**整份 ZIP 字节**里不含任何凭据明文与旧式规则正文
 *
 * 取证强度（契约 §8.2 / §8.7）：**本机无 ~/.cursor（2026-10-04 实测）→ 全部为文档取证、
 * 未经真机验证**；t11 的真机取样在本机恒 skip，用例名里如实标注取证强度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpSection } from '../schema/types.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertCursor } from './cursor.ts';
import type { ForeignImportResult } from './types.ts';
import { classifyRuleActivation, parseCursorRule, readCursor, resolveCursorHome } from './read-cursor.ts';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'fixtures', 'cursor');
const BASIC_HOME = path.join(FIXTURE_ROOT, 'basic');
const BASIC_PROJECT = path.join(BASIC_HOME, 'project');

const LEGACY_SENTINELS = [
  'CURSOR_LEGACY_SENTINEL_BODY_DO_NOT_SHIP',
  'CURSOR_PROJECT_LEGACY_SENTINEL_DO_NOT_SHIP',
];
const CREDENTIAL_SENTINELS = [
  'ghp_CURSOR_FIXTURE_TOKEN_DO_NOT_SHIP',
  'CURSOR_BEARER_DO_NOT_SHIP',
  'pw@',
];

function mcpOf(result: ForeignImportResult): McpSection | undefined {
  return result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection | undefined;
}

function agentsMdOf(result: ForeignImportResult): string {
  const section = result.sections.find((s) => s.sectionId === 'agentInstructions');
  const file = section?.files?.find((f) => f.relativePath === 'AGENTS.md');
  assert.ok(file !== undefined, 'agentInstructions 里必须有 AGENTS.md');
  return new TextDecoder().decode(file.data);
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：三平台同形 <home>/.cursor；项目级目录是可选第二作用域', () => {
  assert.equal(resolveCursorHome({ homeDir: 'C:/Users/u' }), path.join('C:/Users/u', '.cursor'));
  assert.equal(resolveCursorHome({ homeDir: '/home/u' }), path.join('/home/u', '.cursor'));
  // 契约 §8.2 未列出任何环境变量覆盖 → 不猜：解析出来的路径就是唯一候选
  const resolved = resolveCursorHome({ homeDir: '/tmp/nope' });
  assert.ok(resolved.endsWith('.cursor'));
});

/* ---------------- ② 翻译层 ---------------- */

test('t2 MCP：stdio 与 remote 两类映射；URL userinfo 与 Authorization 值都剥离并报码', () => {
  const result = convertCursor({
    mcpJson: {
      mcpServers: {
        svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: 'ghp_SUPERSECRET', PLAIN: 'ok' } },
        remote: { url: 'https://user:pw@mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
        legacySse: { url: 'https://sse.example.com/sse', type: 'sse' },
        empty: { note: '既无 command 也无 url' },
      },
    },
  });
  const mcp = mcpOf(result);
  assert.ok(mcp !== undefined, '有可映射条目时必须产出 mcp 分区');
  const servers = mcp?.servers ?? [];
  assert.equal(servers.length, 3, '既无 command 也无 url 的条目不产出');
  assert.equal(servers.find((s) => s.serverName === 'svc')?.type, 'stdio');
  assert.deepEqual(servers.find((s) => s.serverName === 'svc')?.args, ['-y', 'svc']);
  assert.equal(servers.find((s) => s.serverName === 'remote')?.type, 'streamable-http');
  assert.equal(servers.find((s) => s.serverName === 'remote')?.url, 'https://mcp.example.com/mcp', 'URL userinfo 必须剥离');
  assert.equal(servers.find((s) => s.serverName === 'remote')?.headers?.['Authorization'], '', '命中凭据的字段值置空、字段名保留');
  assert.equal(servers.find((s) => s.serverName === 'svc')?.env?.['PLAIN'], 'ok', '非凭据字段原样保留');
  assert.ok(result.credentialRefs.includes('mcp:remote:url'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-credential-redacted' && s.origin === 'remote:url'), 'URL userinfo 剥离必须报码');
  assert.ok(result.skipped.some((s) => s.code === 'mcp-credential-redacted' && typeof s.count === 'number'), '字段名命中的凭据也报码（只有条数，没有值）');
  assert.ok(result.credentialRefs.includes('mcp:svc:GITHUB_TOKEN'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'legacySse'));
  assert.ok(!JSON.stringify(result).includes('ghp_SUPERSECRET'), '结果对象里不得出现凭据明文');
  assert.ok(!JSON.stringify(result).includes('pw@'), 'URL userinfo 也必须剥离');
  assert.ok(!JSON.stringify(result).includes('Bearer t'), 'headers 里的 bearer 值也必须剥离');
});

test('t3 MCP 容器形态对不上：非映射与「没有 mcpServers 只有别的映射」都如实报码、不产出空分区', async () => {
  // 直接吃 fixture 的两种真实文件形态（不是内联对象）：形态断言与入库样例同源
  const shape = await readCursor({ homeDir: path.join(FIXTURE_ROOT, 'shape') });
  const notMapping = convertCursor(shape.input);
  assert.ok(
    notMapping.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'mcp.json' && s.detail === 'not-a-mapping'),
  );
  assert.ok(mcpOf(notMapping) === undefined, '不产出空 mcp 分区');

  const alt = await readCursor({ homeDir: path.join(FIXTURE_ROOT, 'alt') });
  const otherKey = convertCursor(alt.input);
  assert.ok(otherKey.skipped.some((s) => s.code === 'mcp-server-empty' && s.detail === 'unexpected-container-key'));
  assert.ok(mcpOf(otherKey) === undefined, '绝不按别的容器键猜着映射');

  const absent = convertCursor({ mcpJson: {} });
  assert.deepEqual(absent.sections, [], '没有 mcpServers 就是没有，绝不报错也绝不产出空分区');
});

test('t4 项目级优先：同名 server 取项目级定义、只产出一条；项目独有条目追加', () => {
  const result = convertCursor({
    mcpJson: { mcpServers: { shared: { command: 'npx', args: ['-y', 'user-level-shared'] } } },
    projectMcpJson: { mcpServers: { shared: { command: 'npx', args: ['-y', 'project-level-shared'] }, extra: { command: 'npx' } } },
  });
  const servers = mcpOf(result)?.servers ?? [];
  assert.deepEqual(servers.map((s) => s.serverName), ['shared', 'extra'], '同名只留一条且保持原位置');
  assert.deepEqual(servers[0]?.args, ['-y', 'project-level-shared'], '项目级定义胜出');
  assert.equal(result.counts['mcp.projectOverridden'], 1, '覆盖条数必须可见');
  assert.equal(result.counts['mcp.servers'], 2);
});

test('t5 规则四类激活：frontmatter 判定顺序 + 无 frontmatter = Manual', () => {
  assert.equal(classifyRuleActivation({ alwaysApply: true }), 'always');
  assert.equal(classifyRuleActivation({ alwaysApply: 'true' }), 'always', '引号包裹的 true 也认（只认明确字面）');
  assert.equal(classifyRuleActivation({ alwaysApply: false, globs: ['a'] }), 'auto-attached');
  assert.equal(classifyRuleActivation({ globs: 'src/**/*.ts' }), 'auto-attached');
  assert.equal(classifyRuleActivation({ globs: [] }), 'manual', '空 globs 不是 auto-attached');
  assert.equal(classifyRuleActivation({ description: 'd' }), 'agent-requested');
  assert.equal(classifyRuleActivation({ alwaysApply: false, description: '  ' }), 'manual');
  assert.equal(classifyRuleActivation({}), 'manual');
  assert.equal(classifyRuleActivation(null), 'manual');

  const noFrontmatter = parseCursorRule('没有 frontmatter 的正文');
  assert.deepEqual(noFrontmatter, { activation: 'manual', body: '没有 frontmatter 的正文' });
  const fmRule = parseCursorRule('---' + String.fromCharCode(10) + 'description: d' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'BODY');
  assert.equal(fmRule.activation, 'agent-requested');
  assert.ok(fmRule.body.includes('BODY') && !fmRule.body.includes('description:'), 'frontmatter 只用于分类，不并入正文');
});

test('t6 规则合并：四种激活全部进唯一一个 AGENTS.md，注释头带激活与作用域，并报 instructions-merged', async () => {
  const read = await readCursor({ homeDir: BASIC_HOME, projectDir: BASIC_PROJECT });
  const result = convertCursor(read.input);
  assert.deepEqual(
    (read.input.rules ?? []).map((r) => r.name + ':' + r.activation + ':' + r.scope).sort(),
    [
      'agent.mdc:agent-requested:user',
      'always.mdc:always:user',
      'auto.mdc:auto-attached:user',
      'manual.mdc:manual:user',
      'project-always.mdc:always:project',
    ],
  );
  assert.equal(result.counts['rules.total'], 5);
  assert.equal(result.counts['rules.always'], 2);
  assert.equal(result.counts['rules.auto-attached'], 1);
  assert.equal(result.counts['rules.agent-requested'], 1);
  assert.equal(result.counts['rules.manual'], 1);
  assert.ok(result.skipped.some((s) => s.code === 'instructions-merged' && s.count === 5));

  const md = agentsMdOf(result);
  for (const marker of [
    'CURSOR_RULE_AGENT_BODY', 'CURSOR_RULE_ALWAYS_BODY', 'CURSOR_RULE_AUTO_BODY',
    'CURSOR_RULE_MANUAL_BODY', 'CURSOR_RULE_PROJECT_ALWAYS_BODY',
  ]) {
    assert.ok(md.includes(marker), '规则正文必须全部并入：' + marker);
  }
  assert.ok(md.includes('<!-- cursor rule: always.mdc [always, user] -->'));
  assert.ok(md.includes('<!-- cursor rule: auto.mdc [auto-attached, user] -->'));
  assert.ok(md.includes('<!-- cursor rule: project-always.mdc [always, project] -->'));
  assert.ok(md.indexOf('CURSOR_RULE_AGENT_BODY') < md.indexOf('CURSOR_RULE_PROJECT_ALWAYS_BODY'), '顺序确定：用户级在前、项目级在后');
  assert.equal(result.counts['agentInstructions.files'], 1, 'agentInstructions 至多一个文件（契约 §8.6-4）');
});

test('t7 损坏的 frontmatter：报码 + 按 Manual 保守归类 + 正文原样保留（绝不丢内容）', async () => {
  const read = await readCursor({ homeDir: path.join(FIXTURE_ROOT, 'malformed') });
  assert.equal(read.found, true);
  assert.ok(read.input.readFindings?.some((s) => s.code === 'source-unreadable' && s.origin === 'mcp.json' && s.detail === 'json-error'));
  assert.ok(
    read.input.readFindings?.some(
      (s) => s.code === 'source-unreadable' && s.origin === 'rules/broken.mdc' && s.detail === 'frontmatter-yaml-error',
    ),
  );
  const rule = (read.input.rules ?? [])[0];
  assert.equal(rule?.activation, 'manual', '读不懂就保守归类，绝不当成 always-on');
  assert.ok(rule?.body.includes('CURSOR_RULE_BROKEN_BODY'), '正文原样保留');
  assert.ok(rule?.body.includes('---'), '损坏的 frontmatter 原文也不丢（无法可靠剥离）');
  const result = convertCursor(read.input);
  assert.ok(mcpOf(result) === undefined, '畸形 JSON 不产出空 mcp 分区');
  assert.ok(agentsMdOf(result).includes('CURSOR_RULE_BROKEN_BODY'));
});

test('t8 旧式 .cursorrules：只报告不导入（两种作用域各一条码，正文绝不进结果）', async () => {
  const read = await readCursor({ homeDir: BASIC_HOME, projectDir: BASIC_PROJECT });
  assert.deepEqual(read.input.legacyRules, [{ scope: 'user' }, { scope: 'project' }]);
  const serialized = JSON.stringify(read.input);
  for (const marker of LEGACY_SENTINELS) {
    assert.ok(!serialized.includes(marker), '旧式规则正文连读盘结果对象都不许进（只 stat）');
  }
  const result = convertCursor(read.input);
  assert.equal(result.counts['rules.legacy'], 2);
  assert.ok(result.skipped.some((s) => s.code === 'legacy-rules-file' && s.origin === '.cursorrules' && s.detail === 'user'));
  assert.ok(result.skipped.some((s) => s.code === 'legacy-rules-file' && s.detail === 'project'));
});

test('t9 skills：嵌套压平为叶子名、点开头目录不算技能、同名冲突项目级胜出并报码', async () => {
  const read = await readCursor({ homeDir: BASIC_HOME, projectDir: BASIC_PROJECT });
  const result = convertCursor(read.input);
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath).sort(), ['hello/SKILL.md', 'nested/SKILL.md', 'nested/notes.md']);
  const hello = new TextDecoder().decode(files.find((f) => f.relativePath === 'hello/SKILL.md')?.data);
  assert.ok(hello.includes('project-level hello body'), '同名冲突先到先得 → 项目级（读盘层排在前面）胜出');
  assert.ok(!hello.includes('user-level hello body'), '败者绝不进包');
  assert.ok(result.skipped.some((s) => s.code === 'skill-id-conflict' && s.origin === 'hello'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-category-flattened' && s.origin === 'wrapper/nested'));
  assert.ok(!files.some((f) => f.relativePath.startsWith('hidden/')), '点开头目录不是技能');
});

test('t10 端到端：fixture → 标准 bundle v1；整份 ZIP 字节不含任何凭据明文与旧式规则正文', async () => {
  const read = await readCursor({ homeDir: BASIC_HOME, projectDir: BASIC_PROJECT });
  const result = convertCursor(read.input);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-zip-'));
  try {
    const zipPath = path.join(tmp, 'cursor.zip');
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
      'custom/skills/nested/notes.md',
      'mcp/servers.json',
    ]);
    const buf = await fs.readFile(zipPath);
    for (const sentinel of [...CREDENTIAL_SENTINELS, ...LEGACY_SENTINELS, 'must not be imported']) {
      assert.ok(!buf.includes(Buffer.from(sentinel, 'utf8')), 'ZIP 字节里不得出现：' + sentinel);
    }
    assert.ok(
      !buf.includes(Buffer.from('user-level-shared', 'utf8')),
      '被项目级覆盖掉的用户级 server 定义不得进包（覆盖是真的，不是两份都在）',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t11 0 字节 mcp.json 与目录不存在：如实报码、绝不抛、绝不产出空分区', async () => {
  const empty = await readCursor({ homeDir: path.join(FIXTURE_ROOT, 'empty') });
  assert.equal(empty.found, true);
  assert.ok(empty.input.readFindings?.some((s) => s.code === 'source-empty-file' && s.origin === 'mcp.json'));
  assert.deepEqual(convertCursor(empty.input).sections, []);

  const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-none-'));
  try {
    const missing = await readCursor({ homeDir: path.join(missingDir, 'no-such-home') });
    assert.equal(missing.found, false, '未安装是正常状态');
    assert.deepEqual(missing.input.readFindings, []);
    assert.deepEqual(convertCursor(missing.input).sections, []);
  } finally {
    await fs.rm(missingDir, { recursive: true, force: true });
  }
});

/* ---------------- 真机取样（本机无 ~/.cursor → skip；取证强度如实标注） ---------------- */

const REAL_HOME = resolveCursorHome({ homeDir: os.homedir() });
const realStat = await fs.stat(REAL_HOME).catch(() => null);

test('t12 真机取样（契约 §8.2：Cursor 为「文档取证、未经真机验证」；本机无 ~/.cursor 即 skip）', { skip: realStat === null ? '本机无 ~/.cursor（文档取证、未经真机验证）' : false }, async () => {
  const read = await readCursor({ homeDir: os.homedir() });
  assert.equal(read.found, true);
  assert.ok(Array.isArray(read.input.rules));
  // 结构性断言（不读任何配置值）：只数条目、只看机器码
  const result = convertCursor(read.input);
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), 'Cursor 来源不产出 sessions 分区');
  assert.ok(!result.sections.some((s) => s.sectionId === 'workspaces'));
});
