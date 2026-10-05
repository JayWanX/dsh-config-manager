/**
 * MCP 凭据剥离的**值形状**回归护栏（t40；来源 = ui-audit 在 t18 反向攻击时的新发现）。
 *
 * 现象：env / headers 走的是 core 的**字段名黑名单**扫描器（src/core/exporter.ts 的 defaultSecretScanner），
 * 值形状判定（matchSecretValuePattern）在这条路径上没被用到 —— 于是**键名不敏感**时
 * `env:{FOO:'sk-…'}`、`headers:{'X-Custom':'ghp_…'}` 明文进包；t40 复核还发现 url 的 query/path、
 * command、cwd 同属这一类（url 只剥 userinfo）。
 *
 * base 3f42a8b 上的红：上面这些字段里的真值形状值原样留在 mcp 载荷与整份 ZIP 字节里
 * （t18 证据：outputs/bug-audit/verify-t18/t18-env-shape-BASE.txt 与 -VFY18.txt 逐字相同）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode } from './claude-code.ts';
import { mcpSectionFromEntries, redactMcpSection } from './kernel.ts';
import { parseZip } from '../utils/zip.ts';
import type { ForeignImportResult, ForeignSkip } from './types.ts';
import type { McpSection, McpServerEntry } from '../schema/types.ts';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const S = 'sk-abcdefghijklmnop0123456789XYZ';
const GH = 'ghp_' + 'AbCdEf0123456789aBcDeF0123456789aB';
const AKIA = 'AKIA' + '0123456789ABCDEF';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';

/** 整份 ZIP 里的 mcp/servers.json 原文（字节级证明「凭据不进包」） */
async function zipMcpText(result: { sections: readonly unknown[] }): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-t40-zip-'));
  try {
    const outPath = path.join(tmp, 'b.zip');
    await writeForeignBundle({ result: result as never, outPath, exporterVersion: '0.0.0-t40', dshVersion: '0.1.0' });
    const archive = parseZip(new Uint8Array(await fs.readFile(outPath)));
    return new TextDecoder().decode(archive.readEntry('mcp/servers.json'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
function skipsOf(skipped: readonly ForeignSkip[], origin: string): ForeignSkip | undefined {
  return skipped.find((s) => s.code === 'mcp-credential-redacted' && s.origin === origin);
}
/** 取 mcp 分区载荷（sections 的 data 是 unknown：这里断言并收窄一次，避免每处重复 cast） */
function mcpOf(result: ForeignImportResult): McpSection {
  const found = result.sections.find((s) => s.sectionId === 'mcp');
  assert.ok(found !== undefined, '必须产出 mcp 分区');
  return (found as unknown as { data: McpSection }).data;
}

test('t40-a 键名不敏感时 env / headers 的真值形状值也必须剥空（+ 逐字段码 + 引用名）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['plain', { command: 'npx', env: { FOO: S }, headers: { 'X-Custom': GH } }]],
    refs,
    skipped,
  );
  assert.ok(section !== null, '有 server 时必须产出 mcp 分区');
  const server = section.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.env, { FOO: '' }, '键名不敏感（FOO）不是明文进包的理由');
  assert.deepEqual(server.headers, { 'X-Custom': '' }, '键名不敏感（X-Custom）不是明文进包的理由');
  assert.equal(skipsOf(skipped, 'plain:env')?.count, 1, 'env 命中必须留可见码');
  assert.equal(skipsOf(skipped, 'plain:headers')?.count, 1, 'headers 命中必须留可见码');
  assert.ok(refs.includes('mcp:plain:env') && refs.includes('mcp:plain:headers'), '两个字段都要留引用名');
  assert.equal(JSON.stringify(section).includes(S), false, 'mcp 载荷里不得残留 sk- 明文');
  assert.equal(JSON.stringify(section).includes(GH), false, 'mcp 载荷里不得残留 ghp_ 明文');
});

test('t40-b t18 实测的 8 种值写法（--k=v / 分隔 / 1 万字符内嵌 / 尾 CRLF / ghp_ / AKIA / JWT / Bearer）在 env/headers 上全部剥离', async () => {
  const writings: Record<string, string> = {
    joined: '--token=' + S,
    bare: S,
    longPad: 'p'.repeat(10000) + S,
    crlfTail: S + CR + NL,
    ghToken: GH,
    awsKey: AKIA,
    jwtToken: JWT,
    bearer: 'Bearer ' + S,
  };
  // 键名刻意**中立**（E_1 / X_1…）：本用例要单独验证「值形状判定独立于键名」，
  // 不含 token/authorization 这类会被字段名黑名单先接走的键（那种情形见 t40-b2）。
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let i = 0;
  for (const value of Object.values(writings)) {
    i += 1;
    env['E_' + String(i)] = value;
    headers['X_' + String(i)] = value;
  }
  const result = convertClaudeCode({ claudeJson: { mcpServers: { eight: { command: 'npx', env, headers } } } });
  const mcp = mcpOf(result);
  const server = mcp.servers[0];
  assert.ok(server !== undefined);
  // 16 个值（8 写法 × env/headers）全部置空
  for (const [k, v] of Object.entries(server.env ?? {})) assert.equal(v, '', 'env ' + k + ' 必须被剥空');
  for (const [k, v] of Object.entries(server.headers ?? {})) assert.equal(v, '', 'headers ' + k + ' 必须被剥空');
  assert.equal(skipsOf(result.skipped ?? [], 'eight:env')?.count, 8, 'env 侧 8 个全命中（键名中立 → 只能靠值形状判）');
  assert.equal(skipsOf(result.skipped ?? [], 'eight:headers')?.count, 8, 'headers 侧 8 个全命中（键名中立）');
  const zipText = await zipMcpText(result);
  for (const secret of [S, GH, AKIA, JWT]) {
    assert.equal(zipText.includes(secret), false, 'ZIP 字节不得残留 ' + secret.slice(0, 8) + '…');
  }
});

