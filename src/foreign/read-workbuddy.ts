/**
 * WorkBuddy（~\.workbuddy/projects）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 workbuddy 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的根逐字一致，无出入）：
 *  - 根：`<home>/.workbuddy/projects`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<projects>/<project-hash>/<session-uuid>.jsonl`（JSONL）
 *  - 目录名 = cwd 的**哈希**（convert/workbuddy.mjs:3-18）
 *
 * cwd 只有**一个**合法来源：记录里的字段。目录名是哈希、**不可逆** —— 本层刻意不做任何
 * 反解，也不拿「第一个用户消息里看起来像路径的串」凑数（那是猜）。没有 cwd 字段的会话
 * 由下游 `transcodeSessionDraft` 按 `session-missing-cwd` 跳过并报码（绝不产出一条
 * 指向不存在目录的会话，也绝不静默丢弃）。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 workbuddy 行）。本机无 ~/.workbuddy，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律（与 read-claude-code.ts / read-qoder.ts 同口径）：只读固定位置、不跟随符号链接、
 * 单文件有字节上限（超限即**不读**并如实报码，绝不截断）、读不到一律记账不抛、结果排序确定。
 * 路径函数**显式收 platform**（joinFor），绝不在真值表里读运行时平台。
 */
import fs from 'node:fs/promises';

import { joinFor, normalizePlatform } from './platform-paths.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**） */
export const WORKBUDDY_PROJECTS_REL = '.workbuddy/projects';

/** 会话文件（JSONL 是唯一形态） */
export const WORKBUDDY_SESSION_FILE_RE = /\.jsonl$/;

/** 单次读盘的会话文件数上限 */
const MAX_SESSION_FILES = 500;

/** WorkBuddy 的项目根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function workbuddyProjectsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.workbuddy', 'projects');
}

/**
 * 记录形态：通用 JSONL 同族 + **保守**的 cwd 同义键集合。
 *
 * cwdKeys 的取法是「只收语义唯一、不会被别的字段占用」的键：`cwd`/`workdir`/`working_directory`
 * 一类。刻意**不收** `path`/`file` 这类在 tool-call 里到处都是的键 —— 收进来就会把工具
 * 参数里的路径当成会话 cwd（那是猜，且错得静默）。`titleKeys` 去掉 `name`（常是工具名）。
 */
export const WORKBUDDY_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 WorkBuddy 会话 */
export interface WorkbuddySessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface WorkbuddyReadOptions extends RootProbeOptions {
  /** 单文件读取上限（缺省 8 MiB） */
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

export async function readWorkbuddySessions(
  opts: WorkbuddyReadOptions,
): Promise<SessionReadOutcome<WorkbuddySessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const projectsDir = workbuddyProjectsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: WorkbuddySessionFile[] = [];

  if (!(await isDirectory(projectsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）：静默 break 会让「报成功但条目缺失」。
  let truncated = false;
  // 目录名是**哈希**：本层只把它当遍历键，绝不参与 cwd 推导（不可逆 → 推导就是猜）
  for (const projectHash of await listDirNames(projectsDir)) {
    const projectDir = joinFor(platform, projectsDir, projectHash);
    for (const name of await listFileNames(projectDir, (n) => WORKBUDDY_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = WORKBUDDY_PROJECTS_REL + '/' + projectHash + '/' + name;
      const text = await readTextGuarded(joinFor(platform, projectDir, name), label, maxBytes, findings);
      if (text === null) continue;
      files.push({ id: stemOf(name), parsed: parseGenericJsonl(text, WORKBUDDY_SHAPE) });
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'workbuddy', detail: 'max-sessions-reached', count: maxFiles });
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}
