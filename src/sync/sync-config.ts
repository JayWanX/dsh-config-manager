/**
 * m-sync-ui：同步通道配置的持久化（sync-config.json，schemaVersion v2）。
 *
 * 与 sync-state.json 的分工：sync-state 记录「同步了哪些分区、何时同步」（t4 拥有），
 * 本文件只记录「上一次使用的同步通道配置」，供 UI 打开设置页时回填表单。
 *
 * schema v2（统一接口契约，captain 冻结）：
 * - 顶层形状：
 *     { "schemaVersion": 2, "transport": "git"|"webdav",
 *       "git":    { "repoUrl": "..." },   // transport=git 时
 *       "webdav": { "url": "...", "username": "..." } }    // transport=webdav 时
 * - 顶层 transport 选择 + git/webdav 命名空间对象（嵌套，非扁平，避免歧义）。
 *   git 命名空间不再含 gitBin（git 可执行文件固定使用系统 PATH 中的 git）。
 * - webdav.url 不含任何凭据、拒绝 userinfo；username 可回显；
 *   password 绝不入文件（走 DSH credentials ref `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`）。
 * - 代码内为可辨识联合 SyncConfig + isGitConfig()/isWebDavConfig() 守卫。
 * - 兼容旧 v1 文件（{schemaVersion:1, repoUrl, gitBin?} 或缺 schemaVersion 视为 v1）
 *   → 读取时归一为 v2 git 形态（旧 gitBin 字段被忽略/下一次保存时丢弃）。
 *
 * 安全不变量：
 * - 配置文件绝不出现密码/token（webdav 仅存 url/可选 username；口令走 DSH credentials）。
 * - url 校验：拒绝空白、非 http(s)、含 userinfo（username:password@）——仿 validateRepoUrl。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const SYNC_CONFIG_FILE = 'sync-config.json';

/**
 * 同步通道枚举（**唯一声明处**，t32）：所有「有哪些通道 / 通道列表 / 通道判定」的唯一事实源。
 *
 * 为什么要单一来源：此前 SyncTransportType 在 sync-config / ui-prefs / client sync-api /
 * client sync-view 各自声明一遍，通道数组也在 autosync-scheduler 里写了两遍 ——「改一处漏一处」
 * 的表现是某个通道**静默**不再排期 / 不再落盘，而不是报错。新增通道只改这里：typecheck 会在
 * 所有 Record<SyncTransportType, X> 的构造处与穷尽检查处报错。
 */
export const SYNC_CHANNELS = ['git', 'webdav'] as const;

/** 同步通道类型（由 SYNC_CHANNELS 派生；host 侧与 client 半统一引用）。 */
export type SyncTransportType = (typeof SYNC_CHANNELS)[number];

/** 通道值守卫（用于请求体 / localStorage / 磁盘 JSON 的原始输入校验）。 */
export function isSyncTransportType(value: unknown): value is SyncTransportType {
  return typeof value === 'string' && (SYNC_CHANNELS as readonly string[]).includes(value);
}

/** 严格解析通道值：非法/缺失 → undefined（缺省由调用方决定，**不在此静默兜底成 git**）。 */
export function parseSyncChannel(value: unknown): SyncTransportType | undefined {
  return isSyncTransportType(value) ? value : undefined;
}

/**
 * 配置 → 通道：**唯一判定口径**（替代散落的 `isWebDavConfig(cfg) ? 'webdav' : 'git'`）。
 * SyncConfig 是可辨识联合，transport 字段本身就是通道，无需先过守卫再分支。
 */
export function channelOf(cfg: SyncConfig): SyncTransportType {
  return cfg.transport;
}

/**
 * `Record<SyncTransportType, T>` 的统一构造器：遍历 SYNC_CHANNELS 生成。新增通道时无需
 * 在每处穷举字面量（漏写的表现曾是「该通道的配置永远读不到 / 写不回」，静默且难查）。
 */
export function channelMap<T>(make: (channel: SyncTransportType) => T): Record<SyncTransportType, T> {
  const out = {} as Record<SyncTransportType, T>;
  for (const channel of SYNC_CHANNELS) out[channel] = make(channel);
  return out;
}

/** 当前 sync-config.json schema 版本号（v3：双命名空间共存，切换通道不丢失另一通道配置）。 */
export const SYNC_CONFIG_SCHEMA_VERSION = 3;
/** 历史可读取版本：v1、v2、v3。 */
export const SYNC_CONFIG_SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3];

/** git 通道配置（不含任何凭据；git 可执行文件固定使用系统 PATH 中的 git） */
export interface GitConfig {
  repoUrl: string;
}

/** webdav 通道配置（不含 password；password 走 DSH credentials） */
export interface WebDavConfig {
  /** WebDAV 端点地址（不含凭据；拒绝 userinfo） */
  url: string;
  /** 可选用户名（可回显） */
  username?: string;
}

/**
 * 完整双命名空间配置视图（v3 文件直接读取，供 status 路由回填另一通道的 repoUrl/url）。
 * 与可辨识联合 SyncConfig 不同：git 和 webdav 命名空间同时存在，可能缺失。
 */
export interface FullSyncConfig {
  transport: SyncTransportType;
  git?: GitConfig;
  webdav?: WebDavConfig;
}

