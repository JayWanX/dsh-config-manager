/**
 * Cursor 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与 claude-code.test.ts / hermes.test.ts / codex.test.ts 同构）：
 *  ① 位置真值：<home>/.cursor（三平台同形）+ 可选项目级 <项目>/.cursor
 *  ② 翻译与安全不变量：MCP 两类映射与凭据剥离、规则四类激活分类与计数、两层 skills 压平、
 *     旧式 .cursorrules **只报告不导入**
 *  ③ 端到端：产物是合法 bundle v1 分区，且**整份 ZIP 字节**里不含任何凭据明文与旧式规则正文
 *  ④ 会话（2026-10-06 起）：提问包裹剥离 / `[REDACTED]` 过滤 / tool_use 兜底 id 的解析口径，
 *     slug 的存在性贪心解码（注入式，三平台可跑），以及「解不出 cwd 就如实跳过、绝不伪造」
 *     与 sessions + workspaces 同源产出
 *
 * 取证强度（契约 §8.2 / §8.7）：**本机无 ~/.cursor（2026-10-04 实测）→ 全部为文档取证、
 * 未经真机验证**；t12 的真机取样在本机恒 skip，用例名里如实标注取证强度。
 * 会话层的结构真值来自参考实现（lib/convert/cursor.mjs + lib/discovery 的 cursor 行 +
 * lib/tools/source-derive.mjs 的 cursorDeriveArgs）—— 同样是**参考实现取证**，不是真机。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpSection } from '../schema/types.ts';
import { projectKeyOf } from '../core/session-select.ts';
import { decodeZstdFrame, scanZstdFrames, zstdAvailable } from '../utils/zstd-frame.ts';
import { writeForeignBundle } from './bundle.ts';
import { dshSessionLogName } from './claude-sessions.ts';
import { convertCursor } from './cursor.ts';
import { isSafeIrId } from './session-ir.ts';
import type { ForeignImportResult } from './types.ts';
import {
  classifyRuleActivation,
  decodeCursorSlugPath,
  encodeCursorSlug,
  isCursorNonRepoSlug,
  parseCursorRule,
  parseCursorTranscript,
  readCursor,
  readCursorSessions,
  resolveCursorHome,
} from './read-cursor.ts';

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

/* ---------------- ④ 会话（2026-10-06）：解析口径 + slug 存在性解码 + 端到端 ---------------- */

const NL = String.fromCharCode(10);

/** 临时目录里写相对路径（会话夹具一律现造，绝不把真实用户内容写进仓库） */
async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

/** 会话日志是 zstd 帧拼接（DSH 的真实形态）→ 断言正文前先解帧 */
function decodeSessionLog(data: Uint8Array): string {
  const { frames } = scanZstdFrames(data);
  return Buffer.concat(frames.map((f) => decodeZstdFrame(data.subarray(f.start, f.end)))).toString('utf8');
}

/** 一条最小可用转录（一条提问 + 一条回复）；id 由调用方决定放在哪 */
function transcriptOf(text: string): string {
  return [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>' + NL + text + NL + '</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '收到：' + text }] } }),
  ].join(NL) + NL;
}

