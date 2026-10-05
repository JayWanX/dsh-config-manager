/**
 * DSH 自身会话来源（dsh）的翻译层 —— 也是 **dsh / dsh4 共用的装配器**。
 *
 * dsh 与 dsh4 是同一份会话目录的两个代次（真值表 dynamic 明写「逐字节直通，不重新编码」）：
 *   · 读盘 = read-dsh.ts 的 readDshLogs（dsh4 经 read-dsh4.ts 换代次过滤，路径规则零副本）；
 *   · 翻译 = 本文件的 transcodeDshLog（id/cwd 自证 → 代次必须等于目标机版本 → relativePath 归位）；
 *   · 装配 = createDshLikeSource（detect 只 stat；build 走 kernel.collectSessionSections）。
 *
 * 为什么不走 sessionSourceOf（会话类来源的通用工厂）：那个工厂的出口是「草稿 → IR → 合成 DSH 行」，
 * 而 DSH 自己的日志**不能重编**（重编会丢 generation 的行式与压缩帧形态）。这里的手写装配与
 * 六个配置类来源同形，且**复用同一份 collectSessionSections**（冲突语义/工作区连带/未迁移计数
 * 都只有一处实现）。
 *
 * evidence 与 truth-table.ts 的 dsh / dsh4 行一致：`measured`（本机 ~/.dsh/sessions 实测：
 * 501 个日志的「文件名 ↔ 首帧 version」逐条对应，见 read-dsh.ts 文件头）。
 */
import { projectKeyOf } from '../core/session-select.ts';
import { collectSessionSections } from './kernel.ts';
import type { KernelTranscodeResult } from './kernel.ts';
import { foreignSourceLabelKey } from './source-modules.ts';
import { probeConfiguredPaths } from './session-read.ts';
import { DSH_HOME_ENV, dshProbePaths, readDshLogs, resolveDshHome } from './read-dsh.ts';
import type { DshGeneration, DshSessionLogFile } from './read-dsh.ts';
import { isSafeIrId } from './session-ir.ts';
import type { ForeignSource, ForeignSourceContext, ForeignSourceDetection } from './registry.ts';
import type { ForeignImportResult, ForeignSectionOut, ForeignSkip, ForeignSourceId } from './types.ts';

/**
 * 一条 DSH 日志 → sessions 分区里的一个文件（**逐字节直通**）。
 *
 * 判定顺序与 session-source.ts 的 transcodeSessionDraft 逐条对齐（版本 → id → 内容 → cwd），
 * 但「版本」这一关不是「我们会不会写」，而是**目标机读不读得了**：DSH 拒收非本 build 的
 * version（会话列表静默跳过 → 用户看到「对话消失」），所以只有 header.version == 目标版本才直通。
 */
export function transcodeDshLog(file: DshSessionLogFile, targetVersion: number | undefined): KernelTranscodeResult {
  if (targetVersion === undefined) return { skip: { code: 'session-format-version-unknown' } };
  if (!isSafeIrId(file.id)) return { skip: { code: 'session-unsafe-id', detail: file.id } };
  if (file.version !== targetVersion) {
    return { skip: { code: 'session-format-unsupported', detail: String(file.version) } };
  }
  if (file.cwd === '') return { skip: { code: 'session-missing-cwd', detail: file.id } };
  return {
    session: {
      id: file.id,
      cwd: file.cwd,
      // 归位判据与 Host 硬不变量同源：日志位置必须是 projectKey(首帧 cwd)/id/<原名>
      relativePath: projectKeyOf(file.cwd) + '/' + file.id + '/' + file.name,
      data: file.data,
      info: { ignored: {} },
    },
  };
}

async function detectLike(
  ctx: ForeignSourceContext,
  opts: { homeDir: string; env: Readonly<Record<string, string | undefined>>; platform: string },
): Promise<ForeignSourceDetection> {
  const probed = await probeConfiguredPaths(dshProbePaths(opts), ctx.homeDir);
  const skipped: ForeignSkip[] = [...probed.skipped];
  if (resolveDshHome(opts).overridden) skipped.push({ code: 'source-location-overridden', origin: DSH_HOME_ENV });
  return { found: probed.paths.length > 0, paths: [...probed.paths], skipped };
}

/**
 * 造一个 dsh 族的来源：`read` 由调用方给（dsh 用 readDshLogs，dsh4 用 readDsh4），
 * 其余装配（detect/build/evidence/labelKey）**只有这一份实现**。
 */
export function createDshLikeSource(
  id: ForeignSourceId,
  generation: DshGeneration,
  read: (opts: {
    homeDir: string;
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    projectDir?: string | undefined;
  }) => Promise<{ files: readonly DshSessionLogFile[]; readFindings?: readonly ForeignSkip[] | undefined; extraSkips?: readonly ForeignSkip[] | undefined; extraCounts?: Readonly<Record<string, number>> | undefined }>,
): ForeignSource {
  return {
    id,
    labelKey: foreignSourceLabelKey(id),
    evidence: 'measured',
    probePaths: (opts) => dshProbePaths(opts),
    async detect(ctx) {
      return detectLike(ctx, { homeDir: ctx.homeDir, env: ctx.env, platform: ctx.platform ?? process.platform });
    },
    async build(ctx): Promise<ForeignImportResult> {
      const opts = {
        homeDir: ctx.homeDir,
        env: ctx.env,
        platform: ctx.platform ?? process.platform,
        ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
      };
      // 局部名不叫 read（参数名就是 read，重名会踩 TDZ：'read' used before its declaration）
      const outcome = await read(opts);
      const sections: ForeignSectionOut[] = [];
      const skipped: ForeignSkip[] = [...(outcome.readFindings ?? []), ...(outcome.extraSkips ?? [])];
      const counts: Record<string, number> = { ...(outcome.extraCounts ?? {}) };
      collectSessionSections<DshSessionLogFile>({
        files: outcome.files,
        targetFormatVersion: ctx.targetSessionFormatVersion,
        transcode: (file) => transcodeDshLog(file, ctx.targetSessionFormatVersion),
        workspaceIdPrefix: id,
        sections,
        skipped,
        counts,
      });
      return { source: id, sections, skipped, credentialRefs: [], counts };
    },
  };
}

/** dsh = V3 族（v0–v3），读盘走 read-dsh.ts 的扫描器 */
export function createDshSource(): ForeignSource {
  return createDshLikeSource('dsh', 'v3', (opts) => readDshLogs({ ...opts, generation: 'v3' }));
}

export const dshSource: ForeignSource = createDshSource();