test('t40-b2 敏感键名与不敏感键名**两条路径并存**：都不得明文进包（t4-F1 的前提纠正）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  // t4-F1 当年用 FOO_TOKEN / Authorization 做对照，据此断言「env/headers 已正确剥空」——
  // 只对**敏感键名**成立。这里两种键名同时出现，两条判定路径都必须生效。
  const section = mcpSectionFromEntries(
    [['mixed', { command: 'npx', env: { FOO_TOKEN: GH, NEUTRAL: GH }, headers: { Authorization: S, 'X-Plain': S } }]],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  const server = section.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.env, { FOO_TOKEN: '', NEUTRAL: '' }, '敏感键名与中立键名都必须剥空');
  assert.deepEqual(server.headers, { Authorization: '', 'X-Plain': '' });
  assert.equal(JSON.stringify(section).includes(GH), false);
  assert.equal(JSON.stringify(section).includes(S), false);
  assert.ok(skipsOf(skipped, 'mixed:env')?.count === 1, '中立键名那条由值形状判定留码');
  assert.ok(refs.includes('mcp:mixed:env') && refs.includes('mcp:mixed:FOO_TOKEN'), '两条路径各自留引用名');
});

test('t40-c args 的既有判定不回归（8 种写法照旧剥离、逐条报码、引用名不变）', async () => {
  const args = ['--token=' + S, S, 'p'.repeat(10000) + S, S + CR + NL, GH, AKIA, JWT, 'Bearer ' + S];
  const result = convertClaudeCode({ claudeJson: { mcpServers: { argScope: { command: 'npx', args } } } });
  const kept = mcpOf(result).servers[0]?.args ?? [];
  assert.equal(kept.length, args.length, 'args 个数与形状不变（只置空命中的元素）');
  for (const a of kept) assert.equal(a, '', '每个 args 元素都必须被剥空');
  assert.equal(skipsOf(result.skipped ?? [], 'argScope:args')?.count, 8, '逐条计数不变');
  assert.ok((result.credentialRefs ?? []).includes('mcp:argScope:args'), '引用名不变');
  const zipText = await zipMcpText(result);
  for (const secret of [S, GH, AKIA, JWT]) assert.equal(zipText.includes(secret), false, 'ZIP 字节零残留');
});

test('t40-d 非字符串元素：env 只收字符串、args 过滤非字符串，且不崩不残留', async () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['junk', { command: 'npx', args: ['--n', 42, null, { a: 1 }, ['nested', S], true], env: { A: 42, B: null, C: { nested: S }, D: [S], E: true, F: S } }]],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  const server = section.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.args, ['--n'], '非字符串 args 一律过滤（形状不变）');
  assert.deepEqual(server.env, { F: '' }, 'env 只保留字符串值，且命中的字符串被剥空');
  assert.equal(JSON.stringify(section).includes(S), false, '嵌套对象/数组里的值不得残留（它们根本不进载荷）');
});

test('t40-e 同族第三条漏口：url 的 query/path、command、cwd 也必须剥（url 保持可用）', async () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [
      ['query', { url: 'https://api.example.com/mcp?api_key=' + S }],
      ['path', { url: 'https://api.example.com/' + S + '/mcp' }],
      ['authority', { url: 'https://' + S + '/mcp' }],
      ['cmd', { command: S, args: ['x'] }],
      ['wd', { command: 'npx', cwd: '/home/u/' + S }],
    ],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  const byName = (n: string): Record<string, unknown> | undefined =>
    section.servers.find((s) => s.serverName === n) as unknown as Record<string, unknown> | undefined;
  assert.equal(byName('query')?.['url'], 'https://api.example.com/mcp?api_key=', 'query 的值被剥空、URL 仍可用');
  assert.equal(byName('path')?.['url'], 'https://api.example.com//mcp', 'path 段被剥空、URL 仍可用');
  assert.equal(byName('authority')?.['url'], '', 'secret 落在 authority → 整串置空兜底');
  assert.equal(byName('cmd')?.['command'], '', 'command 是字符串字段，同样必须判');
  assert.equal(byName('wd')?.['cwd'], '', 'cwd 里嵌的 secret 同样必须判');
  for (const origin of ['query:url', 'path:url', 'authority:url', 'cmd:command', 'wd:cwd']) {
    assert.ok(skipsOf(skipped, origin) !== undefined, '必须有可见码：' + origin);
  }
  assert.equal(JSON.stringify(section).includes(S), false, 'mcp 载荷里不得残留密钥明文');
});

