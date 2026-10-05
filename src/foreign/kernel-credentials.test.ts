/**
 * audit-foreign F1 的回归护栏（t17）：MCP server 的 args 是**字符串数组**，其元素必须与
 * env / headers 一样过凭据剥离（安全不变量：凭据值绝不进包）。
 *
 * base 3f42a8b 上的红：args 里的 sk- 形状密钥明文留在 mcp 载荷与整份 ZIP 字节里（t4 findings F1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode } from './claude-code.ts';
import { mcpSectionFromEntries } from './kernel.ts';
import { parseZip } from '../utils/zip.ts';
import type { McpSection } from '../schema/types.ts';
import type { ForeignSkip } from './types.ts';

const SECRET = 'sk-abcdefghijklmnop0123456789XYZ';

test('F1-a kernel：args 数组里的真值形状密钥被剥空、留引用名、并按条报码（env/headers 口径不变）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['svc', {
      command: 'npx',
      args: ['-y', 'svc', '--api-key', SECRET],
      env: { FOO_TOKEN: SECRET },
      headers: { Authorization: 'Bearer ' + SECRET },
      url: 'https://user:' + SECRET + '@host.invalid/mcp',
    }]],
    refs,
    skipped,
  );
  assert.ok(section !== null, '有 server 时必须产出 mcp 分区');
  const server = section.servers[0];
  assert.ok(server !== undefined);
  assert.deepEqual(server.args, ['-y', 'svc', '--api-key', ''], 'args 里的密钥必须被剥成空串');
  assert.deepEqual(server.env, { FOO_TOKEN: '' });
  assert.deepEqual(server.headers, { Authorization: '' });
  assert.equal(server.url, 'https://host.invalid/mcp');
  assert.deepEqual(refs.filter((r) => r.endsWith(':args')), ['mcp:svc:args']);
  assert.ok(refs.includes('mcp:svc:FOO_TOKEN'));
  const argSkip = skipped.find((s) => s.code === 'mcp-credential-redacted' && s.origin === 'svc:args');
  assert.equal(argSkip?.count, 1);
  assert.equal(JSON.stringify(section).includes(SECRET), false, 'mcp 载荷里不得残留密钥明文');
});

test('F1-a2 kernel：非密钥的 args 原样保留（不误伤 -y / 包名 / 开关名）', () => {
  const refs: string[] = [];
  const skipped: ForeignSkip[] = [];
  const section = mcpSectionFromEntries(
    [['svc', { command: 'npx', args: ['-y', 'mcp-server-svc', '--verbose'] }]],
    refs,
    skipped,
  );
  assert.ok(section !== null);
  assert.deepEqual(section.servers[0]?.args, ['-y', 'mcp-server-svc', '--verbose']);
  assert.deepEqual(refs, []);
  assert.deepEqual(skipped, []);
});

test('F1-b 端到端：整份 ZIP 的 mcp/servers.json 里不含 args 里的密钥', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-f1-fix-'));
  try {
    const result = convertClaudeCode({
      claudeJson: { mcpServers: { leaky: { command: 'npx', args: ['-y', 'mcp-server-leaky', '--token', SECRET] } } },
    });
    const mcp = result.sections.find((s) => s.sectionId === 'mcp')?.data as McpSection | undefined;
    assert.ok(mcp !== undefined, '必须产出 mcp 分区');
    assert.equal(JSON.stringify(mcp).includes(SECRET), false, 'mcp 载荷里不得残留密钥');
    assert.ok(
      result.skipped.some((s) => s.code === 'mcp-credential-redacted' && s.origin === 'leaky:args'),
      'args 剥离必须可见（mcp-credential-redacted + origin=leaky:args）：' + JSON.stringify(result.skipped),
    );

    const zipPath = path.join(tmp, 'f1.zip');
    await writeForeignBundle({ result, outPath: zipPath, exporterVersion: '0.0.0-fix', dshVersion: '0.1.0' });
    const zip = parseZip(new Uint8Array(await fs.readFile(zipPath)));
    const data = zip.readEntry('mcp/servers.json');
    assert.ok(data !== undefined, 'ZIP 里必须有 mcp/servers.json');
    const text = new TextDecoder().decode(data);
    assert.equal(text.includes(SECRET), false, 'ZIP 字节里不得残留密钥');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
