/**
 * Qoder（~\.qoder/projects）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（read-chat-import.md §3.1 的 qoder 行；交叉核对 read-movein.md 附录 A 与
 * read-vault.md §10.2 —— 三份报告的**根**与**编码规则**逐字一致，无出入）：
 *  - 根：`<home>/.qoder/projects`（三平台同形，**无环境变量覆盖**）
 *  - 会话：`<projects>/<encoded-project>/<sessionId>.jsonl`（JSONL）
 *  - 目录名 = cwd 的 `/`→`-` 编码（convert/qoder.mjs:3-16）
 *  - 子代理会话在 `<projects>/<encoded-project>/<sessionId>/subagents/*.jsonl`
 *
 * cwd 的来源分两档，**绝不猜**：
 *  ① 记录里有 cwd 字段 → 采信记录（权威）；
 *  ② 没有 → 用目录名的 `/`→`-` 编码**反解**，且**反解结果必须在本机真实存在**（isDirectory）
 *     才落盘，并如实报 `session-cwd-derived`（types.ts 对该码的语义：存在性检查把「猜」变成
 *     「有证据的推断」）。反解不存在 → **不产出**会话（下游按 session-missing-cwd 跳过），
 *     绝不产出一条指向不存在目录的会话。
 *
 * 子代理 transcript（`subagents/*.jsonl`）**本期不迁移**：DSH 侧的子代理会话靠
 * `delegationDepth/origin` 表达，而 IR 层当前的草稿没有承载位（`transcodeSessionDraft`
 * 恒写 delegationDepth: 0）—— 硬导成顶层会话会让用户看到一条「不是自己开的对话」。
 * 因此只逐类计数并报 `unsupported-session-record`（detail=subagent-transcript），**绝不静默**。
 *
 * 取证强度：**fixture**（真值表 truth-table.ts 的 qoder 行）。本机无 ~/.qoder/projects，
 * 夹具 + 单测端到端跑同一份布局 —— **真机未验证，不得标 measured**。
 *
 * 读盘纪律（与 read-claude-code.ts / read-cursor.ts 同口径）：只读固定位置、不跟随符号链接、
 * 单文件有字节上限（超限即**不读**并如实报码，绝不截断）、读不到一律记账不抛、结果排序确定。
 * 路径函数**显式收 platform**（joinFor）——运行时平台的真值只在装配层兜底，绝不在这里读。
 */
import fs from 'node:fs/promises';

import { joinFor, normalizePlatform, sepFor } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { DEFAULT_MAX_FILE_BYTES, isDirectory, listDirNames, listFileNames, statOrNull, stemOf } from './session-read.ts';
import { GENERIC_TRANSCRIPT_SHAPE, parseGenericJsonl } from './session-source.ts';
import type { ParsedTranscript, RootProbeOptions, SessionReadOutcome, TranscriptShape } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

/** 相对用户 home 的位置标签前缀（回给 GUI/CLI 的**只允许路径**，绝不含用户名/盘符） */
export const QODER_PROJECTS_REL = '.qoder/projects';

/** 会话文件（在该来源里 JSONL 是唯一形态） */
export const QODER_SESSION_FILE_RE = /\.jsonl$/;

/** 单次读盘的会话文件数上限（防病态目录树；与 Claude 读盘层同量级） */
const MAX_SESSION_FILES = 500;

/** Qoder 的项目根（三平台同形；真值表没有为它列任何环境变量覆盖） */
export function qoderProjectsDir(opts: RootProbeOptions): string {
  return joinFor(normalizePlatform(opts.platform), opts.homeDir, '.qoder', 'projects');
}

/**
 * 记录形态：与通用 JSONL 同族（`{role|type, message|content, timestamp, id}`）。
 *
 * 两处**收紧**（不是美化，而是避免误取）：
 *  - `titleKeys` 去掉 `name`：JSONL 里的 `name` 常是工具名，拿它当标题会张冠李戴；
 *  - `cwdKeys` 加几个同义键（记录里带 cwd 时优先采信记录，见文件头 ①）。
 */
