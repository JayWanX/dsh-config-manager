/**
 * 千问办公 / Qwen（~\.qwenworkcn/projects）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 qwen 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致）：
 *  - 根：`<home>/.qwenworkcn/projects`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<projects>/<slug>/<session-uuid>.jsonl`（JSONL）
 *
 * **交叉核对的一处刻意留白（不得美化）**：chat-import §3.1 对 qoder 写明「目录名 = cwd 的
 * `/`→`-` 编码」、对 workbuddy 写明「目录名 = cwd 哈希，**不可逆**」，但对 qwen 只写
 * `<slug>` —— **没有**任何报告说明这个 slug 的编码语义（是 cwd 编码？是产品内部分组？
 * 是工作区 id？）。因此本层**不据 slug 推导 cwd**（推导 = 猜），只采信记录字段；
 * 记录里也没有 cwd 的会话由下游 `transcodeSessionDraft` 按 `session-missing-cwd` 跳过
 * 并在计划里可见 —— 与 chatgpt「无自动根就如实报码、绝不假装」同一条纪律。
 * 待真机取证（拿到一份真实 qwen 目录）后再决定是否升级为「编码推导 + 存在性检查」。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 qwen 行）。本机无 ~/.qwenworkcn，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律：只读固定位置、不跟随符号链接、单文件有字节上限（超限即不读并报码，绝不截断）、
 * 读不到一律记账不抛、结果排序确定。路径函数**显式收 platform**（joinFor）。
 */
import fs from 'node:fs/promises';

import { joinFor, normalizePlatform } from './platform-paths.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const QWEN_PROJECTS_REL = '.qwenworkcn/projects';

/** 会话文件（JSONL 是唯一形态） */
export const QWEN_SESSION_FILE_RE = /\.jsonl$/;

const MAX_SESSION_FILES = 500;

/** Qwen 的项目根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function qwenProjectsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.qwenworkcn', 'projects');
}

/** 记录形态：通用 JSONL 同族 + 保守的 cwd 同义键；titleKeys 去掉 name（常是工具名） */
export const QWEN_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 Qwen 会话 */
export interface QwenSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface QwenReadOptions extends RootProbeOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxSessionFiles?: number | undefined;
}

/** 读一个文件（大小闸门在前，绝不截断）；空文件 / 超限 / 读失败都变成稳定机器码 */
async function readTextGuarded(
  p: string,
  label: string,
  maxBytes: number,
  findings: ForeignSkip[],
): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return null;
  if (st.size > maxBytes) {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return null;
  }
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return null;
  }
  if (text.trim() === '') {
    findings.push({ code: 'source-empty-file', origin: label });
    return null;
  }
  return text;
}

export async function readQwenSessions(opts: QwenReadOptions): Promise<SessionReadOutcome<QwenSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const projectsDir = qwenProjectsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: QwenSessionFile[] = [];

  if (!(await isDirectory(projectsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）：静默 break 会让「报成功但条目缺失」。
  let truncated = false;
  // slug 只当遍历键：编码语义未经取证 → 不参与 cwd 推导（见文件头）
  for (const slug of await listDirNames(projectsDir)) {
    const slugDir = joinFor(platform, projectsDir, slug);
    for (const name of await listFileNames(slugDir, (n) => QWEN_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = QWEN_PROJECTS_REL + '/' + slug + '/' + name;
      const text = await readTextGuarded(joinFor(platform, slugDir, name), label, maxBytes, findings);
      if (text === null) continue;
      files.push({ id: stemOf(name), parsed: parseGenericJsonl(text, QWEN_SHAPE) });
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'qwen', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