/** 持久化的同步通道配置：可辨识联合（schemaVersion 恒 2） */
export type SyncConfig =
  | { schemaVersion: 2; transport: 'git'; git: GitConfig }
  | { schemaVersion: 2; transport: 'webdav'; webdav: WebDavConfig };

/** git 通道守卫 */
export function isGitConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'git' }> {
  return cfg.transport === 'git';
}

/** webdav 通道守卫 */
export function isWebDavConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'webdav' }> {
  return cfg.transport === 'webdav';
}

/** 从 v1 扁平形态解析 git 配置；缺 repoUrl → null（gitBin 已废弃：始终使用系统 PATH 中的 git） */
function parseV1Git(obj: Record<string, unknown>): GitConfig | null {
  if (typeof obj['repoUrl'] !== 'string' || obj['repoUrl'] === '') return null;
  return { repoUrl: obj['repoUrl'] };
}

/** 从 v2 git 命名空间解析；缺有效 repoUrl → null */
function parseV2GitNamespace(ns: unknown): GitConfig | null {
  if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) return null;
  return parseV1Git(ns as Record<string, unknown>);
}

/** 从 v2 webdav 命名空间解析；缺有效 url → null */
function parseV2WebDavNamespace(ns: unknown): WebDavConfig | null {
  if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) return null;
  const o = ns as Record<string, unknown>;
  if (typeof o['url'] !== 'string' || o['url'] === '') return null;
  const webdav: WebDavConfig = { url: o['url'] };
  if (typeof o['username'] === 'string' && o['username'] !== '') webdav.username = o['username'];
  return webdav;
}

/**
 * 读取同步通道配置；文件不存在/损坏/不支持 schema → null（视为未配置，UI 显示空表单）。
 * 兼容旧文件：缺 schemaVersion 字段视为 v1（git 通道）。
 * 恒返回 schemaVersion=2 的规范形态（v1 读取时归一为 git）。
 */
export async function readSyncConfig(dir: string): Promise<SyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    // 损坏 JSON / 体积超限 / 嵌套过深 → 视为未配置（不抛错）
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // schemaVersion：缺省视为 v1（兼容旧文件）；非缺省但不在支持列表 → 拒绝
  if (obj['schemaVersion'] !== undefined && typeof obj['schemaVersion'] !== 'number') {
    return null;
  }
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (!SYNC_CONFIG_SUPPORTED_VERSIONS.includes(ver)) return null;

  if (ver === 1) {
    const git = parseV1Git(obj);
    if (git === null) return null;
    return { schemaVersion: 2, transport: 'git', git };
  }

  // v2 / v3：顶层 transport 选择（v3 双命名空间并存，按 transport 返回对应通道）
  const transport = obj['transport'];
  // 通道合法性只认唯一枚举（SYNC_CHANNELS）：新增通道无需在此补字面量
  if (!isSyncTransportType(transport)) return null;
  if (transport === 'git') {
    const git = parseV2GitNamespace(obj['git']);
    if (git === null) return null;
    return { schemaVersion: 2, transport: 'git', git };
  }
  const webdav = parseV2WebDavNamespace(obj['webdav']);
  if (webdav === null) return null;
  return { schemaVersion: 2, transport: 'webdav', webdav };
}

/**
 * 读取 sync-config.json 原始内容，提取 git/webdav 两个命名空间（不存在/无效 → undefined）。
 * 供 writeSyncConfig 合并保留另一通道配置用：切换通道保存时不得丢弃另一通道的 repoUrl/url。
 */
function readBothNamespaces(file: string): Promise<{ git?: GitConfig; webdav?: WebDavConfig }> {
  return (async () => {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return {} // 文件不存在：无历史配置
    }
    let parsed: unknown
    try {
      parsed = parseJsonSafe(raw)
    } catch {
      return {} // 损坏 JSON：按无历史配置处理（不阻塞保存）
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const o = parsed as Record<string, unknown>
    const out: { git?: GitConfig; webdav?: WebDavConfig } = {}
    const git = parseV2GitNamespace(o['git'])
    if (git !== null) out.git = git
    const webdav = parseV2WebDavNamespace(o['webdav'])
    if (webdav !== null) out.webdav = webdav
    // v1 旧文件（无命名空间）：git 读扁平 repoUrl
    if (out.git === undefined && out.webdav === undefined) {
      const v1 = parseV1Git(o)
      if (v1 !== null) out.git = v1
    }
    return out
  })()
}

/**
 * 读取完整的双命名空间配置（供 status 路由回填另一通道的 repoUrl/url）。
 * 文件不存在/损坏/无任何通道配置 → null（视为未配置）。
 */
export async function readFullSyncConfig(dir: string): Promise<FullSyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const both = await readBothNamespaces(file)
  if (both.git === undefined && both.webdav === undefined) return null
  // 从原始文件读取当前活动 transport 字段
  let transport: SyncTransportType = 'git'
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = parseJsonSafe(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      // 与 parseSyncBody 同口径：只接受已知通道值，其它一律保持缺省 git
      const parsedChannel = parseSyncChannel(o['transport'])
      if (parsedChannel !== undefined) transport = parsedChannel
    }
  } catch { /* 默认 git */ }
  return { transport, git: both.git, webdav: both.webdav }
}

