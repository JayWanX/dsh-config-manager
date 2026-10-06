/**
 * Google Antigravity 来源（读盘 + 翻译 + 端到端）的回归护栏。
 *
 * 三层各测一层（与其它来源测试同构）：
 *  ① 位置真值：~/.gemini/config/mcp_config.json 与 ~/.gemini/antigravity/mcp_config.json **两个都探测**
 *  ② 翻译与安全不变量：serverUrl 归一化、envVar 引用名剥离、两份配置合并可见、同名先到先得、
 *     凭据文件只报告；**0 字节文件报码、绝不产出空 mcp 分区、绝不抛**（本机真值就是 0 字节）
 *  ③ 端到端：产物是合法 bundle v1 分区，既有 Importer 能分析，ZIP 字节不含凭据值
 *
 * 取证强度（契约 §8.2 / §8.7）：两个 mcp_config.json 是**实测取证**（本机存在且为 0 字节），
 * mcp_oauth_tokens.json 与 serverUrl/envVar 形态是文档取证。
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
import { convertAntigravity } from './antigravity.ts';
import { readAntigravity, resolveGeminiHome } from './read-antigravity.ts';
import type { ForeignImportResult } from './types.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/antigravity/', import.meta.url));

function mcpOf(result: ForeignImportResult): McpSection {
  const data = result.sections.find((s) => s.sectionId === 'mcp')?.data;
  assert.ok(data !== undefined, '期望产出 mcp 分区');
  return data as McpSection;
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

/* ---------------- ① 位置真值 ---------------- */

test('t1 位置：~/.gemini 下两个 mcp_config.json 都探测，命中路径如实上报', async () => {
  const read = await readAntigravity({ geminiDir: path.join(FIXTURES, 'empty', 'gemini') });
  assert.equal(read.found, true);
  assert.deepEqual([...read.paths].sort(), [
    '.gemini/antigravity/mcp_config.json',
    '.gemini/antigravity/mcp_oauth_tokens.json',
    '.gemini/config/mcp_config.json',
  ], '全局位置与 IDE 侧同形位置都要探测');

  const none = await readAntigravity({ geminiDir: path.join(FIXTURES, 'does-not-exist') });
  assert.equal(none.found, false, '未安装是正常状态，不是错误');
  assert.deepEqual(none.paths, []);
  assert.deepEqual(convertAntigravity(none.input).sections, []);
});

/* ---------------- ② 0 字节（本机真值） ---------------- */

test('t2 0 字节 mcp_config.json：报 source-empty-file、绝不产出空 mcp 分区、绝不抛', async () => {
  const read = await readAntigravity({ geminiDir: path.join(FIXTURES, 'empty', 'gemini') });
  assert.equal(read.found, true);
  assert.equal(read.input.globalMcp, undefined, '0 字节不解析');
  assert.equal(read.input.ideMcp, undefined);
  assert.deepEqual(read.unreadable, [], '0 字节不是「读不到」：是 source-empty-file');
  const codes = (read.input.readFindings ?? []).map((s) => s.code + '@' + (s.origin ?? ''));
  assert.ok(codes.includes('source-empty-file@config/mcp_config.json'), JSON.stringify(codes));
  assert.ok(codes.includes('source-empty-file@antigravity/mcp_config.json'), JSON.stringify(codes));

  const result = convertAntigravity(read.input);
  assert.ok(!result.sections.some((s) => s.sectionId === 'mcp'), '绝不产出空 mcp 分区');
  assert.deepEqual(result.sections, []);
  assert.ok(result.skipped.some((s) => s.code === 'source-empty-file'), '空文件必须在计划里可见');

  // 直接构造（不经读盘）也必须同口径：空字符串 / 空映射都不产出分区
  assert.ok(!convertAntigravity({ globalMcp: {}, ideMcp: {} }).sections.some((s) => s.sectionId === 'mcp'));
  assert.ok(!convertAntigravity({ globalMcp: { mcpServers: {} } }).sections.some((s) => s.sectionId === 'mcp'));
});

