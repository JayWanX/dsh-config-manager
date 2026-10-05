/**
 * mcp adapter 测试：组合 patch 提取（单行 + insert 块）、Create/Skip/Conflict、
 * applyItem 写 patch 行（needsRestart）、validate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpAdapter, extractMcpServers, buildMcpPatchLine } from './mcp.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('mcp: extractMcpServers 兼容单行与 insert 块', () => {
  const lines = [
    {
      lineId: 'mcp-fs',
      raw: {
        id: 'mcp-fs',
        name: 'dsh-mcp-client',
        config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], cwd: 'C:\\Users\\alice\\projects' },
      },
    },
    {
      lineId: 'mcp-http',
      raw: {
        insert: [
          { id: 'mcp-http', name: 'dsh-mcp-client', config: { serverName: 'remote', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer abc' } } },
        ],
      },
    },
    { lineId: 'other', raw: { id: 'other', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } } },
  ];
  const servers = extractMcpServers(lines);
  assert.equal(servers.length, 2);
  const fs = servers.find((s) => s.serverName === 'filesystem');
  assert.equal(fs?.type, 'stdio');
  assert.equal(fs?.command, 'npx');
  assert.equal(fs?.cwd, 'C:\\Users\\alice\\projects');
  assert.equal(fs?.sourceLineId, 'mcp-fs');
  const http = servers.find((s) => s.serverName === 'remote');
  assert.equal(http?.type, 'streamable-http');
  assert.equal(http?.url, 'https://mcp.example.com/sse');
  assert.equal(http?.sourceLineId, 'mcp-http');
});

test('mcp: buildMcpPatchLine 构造写回行', () => {
  const line = buildMcpPatchLine('mcp-fs', { serverName: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', 'x'] });
  assert.equal(line.id, 'mcp-fs');
  assert.equal(line.name, 'dsh-mcp-client');
  assert.equal((line.config as Record<string, unknown>)['command'], 'npx');
});

test('mcp: export 提取 + analyzeImport Create/Skip/Conflict + applyItem 写 patch（needsRestart）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'x'] } },
  });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1);
  assert.equal(exported.data.servers[0]?.serverName, 'filesystem');
  const sections = new Map([['mcp', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.target?.ref, 'mcp-fs');
  let r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true, 'MCP 写 patch 必须重启生效');
  assert.ok(dst.patchFile.lines.has('mcp-fs'));
  assert.equal((dst.patchFile.lines.get('mcp-fs')?.raw as Record<string, unknown>)['name'], 'dsh-mcp-client');

  // 幂等：同 serverName 同内容 → Skip
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 目标同 serverName 不同内容 → Conflict（target.ref = 目标行 id）
  dst.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'other'] } },
  });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
  const useItem: PlanItem = { ...items[0]!, kind: 'Update' };
  r = await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  const raw = dst.patchFile.lines.get('mcp-fs')?.raw as Record<string, unknown>;
  assert.deepEqual((raw['config'] as Record<string, unknown>)['args'], ['-y', 'x'], 'Conflict useImported 应更新目标行');
});

test('issue #71: profile 层 MCP 行也要导出，且写回**原层**（不再凭空消失 / 不搬家）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'tauri');
  // 真机形态：MCP server 由手写/工具写进 profile 层（home 层只有别的行）
  src.patchFile.bucket('profiles/tauri/cordis.patch.yml').set('mcp-codegraph', {
    lineId: 'mcp-codegraph',
    raw: { id: 'mcp-codegraph', name: 'dsh-mcp-client', config: { serverName: 'codegraph', command: 'codegraph', args: ['serve', '--mcp'] } },
  });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1, 'profile 层的 server 必须在备份里（此前只读 home 层 → 恒为空）');
  const server = exported.data.servers[0];
  assert.equal(server?.serverName, 'codegraph');
  assert.equal(server?.sourceFile, 'profiles/tauri/cordis.patch.yml', '必须记住来源层，写回才能落回原层');
  const sections = new Map([['mcp', exported.data]]);

  // 目标机：同一 profile，patch 两层都空 → Create
  const dst = makeContext('linux', '/home/bob', 'tauri');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Create');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.equal(dst.patchFile.bucket('profiles/tauri/cordis.patch.yml').has('mcp-codegraph'), true, '新行必须落 profile 层（来源层）');
  assert.equal(dst.patchFile.lines.size, 0, '不得把 profile 层的 server 搬到 home 层（同一 lineId 两层各一份会让合并语义不可预期）');
});

test('issue #71: 同名行两层都有 → 只导出优先级更高的一层（home 覆盖 profile）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'tauri');
  const profileRel = 'profiles/tauri/cordis.patch.yml';
  src.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'home'] } },
  });
  src.patchFile.bucket(profileRel).set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'profile'] } },
  });
  const exported = await new McpAdapter().export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1);
  assert.deepEqual(exported.data.servers[0]?.args, ['-y', 'home'], '生效值是 home 层（DSH 合并序里 home 层在后）');
  assert.equal(exported.data.servers[0]?.sourceFile, 'cordis.patch.yml');
});

test('mcp: validate 拒绝无 serverName 的条目', async () => {
  const adapter = new McpAdapter();
  const bad = await adapter.validate({ version: 1, servers: [{ serverName: '' } as never] });
  assert.equal(bad.valid, false);
});