/**
 * 读取指定通道的同步通道配置（供自动同步调度器按通道运行）。
 * 从完整双命名空间配置取对应通道构造可辨识联合 SyncConfig；该通道未配置 → null。
 */
export async function readSyncConfigFor(dir: string, channel: SyncTransportType): Promise<SyncConfig | null> {
  const full = await readFullSyncConfig(dir);
  if (full === null) return null;
  if (channel === 'webdav') {
    if (full.webdav === undefined) return null;
    return { schemaVersion: 2, transport: 'webdav', webdav: full.webdav };
  }
  if (full.git === undefined) return null;
  return { schemaVersion: 2, transport: 'git', git: full.git };
}

/**
 * 保存同步通道配置（自动创建目录；恒写 schemaVersion=3 双命名空间）。
 * - 写入当前通道的命名空间（git/webdav）；
 * - 另一通道之前配置过 → 一并保留（切换通道不丢失另一通道的 repoUrl/url）；
 * - 覆盖旧值；未配置过的字段不写入。
 */
export async function writeSyncConfig(dir: string, cfg: SyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const existing = await readBothNamespaces(file)
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_CONFIG_SCHEMA_VERSION,
    transport: cfg.transport,
  }
  if (isGitConfig(cfg)) {
    payload.git = cfg.git
    // 保留另一通道的 webdav 配置（存在时）
    if (existing.webdav !== undefined) payload.webdav = existing.webdav
  } else {
    payload.webdav = cfg.webdav
    // 保留另一通道的 git 配置（存在时）
    if (existing.git !== undefined) payload.git = existing.git
  }
  await atomicWriteFile(file, stringifyJsonSafe(payload, { space: 2 }), { mode: 0o600 });
}

/** 断开单条通道配置的结果（供路由层决定凭据/自动同步/UI 偏好怎么收尾）。 */
export interface ClearSyncChannelResult {
  /** 该通道之前是否有配置；false = 本来就没配（幂等成功，不算失败） */
  removed: boolean;
  /** 是否仍有另一条通道的配置（false = 已无任何通道，configured 应回落为 false） */
  hasRemaining: boolean;
  /** 清除后的活动通道（无剩余时为被清除的通道，仅作占位） */
  transport: SyncTransportType;
}

/**
 * 从 sync-config.json 删除指定通道的命名空间（另一通道的配置原样保留）。
 *
 * 为什么必须有（用户实测）：通道一旦配置过就没有出口 —— 一条打不通的 WebDAV 通道会永久占位，
 * 产物库的远端源与自动同步只能一直报读取失败，用户无从自救。
 *
 * 三条语义：
 *  - 该通道本来没配置 → 幂等成功（removed=false），**不写文件**；
 *  - 删完还剩另一条 → 重写文件；活动 transport 若指向被删通道则自动切到剩下的那条
 *    （否则 readSyncConfig 会返回 null，那条**配置过**的通道反而被显示成「未配置」）；
 *  - 删完一条不剩 → **删除整个文件**（configured 如实回落 false），而不是留一份空配置。
 *
 * 凭据（token / WebDAV 口令 / 该通道的加密解密密码）与自动同步开关**不在本函数职责内** ——
 * 它们分别住在 DSH credentials 与 autosync.json，由路由层显式清除（本模块只碰 sync-config.json）。
 */
export async function clearSyncChannel(dir: string, channel: SyncTransportType): Promise<ClearSyncChannelResult> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  const both = await readBothNamespaces(file);
  const other: SyncTransportType = channel === 'git' ? 'webdav' : 'git';
  const removed = channel === 'git' ? both.git !== undefined : both.webdav !== undefined;
  const otherCfg = other === 'git' ? both.git : both.webdav;

  if (otherCfg === undefined) {
    // 没有另一条通道 → 文件不再代表任何配置：删掉它（readFullSyncConfig 回落 null）
    if (removed) await fs.rm(file, { force: true });
    return { removed, hasRemaining: false, transport: channel };
  }

  // 读当前活动通道（与 readFullSyncConfig 同口径）；它指向被删通道时切到剩下的那条
  let current: SyncTransportType = 'git';
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseJsonSafe(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parseSyncChannel((parsed as Record<string, unknown>)['transport']) ?? 'git';
    }
  } catch { /* 读不到 → 缺省 git（与 readFullSyncConfig 一致） */ }
  const transport: SyncTransportType = current === channel ? other : current;

  const payload: Record<string, unknown> = { schemaVersion: SYNC_CONFIG_SCHEMA_VERSION, transport };
  if (other === 'git') payload.git = otherCfg;
  else payload.webdav = otherCfg;
  await atomicWriteFile(file, stringifyJsonSafe(payload, { space: 2 }), { mode: 0o600 });
  return { removed, hasRemaining: true, transport };
}

/**
 * 仓库地址合法性校验（返回错误消息；null = 合法）。
 * 安全约束：token 永不拼入 repoUrl —— http(s) 地址带 userinfo（username[:password]@）直接拒绝，
 * 引导用户把 token 放凭据字段（DSH credentials），避免 token 经 URL 泄漏进 git 历史/日志。
 */
export function validateRepoUrl(repoUrl: string, msg: MsgFunc = zhMsg): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return 'repoUrl is required';
  }
  const url = repoUrl.trim();
  if (/\s/.test(url)) {
    return msg('sync.configWhitespace');
  }
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return msg('sync.configUnparseable', { url });
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return msg('sync.configUserinfo');
    }
  }
  return null;
}