test('t40-f 对照：无害值不得被误伤（键名不敏感 + 普通值照旧原样带走）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['ok', { command: 'npx', args: ['-y', 'mcp-server-ok'], env: { FOO: 'bar', PATH_LIKE: '/usr/bin' }, headers: { 'X-Trace': 'abc' }, cwd: '/home/u/proj', url: 'https://api.example.com/mcp?foo=bar&v=2' }]],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  const server = section.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.env, { FOO: 'bar', PATH_LIKE: '/usr/bin' });
  assert.deepEqual(server.headers, { 'X-Trace': 'abc' });
  assert.deepEqual(server.args, ['-y', 'mcp-server-ok']);
  assert.equal(server.cwd, '/home/u/proj');
  assert.equal(server.url, 'https://api.example.com/mcp?foo=bar&v=2');
  assert.deepEqual(refs, [], '无害值不得产生引用名');
  assert.deepEqual(skipped, [], '无害值不得产生告警');
});

test('t40-g 示例形状（sk-test-…）按扫描器既有降噪口径放行（与 args 同一条口径，登记为观察）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['exampleShape', { command: 'npx', env: { FOO: 'sk-test-placeholder-value-0000' } }]],
    refs,
    skipped,
  );
  const server = section?.servers[0];
  assert.equal(server?.env?.['FOO'], 'sk-test-placeholder-value-0000', '示例形状沿用扫描器降噪（非缺陷，与 args 一致）');
  assert.deepEqual(refs, []);
});

test('t72-e 真实管道：Bearer 大小写变体（bearer / BEARER / BeArEr）必须剥离、零残留且可追溯', async () => {
  // ① 真实管道（convertClaudeCode：读盘层 → mcpSectionFromEntries）
  const result = convertClaudeCode({
    claudeJson: {
      mcpServers: {
        low: { command: 'npx', env: { A: 'bearer abc12345def' } },
        up: { command: 'npx', headers: { 'X-Custom': 'BEARER AbCdEf0123' } },
        mixed: { command: 'npx', args: ['--h', 'BeArEr a.b_c-d/e+f=g'] },
      },
    },
  });
  const payload = JSON.stringify(mcpOf(result));
  const zip = await zipMcpText(result);
  for (const secret of ['bearer abc12345def', 'BEARER AbCdEf0123', 'BeArEr a.b_c-d/e+f=g']) {
    assert.equal(payload.includes(secret), false, 'mcp 载荷零残留：' + secret);
    assert.equal(zip.includes(secret), false, 'ZIP 字节零残留：' + secret);
  }
  // ② 逐字段可见（同一条 mcpSectionFromEntries，字段级引用名 + 码）
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [
      ['low', { command: 'npx', env: { A: 'bearer abc12345def' } }],
      ['up', { command: 'npx', headers: { 'X-Custom': 'BEARER AbCdEf0123' } }],
      ['mixed', { command: 'npx', args: ['--h', 'BeArEr a.b_c-d/e+f=g'] }],
    ],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  for (const ref of ['mcp:low:env', 'mcp:up:headers', 'mcp:mixed:args']) {
    assert.ok(refs.includes(ref), '必须有引用名：' + ref);
  }
  for (const origin of ['low:env', 'up:headers', 'mixed:args']) {
    assert.ok(skipsOf(skipped, origin) !== undefined, '必须有可见码：' + origin);
  }
});

test('t72-f redactMcpSection **自身**过滤非字符串载体（不再依赖上游 mcpEntryOf）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const raw = {
    serverName: 'direct',
    type: 'stdio',
    command: 'npx',
    args: ['--n', { k: S }],
    env: { A: { nested: S }, B: [S], C: 'plain', D: S },
    headers: { X: [S] },
  };
  const out = redactMcpSection({ version: 1, servers: [raw as unknown as McpServerEntry] }, refs, skipped);
  const server = out.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.args, ['--n'], '非字符串 args 元素被**丢弃**（不是置空）');
  assert.deepEqual(server.env, { C: 'plain', D: '' }, 'env 只留字符串值，命中的字符串被剥空');
  assert.equal(server.headers, undefined, '被滤空的 headers 字段直接删除（不留 {X:""} 这种伪空值）');
  assert.equal(JSON.stringify(out).includes(S), false, '非字符串载体里的明文绝不进载荷');
});

test('t72-g 口径：尖括号占位符在值形状通道也被剥空（有意保留，见 known-gaps G-36）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries([['ph', { command: 'npx', env: { K: '<sk-abcdefgh1234>' } }]], refs, skipped);
  const server = section?.servers[0];
  assert.equal(server?.env?.['K'], '', '值形状通道只认「形状」⇒ <> 占位符同样被剥（多剥是安全方向）');
  assert.ok(skipsOf(skipped, 'ph:env') !== undefined, '必须留可见码');
});

