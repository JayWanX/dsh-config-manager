/**
 * DSH V4 代次会话日志的读盘层。
 *
 * **与 dsh 共用同一扫描器**（read-dsh.ts 的 `readDshLogs`）—— 真值表把 dsh/dsh4 写成同一份
 * 会话目录的两个代次（chat-import discovery.mjs:36-38 的注释 + sources/dsh.mjs:8-25 的格式过滤），
 * 所以这里**只换代次过滤**，路径真值 / 字节纪律 / header 判定**一个字都不另写**。
 */
import { dshGenerationOfVersion, dshProbePaths, dshSessionsRoot, readDshLogs } from './read-dsh.ts';
import type { DshReadOptions, DshSessionLogFile } from './read-dsh.ts';
import type { RootProbeOptions, SessionReadOutcome } from './session-source.ts';

/** dsh4 = V4（`session.v4.jsonl.zstd`；本机实测首帧 version=4） */
export const DSH4_GENERATION = 'v4';

export function dsh4SessionsRoot(opts: RootProbeOptions): string {
  return dshSessionsRoot(opts);
}

export function dsh4ProbePaths(opts: RootProbeOptions): string[] {
  return dshProbePaths(opts);
}

/** 代次判定与 dsh 同源（同一个函数，不是副本） */
export function dsh4GenerationOfVersion(version: number | undefined): 'v4' | undefined {
  const generation = dshGenerationOfVersion(version);
  return generation === 'v4' ? 'v4' : undefined;
}

/** 扫描 V4 代次日志（读盘规则全部来自 read-dsh.ts） */
export async function readDsh4(
  opts: RootProbeOptions & { readonly maxLogs?: number; readonly maxFileBytes?: number; readonly maxTotalBytes?: number },
): Promise<SessionReadOutcome<DshSessionLogFile>> {
  const withGeneration: DshReadOptions = { ...opts, generation: DSH4_GENERATION };
  return readDshLogs(withGeneration);
}
