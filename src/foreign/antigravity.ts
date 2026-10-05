/**
 * Google Antigravity（~/.gemini）→ DSH bundle 分区的**纯**翻译层。
 *
 * 输入 = 已经读好的 Antigravity 数据（读盘层 read-antigravity.ts）；
 * 输出 = ForeignImportResult（分区载荷 + 未迁移项 + 凭据引用名）。
 *
 * 位置与结构真值见契约 §8.2（**实测取证** 2026-10-04：~/.gemini/config/mcp_config.json 与
 * ~/.gemini/antigravity/mcp_config.json **都存在且都是 0 字节** + 文档取证 antigravity.google/docs/mcp）：
 *  - 两个 mcp_config.json 都探测；**0 字节报 source-empty-file，绝不产出空 mcp 分区、绝不抛**
 *  - 全局与兼容位置同时命中 → **合并**两个文件的条目（合并必须可见：报 instructions-merged）
 *  - remote 形态用 **serverUrl**（Antigravity 已不支持 url/httpUrl）→ 单独识别并归一化为 url
 *  - ~/.gemini/antigravity/mcp_oauth_tokens.json 是**凭据文件**：只报告，绝不读、绝不进包
 *  - ~/.gemini/antigravity-cli/**：**不在本期范围**（契约未冻结其中哪些是配置），不读不报，
 *    绝不产出 sessions/workspaces 分区
 *
 * 公共口径（MCP 映射与凭据剥离、路径/名字安全）全部走共享内核 kernel.ts —— 与其它来源同一份实现。
 */
import { isRecord } from '../utils/guards.ts';
import { mcpEntryOf, redactMcpSection } from './kernel.ts';
import type { McpSection, McpServerEntry } from '../schema/types.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip } from './types.ts';

/** Antigravity 配置的已读形态（纯数据；翻译层不做任何 fs 访问） */
export interface AntigravityInput {
  /** ~/.gemini/config/mcp_config.json（已解析；缺失 / 0 字节 / 畸形 = undefined） */
  globalMcp?: unknown;
  /** ~/.gemini/antigravity/mcp_config.json（IDE 侧同形位置；同上） */
  ideMcp?: unknown;
  /** ~/.gemini/antigravity/mcp_oauth_tokens.json 存在与否（**只报告**；正文绝不读） */
  oauthTokensPresent?: boolean;
  /** 读盘层发现（0 字节 / 读不到）——原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

/** 容器候选键：Antigravity 文档用 mcpServers；兼容其它同义形态，按顺序取第一个映射 */
const CONTAINER_KEYS: readonly string[] = ['mcpServers', 'servers'];

/** Antigravity 的 remote 形态字段：serverUrl（现行）优先，url / httpUrl 作为兜底兼容 */
const URL_KEYS: readonly string[] = ['serverUrl', 'url', 'httpUrl'];

function hasContainer(value: unknown, key: string): boolean {
  if (!isRecord(value)) return false;
  const raw = value[key];
  return isRecord(raw) || Array.isArray(raw);
}

function firstContainerKey(value: unknown): string | undefined {
  return CONTAINER_KEYS.find((k) => hasContainer(value, k));
}

function entriesOf(value: unknown, key: string): [string, unknown][] {
  if (!isRecord(value)) return [];
  const raw = value[key];
  if (Array.isArray(raw)) {
    const out: [string, unknown][] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const name = item['name'];
      if (typeof name !== 'string' || name === '') continue;
      out.push([name, item]);
    }
    return out;
  }
  if (isRecord(raw)) return Object.entries(raw);
  return [];
}

/**
 * 单个 Antigravity server 定义 → 内核能吃的「通用形态」。
 *
 * 两条归一化（都是**键名**层面的，绝不猜值）：
 *  ① serverUrl / httpUrl → url（内核只认 url 判定 streamable-http）；
 *  ② envVar（形如 {"API_KEY": "MY_ENV_VAR"}，值是**环境变量名**而非密钥值）→ env：
 *     内核的凭据扫描按字段**名字**命中，因此 envVar 的引用名会随之被剥离为「字段名 + 引用名」，
 *     正是我们想要的语义（既不丢字段，也不带任何值）。
 * 其余字段原样透传（含 enabled），由内核按「DSH 有对等字段才带」的口径过滤。
 */
function normalizeEntry(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (out['url'] === undefined) {
    for (const k of URL_KEYS) {
      const v = out[k];
      if (typeof v === 'string' && v !== '') { out['url'] = v; break; }
    }
  }
  if (out['env'] === undefined && isRecord(out['envVar'])) out['env'] = out['envVar'];
  return out;
}

/** 逐条映射（含 serverUrl/envVar 归一化），失败条目由内核报码；一条都映射不出来时返回 null */
function serversFrom(
  entries: readonly (readonly [string, unknown])[],
  refs: string[],
  skipped: ForeignSkip[],
): McpServerEntry[] | null {
  const servers: McpServerEntry[] = [];
  for (const [name, raw] of entries) {
    const entry = mcpEntryOf(name, normalizeEntry(raw), skipped);
    if (entry !== null) servers.push(entry);
  }
  if (servers.length === 0) return null;
  return redactMcpSection({ version: 1, servers }, refs, skipped).servers;
}

export function convertAntigravity(input: AntigravityInput): ForeignImportResult {
  const skipped: ForeignSkip[] = [...(input.readFindings ?? [])];
  const sections: ForeignSectionOut[] = [];
  const credentialRefs: string[] = [];
  const counts: Record<string, number> = {};

  /* 两个位置都读、都映射；同名条目**先到先得**（全局在前），后者跳过并报码 */
  const servers: McpServerEntry[] = [];
  const seen = new Set<string>();
  let mergedSources = 0;
  const sources: { label: string; value: unknown }[] = [
    { label: 'config/mcp_config.json', value: input.globalMcp },
    { label: 'antigravity/mcp_config.json', value: input.ideMcp },
  ];
  for (const src of sources) {
    if (src.value === undefined) continue;
    const key = firstContainerKey(src.value);
    if (key === undefined) {
      // 形态对不上（如顶层结构完全不是映射）→ 如实报码，绝不静默少一片
      skipped.push({ code: 'mcp-server-empty', origin: src.label, detail: 'no-servers-container' });
      continue;
    }
    mergedSources++;
    const part = serversFrom(entriesOf(src.value, key), credentialRefs, skipped);
    if (part === null) continue;
    for (const s of part) {
      if (seen.has(s.serverName)) {
        skipped.push({ code: 'mcp-server-empty', origin: s.serverName, detail: 'duplicate-across-configs' });
        continue;
      }
      seen.add(s.serverName);
      servers.push(s);
    }
  }
  if (mergedSources > 1 && servers.length > 0) {
    skipped.push({ code: 'instructions-merged', origin: 'mcp_config.json', count: mergedSources });
  }
  if (servers.length > 0) {
    const section: McpSection = { version: 1, servers };
    sections.push({ sectionId: 'mcp', data: section });
    counts['mcp.servers'] = servers.length;
  }

  /* 凭据文件：只报告（值连内存都不进）。导入后由用户在 DSH 里自行补录。 */
  if (input.oauthTokensPresent === true) {
    skipped.push({ code: 'credentials-not-migrated', origin: 'antigravity/mcp_oauth_tokens.json', count: 1 });
  }

  return { source: 'antigravity', sections, skipped, credentialRefs, counts };
}