/**
 * WebDAV 端点地址合法性校验（返回错误消息；null = 合法）。
 * 安全约束：口令/密码永不拼入 url —— 仅接受 http(s)，且拒绝带 userinfo
 * （username[:password]@）的地址，引导用户把口令放 DSH credentials，避免凭据经 URL 泄漏进出入口/日志。
 */
export function validateWebDavUrl(url: string, msg: MsgFunc = zhMsg): string | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return 'url is required';
  }
  const cleaned = url.trim();
  if (/\s/.test(cleaned)) {
    return msg('sync.configWhitespace');
  }
  if (!/^https?:\/\//i.test(cleaned)) {
    return msg('sync.configUnparseable', { url: cleaned });
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return msg('sync.configUnparseable', { url: cleaned });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return msg('sync.configUserinfo');
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * 批次3 Q2：云端点通道配置（s3 兼容系五家 + gist）
 *
 * 为什么单独一份文件（而不是塞进 sync-config.json 的 git/webdav 命名空间）：git/webdav 的通道枚举
 * \`SYNC_CHANNELS\` 是**全仓唯一的通道事实源**，被 \`Record<SyncTransportType, T>\` 的构造处、自动同步
 * 调度器、客户端镜像与 4 处源码级守卫消费；批次3 的写作用域不含那些文件，因此新增通道**不得**
 * 扩 \`SYNC_CHANNELS\`（否则 typecheck 会在他人 in-flight 文件上炸）。云端点通道自带枚举与文件，
 * 与 git/webdav 完全解耦，将来并入 \`SYNC_CHANNELS\` 时只需删掉这里的枚举并补 Record 分支。
 *
 * 照竞品 \`@dickpy/dsh-cloud-sync\` 的 \`savedProviders\` 模式：**按通道分别保存**
 * endpoint/region/bucket/前缀/gistId 等非密字段，切换回某个通道时能自动回填。
 *
 * 密钥纪律（硬约束，不得放宽）：
 *  - 文件里**只有非密字段** + \`secretStored: true\` 标记；AccessKey Secret / Gist Token 的**值**
 *    永远只在 DSH credentials 槽位（\`cloudSecretRef()\`），由宿主经 \`CloudSecretWriter\` 写入；
 *  - 回传 UI 的是 \`CloudChannelView\`（**只带标记、不带值**），读侧即使遇到手写进文件的
 *    secret/token 字段也一律**丢弃**（绝不回读、绝不回传）。
 * ---------------------------------------------------------------------------------------------- */

/** 云端点通道配置文件名（与 sync-config.json 并列，互不影响）。 */
export const CLOUD_SYNC_CONFIG_FILE = 'sync-cloud-config.json';
/** 云端点配置 schema 版本。 */
export const CLOUD_SYNC_CONFIG_SCHEMA_VERSION = 1;
/**
 * S3 兼容系通道枚举（**唯一声明处**）：五家共用同一份 SigV4 实现，
 * 差异只有 endpoint / region / 寻址风格 / 签名方言（见 \`src/sync/s3/s3-providers.ts\` 的变体表）。
 */
export const S3_COMPAT_PROVIDERS = ['s3', 'oss', 'cos', 'minio', 'kodo'] as const;
/** S3 兼容系通道类型 */
export type S3CompatProvider = (typeof S3_COMPAT_PROVIDERS)[number];
/** 非 S3 系的云端点通道（GitHub Gist，走 REST） */
export const GIST_PROVIDER = 'gist' as const;
/** Gist 通道类型 */
export type GistProvider = typeof GIST_PROVIDER;
/** 云端点通道枚举（S3 兼容系 ×5 + gist） */
export const CLOUD_SYNC_PROVIDERS = [...S3_COMPAT_PROVIDERS, GIST_PROVIDER] as const;
/** 云端点通道类型 */
export type CloudSyncProvider = (typeof CLOUD_SYNC_PROVIDERS)[number];

/** 通道值守卫（请求体 / 磁盘 JSON 的原始输入校验）。 */
export function isCloudSyncProvider(value: unknown): value is CloudSyncProvider {
  return typeof value === 'string' && (CLOUD_SYNC_PROVIDERS as readonly string[]).includes(value);
}

/** 是否 S3 兼容系通道。 */
export function isS3CompatProvider(value: unknown): value is S3CompatProvider {
  return typeof value === 'string' && (S3_COMPAT_PROVIDERS as readonly string[]).includes(value);
}

/** 是否 Gist 通道。 */
export function isGistProvider(value: unknown): value is GistProvider {
  return value === GIST_PROVIDER;
}

/**
 * 密钥槽位引用（值只写不回读）。
 * 命名与既有 \`syncPasswordRef\` 同族：\`DSH_CONFIG_MANAGER_SYNC_<CHANNEL>_<KIND>\`。
 */
const CLOUD_SECRET_REFS: Record<CloudSyncProvider, string> = {
  s3: 'DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY',
  oss: 'DSH_CONFIG_MANAGER_SYNC_OSS_SECRET_ACCESS_KEY',
  cos: 'DSH_CONFIG_MANAGER_SYNC_COS_SECRET_ACCESS_KEY',
  minio: 'DSH_CONFIG_MANAGER_SYNC_MINIO_SECRET_ACCESS_KEY',
  kodo: 'DSH_CONFIG_MANAGER_SYNC_KODO_SECRET_ACCESS_KEY',
  gist: 'DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN',
};

/** 取某云端点通道的密钥槽位引用（不涉及任何值）。 */
export function cloudSecretRef(provider: CloudSyncProvider): string {
  return CLOUD_SECRET_REFS[provider];
}

/**
 * 密钥**只写**端口：故意不提供 get()——宿主只能写、只能问「有没有」，
 * 通道实现与 UI 都不可能把值回读出来（这是「只写不回读」的结构性保证，不靠纪律）。
 */
export interface CloudSecretWriter {
  /** 写入密钥值（仅内存传递；不落盘、不进日志、不回传） */
  set(ref: string, value: string): Promise<void>;
  /** 只问「该槽位有没有值」（绝不返回值本身） */
  has(ref: string): Promise<boolean>;
}

/** S3 兼容系通道的非密配置（值里绝不含 AccessKey Secret）。 */
export interface CloudS3ChannelConfig {
  /** 对象存储端点（http(s)，不含凭据、不含桶名；如 https://s3.us-east-1.amazonaws.com） */
  endpoint: string;
  /** V4 签名作用域里的 region（如 us-east-1 / cn-hangzhou / ap-guangzhou） */
  region: string;
  /** 桶名 */
  bucket: string;
  /** 对象键前缀（缺省 dsh-config-manager） */
  prefix?: string;
  /** AccessKey ID（标识符，可回显；**不是**密钥） */
  accessKeyId: string;
  /** path-style 寻址开关（缺省取变体默认：MinIO true，其余 false） */
  pathStyle?: boolean;
  /** 密钥是否已在 DSH credentials 里（**只回标记，不回值**） */
  secretStored?: boolean;
}

/** Gist 通道的非密配置（值里绝不含 token）。 */
export interface CloudGistChannelConfig {
  /** 目标 gist id（十六进制串） */
  gistId: string;
  /** GitHub API 根（缺省 https://api.github.com；GitHub Enterprise 可改） */
  apiBaseUrl?: string;
  /** gist 内文件名前缀（缺省 dsh-sync） */
  filePrefix?: string;
  /** token 是否已在 DSH credentials 里（**只回标记，不回值**） */
  secretStored?: boolean;
}

/** 按通道分别保存的非密配置（照 cloud-sync 的 savedProviders 模式）。 */
export interface CloudSavedProviders {
  s3?: CloudS3ChannelConfig;
  oss?: CloudS3ChannelConfig;
  cos?: CloudS3ChannelConfig;
  minio?: CloudS3ChannelConfig;
  kodo?: CloudS3ChannelConfig;
  gist?: CloudGistChannelConfig;
}

/** 磁盘上的云端点配置（读侧恒归一为该形态；损坏/不支持的版本 → null）。 */
export interface CloudSyncConfig {
  schemaVersion: number;
  savedProviders: CloudSavedProviders;
}

/** 某通道读出来的配置（按 provider 收窄的联合）。 */
export type CloudChannelConfig =
  | { provider: S3CompatProvider; config: CloudS3ChannelConfig }
  | { provider: GistProvider; config: CloudGistChannelConfig };

/** S3 兼容系通道的回传视图：**只带 secretStored 标记，绝不带密钥值**。 */
export interface CloudS3ChannelView {
  provider: S3CompatProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
  /** 密钥已在 credentials 里（只回布尔） */
  secretStored: boolean;
}

/** Gist 通道的回传视图：**只带 secretStored 标记，绝不带 token 值**。 */
export interface CloudGistChannelView {
  provider: GistProvider;
  gistId: string;
  apiBaseUrl: string;
  filePrefix: string;
  secretStored: boolean;
}

/** 回传 UI 的通道视图（按 provider 收窄的联合） */
export type CloudChannelView = CloudS3ChannelView | CloudGistChannelView;

/** 写入入参（表单原样；字段按 provider 各自校验）。 */
export interface CloudChannelWriteInput {
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  pathStyle?: boolean;
  gistId?: string;
  apiBaseUrl?: string;
  filePrefix?: string;
  /** 明文密钥：**只写**（提供即写入 credentials）；缺省 = 只更新非密字段，已有密钥不动 */
  secret?: string;
}

/**
 * 云端点配置的**稳定错误码**（不是用户文案）。
 * 与 \`validateRepoUrl\` 返回 \`'repoUrl is required'\` 同口径：码由路由/UI 层映射进字典，
 * 因此本模块不产生任何用户可见字符串。
 */
export type CloudConfigIssueCode =
  | 'cloud.providerUnknown'
  | 'cloud.endpointRequired'
  | 'cloud.endpointInvalid'
  | 'cloud.endpointUserinfo'
  | 'cloud.regionRequired'
  | 'cloud.bucketRequired'
  | 'cloud.bucketInvalid'
  | 'cloud.prefixInvalid'
  | 'cloud.accessKeyIdRequired'
  | 'cloud.gistIdRequired'
  | 'cloud.gistIdInvalid'
  | 'cloud.apiBaseUrlInvalid'
  | 'cloud.secretWriterRequired';

/** 配置校验失败：携带稳定错误码（无用户文案），由上层映射成字典键。 */
export class CloudConfigError extends Error {
  readonly code: CloudConfigIssueCode;
  constructor(code: CloudConfigIssueCode, detail?: string) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'CloudConfigError';
    this.code = code;
  }
}

/** 桶名：3-63 位小写字母/数字/点/连字符，首尾为字母或数字（与 S3 命名规则同口径）。 */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** gist id：GitHub 的十六进制串 */
const GIST_ID_RE = /^[0-9a-f]{5,64}$/i;

/** 端点校验（http(s)、无 userinfo、无 query/hash）；返回错误码或 null。 */
export function validateCloudEndpoint(endpoint: string): CloudConfigIssueCode | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return 'cloud.endpointRequired';
  const raw = endpoint.trim();
  if (/\s/.test(raw)) return 'cloud.endpointInvalid';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'cloud.endpointInvalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cloud.endpointInvalid';
  if (parsed.username !== '' || parsed.password !== '') return 'cloud.endpointUserinfo';
  if (parsed.search !== '' || parsed.hash !== '') return 'cloud.endpointInvalid';
  return null;
}

/** region 校验：非空、无空白。 */
export function validateCloudRegion(region: string): CloudConfigIssueCode | null {
  if (typeof region !== 'string' || region.trim() === '' || /\s/.test(region.trim())) return 'cloud.regionRequired';
  return null;
}

/** 桶名校验。 */
export function validateCloudBucket(bucket: string): CloudConfigIssueCode | null {
  if (typeof bucket !== 'string' || bucket.trim() === '') return 'cloud.bucketRequired';
  const b = bucket.trim();
  if (!BUCKET_NAME_RE.test(b) || b.includes('..')) return 'cloud.bucketInvalid';
  return null;
}

/** 对象键前缀校验（可缺省 = 根前缀；不得以 / 开头、不得含 .. / 反斜杠 / 空段）。 */
export function validateCloudPrefix(prefix: string): CloudConfigIssueCode | null {
  if (typeof prefix !== 'string') return 'cloud.prefixInvalid';
  // 首尾斜杠先归一（与 `normalizeObjectPrefix` 同口径）：用户从控制台复制粘贴的
  // 前缀常带 /，那是书写噪声而不是错误 —— 归一后才判定真正的非法形态。
  const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '') return null;
  if (p.includes('\\') || p.includes('//') || p.includes('..')) return 'cloud.prefixInvalid';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'cloud.prefixInvalid';
  return null;
}

/** gist id 校验。 */
export function validateGistId(gistId: string): CloudConfigIssueCode | null {
  if (typeof gistId !== 'string' || gistId.trim() === '') return 'cloud.gistIdRequired';
  if (!GIST_ID_RE.test(gistId.trim())) return 'cloud.gistIdInvalid';
  return null;
}

/** GitHub API 根校验（http(s)、无 userinfo）。 */
export function validateCloudApiBaseUrl(url: string): CloudConfigIssueCode | null {
  if (typeof url !== 'string' || url.trim() === '') return 'cloud.apiBaseUrlInvalid';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'cloud.apiBaseUrlInvalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cloud.apiBaseUrlInvalid';
  if (parsed.username !== '' || parsed.password !== '') return 'cloud.apiBaseUrlInvalid';
  return null;
}

/** 按通道校验写入入参；返回首个错误码或 null。 */
export function validateCloudChannelInput(
  provider: CloudSyncProvider,
  input: CloudChannelWriteInput,
): CloudConfigIssueCode | null {
  if (!isCloudSyncProvider(provider)) return 'cloud.providerUnknown';
  if (isGistProvider(provider)) {
    const bad = validateGistId(input.gistId ?? '');
    if (bad !== null) return bad;
    if (input.apiBaseUrl !== undefined && input.apiBaseUrl.trim() !== '') {
      const apiBad = validateCloudApiBaseUrl(input.apiBaseUrl);
      if (apiBad !== null) return apiBad;
    }
    if (input.filePrefix !== undefined && validateCloudPrefix(input.filePrefix) !== null) return 'cloud.prefixInvalid';
    return null;
  }
  const checks: Array<CloudConfigIssueCode | null> = [
    validateCloudEndpoint(input.endpoint ?? ''),
    validateCloudRegion(input.region ?? ''),
    validateCloudBucket(input.bucket ?? ''),
    typeof input.accessKeyId === 'string' && input.accessKeyId.trim() !== '' ? null : 'cloud.accessKeyIdRequired',
  ];
  for (const c of checks) if (c !== null) return c;
  if (input.prefix !== undefined && validateCloudPrefix(input.prefix) !== null) return 'cloud.prefixInvalid';
  return null;
}

/** 解析 S3 通道的非密字段；必填字段缺失/非法 → null（视为未配置）。 */
function parseS3Channel(raw: unknown): CloudS3ChannelConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const endpoint = typeof o['endpoint'] === 'string' ? o['endpoint'] : '';
  const region = typeof o['region'] === 'string' ? o['region'] : '';
  const bucket = typeof o['bucket'] === 'string' ? o['bucket'] : '';
  const accessKeyId = typeof o['accessKeyId'] === 'string' ? o['accessKeyId'] : '';
  if (validateCloudEndpoint(endpoint) !== null || region === '' || bucket === '' || accessKeyId === '') return null;
  const cfg: CloudS3ChannelConfig = { endpoint: endpoint.trim(), region: region.trim(), bucket: bucket.trim(), accessKeyId: accessKeyId.trim() };
  if (typeof o['prefix'] === 'string' && o['prefix'].trim() !== '') cfg.prefix = o['prefix'].trim();
  if (typeof o['pathStyle'] === 'boolean') cfg.pathStyle = o['pathStyle'];
  if (o['secretStored'] === true) cfg.secretStored = true;
  // 注意：raw 里若混进 secretAccessKey/token 之类的键，这里**整体忽略**（读侧绝不回读密钥）
  return cfg;
}

/** 解析 Gist 通道的非密字段；非法 → null。 */
function parseGistChannel(raw: unknown): CloudGistChannelConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const gistId = typeof o['gistId'] === 'string' ? o['gistId'] : '';
  if (validateGistId(gistId) !== null) return null;
  const cfg: CloudGistChannelConfig = { gistId: gistId.trim() };
  if (typeof o['apiBaseUrl'] === 'string' && o['apiBaseUrl'].trim() !== '') cfg.apiBaseUrl = o['apiBaseUrl'].trim();
  if (typeof o['filePrefix'] === 'string' && o['filePrefix'].trim() !== '') cfg.filePrefix = o['filePrefix'].trim();
  if (o['secretStored'] === true) cfg.secretStored = true;
  return cfg;
}

/** 从原始 JSON 对象解析 savedProviders（只取白名单字段；任何密钥字段一律丢弃）。 */
function parseCloudSavedProviders(raw: unknown): CloudSavedProviders {
  const out: CloudSavedProviders = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const provider of S3_COMPAT_PROVIDERS) {
    const cfg = parseS3Channel(o[provider]);
    if (cfg !== null) out[provider] = cfg;
  }
  const gist = parseGistChannel(o[GIST_PROVIDER]);
  if (gist !== null) out.gist = gist;
  return out;
}

/**
 * 读取云端点配置；文件不存在/损坏/schema 不支持 → null（视为未配置）。
 * **绝不回读密钥值**：只认非密白名单字段 + \`secretStored\` 标记。
 */
export async function readCloudSyncConfig(dir: string): Promise<CloudSyncConfig | null> {
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const version = typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : CLOUD_SYNC_CONFIG_SCHEMA_VERSION;
  if (version !== CLOUD_SYNC_CONFIG_SCHEMA_VERSION) return null;
  return { schemaVersion: version, savedProviders: parseCloudSavedProviders(o['savedProviders']) };
}

/** 读取单条云端点通道的配置；该通道未配置/非法 → null。 */
export async function readCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
): Promise<CloudChannelConfig | null> {
  const all = await readCloudSyncConfig(dir);
  if (all === null) return null;
  if (isGistProvider(provider)) {
    const gist = all.savedProviders.gist;
    return gist === undefined ? null : { provider: 'gist', config: gist };
  }
  const cfg = all.savedProviders[provider];
  return cfg === undefined ? null : { provider, config: cfg };
}

/** 已配置的云端点通道清单（供 UI 回填 / 断开时判断是否还剩别的通道）。 */
export async function listCloudConfiguredProviders(dir: string): Promise<CloudSyncProvider[]> {
  const all = await readCloudSyncConfig(dir);
  if (all === null) return [];
  const out: CloudSyncProvider[] = [];
  for (const provider of CLOUD_SYNC_PROVIDERS) {
    const has = provider === GIST_PROVIDER
      ? all.savedProviders.gist !== undefined
      : all.savedProviders[provider] !== undefined;
    if (has) out.push(provider);
  }
  return out;
}

/** 组装 S3 兼容系回传视图（**只带标记、不带值**）。 */
export function s3ChannelView(
  provider: S3CompatProvider,
  config: CloudS3ChannelConfig,
  secretStored: boolean,
): CloudS3ChannelView {
  return {
    provider,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix ?? 'dsh-config-manager',
    accessKeyId: config.accessKeyId,
    pathStyle: config.pathStyle ?? false,
    secretStored,
  };
}

/** 组装 Gist 回传视图（**只带标记、不带值**）。 */
export function gistChannelView(
  config: CloudGistChannelConfig,
  secretStored: boolean,
): CloudGistChannelView {
  return {
    provider: 'gist',
    gistId: config.gistId,
    apiBaseUrl: config.apiBaseUrl ?? 'https://api.github.com',
    filePrefix: config.filePrefix ?? 'dsh-sync',
    secretStored,
  };
}

/** 组装回传视图（按 provider 分派到具名视图构造器）。 */
export function cloudChannelView(
  channel: CloudChannelConfig,
  secretStored: boolean,
): CloudChannelView {
  return channel.provider === 'gist'
    ? gistChannelView(channel.config, secretStored)
    : s3ChannelView(channel.provider, channel.config, secretStored);
}

/** 把某通道配置写进 savedProviders（显式穷举，新增通道时 typecheck 会报缺分支）。 */
function assignProvider(
  saved: CloudSavedProviders,
  provider: CloudSyncProvider,
  cfg: CloudS3ChannelConfig | CloudGistChannelConfig,
): CloudSavedProviders {
  const next: CloudSavedProviders = { ...saved };
  switch (provider) {
    case 's3':
    case 'oss':
    case 'cos':
    case 'minio':
    case 'kodo':
      next[provider] = cfg as CloudS3ChannelConfig;
      return next;
    case 'gist':
      next.gist = cfg as CloudGistChannelConfig;
      return next;
  }
}

/**
 * 保存某云端点通道的配置（自动创建目录；恒写 schemaVersion=1 的 savedProviders）。
 * - 只写当前通道的条目，其它通道原样保留（切换通道不丢失已填的 endpoint/bucket）；
 * - 密钥**只写**：提供 input.secret 时经注入的 \`CloudSecretWriter\` 写进 credentials 槽位，
 *   文件里只留 \`secretStored: true\`（值绝不落文件、绝不回传）；
 * - 未提供 secret 时只更新非密字段（已有密钥不动，标记按 \`has()\` 现算）。
 */
export async function writeCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
  input: CloudChannelWriteInput,
  secrets?: CloudSecretWriter,
): Promise<CloudChannelView> {
  const issue = validateCloudChannelInput(provider, input);
  if (issue !== null) throw new CloudConfigError(issue);
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  const existing = await readCloudSyncConfig(dir);
  const saved: CloudSavedProviders = existing === null ? {} : { ...existing.savedProviders };

  const secretValue = typeof input.secret === 'string' ? input.secret : '';
  const ref = cloudSecretRef(provider);
  let secretStored: boolean;
  if (secretValue !== '') {
    if (secrets === undefined) throw new CloudConfigError('cloud.secretWriterRequired');
    await secrets.set(ref, secretValue);
    secretStored = true;
  } else {
    // 绝不回读值：只能问「有没有」
    secretStored = secrets === undefined ? savedStoredFlag(saved, provider) : await secrets.has(ref);
  }

  let cfg: CloudS3ChannelConfig | CloudGistChannelConfig;
  if (isGistProvider(provider)) {
    cfg = {
      gistId: (input.gistId ?? '').trim(),
      ...(input.apiBaseUrl !== undefined && input.apiBaseUrl.trim() !== '' ? { apiBaseUrl: input.apiBaseUrl.trim() } : {}),
      ...(input.filePrefix !== undefined && input.filePrefix.trim() !== '' ? { filePrefix: normalizePrefix(input.filePrefix) } : {}),
      ...(secretStored ? { secretStored: true } : {}),
    };
  } else {
    cfg = {
      endpoint: (input.endpoint ?? '').trim().replace(/\/+$/, ''),
      region: (input.region ?? '').trim(),
      bucket: (input.bucket ?? '').trim(),
      ...(input.prefix !== undefined && input.prefix.trim() !== '' ? { prefix: normalizePrefix(input.prefix) } : {}),
      accessKeyId: (input.accessKeyId ?? '').trim(),
      ...(typeof input.pathStyle === 'boolean' ? { pathStyle: input.pathStyle } : {}),
      ...(secretStored ? { secretStored: true } : {}),
    };
  }
  const nextSaved = assignProvider(saved, provider, cfg);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    file,
    stringifyJsonSafe({ schemaVersion: CLOUD_SYNC_CONFIG_SCHEMA_VERSION, savedProviders: nextSaved }, { space: 2 }),
    { mode: 0o600 },
  );
  return isGistProvider(provider)
    ? gistChannelView(cfg as CloudGistChannelConfig, secretStored)
    : s3ChannelView(provider, cfg as CloudS3ChannelConfig, secretStored);
}

/** 前缀归一：去首尾斜杠（空 = 根前缀）。 */
function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 既有条目里的 secretStored 标记（无 writer 时的保守答案：只信磁盘上的标记）。 */
function savedStoredFlag(saved: CloudSavedProviders, provider: CloudSyncProvider): boolean {
  const cfg = provider === GIST_PROVIDER ? saved.gist : saved[provider];
  return cfg?.secretStored === true;
}

/**
 * 断开某云端点通道：删掉该通道的配置条目；一条不剩则删除整个文件。
 * 幂等：本来没配置 → removed=false 且**不写文件**。
 * 密钥槽位不在这里清除（凭据归凭据层），与 \`clearSyncChannel\` 同口径。
 */
export async function clearCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
): Promise<{ removed: boolean; hasRemaining: boolean }> {
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  const existing = await readCloudSyncConfig(dir);
  if (existing === null) return { removed: false, hasRemaining: false };
  const saved: CloudSavedProviders = { ...existing.savedProviders };
  const present = provider === GIST_PROVIDER ? saved.gist !== undefined : saved[provider] !== undefined;
  if (!present) return { removed: false, hasRemaining: Object.keys(saved).length > 0 };
  if (provider === GIST_PROVIDER) delete saved.gist;
  else delete saved[provider];
  const remaining = Object.keys(saved).length > 0;
  if (!remaining) {
    await fs.rm(file, { force: true });
    return { removed: true, hasRemaining: false };
  }
  await atomicWriteFile(
    file,
    stringifyJsonSafe({ schemaVersion: CLOUD_SYNC_CONFIG_SCHEMA_VERSION, savedProviders: saved }, { space: 2 }),
    { mode: 0o600 },
  );
  return { removed: true, hasRemaining: true };
}

