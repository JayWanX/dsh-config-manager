/**
 * cordis.patch.yml 的**两层身份**（issue #71）。
 *
 * DSH 启动时按固定顺序合并 patch 层（dsh-app-boot 的 readProfilePatches）：
 * profile 层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）在前，home 层
 * （`$DSH_HOME/cordis.patch.yml`）在后 —— **后者覆盖前者**，同名行以 home 层为准。
 *
 * 层身份 = **相对 homeDir 的 POSIX 路径**（与 core/backup.ts 的 HOST_FILE_CANDIDATES 同口径）：
 *   - 用户层：`cordis.patch.yml`
 *   - profile 层：`profiles/<profile>/cordis.patch.yml`
 *
 * 为什么用路径而不是枚举：PatchFileFacade 只有 `file: string` 一个参数（Phase 4 的
 * phase4-crash-child 只实现了 readPatchLines，给门面加方法会破坏它），而备份 / 快照 / 回滚
 * 需要跨进程、跨机器地记住「这一行原本在哪个文件里」。路径是唯一现成的稳定编码。
 *
 * 零第三方依赖（core 层铁律：不 import js-yaml / node:*）。
 */
import type { PatchFileFacade } from './types.ts';

/** 用户（home）patch 层：`$DSH_HOME/cordis.patch.yml`，相对 homeDir 的 POSIX 路径。 */
export const USER_PATCH_FILE = 'cordis.patch.yml';

/** profile patch 层文件名（与 dsh-app-boot 的 PROFILE_PATCH_FILENAME 一致）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';

/** profile 名缺省值（与 core/backup.ts 的 profileDirOf 同口径：宿主未暴露 profile 时按 web）。 */
export const DEFAULT_PROFILE = 'web';

/** profile patch 层相对 homeDir 的 POSIX 路径。 */
export function profilePatchRel(profile: string | undefined): string {
  const name = profile === undefined || profile === '' ? DEFAULT_PROFILE : profile;
  return `profiles/${name}/${PROFILE_PATCH_FILENAME}`;
}

/** 是否是 profile patch 层路径（`profiles/<name>/cordis.patch.yml`；名字不得含分隔符或 `..`）。 */
export function isProfilePatchRel(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  const matched = /^profiles\/([^/]+)\/cordis\.patch\.yml$/.exec(norm);
  if (matched === null) return false;
  const name = matched[1];
  return name !== undefined && name !== '' && name !== '.' && name !== '..';
}

/** 是否是任一 patch 层路径（用户层或 profile 层）。 */
export function isPatchLayerRel(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  return norm === USER_PATCH_FILE || isProfilePatchRel(norm);
}

/**
 * 合并序里的层清单，**优先级从高到低**（home 层在前，与 DSH 的实际合并顺序一致）。
 *
 * 恒返回两层：不存在的层读出来是空表（宿主门面把「文件不存在」当空文档），
 * 因此调用方无需先探测文件是否存在。
 */
export function patchLayerRels(profile: string | undefined): string[] {
  return [USER_PATCH_FILE, profilePatchRel(profile)];
}

/** 带层身份的一行 patch：`raw` 是行内容，`file` 是它所在层的相对路径。 */
export interface PatchLayerLine {
  file: string;
  lineId: string;
  raw: unknown;
}

export interface PatchLayerReadResult {
  /** 生效行：同名行只保留优先级最高的一层，按层优先级排序 */
  lines: PatchLayerLine[];
  /** 读失败的层（单层失败不阻塞其它层） */
  failures: { file: string; reason: string }[];
}

/**
 * 「新建行」的落点：把备份里记下的**来源层**映射到目标机上的同语义层（issue #71）。
 *
 * 为什么不照抄来源层的 profile 名：备份可能是在另一台机器 / 另一个 profile 上做的
 * （真机 `tauri`，目标机可能是 `web`），照抄会写到别的档案的 patch 文件上 —— 宿主门面
 * 会直接拒绝（`host.patchUnsupported`），导入整体失败。这里按语义映射：
 *   - 来源 = 用户层 → 用户层；
 *   - 来源 = 任一 profile 层 → **目标机当前 profile** 的 profile 层（保住「这行属于 profile 层」
 *     这一事实，而不是静默搬到用户层 —— 那会与 DSH 自己的写入者（plugin-manager / marketplace
 *     都写 profile 层）不一致）；
 *   - 缺省 / 不认识 → 用户层（旧备份包无该字段时的行为）。
 */
export function resolveWriteLayer(sourceFile: string | undefined, profile: string | undefined): string {
  if (sourceFile === undefined) return USER_PATCH_FILE;
  const norm = sourceFile.replace(/\\/g, '/');
  if (norm === USER_PATCH_FILE) return USER_PATCH_FILE;
  if (isProfilePatchRel(norm)) return profilePatchRel(profile);
  return USER_PATCH_FILE;
}

/**
 * 定位某个 patch 行**当前所在层**（写回时的落点，issue #71）。
 *
 * 规则：按层优先级从高到低找第一个含该行的层；两层都没有 → 用户层（保持旧行为：
 * 新建行写 home 层）。这样「更新已有行」不会因为猜错层而产生重复行（同一 lineId 在两层各一份）。
 */
export async function locatePatchLineLayer(
  patchFile: PatchFileFacade,
  profile: string | undefined,
  lineId: string,
): Promise<string> {
  for (const file of patchLayerRels(profile)) {
    let rows: { lineId: string; raw: unknown }[];
    try {
      rows = await patchFile.readPatchLines(file);
    } catch {
      continue;
    }
    if (rows.some((row) => row.lineId === lineId)) return file;
  }
  return USER_PATCH_FILE;
}

/**
 * 读**全部** patch 层并返回生效行（issue #71）。
 *
 * 为什么必须读两层：MCP / prompts / 插件激活行的真实所在层取决于写入者 —— DSH 自己的
 * 工具与 marketplace 写 profile 层，手写偏好常写 home 层。此前只读 home 层，于是 profile 层
 * 里的 MCP server 在备份里「凭空消失」（用户报告的「备份不到外壳 mcp / skills」）。
 *
 * 同名行按合并序取**优先级最高**的一层（home 覆盖 profile），与 DSH 启动后的实际生效值一致；
 * 每行都带 `file`，导入写回时据此落回原层。
 */
export async function readEffectivePatchLines(
  patchFile: PatchFileFacade,
  profile: string | undefined,
): Promise<PatchLayerReadResult> {
  const lines: PatchLayerLine[] = [];
  const failures: { file: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const file of patchLayerRels(profile)) {
    let rows: { lineId: string; raw: unknown }[];
    try {
      rows = await patchFile.readPatchLines(file);
    } catch (err) {
      failures.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const row of rows) {
      // 高优先级层已给出该行 → 低优先级层的同名行被覆盖（不导出被覆盖的旧值）
      if (seen.has(row.lineId)) continue;
      seen.add(row.lineId);
      lines.push({ file, lineId: row.lineId, raw: row.raw });
    }
  }
  return { lines, failures };
}
