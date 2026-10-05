/**
 * skills 分区 adapter（设计 §3.3；issue #71 重做数据源）。
 *
 * 数据源**两路合并**：
 *  1. **文件目录** `$DSH_HOME/skills`（flat `.md` + `<name>/SKILL.md` bundle）；
 *  2. **技能服务** `ctx.skills`（DSH 的 `@deepseek-ai/dsh-skill` 注册表）—— 这是**唯一**能
 *     看见「外壳技能」的通道。
 *
 * 为什么必须加第 2 路（真机报告「备份不到外壳 skills」）：技能 provider 由插件在 apply 时注册
 * （`ctx.skills.registerProvider`），来源可以是
 *  - pnpm 装进 profile 的插件包（`profiles/<p>/node_modules` 下任意层级的 `SKILL.md`，如 dsh-reverse-skill）；
 *  - 插件配置项 `customSkillDirs` 指向的任意目录；
 *  - 内置目录 `DSH_BUNDLED_SKILL_DIR`。
 * 这些技能**一个都不在** `$DSH_HOME/skills` 里，只扫目录的结果就是「技能分区恒为空」。
 *
 * 合并语义（与 `ctx.skills` 自己的层级语义一致：global 打底、scope 链覆盖）：
 *  - 服务里的技能统一映射成虚拟路径 `<name>/SKILL.md`（DSH 自己的目录形态）；
 *  - 同一相对路径**文件系统优先**（用户磁盘上的原文是事实源，服务可能已做归一化）；
 *  - 单元 id 仍是首个路径段 = 技能名（`unitIdOf` 缺省规则），因此选择器上「一个技能一个勾选项」，
 *    且与导入侧 `PlanItem.unitId` 自动对齐。
 *
 * 仅迁移用户可迁移的技能：项目级技能（`.agents/skills`、仓库内 skills 目录）不在本分区射程内
 * （研究报告 §2.2 同策略）。
 */
import path from 'node:path';
import { FileCollectionAdapter } from './file-collection.ts';
import type { HostContext, SkillDefinitionView } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { isPathSafe, normalizePath } from '../utils/paths.ts';
import { sectionMeta } from '../schema/section-registry.ts';

/** 技能服务技能的虚拟路径（相对 baseDir）：`<name>/SKILL.md`。 */
export function skillServiceRel(name: string): string {
  return normalizePath(path.join(name, 'SKILL.md'));
}

/** YAML 单引号标量转义（`'` → `''`）。 */
function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 由技能定义重建 `SKILL.md` 文本。
 *
 * 字段口径与 dsh-skill-filesystem 的解析器逐一对齐（多写一个键就会让 DSH 报
 * 「unsupported」并**忽略整个技能**，少写一个键则会丢失调用策略）：
 *  - 必需：`name` / `description`；
 *  - 可选：`whenToUse`；
 *  - 调用策略**只接受** `disable-model-invocation` / `user-invocable`
 *    （`modelInvocable` / `userInvocable` 会被判为 legacy 键并拒绝）。
 */
export function buildSkillFile(def: SkillDefinitionView): string {
  const lines: string[] = ['---', `name: ${quoteYaml(def.name)}`, `description: ${quoteYaml(def.description)}`];
  if (def.whenToUse !== undefined && def.whenToUse !== '') lines.push(`whenToUse: ${quoteYaml(def.whenToUse)}`);
  const invocation = def.invocation;
  if (invocation !== undefined && invocation.modelInvocable === false) lines.push('disable-model-invocation: true');
  if (invocation !== undefined && invocation.userInvocable === false) lines.push('user-invocable: false');
  // 正文原样保留（服务返回的 content 已是 frontmatter 之后的正文；不 trim，避免丢用户排版）
  return `${lines.join('\n')}\n---\n\n${def.content}`;
}

export class SkillsAdapter extends FileCollectionAdapter {
  readonly id = 'skills' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('skills').displayName;
  readonly defaultIncluded = sectionMeta('skills').defaultIncluded;
  readonly portability = sectionMeta('skills').portability;
  readonly baseDir = 'skills';

  /** 本趟由技能服务贡献的技能定义（相对路径 → 定义）。每次 collect 前重建，避免跨趟串味。 */
  private serviceSkills = new Map<string, SkillDefinitionView>();

  /**
   * 枚举 = 目录扫描 ∪ 技能服务清单。
   *
   * 服务不可用（旧宿主 / 无 skills 服务）时**完全退回**目录扫描：一个告警都不多加，
   * 行为与改造前逐项一致（file-collection.test.ts 钉住「无服务时不产生新告警」）。
   */
  protected override async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    const listing = await super.listRelPaths(ctx);
    this.serviceSkills = new Map<string, SkillDefinitionView>();
    if (ctx.skills === undefined) return listing;
    let summaries: { name: string }[];
    try {
      summaries = await ctx.skills.list();
    } catch (err) {
      ctx.log.warn(`技能服务列举失败（该路技能未进备份）: ${err instanceof Error ? err.message : String(err)}`);
      return listing;
    }
    const extra: string[] = [];
    // 目录清单里的是「含 baseDir 的路径」（`skills/<name>/SKILL.md`），服务侧算的是分区内相对路径，
    // 必须先归一到同一口径再比，否则同路径判不出重合 → 磁盘原文会被服务重建文本挤掉。
    const onDisk = new Set(listing.paths.map((p) => this.relPathOf(p)));
    for (const summary of summaries) {
      // 名字要能当路径用：DSH 的 SKILL_NAME 是 [a-z0-9-]，这里再做一道通用安全校验（拒 `..`/绝对路径）
      if (typeof summary.name !== 'string' || !isPathSafe(summary.name) || summary.name.includes('/')) continue;
      const rel = skillServiceRel(summary.name);
      if (onDisk.has(rel)) continue; // 文件系统优先
      let definition: SkillDefinitionView | undefined;
      try {
        definition = await ctx.skills.get(summary.name);
      } catch (err) {
        ctx.log.warn(`技能 ${summary.name} 读取失败（未进备份）: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (definition === undefined || typeof definition.content !== 'string') continue;
      this.serviceSkills.set(rel, definition);
      extra.push(rel);
    }
    if (extra.length === 0) return listing;
    return { ...listing, paths: [...listing.paths, ...extra] };
  }

  /**
   * 读成员：先看本趟的服务清单（虚拟 `<name>/SKILL.md`），命中则用重建文本；
   * 否则走基类的文件读（含 statSize 快路径）。
   *
   * 两条路都必须给出**同一个体积口径**（UTF-8 字节数），否则字节闸门在预览与导出之间分叉。
   */
  protected override async readMember(
    ctx: HostContext,
    rel: string,
    mode: 'content' | 'size',
    statTimes?: Map<string, number>,
  ): Promise<{ data: Uint8Array; sizeBytes: number; contentHash: string }> {
    const definition = this.serviceSkills.get(this.relPathOf(rel));
    if (definition === undefined) return super.readMember(ctx, rel, mode, statTimes);
    const text = buildSkillFile(definition);
    const data = new TextEncoder().encode(text);
    if (mode === 'size') {
      // 预览：不建哈希（与基类的 size 模式同语义），但体积必须精确
      return { data: new Uint8Array(0), sizeBytes: data.byteLength, contentHash: '' };
    }
    return { data, sizeBytes: data.byteLength, contentHash: sha256Hex(data) };
  }
}
