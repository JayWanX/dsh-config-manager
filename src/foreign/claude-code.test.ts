/**
 * 外部 agent 导入（v1 / Claude Code）的回归护栏。
 *
 * 三层各测一层：
 *  ① 纯翻译（映射口径、路径安全、frontmatter 判定）
 *  ② 凭据不变量（结果对象与**整份 ZIP 字节**里都不得出现凭据明文）
 *  ③ 端到端（转换产物是合法 bundle v1，既有 Importer 能正常分析 —— 这条才证明「复用既有管道」成立）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import type { McpSection, SectionId } from '../schema/types.ts';
import { Importer } from '../core/importer.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode, frontmatterProblem, splitFrontmatter, stripUserInfo } from './claude-code.ts';

const NL = String.fromCharCode(10);
const enc = new TextEncoder();

const NL2 = String.fromCharCode(10);
const CC_ID = '22222222-2222-4222-8222-222222222222';
const CC_CWD = 'D:/proj/cc';
function ccSession(): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'bbbbbbbb-0000-4000-8000-000000000001', timestamp: '2026-10-02T09:00:00.000Z', cwd: CC_CWD, message: { role: 'user', content: '导入一条对话' } }),
    JSON.stringify({ type: 'assistant', uuid: 'bbbbbbbb-0000-4000-8000-000000000002', timestamp: '2026-10-02T09:00:03.000Z', cwd: CC_CWD, message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: '好的' }] } }),
  ].join(NL2) + NL2;
}


function skillMd(name: string, description: string, body = '# body'): Uint8Array {
  return enc.encode(['---', 'name: ' + name, 'description: ' + description, '---', '', body].join(NL));
}

function frontmatterOnly(line: string): Uint8Array {
  return enc.encode(['---', line, '---', '', 'body'].join(NL));
}

function claudeJsonWith(servers: Record<string, unknown>): unknown {
  return { mcpServers: servers };
}

test('t0 frontmatter 切分与 URL userinfo 剥离的边界', () => {
  const fm = splitFrontmatter(['---', 'name: a', '---', 'body'].join(NL));
  assert.equal(fm?.raw, 'name: a');
  assert.equal(splitFrontmatter('no frontmatter'), null);
  assert.equal(frontmatterProblem('no frontmatter'), 'no-frontmatter');
  assert.equal(frontmatterProblem(['---', 'description: x', '---', 'body'].join(NL)), 'no-name');
  assert.equal(frontmatterProblem(['---', 'name: a', '---', 'body'].join(NL)), 'no-description');
  assert.equal(frontmatterProblem(['---', 'name: a', 'description: ok', '---', 'body'].join(NL)), null);
  assert.deepEqual(stripUserInfo('https://u:p@h/mcp'), { url: 'https://h/mcp', stripped: true });
  assert.deepEqual(stripUserInfo('https://h/path@x'), { url: 'https://h/path@x', stripped: false });
  assert.deepEqual(stripUserInfo('npx'), { url: 'npx', stripped: false });
});

test('t1 MCP：stdio 与 url 两种形态按 extractMcpServers 同口径映射', () => {
  const result = convertClaudeCode({
    claudeJson: claudeJsonWith({
      gitnexus: { command: 'npx', args: ['-y', 'gitnexus'], cwd: '/repo' },
      remote: { url: 'https://mcp.example.com/mcp', headers: { 'X-Trace': 'on' }, type: 'sse' },
      empty: { note: 'no command' },
    }),
  });
  const mcp = result.sections.find((s) => s.sectionId === 'mcp');
  assert.ok(mcp, '应产出 mcp 分区');
  const section = mcp.data as McpSection;
  assert.equal(section.servers.length, 2, '既无 command 也无 url 的条目不带进包');

  const stdio = section.servers.find((s) => s.serverName === 'gitnexus');
  assert.equal(stdio?.type, 'stdio');
  assert.equal(stdio?.command, 'npx');
  assert.deepEqual(stdio?.args, ['-y', 'gitnexus']);
  assert.equal(stdio?.cwd, '/repo');
  // 刻意不写 sourceLineId：交给 adapter 的 newLineId(serverName) 兜底，避免撞上目标机既有行 id
  assert.equal(Object.prototype.hasOwnProperty.call(stdio ?? {}, 'sourceLineId'), false);

  const remote = section.servers.find((s) => s.serverName === 'remote');
  assert.equal(remote?.type, 'streamable-http');
  assert.equal(remote?.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(remote?.headers, { 'X-Trace': 'on' });

  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'remote'));
});

test('t2 凭据值绝不进包：env 与 URL userinfo 都被剥离，只留字段名与引用名', async () => {
  const SECRET = 'sk-ant-SUPERSECRET-TOKEN-1234567890';
  const result = convertClaudeCode({
    claudeJson: claudeJsonWith({
      svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: SECRET, PLAIN: 'ok' } },
      web: { url: 'https://user:pw@mcp.example.com/mcp' },
    }),
    settings: { env: { ANTHROPIC_AUTH_TOKEN: SECRET }, hooks: { PreToolUse: [] } },
  });

  assert.ok(!JSON.stringify(result).includes(SECRET), '结果对象里不得出现凭据明文');
  assert.ok(!JSON.stringify(result).includes('pw@'), 'URL userinfo 也必须剥离');

  const section = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection;
  const svc = section.servers.find((s) => s.serverName === 'svc');
  assert.equal(svc?.env?.['GITHUB_TOKEN'], '', '命中凭据的字段值被剥离为空串，字段名保留');
  assert.equal(svc?.env?.['PLAIN'], 'ok');
  assert.equal(section.servers.find((s) => s.serverName === 'web')?.url, 'https://mcp.example.com/mcp');

  assert.ok(result.credentialRefs.includes('mcp:svc:GITHUB_TOKEN'));
  assert.ok(result.credentialRefs.includes('mcp:web:url'));
  assert.ok(result.credentialRefs.includes('settings.env:ANTHROPIC_AUTH_TOKEN'));
  assert.ok(result.skipped.some((s) => s.code === 'credentials-not-migrated'));
  assert.ok(result.skipped.some((s) => s.code === 'unsupported-hooks'));
  // settings 本身**不产生**任何分区（env 是凭据、hooks 无对等结构）
  assert.ok(!result.sections.some((s) => s.sectionId === 'settings'));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-secret-'));
  try {
    const zipPath = path.join(tmp, 'b.zip');
    await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-test', dshVersion: '0.1.0' });
    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from(SECRET, 'utf8')), 'ZIP 字节里不得出现凭据明文');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t3 skill：非法 frontmatter 整体跳过并报码（DSH 会静默丢弃，所以这里必须报）', () => {
  // 这条 description 是本仓实测过的「静默杀手」：plain scalar 里出现冒号加空格
  const broken = frontmatterOnly('description: great DX: intuitive');
  const result = convertClaudeCode({
    skills: [
      {
        name: 'good',
        files: [
          { relativePath: 'SKILL.md', data: skillMd('good', 'ok') },
          { relativePath: 'ref.md', data: enc.encode('ref') },
        ],
      },
      { name: 'broken', files: [{ relativePath: 'SKILL.md', data: broken }] },
      { name: 'no-md', files: [{ relativePath: 'readme.md', data: enc.encode('x') }] },
      { name: 'bad/name', files: [{ relativePath: 'SKILL.md', data: skillMd('x', 'y') }] },
    ],
  });
  const files = result.sections.find((s) => s.sectionId === 'skills')?.files ?? [];
  assert.deepEqual(files.map((f) => f.relativePath).sort(), ['good/SKILL.md', 'good/ref.md']);
  assert.ok(result.skipped.some((s) => s.code === 'skill-invalid-frontmatter' && s.origin === 'broken'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-missing-file' && s.origin === 'no-md'));
  assert.ok(result.skipped.some((s) => s.code === 'skill-invalid-name' && s.origin === 'bad/name'));
});

test('t4 端到端：产物是合法 v1 bundle，既有 Importer 能分析出来', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-e2e-'));
  try {
    const result = convertClaudeCode({
      claudeJson: claudeJsonWith({ svc: { command: 'npx', args: ['-y', 'svc'] } }),
      skills: [{ name: 'alpha', files: [{ relativePath: 'SKILL.md', data: skillMd('alpha', 'A skill') }] }],
      memory: '# 我的全局指令' + NL,
    });
    const zipPath = path.join(tmp, 'foreign.zip');
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
      'custom/skills/alpha/SKILL.md',
      'mcp/servers.json',
    ]);

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

test('t5 空来源不产出任何分区（不生成空载荷分区）', () => {
  const result = convertClaudeCode({});
  assert.deepEqual(result.sections, []);
  assert.deepEqual(result.credentialRefs, []);
});

test('t6 会话转码接入：sessions 与 workspaces 同时进包，既有 Importer 能分析', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-foreign-session-'));
  try {
    const result = convertClaudeCode({
      claudeJson: claudeJsonWith({ svc: { command: 'npx', args: ['-y', 'svc'] } }),
      sessions: [{ id: CC_ID, text: ccSession() }],
      targetSessionFormatVersion: 3,
    });
    assert.deepEqual([...result.sections.map((s) => s.sectionId)].sort(), ['mcp', 'sessions', 'workspaces']);
    const workspaces = result.sections.find((s) => s.sectionId === 'workspaces')?.data as { workspaces: { path: string; sessionIds: string[] }[] };
    assert.equal(workspaces.workspaces.length, 1);
    assert.equal(workspaces.workspaces[0]?.path, CC_CWD);
    assert.deepEqual(workspaces.workspaces[0]?.sessionIds, [CC_ID]);

    const zipPath = path.join(tmp, 'sessions.zip');
    const written = await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-test', dshVersion: '0.1.0' });
    assert.deepEqual([...written.sections].sort(), ['mcp', 'sessions', 'workspaces']);
    assert.ok(
      written.entryNames.includes('sessions/--D-proj-cc--/' + CC_ID + '/session.v3.jsonl.zstd'),
      '会话日志必须落在 sessions/<projectKey>/<id>/ 下：' + JSON.stringify(written.entryNames),
    );

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters({ includeSessions: true }), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '含会话的包必须合法：' + JSON.stringify(analysis.errors));
    assert.ok(analysis.sectionsInZip.includes('sessions'));
    assert.ok(analysis.sectionsInZip.includes('workspaces'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t7 未提供目标机会话格式版本时不转码任何会话（只报码，绝不猜版本）', () => {
  const result = convertClaudeCode({ sessions: [{ id: CC_ID, text: ccSession() }] });
  assert.ok(!result.sections.some((s) => s.sectionId === 'sessions'));
  const skip = result.skipped.find((s) => s.code === 'session-format-version-unknown');
  assert.equal(skip?.count, 1);
});
