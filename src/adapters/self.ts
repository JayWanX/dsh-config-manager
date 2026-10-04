/**
 * self 分区 adapter（插件自身配置，设计「self 分区」）：
 * 数据源 = $DSH_HOME/dsh-config-manager/ 下的插件自身配置文件（白名单收集，非递归）：
 *   - sync/sync-config.json     同步通道配置（git repoUrl / webdav url+username；凭据值走 credentials 槽位，不含 secret）
 *   - sync/sync-autosync.json   自动同步调度配置
 *   - sync/sync-selection.json  同步分区选择（默认/高级模式 + 勾选分区）
 *   - sync/ui-prefs.json        插件 UI 偏好（如上次选择的同步通道；从 localStorage 迁入）
 *   - market/market-config.json 配置市场配置
 *
 * 排除项：sync/sync-history.json（执行记录，属数据非配置）、market/cache/（缓存）、
 * snapshots/（快照）、tmp/ exports/（临时/导出产物）——只备份「配置」，不备份数据。
 *
 * 实现：继承 FileCollectionAdapter 复用 analyzeImport/applyItem/validate（幂等 hash 比对、
 * 快照/回滚路径一致）；**清单来自覆写的 listRelPaths()（白名单），export() 与 preview() 都经
 * 基类 collect()**（self 目录内存在大量非配置子目录，不能像 skills/sessions 那样整体递归）。
 *
 * 为什么必须靠 listRelPaths() 而不是覆写 export() 来收窄（2026-10 真机报告）：
 * `preview()` / `listRelPaths()` 是后来才加进基类的。本类此前只覆写 export()，于是只读预览
 * 落到基类的目录递归 —— 把整个 $DSH_HOME/dsh-config-manager（快照、config-snapshots、
 * sync/work 的 Git 工作副本与远端快照、transactions、exports、遗留 profiles）都当成该分区的
 * 可勾选单元：实测 2460 个文件 / 11.44 MB，而真实导出只有 6 个文件 / 1936 B；界面上
 * 「插件自身配置 已选 2460/2460 11.5 MB」即由此而来。同款缺陷已在 agent-instructions.ts 踩过
 * 并修复（那边 baseDir='' 时更夸张：把整个 home 当该分区）。覆写 listRelPaths() 让两条路径
 * 共用同一份清单 —— 这正是基类 preview() 存在的意义。
 *
 * relativePath 一律是「相对 baseDir」的路径（如 sync/sync-config.json），与
 * FileCollectionAdapter 的基准目录语义一致：导入时按 path.join(baseDir, rel) 写回
 * $DSH_HOME/dsh-config-manager/<rel>；ZIP 内位于 self/<rel>。
 *
 * 安全不变量：配置文件本身不含凭据值（同步凭据走 DSH credentials 槽位引用），
 * 且文件类分区不进 SecretScanner（与 pluginFiles/skills 同语义）。
 */
import type { HostContext } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';
import { FileCollectionAdapter } from './file-collection.ts';

/** self 分区白名单文件（相对 baseDir，即 $DSH_HOME/dsh-config-manager/）。 */
export const SELF_CONFIG_FILES: readonly string[] = [
  'sync/sync-config.json',
  'sync/sync-autosync.json',
  'sync/sync-selection.json',
  'sync/ui-prefs.json',
  'sync/backup-schedule.json',
  'market/market-config.json',
  // P0-④：导出产物备注清单（exports/.backup-notes.json）——随 self 分区迁移，
  // 换机器后备份列表仍能看到手动导出时填写的备注
  'exports/.backup-notes.json',
];

export class SelfAdapter extends FileCollectionAdapter {
  readonly id = 'self' as const;
  readonly displayName = 'Plugin Self Config';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 插件自身配置目录（相对 homeDir；宿主按 dataDir 解析注入，缺省 dsh-config-manager） */
  readonly baseDir: string;

  constructor(baseDir = 'dsh-config-manager') {
    super();
    this.baseDir = baseDir;
  }

  /** self 的白名单文件彼此独立（同步配置 / 市场配置 / UI 偏好…），不构成 bundle
   *  → 覆写为「逐文件单元」，用户可以只带走其中几项。 */
  protected override unitIdOf(relativePath: string): string {
    return relativePath;
  }

  /**
   * 清单枚举 = **白名单文件**（覆写基类的目录递归）。
   *
   * 为什么必须覆写：self 目录下并存着插件自身的数据（snapshots/、config-snapshots/、
   * sync/work/ 的 Git 工作副本与远端快照、transactions/、exports/、遗留 profiles/），
   * 整目录递归会把它们全部当成「可勾选单元」（实测本机 2460 个文件 / 11.44 MB）。
   * 覆写后 export()（基类 collect，content 模式）与 preview()（size 模式）拿到**同一份清单**，
   * 选择器显示的条目/体积与真实导出逐项一致。
   *
   * 存在性判定优先 statSize（只 stat；白名单最多 7 个文件）；旧宿主未实现时退回读一次文件
   * （单文件代价可忽略，且 collect 之后还要读它）。读不到 / 未创建 → 跳过，
   * 与「文件不存在 = 非白名单命中」同语义（如从未配置市场/同步）。
   *
   * 路径一律用 POSIX 分隔符拼：relativePath 是**备份格式的一部分**（ZIP 内为 self/<rel>），
   * 同时是单元 id（self:<rel>）与 includeItems 的比对键 —— 不能随平台漂移成反斜杠。
   */
  protected override async listRelPaths(ctx: HostContext): Promise<RecursiveListing> {
    const empty: RecursiveListing = { paths: [], skippedLinks: [], followedLinks: 0, unreadableDirs: [] };
    const found: string[] = [];
    for (const rel of SELF_CONFIG_FILES) {
      const full = `${this.baseDir}/${rel}`;
      try {
        if (ctx.fs.statSize !== undefined) {
          if ((await ctx.fs.statSize(full)) === null) continue;
        } else {
          await ctx.fs.readFile(full);
        }
        found.push(full);
      } catch {
        // 未创建过的配置文件跳过
      }
    }
    return { ...empty, paths: found };
  }
}