/* ---------------- ② MCP 翻译 ---------------- */

test('t3 MCP：serverUrl 归一化为 http、envVar 引用名被剥离、type=sse 报码、空条目跳过', async () => {
  const read = await readAntigravity({ geminiDir: path.join(FIXTURES, 'basic', 'gemini') });
  assert.equal(read.found, true);
  assert.deepEqual(read.unreadable, []);
  const result = convertAntigravity(read.input);
  const mcp = mcpOf(result);

  const remote = mcp.servers.find((s) => s.serverName === 'remote');
  assert.equal(remote?.type, 'streamable-http', 'serverUrl 必须被识别为 url');
  assert.equal(remote?.url, 'https://mcp.example.com/sse', 'URL userinfo 必须剥离');
  assert.equal(mcp.servers.filter((s) => s.serverName === 'remote').length, 1, '同名条目先到先得，不重复');

  const local = mcp.servers.find((s) => s.serverName === 'local');
  assert.equal(local?.type, 'stdio');
  assert.equal(local?.env?.['API_TOKEN'], '', 'envVar → env 后按字段名剥离（API_TOKEN 在凭据名单里），值绝不留');
  assert.ok(result.credentialRefs.includes('mcp:local:API_TOKEN'), '凭据引用名必须被记录（导入后由用户补录），且只记名字');

  assert.ok(mcp.servers.some((s) => s.serverName === 'legacy'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-type-sse-coerced' && s.origin === 'legacy'));
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'empty'), '既无 command 也无 serverUrl 的条目进 skipped');
  assert.ok(result.skipped.some((s) => s.code === 'mcp-server-empty' && s.origin === 'remote' && s.detail === 'duplicate-across-configs'), '两份配置同名条目必须可见地跳过');
  assert.ok(result.skipped.some((s) => s.code === 'instructions-merged' && s.count === 2), '合并两份配置必须可见');

  // 凭据文件只报告：basic fixture 里没有它，用读盘结果显式构造（正文本来就没有承载字段）
  const withOauth = convertAntigravity({ ...read.input, oauthTokensPresent: true });
  assert.ok(withOauth.skipped.some((s) => s.code === 'credentials-not-migrated' && s.origin === 'antigravity/mcp_oauth_tokens.json'));
  assert.ok(!convertAntigravity({ ...read.input, oauthTokensPresent: false }).skipped.some((s) => s.code === 'credentials-not-migrated'));
  assert.ok(!JSON.stringify(result).includes('sk-FIXTURE_TOKEN_DO_NOT_SHIP'), '结果对象里不得出现凭据明文');

  // 只有一份配置时不报合并码
  const single = convertAntigravity({ globalMcp: { mcpServers: { only: { command: 'node' } } } });
  assert.ok(!single.skipped.some((s) => s.code === 'instructions-merged'));
  // 形态对不上（顶层结构完全不是映射）→ 如实报码，不静默少一片
  const odd = convertAntigravity({ globalMcp: { wrong: true } });
  assert.ok(odd.skipped.some((s) => s.code === 'mcp-server-empty' && s.detail === 'no-servers-container'));
  assert.ok(!odd.sections.some((s) => s.sectionId === 'mcp'));
});

/* ---------------- ② 畸形 / 超限 ---------------- */