test('t13 会话解析：user_query/timestamp 剥离、[REDACTED] 过滤、tool_use 缺 id 铸稳定兜底 id', () => {
  const lines: unknown[] = [
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Thursday, Aug 27, 2026, 3:11 PM (UTC+8)</timestamp>' + NL + '<user_query>' + NL + '帮我看下构建' + NL + '</user_query>' }] } },
    // 整段只剩哨兵 → 该步不产出（assistant-empty）
    { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '先看日志 [REDACTED]' }] } },
    { role: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Glob', input: { glob_pattern: '**/*.rs' } },
      { type: 'tool_use', name: 'Read', input: { path: 'a.rs' } },
    ] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', id: 'given-id', name: 'Read', input: {} }] } },
    { role: 'user', message: { content: [{ type: 'text', text: '第二轮' }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: {} }] } },
    { role: 'system', message: { content: [] } },
    { role: 'assistant', message: { content: 'plain-string-not-array' } },
  ];
  const raw = lines.map((o) => JSON.stringify(o)).join(NL) + NL + '{not json' + NL;
  const parsed = parseCursorTranscript(raw);

  assert.equal(parsed.raw, lines.length, 'raw = 解析出来的对象行数');
  assert.equal(parsed.bad, 1, '坏行只计数、绝不抛');
  assert.equal(parsed.createdAt, Date.parse('Thursday, Aug 27, 2026, 3:11 PM'), 'createdAt 取首轮内嵌时间戳（(UTC+8) 后缀先剥掉）');
  assert.equal(parsed.title, '帮我看下构建', '标题与提问同一口径：标签必须剥掉');
  assert.equal(parsed.cwd, undefined, '转录里没有 cwd：解析层绝不猜');

  const first = parsed.records[0];
  assert.equal(first?.role, 'user');
  const firstText = first?.blocks.find((b) => b.type === 'text');
  assert.ok(firstText?.type === 'text' && firstText.text === '帮我看下构建', '<user_query> / <timestamp> 必须剥离');
  assert.equal(first?.time, parsed.createdAt, '首轮自己的时间戳落在它自己那条记录上');

  const second = parsed.records.find((r) => r.blocks.some((b) => b.type === 'text' && b.text.includes('先看日志')));
  const secondText = second?.blocks.find((b) => b.type === 'text');
  assert.ok(secondText?.type === 'text' && secondText.text === '先看日志', '[REDACTED] 哨兵必须滤掉、其余正文保留');

  const ids = parsed.records.flatMap((r) => r.blocks).filter((b) => b.type === 'tool_call').map((b) => (b.type === 'tool_call' ? b.id : ''));
  assert.deepEqual(ids, ['cursor-1-2-1', 'cursor-1-2-2', 'given-id', 'cursor-2-1-1'], '缺 id 时铸 cursor-<轮>-<步>-<块序>；给了 id 就原样用');
  for (const id of ids) assert.ok(isSafeIrId(id), '工具调用 id 也要能当路径段用：' + id);

  assert.equal(parsed.ignored['assistant-empty'], 1, '只剩哨兵的助手步逐类计数，绝不静默');
  assert.equal(parsed.ignored['system'], 1, '不认识的角色逐类计数');
  assert.equal(parsed.ignored['content-not-array'], 1, 'content 不是数组也要可见');
  assert.ok(
    !parsed.records.flatMap((r) => r.blocks).some((b) => b.type === 'tool_result'),
    '源里没有 tool_result：绝不自己造一条假的工具结果',
  );
});

test('t14 slug 贪心解码（注入存在性）：段内点号变体命中；非仓库 slug / 超预算一律不解码', async () => {
  // 编码/解码的逆运算（段内 . → -、盘符小写），先钉住编码本身
  assert.equal(encodeCursorSlug('D:\\Projects\\demo.Client\\app'), 'd-Projects-demo-Client-app');
  assert.equal(encodeCursorSlug('/home/u/proj'), null, '非盘符形态没有编码语义：不猜');
  assert.equal(isCursorNonRepoSlug('empty-window'), true);
  assert.equal(isCursorNonRepoSlug('2049'), true);
  assert.equal(isCursorNonRepoSlug('d-Projects-demo'), false);

  const present = new Set(['D:\\Projects', 'D:\\Projects\\demo.Client', 'D:\\Projects\\demo.Client\\app']);
  const seen: string[] = [];
  const exists = async (candidate: string): Promise<boolean> => { seen.push(candidate); return present.has(candidate); };
  const decoded = await decodeCursorSlugPath('d-Projects-demo-Client-app', exists);
  assert.equal(decoded, 'D:\\Projects\\demo.Client\\app', '逐段存在性检查 + 点号变体必须还原出真实目录');
  assert.ok(seen.length > 0 && seen.every((p) => p.startsWith('D:\\')), '只探测盘符形态的候选');

  let calls = 0;
  const never = async (): Promise<boolean> => { calls += 1; return false; };
  assert.equal(await decodeCursorSlugPath('empty-window', never), undefined, '非仓库 slug 直接放弃');
  assert.equal(await decodeCursorSlugPath('2049', never), undefined, '纯数字项目 id 直接放弃');
  assert.equal(await decodeCursorSlugPath('nodash', never), undefined, '不是盘符形态直接放弃');
  assert.equal(calls, 0, '放弃必须在任何探测之前 —— 绝不为解不出来的 slug 白探盘');

  calls = 0;
  assert.equal(await decodeCursorSlugPath('d-aaa-bbb-ccc-ddd', never, 5), undefined, '不存在就返回 undefined');
  assert.equal(calls, 5, '探测次数必须被预算封顶（否则病态 slug 会组合爆炸）');
});

test('t15 会话读盘：slug 解不出 cwd → 绝不伪造（下游按 session-missing-cwd 跳过）；id 不自证安全即报码', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-sess-'));
  const base = '.cursor/projects/d-zzzz-no-such-project-zzzz/agent-transcripts';
  const okId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const unsafeId = 'bad id';
  try {
    await writeAt(tmp, base + '/' + okId + '/' + okId + '.jsonl', transcriptOf('临时夹具'));
    await writeAt(tmp, base + '/' + unsafeId + '/' + unsafeId + '.jsonl', transcriptOf('第二个'));

    const read = await readCursor({ homeDir: tmp, limits: { maxSessionFiles: 10 } });
    assert.equal(read.input.sessions?.length, 2, 'composer 目录下的 .jsonl 必须被读成会话');
    assert.equal(read.input.sessions?.[0]?.id, okId, '会话 id = composer uuid（目录名 / 文件名同值）');
    assert.equal(read.input.sessions?.[0]?.parsed.cwd, undefined, '解不出 slug 就绝不伪造 cwd');
    assert.ok(
      !(read.input.readFindings ?? []).some((s) => s.code === 'session-cwd-derived'),
      '没推导出来就不许报「推导成功」',
    );

    read.input.targetSessionFormatVersion = 3;
    const result = convertCursor(read.input);
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === okId), '缺 cwd 如实报码');
    assert.ok(result.skipped.some((s) => s.code === 'session-unsafe-id' && s.origin === unsafeId), 'id 不自证安全即报码');
    assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'), '一条都转不出来就不产出空 sessions 分区');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t15b 会话读盘：0 字节文件报码、条数触顶可见（max-sessions-reached）；没有 projects 目录时不产出', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-sess2-'));
  const base = '.cursor/projects/d-zzzz-no-such-project-zzzz/agent-transcripts';
  try {
    await writeAt(tmp, base + '/id1/id1.jsonl', '');
    await writeAt(tmp, base + '/id2/id2.jsonl', transcriptOf('第二'));
    await writeAt(tmp, base + '/id3/id3.jsonl', transcriptOf('第三'));
    const read = await readCursorSessions({ homeDir: tmp, limits: { maxSessionFiles: 1 } });
    assert.equal(read.files.length, 1, '触顶即停，绝不静默多带');
    assert.ok(read.readFindings?.some((s) => s.code === 'source-empty-file'), '0 字节会话文件如实报码');
    assert.ok(
      read.readFindings?.some((s) => s.code === 'source-unreadable' && s.detail === 'max-sessions-reached'),
      '触顶必须可见',
    );

    const none = await readCursorSessions({ homeDir: path.join(tmp, 'no-such-home') });
    assert.deepEqual(none.files, []);
    assert.deepEqual(none.readFindings, [], '未安装是正常状态，不是错误');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test(
  't16 会话端到端：slug 存在性解码出的 cwd → sessions + workspaces 同源产出',
  { skip: process.platform === 'win32' ? false : 'Cursor 的 slug 编码只有盘符形态（参考实现同款）；非 Windows 造不出真实盘符路径' },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cursor-derive-'));
    const project = path.join(tmp, 'Projects', 'demo.Client', 'app');
    const id = 'ffffffff-1111-4222-8333-444444444444';
    const sentinel = 'CURSOR_SESSION_SENTINEL_DO_NOT_SHIP';
    try {
      await fs.mkdir(project, { recursive: true });
      const slug = encodeCursorSlug(project);
      assert.ok(slug !== null, '本机真实路径必须能编码成 slug');
      await writeAt(tmp, '.cursor/projects/' + slug + '/agent-transcripts/' + id + '/' + id + '.jsonl', transcriptOf(sentinel));

      const read = await readCursor({ homeDir: tmp, limits: { maxSessionFiles: 10 } });
      assert.equal(read.input.sessions?.[0]?.parsed.cwd?.toLowerCase(), project.toLowerCase(), 'cwd 必须由存在性解码得出');
      assert.ok(
        read.input.readFindings?.some((s) => s.code === 'session-cwd-derived' && s.origin === id),
        '推导必须可见（session-cwd-derived）',
      );

      read.input.targetSessionFormatVersion = 3;
      const result = convertCursor(read.input);
      const sessions = result.sections.find((s) => s.sectionId === 'sessions')?.files ?? [];
      assert.equal(sessions.length, 1, '有 cwd 就必须转出会话');
      assert.equal(
        sessions[0]?.relativePath,
        projectKeyOf(project) + '/' + id + '/' + dshSessionLogName(3),
        '会话路径必须与 cwd 的 projectKey 同源',
      );
      const workspaces = result.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { sessionIds: string[] }[] } | undefined;
      assert.deepEqual(workspaces?.workspaces[0]?.sessionIds, [id], '只给会话不给工作区 = 目标机一条对话都看不见');
      assert.ok(zstdAvailable(), 'Node 运行时必须提供 zstd（DSH 自身也依赖它）');
      const text = decodeSessionLog(sessions[0]?.data ?? new Uint8Array());
      assert.ok(text.includes(sentinel), '转录正文必须进包');
      assert.ok(!text.includes('[REDACTED]') && !text.includes('user_query'), '哨兵与包裹标签都不得进包');
      assert.ok(!text.includes('<timestamp>'), '时间戳标签不得进包');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);

/* ---------------- 真机取样（本机无 ~/.cursor → skip；取证强度如实标注） ---------------- */

const REAL_HOME = resolveCursorHome({ homeDir: os.homedir() });
const realStat = await fs.stat(REAL_HOME).catch(() => null);

test('t12 真机取样（契约 §8.2：Cursor 为「文档取证、未经真机验证」；本机无 ~/.cursor 即 skip）', { skip: realStat === null ? '本机无 ~/.cursor（文档取证、未经真机验证）' : false }, async () => {
  const read = await readCursor({ homeDir: os.homedir() });
  assert.equal(read.found, true);
  assert.ok(Array.isArray(read.input.rules));
  // 结构性断言（不读任何配置值）：只数条目、只看机器码
  read.input.targetSessionFormatVersion = 3;
  const result = convertCursor(read.input);
  for (const s of result.skipped) assert.equal(typeof s.code, 'string');
  if (read.input.sessions !== undefined && read.input.sessions.length > 0) {
    assert.ok(
      result.sections.some((s) => s.sectionId === 'sessions') || result.skipped.some((s) => s.code === 'session-missing-cwd'),
      '读到了会话就必须能解释它去哪了（转出 or 如实跳过）',
    );
  }
  const sessionCount = (result.sections.find((s) => s.sectionId === 'sessions')?.files ?? []).length;
  if (sessionCount > 0) {
    assert.ok(result.sections.some((s) => s.sectionId === 'workspaces'), '有会话就必须连工作区一起产出');
  }
});