export const QODER_SHAPE: TranscriptShape = {
  ...GENERIC_TRANSCRIPT_SHAPE,
  cwdKeys: ['cwd', 'workdir', 'working_directory', 'workingDir', 'directory', 'projectPath', 'project_path', 'workspacePath', 'workspace_path'],
  titleKeys: ['title', 'summary', 'sessionTitle'],
};

/** 一条已解析的 Qoder 会话（读盘层的产物；`parsed` 已含 cwd 判定结果） */
export interface QoderSessionFile {
  readonly id: string;
  readonly parsed: ParsedTranscript;
}

export interface QoderReadOptions extends RootProbeOptions {
  /** 单文件读取上限（缺省 8 MiB）；超限即不读并如实计入 findings */
  readonly maxFileBytes?: number | undefined;
  /** 本次最多收集多少条会话（缺省 500） */
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

/**
 * 目录名（cwd 的 `/`→`-` 编码）→ 本机真实存在的目录；反解不出来就返回 undefined（绝不猜）。
 *
 * 两个候选形态（按平台决定先后，**存在性**是唯一判据）：
 *  - posix 形态：`-home-u-proj` → `/home/u/proj`；
 *  - win32 盘符形态：`C--Users-u-proj` → `C:\Users\u\proj`。
 */
export async function derivedCwdOf(encoded: string, platform: ForeignPlatform): Promise<string | undefined> {
  const sep = sepFor(platform);
  const posix = encoded.split('-').join('/');
  const drive = /^([A-Za-z])--(.*)$/.exec(encoded);
  const driveForm = drive === null ? undefined : drive[1] + ':' + sep + (drive[2] ?? '').split('-').join(sep);
  const candidates = platform === 'win32'
    ? [driveForm, posix]
    : [posix, driveForm];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

/** 子代理 transcript 的条数（只数不读；正文绝不进内存） */
async function countSubagentTranscripts(sessionDir: string, platform: ForeignPlatform): Promise<number> {
  const subDir = joinFor(platform, sessionDir, 'subagents');
  if (!(await isDirectory(subDir))) return 0;
  return (await listFileNames(subDir, (n) => QODER_SESSION_FILE_RE.test(n))).length;
}

export async function readQoderSessions(opts: QoderReadOptions): Promise<SessionReadOutcome<QoderSessionFile>> {
  const platform = normalizePlatform(opts.platform);
  const projectsDir = qoderProjectsDir(opts);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxSessionFiles ?? MAX_SESSION_FILES;
  const findings: ForeignSkip[] = [];
  const files: QoderSessionFile[] = [];
  let subagents = 0;

  if (!(await isDirectory(projectsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }

  // 触顶必须**可见**（audit-foreign F4）。
  let truncated = false;
  for (const project of await listDirNames(projectsDir)) {
    const projectDir = joinFor(platform, projectsDir, project);
    const derivedCwd = await derivedCwdOf(project, platform);
    for (const name of await listFileNames(projectDir, (n) => QODER_SESSION_FILE_RE.test(n))) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const label = QODER_PROJECTS_REL + '/' + project + '/' + name;
      const text = await readTextGuarded(joinFor(platform, projectDir, name), label, maxBytes, findings);
      if (text === null) continue;
      const id = stemOf(name);
      const base = parseGenericJsonl(text, QODER_SHAPE);
      if (base.cwd === undefined && derivedCwd !== undefined) {
        files.push({ id, parsed: { ...base, cwd: derivedCwd } });
        findings.push({ code: 'session-cwd-derived', origin: id, detail: 'project-dir-encoding' });
        continue;
      }
      files.push({ id, parsed: base });
    }
    for (const sessionId of await listDirNames(projectDir)) {
      subagents += await countSubagentTranscripts(joinFor(platform, projectDir, sessionId), platform);
    }
  }

  if (truncated) findings.push({ code: 'source-unreadable', origin: 'qoder', detail: 'max-sessions-reached', count: maxFiles });
  const extraSkips: ForeignSkip[] = subagents > 0
    ? [{ code: 'unsupported-session-record', origin: 'subagents', detail: 'subagent-transcript', count: subagents }]
    : [];
  return {
    files,
    readFindings: findings,
    extraSkips,
    extraCounts: { 'sessions.candidates': files.length, 'qoder.subagentTranscripts': subagents },
  };
}