test('t4 畸形 JSON 与超限文件：进 skipped 且有稳定机器码，绝不抛、绝不产出分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ag-edge-'));
  try {
    await writeAt(tmp, '.gemini/config/mcp_config.json', '{ "mcpServers": { "x": { "command": "node" } }');
    const broken = await readAntigravity({ geminiDir: path.join(tmp, '.gemini') });
    assert.equal(broken.found, true);
    assert.deepEqual(broken.unreadable, ['.gemini/config/mcp_config.json']);
    assert.ok((broken.input.readFindings ?? []).some((s) => s.code === 'source-unreadable' && s.detail === 'json-error'));
    assert.deepEqual(convertAntigravity(broken.input).sections, []);

    await fs.rm(path.join(tmp, '.gemini', 'config', 'mcp_config.json'));
    await writeAt(tmp, '.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { x: { command: 'node' } } }));
    const oversized = await readAntigravity({ geminiDir: path.join(tmp, '.gemini'), maxFileBytes: 4 });
    assert.equal(oversized.input.globalMcp, undefined, '超限即不读（绝不截断）');
    assert.ok((oversized.input.readFindings ?? []).some((s) => s.code === 'source-unreadable' && s.detail === 'too-large'));
    assert.ok(!convertAntigravity(oversized.input).sections.some((s) => s.sectionId === 'mcp'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- ③ 端到端 ---------------- */

test('t5 端到端：fixture → 标准 bundle v1（既有 Importer 能分析），ZIP 字节不含凭据值', async () => {
  const read = await readAntigravity({ geminiDir: path.join(FIXTURES, 'basic', 'gemini') });
  const result = convertAntigravity(read.input);
  assert.deepEqual(result.sections.map((s) => s.sectionId), ['mcp']);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ag-e2e-'));
  try {
    const zipPath = path.join(tmp, 'antigravity.zip');
    const written = await writeForeignBundle({
      result,
      outPath: zipPath,
      exporterVersion: '0.0.0-test',
      dshVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      exportedAt: '2026-10-04T00:00:00.000Z',
    });
    assert.deepEqual([...written.sections], ['mcp']);
    assert.deepEqual([...written.entryNames], ['mcp/servers.json']);

    const buf = await fs.readFile(zipPath);
    assert.ok(!buf.includes(Buffer.from('sk-FIXTURE_TOKEN_DO_NOT_SHIP', 'utf8')), 'ZIP 字节里不得出现凭据值');
    assert.ok(!buf.includes(Buffer.from('pw@', 'utf8')), 'ZIP 字节里不得出现 URL userinfo');
    assert.ok(!buf.includes(Buffer.from('oauth', 'utf8')), '凭据文件绝不进包');

    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters(), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, '产物必须是合法 bundle：' + JSON.stringify(analysis.errors));
    assert.ok(analysis.sectionsInZip.includes('mcp' as SectionId));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- 范围与真机取样 ---------------- */

test('t6 会话：brain/<id>/.system_generated/logs 的转录进 sessions+workspaces；conversations/*.pb 绝不读', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ag-sess-'));
  const NL = String.fromCharCode(10);
  const id = '11111111-2222-4333-8444-555555555555';
  try {
    const logs = '.gemini/antigravity-cli/brain/' + id + '/.system_generated/logs';
    const lines: unknown[] = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-02T03:04:05Z', content: '<USER_REQUEST>' + NL + '帮我看下构建' + NL + '</USER_REQUEST>' + NL + '<ADDITIONAL_METADATA>' + NL + 'noise' + NL + '</ADDITIONAL_METADATA>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-02T03:04:06Z', content: '我看一下', tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', Cwd: '"D:\\\\Projects\\\\demo"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-01-02T03:04:09Z', content: 'npm test' + NL + NL + 'The command exited with code 0.' + NL + 'Output:' + NL + 'all good' },
      { step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-01-02T03:04:10Z', content: 'framework noise' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-02T03:04:11Z', content: '完成', tool_calls: [] },
    ];
    await writeAt(tmp, logs + '/transcript.jsonl', lines.map((o) => JSON.stringify(o) + NL).join(''));
    await writeAt(tmp, '.gemini/antigravity-cli/annotations/' + id + '.pbtxt', 'title:"构建排错"' + NL);
    await writeAt(tmp, '.gemini/antigravity-cli/conversations/' + id + '.pb', 'PROTO_SENTINEL_DO_NOT_SHIP');

    const read = await readAntigravity({ geminiDir: path.join(tmp, '.gemini'), limits: { maxSessionFiles: 10 } });
    assert.equal(read.input.sessions?.length, 1, 'brain 下的转录必须被读成一个会话');
    const parsed = read.input.sessions?.[0]?.parsed;
    assert.equal(parsed?.cwd, 'D:\\Projects\\demo', 'cwd 取 tool_calls 的 Cwd（带引号值要还原）');
    assert.equal(parsed?.title, '构建排错', '标题取 annotations/*.pbtxt');
    assert.ok(!JSON.stringify(read.input).includes('PROTO_SENTINEL_DO_NOT_SHIP'), 'conversations/*.pb 绝不读');

    const first = parsed?.records[0];
    assert.ok(first?.blocks.some((b) => b.type === 'text' && b.text === '帮我看下构建'), '<USER_REQUEST> 必须剥壳');
    const call = parsed?.records.flatMap((r) => r.blocks).find((b) => b.type === 'tool_call');
    assert.ok(call !== undefined && call.type === 'tool_call');
    const results = parsed?.records.flatMap((r) => r.blocks).filter((b) => b.type === 'tool_result') ?? [];
    assert.equal(results.length, 1, '未决调用必须恰好配上一个结果');
    assert.equal(results[0]?.id, call?.id, '结果必须按「最早未决调用」配对');
    assert.ok(results[0]?.text.includes('all good'));

    read.input.targetSessionFormatVersion = 3;
    const result = convertAntigravity(read.input);
    assert.ok(result.sections.some((s) => s.sectionId === 'sessions'), '会话必须产出 sessions 分区');
    assert.ok(result.sections.some((s) => s.sectionId === 'workspaces'), '会话必须连工作区一起产出');
    assert.ok(
      result.skipped.some((s) => s.code === 'unsupported-session-record' && s.detail === 'SYSTEM_MESSAGE'),
      'SYSTEM_MESSAGE 必须逐类计数而不是静默丢',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('t6b 缺 cwd 或只有 0 字节 mcp 配置时：0 字节配置报码，会话缺失 cwd 也如实报码（绝不猜）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ag-nocwd-'));
  const NL = String.fromCharCode(10);
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  try {
    await writeAt(tmp, '.gemini/config/mcp_config.json', '');
    await writeAt(tmp, '.gemini/antigravity/brain/' + id + '/.system_generated/logs/overview.txt', JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '没有工具调用的一段话' }) + NL);
    const read = await readAntigravity({ geminiDir: path.join(tmp, '.gemini') });
    assert.equal(read.input.sessions?.length, 1, 'overview.txt 也是同一记录形态');
    read.input.targetSessionFormatVersion = 3;
    const result = convertAntigravity(read.input);
    assert.ok(result.skipped.some((s) => s.code === 'source-empty-file'), '0 字节配置报码');
    assert.ok(result.skipped.some((s) => s.code === 'session-missing-cwd' && s.origin === id), '缺 cwd 如实报码');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

const REAL_GEMINI = path.join(os.homedir(), '.gemini');
const realStat = await fs.stat(REAL_GEMINI).catch(() => null);

test(
  't7 真机取样：本机 ~/.gemini 的两个 mcp_config.json（实测 0 字节）→ 报码、无分区、不抛',
  { skip: realStat === null ? '本机无 ~/.gemini' : false },
  async () => {
    const read = await readAntigravity({ geminiDir: resolveGeminiHome({ homeDir: os.homedir() }).dir });
    assert.equal(read.found, true);
    read.input.targetSessionFormatVersion = 3;
    const result = convertAntigravity(read.input);
    const sessionCount = (result.sections.find((s) => s.sectionId === 'sessions')?.files ?? []).length;
    if (sessionCount > 0) {
      assert.ok(result.sections.some((s) => s.sectionId === 'workspaces'), '有会话就必须有工作区');
    }
    // 本机实测两个文件都是 0 字节 → 必须报码而不是产出空分区；若将来用户填了真实配置，这里仍必须合法
    for (const s of read.input.readFindings ?? []) {
      assert.equal(typeof s.code, 'string');
    }
    if (result.sections.length === 0) {
      assert.ok(result.skipped.some((s) => s.code === 'source-empty-file'), '没有分区时必须能解释原因');
    }
  },
);
