/**
 * Cursor（~/.cursor + 可选的 <项目>/.cursor）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（契约 §8.2；**文档取证**：cursor.com/help/customization/mcp.md 与 rules.md；
 * 本机无 ~/.cursor —— **未经真机验证**，取证强度必须如实标注，见 §8.7）：
 *  - ~/.cursor/mcp.json（用户级 MCP；<项目>/.cursor/mcp.json 为项目级，同名 server 项目级优先）
 *  - <项目>/.cursor/rules/*.mdc（文档明列的规则位置）与 ~/.cursor/rules/*.mdc（**文档未列出**：
 *    官方称用户规则随账号同步 → 存在即读、不存在即跳过，**不得据此产出空分区**）
 *  - ~/.cursor/skills/**​/SKILL.md 与 <项目>/.cursor/skills/**​/SKILL.md（**文档未取证**，同上处理）
 *  - .cursorrules（旧式；用户级 <home>/.cursorrules 与项目级 <项目>/.cursorrules）→ **只 stat 不读**
 *
 * 四条读盘纪律（与 read-claude-code.ts / read-hermes.ts / read-codex.ts 同口径，
 * 但**刻意不互相 import 私有实现**：各读盘层自带边界与错误口径，真正共享的是纯内核 kernel.ts）：
 *  ① 只读固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable，绝不截断）
 *  ② mcp.json 为 0 字节报 source-empty-file、JSON 畸形报 source-unreadable(json-error)，绝不抛
 *  ③ rules/*.mdc 的 frontmatter 只用于**分类**（always / auto-attached / agent-requested / manual）；
 *     损坏的 frontmatter 报 source-unreadable(frontmatter-*)，并按 **manual 保守归类**、正文原样保留
 *  ④ .cursorrules **只 stat 不读**：正文连内存都不进（用户可见的只有 legacy-rules-file 一条码）
 *
 * 作用域与优先级：**项目级排在用户级之前**（同名技能项目级胜出，由内核 collectSkills 先到先得 +
 * skill-id-conflict 报码）；MCP 的同名覆盖由翻译层按「用户级打底、项目级覆盖」合成。
 *
 * **会话（2026-10-06 起）**：`~/.cursor/projects/<slug>/agent-transcripts/<composer-uuid>/<composer-uuid>.jsonl`
 * （位置真值：参考实现 lib/discovery 的 cursor 行 + `lib/tools/source-derive.mjs` 的 `cursorDeriveArgs`；
 * 本机无 ~/.cursor，取证强度仍是**文档 + 参考实现**，见 §8.7）：
 *  - 行结构固定 `{role, message:{content:[…]}}`，块只有 text / tool_use（**源里没有 tool_result**，
 *    参考实现也只发 tool/call）→ 本层绝不自造工具结果；
 *  - 提问包在 `<user_query>…</user_query>` 与 `<timestamp>…</timestamp>` 里 → 剥离（提问与标题同一口径）；
 *    内嵌时间戳单独解析成 createdAt（Cursor 记录里没有别的时间字段）；
 *  - assistant 正文里的 `[REDACTED]` 是 Cursor 客户端的隐私哨兵，过滤；整段只剩它时该步不产出（计数可见）；
 *  - 记录里**没有 cwd**：`<slug>` 是工作目录的编码（`\` 与段内 `.` → `-`、盘符小写前缀）。
 *    本层按参考实现的**贪心逐段解码 + 存在性检查**（每一段都必须是本机真实目录）才落盘并报
 *    `session-cwd-derived`；解不出来（非盘符形态 / 非仓库 slug / 探测预算触顶）**绝不伪造**，
 *    交由下游按 `session-missing-cwd` 如实跳过 —— 与 qoder / pi 的存在性检查同一口径；
 *  - 会话 id = composer uuid（真机布局里目录名与文件名同值）；不安全 / 冲突由下游的
 *    session-unsafe-id / session-id-conflict 如实报码，本层不静默丢。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { isRecord } from '../utils/guards.ts';
import { splitFrontmatter } from './kernel.ts';
import { dirWalkSkips, isDirectory, listDirNames, listFileNames, resolveLimit, stemOf, type DirWalkStats } from './session-read.ts';
import { irBump, irTextBlock, irToolCallBlock } from './session-ir.ts';
import type { IrBlock, IrTimeMs } from './session-ir.ts';
import { firstUserText } from './session-source.ts';
import type { ParsedTranscript, SessionReadOutcome, TranscriptRecord } from './session-source.ts';
import type { ForeignLimitOverrides, ForeignSkip } from './types.ts';
import type {
  CursorInput,
  CursorRuleActivation,
  CursorRuleInput,
  CursorScope,
  CursorSessionInput,
  CursorSkillInput,
} from './cursor.ts';

export interface CursorHomeOptions {
  /** 用户 home（Windows = %USERPROFILE%，macOS/Linux = $HOME） */
  homeDir: string;
}

/**
 * Cursor 用户级配置目录：三平台同形 = <home>/.cursor（契约 §8.2 未列出任何环境变量覆盖，
 * 官方文档也没有 CURSOR_CONFIG_DIR 这类开关 → **不猜**：解析出来的路径就是唯一候选）。
 */
export function resolveCursorHome(opts: CursorHomeOptions): string {
  return path.join(opts.homeDir, '.cursor');
}

/**
 * 会话读盘的选项（**只含会话需要的那几项**）。
 *
 * 为什么刻意不收 `projectDir`：会话根只有用户级 `~/.cursor/projects`（项目级 `.cursor/` 只有
 * mcp/rules/skills，没有 projects）—— 收一个用不上的参数只会让调用方以为项目级也有会话。
 */
export interface CursorSessionsReadOptions extends CursorHomeOptions {
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 findings */
  maxFileBytes?: number;
  /** 会话文件数上限（默认 500）；超出即报 max-sessions-reached，绝不静默截断 */
  maxSessions?: number;
  /** 可选上限覆盖（t36，装配层透传；缺省 = 上面各默认值逐字不变） */
  limits?: ForeignLimitOverrides;
}

export interface CursorReadOptions extends CursorSessionsReadOptions {
  /** 可选的项目目录（项目级 .cursor/ 与 .cursorrules 在这里；缺省 = 只读用户级） */
  projectDir?: string;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
}

/** 一次会话读盘的结果（形状与档 B 会话来源共用：`{ files, readFindings, … }`） */
export type CursorSessionsReadResult = SessionReadOutcome<CursorSessionInput>;

export interface CursorReadResult {
  /** 是否找到 Cursor 的痕迹（~/.cursor 或 <项目>/.cursor 目录，或读到了任何内容）；未安装是正常状态 */
  found: boolean;
  /** 解析出的用户级配置目录（诊断用；不含任何值） */
  home: string;
  /** 项目目录（未提供时为 undefined） */
  projectDir?: string;
  input: CursorInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILLS = 500;
/** 技能根目录下的最大下钻深度（防病态深层树；超深不再下钻） */
const MAX_SKILL_DEPTH = 4;

/** 规则文件名的稳定标签（只含相对位置，绝不含绝对路径 = 机器身份） */
function ruleLabel(scope: CursorScope, name: string): string {
  return (scope === 'user' ? 'rules/' : 'project/.cursor/rules/') + name;
}

const MCP_LABEL: Readonly<Record<CursorScope, string>> = { user: 'mcp.json', project: 'project/.cursor/mcp.json' };

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/* ---------------- ① 规则 frontmatter 分类（纯函数，可单测） ---------------- */

export interface ParsedCursorRule {
  activation: CursorRuleActivation;
  /** 并入 AGENTS.md 的正文（frontmatter 缺失/损坏时 = 全文，绝不丢内容） */
  body: string;
  /** frontmatter 解析问题（稳定机器码片段；undefined = 正常） */
  problem?: 'frontmatter-yaml-error' | 'frontmatter-not-mapping';
}

/**
 * frontmatter → 四种激活类型（Cursor 文档的判定顺序，不猜）：
 *  ① alwaysApply 为真 → **always**（无条件加载）
 *  ② globs 非空 → **auto-attached**（匹配到文件时自动附带）
 *  ③ description 非空 → **agent-requested**（由 agent 判断是否附带）
 *  ④ 以上都没有（含完全没有 frontmatter）→ **manual**（只在显式 @ 提及时使用）
 */
export function classifyRuleActivation(fm: unknown): CursorRuleActivation {
  if (!isRecord(fm)) return 'manual';
  const always = fm['alwaysApply'];
  if (always === true) return 'always';
  // 有些用户把它写成字符串（引号包裹）—— 只认明确的 'true' 字面，其余一律往下走（不猜）
  if (typeof always === 'string' && always.trim().toLowerCase() === 'true') return 'always';
  const globs = fm['globs'];
  if (typeof globs === 'string' && globs.trim() !== '') return 'auto-attached';
  if (Array.isArray(globs) && globs.some((g) => typeof g === 'string' && g.trim() !== '')) return 'auto-attached';
  const description = fm['description'];
  if (typeof description === 'string' && description.trim() !== '') return 'agent-requested';
  return 'manual';
}

/**
 * 一条 *​.mdc 的解析：frontmatter 分隔线缺失 = 没有 frontmatter（Cursor 文档：无字段即 Manual）；
 * frontmatter 损坏时**按 Manual 保守归类**（绝不因为读不懂就当成 always-on）并把问题如实报出。
 */
export function parseCursorRule(text: string): ParsedCursorRule {
  const fm = splitFrontmatter(text);
  if (fm === null) return { activation: 'manual', body: text };
  let parsed: unknown;
  try {
    parsed = yaml.load(fm.raw);
  } catch {
    return { activation: 'manual', body: text, problem: 'frontmatter-yaml-error' };
  }
  if (parsed === null) return { activation: 'manual', body: fm.body };
  if (!isRecord(parsed)) return { activation: 'manual', body: text, problem: 'frontmatter-not-mapping' };
  return { activation: classifyRuleActivation(parsed), body: fm.body };
}

/* ---------------- ② 通用读文件（大小闸门在前，绝不截断） ---------------- */

async function readTextGuarded(
  p: string,
  label: string,
  maxBytes: number,
  scope: CursorScope,
  findings: ForeignSkip[],
  unreadable: string[],
): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return null;
  if (st.size === 0) {
    findings.push({ code: 'source-empty-file', origin: label, detail: scope });
    return null;
  }
  if (st.size > maxBytes) {
    unreadable.push(label);
    findings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
    return null;
  }
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    unreadable.push(label);
    findings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
    return null;
  }
}

async function readJsonConfig(
  p: string,
  label: string,
  maxBytes: number,
  scope: CursorScope,
  findings: ForeignSkip[],
  unreadable: string[],
): Promise<unknown | undefined> {
  const text = await readTextGuarded(p, label, maxBytes, scope, findings, unreadable);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    unreadable.push(label);
    findings.push({ code: 'source-unreadable', origin: label, detail: 'json-error' });
    return undefined;
  }
}

/* ---------------- ③ rules/*.mdc ---------------- */

async function readRules(
  rulesDir: string,
  scope: CursorScope,
  maxBytes: number,
  findings: ForeignSkip[],
  unreadable: string[],
): Promise<CursorRuleInput[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(rulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // 只认 .mdc（Cursor 规则的唯一扩展名）；排序保证合并顺序确定，不依赖目录遍历顺序
  const names = dirents
    .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith('.mdc'))
    .map((d) => d.name)
    .sort();
  const out: CursorRuleInput[] = [];
  for (const name of names) {
    const label = ruleLabel(scope, name);
    const text = await readTextGuarded(path.join(rulesDir, name), label, maxBytes, scope, findings, unreadable);
    if (text === null) continue;
    const parsed = parseCursorRule(text);
    if (parsed.problem !== undefined) {
      unreadable.push(label);
      findings.push({ code: 'source-unreadable', origin: label, detail: parsed.problem });
    }
    out.push({ name, scope, activation: parsed.activation, body: parsed.body });
  }
  return out;
}

/* ---------------- ④ skills/**​/SKILL.md（深层压平为叶子名） ---------------- */

/** 递归收集一个技能目录下的普通文件（不跟随符号链接；条目数与单文件字节都有上限） */
async function walkFiles(
  root: string,
  start: string,
  maxFiles: number,
  maxBytes: number,
  stats?: DirWalkStats,
): Promise<{ relativePath: string; data: Uint8Array }[]> {
  const out: { relativePath: string; data: Uint8Array }[] = [];
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // t36：条数触顶不再静默 —— 置标志，由调用方推 max-skill-files-reached。
      if (out.length >= maxFiles) { if (stats !== undefined) stats.truncatedFiles = true; break; }
      if (d.isSymbolicLink()) continue;
      const full = path.join(cur, d.name);
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await statOrNull(full);
      if (st === null) continue;
      if (st.size > maxBytes) {
        if (stats !== undefined) stats.tooLargeCount = (stats.tooLargeCount ?? 0) + 1;
        continue;
      }
      try {
        const data = await fs.readFile(full);
        out.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), data });
      } catch {
        // 单文件读不到就不带：该技能的成员数随之少一个，用户在计数上看得见
      }
    }
  }
  return out;
}

async function hasSkillMd(dir: string): Promise<boolean> {
  const st = await statOrNull(path.join(dir, 'SKILL.md'));
  return st !== null && st.isFile();
}

async function findSkillUnits(
  skillsDir: string,
  maxFiles: number,
  maxBytes: number,
  maxSkills: number,
  stats?: DirWalkStats & { truncated?: boolean },
): Promise<CursorSkillInput[]> {
  const out: CursorSkillInput[] = [];
  const visit = async (dir: string, parents: string[]): Promise<void> => {
    // 技能数触顶绝不静默（audit-foreign F4）：置标志，由调用方推一条 source-unreadable。
    if (out.length >= maxSkills) { if (stats !== undefined) stats.truncated = true; return; }
    if (parents.length > MAX_SKILL_DEPTH) return;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
    for (const name of dirs) {
      if (out.length >= maxSkills) { if (stats !== undefined) stats.truncated = true; break; }
      const child = path.join(dir, name);
      if (await hasSkillMd(child)) {
        // 自带 SKILL.md 就是一个技能单元：它的子目录只作资产（walkFiles 递归带走），不再单独成技能
        const files = await walkFiles(child, child, maxFiles, maxBytes, stats);
        if (files.length === 0) continue;
        const unit: CursorSkillInput = { name, files };
        if (parents.length > 0) unit.category = parents.join('/');
        out.push(unit);
        continue;
      }
      await visit(child, [...parents, name]);
    }
  };
  await visit(skillsDir, []);
  return out;
}

/* ---------------- ⑤ 旧式 .cursorrules（只 stat） ---------------- */

async function legacyScopes(homeDir: string, projectDir: string | undefined): Promise<{ scope: CursorScope }[]> {
  const out: { scope: CursorScope }[] = [];
  const userStat = await statOrNull(path.join(homeDir, '.cursorrules'));
  if (userStat !== null && userStat.isFile()) out.push({ scope: 'user' });
  if (projectDir !== undefined) {
    const projectStat = await statOrNull(path.join(projectDir, '.cursorrules'));
    if (projectStat !== null && projectStat.isFile()) out.push({ scope: 'project' });
  }
  return out;
}

/* ---------------- ⑥ 会话：projects/<slug>/agent-transcripts/<composer>/<composer>.jsonl ---------------- */

/** 相对用户 home 的会话根（回给 GUI/CLI 的**只允许路径**，绝不回传用户名/盘符） */
export const CURSOR_PROJECTS_REL = '.cursor/projects';

/** composer 目录下的会话文件（Cursor 只写 `.jsonl`） */
export const CURSOR_SESSION_FILE_RE = /\.jsonl$/;

/** transcript 的中间目录名（真值：projects/<slug>/agent-transcripts/<composer>/） */
const CURSOR_TRANSCRIPTS_DIR = 'agent-transcripts';

/** 单次读盘的会话文件数上限（与 qoder / qwen 读盘层同量级） */
const DEFAULT_MAX_SESSIONS = 500;

/** 一个 slug 允许的**存在性探测次数**上限（防病态 slug 的组合爆炸；触顶即放弃该 slug，绝不猜） */
const CURSOR_DECODE_BUDGET = 400;

/** 与真实仓库无关、绝不解码的 slug（空窗口；纯数字项目 id 另判） */
const CURSOR_NON_REPO_SLUGS: readonly string[] = ['empty-window'];

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

/* --- 提问装饰（纯函数；提问与标题同一口径） --- */

/**
 * 剥离 Cursor 提问的 `<timestamp>…</timestamp>` 与 `<user_query>…</user_query>` 包裹。
 *
 * 为什么提问与标题必须同一口径：DSH 的标题取自首条用户文本（session-source.firstUserText），
 * 若只在标题上剥壳，面板里会留下 `\nCreate a …` 这种带标签残留的标题（参考实现同款，
 * 见 lib/convert/cursor.mjs 的 stripCursorTitleDecorations）。
 */
export function stripCursorTitleDecorations(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  return s
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '')
    .replace(/<\/?user_query>/gi, '')
    .trim();
}

/**
 * 从提问正文里解析内嵌的毫秒时间戳（形如
 * `<timestamp>Thursday, Aug 27, 2026, 3:11 PM (UTC+8)</timestamp>`）。
 *
 * 与参考实现 parseCursorEmbeddedTimestamp 逐字对齐：先剥掉 `(UTC…)` 后缀再 `Date.parse`；
 * 解析不出来返回 undefined（**绝不 Date.now() 伪造**）。
 * 已知口径：`Date.parse` 按**本机时区**解释该串（`(UTC+8)` 只被剥掉、不做偏移换算）——
 * 与参考实现同款；它只用于 createdAt 兜底，不参与任何判定。
 */
export function parseCursorEmbeddedTimestamp(text: unknown): IrTimeMs | undefined {
  const s = typeof text === 'string' ? text : '';
  const m = s.match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i);
  if (m === null || m[1] === undefined) return undefined;
  const cleaned = m[1].replace(/\s*\(UTC[^)]*\)\s*/gi, ' ').trim();
  const t = Date.parse(cleaned);
  return Number.isFinite(t) ? t : undefined;
}

/* --- 工作目录 slug（编码语义取自参考实现的 discovery 层） --- */

/**
 * Windows 绝对路径 → Cursor 的 `projects/<slug>` 目录名。
 *
 * 与参考实现 `cwd-map.mjs: encodeCursorSlug` 逐字对齐：**只有盘符小写**（其余段保留原大小写），
 * 分隔符与段内的 `.` 都变成 `-`。非盘符形态（UNC / posix 绝对路径）返回 null —— 参考实现同样
 * 只支持盘符形态，**不猜**（猜出来的 cwd 会指向别的目录，比缺 cwd 更坏）。
 * 导出它是为了让单测能**用本机真实路径**构造夹具（往返一致才是解码正确的证据）。
 */
export function encodeCursorSlug(absPath: string): string | null {
  const p = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^([A-Za-z]):\/?(.*)$/.exec(p);
  if (m === null || m[1] === undefined) return null;
  const drive = m[1].toLowerCase();
  const tail = (m[2] ?? '').split('/').filter((s) => s !== '').map((s) => s.replace(/\./g, '-')).join('-');
  return tail === '' ? drive : drive + '-' + tail;
}

/** 与真实仓库无关的 slug（空窗口 / 纯数字项目 id）→ **绝不解码**（参考实现 isCursorNonRepoSlug 同款） */
export function isCursorNonRepoSlug(slug: string): boolean {
  if (slug === '' || CURSOR_NON_REPO_SLUGS.includes(slug)) return true;
  return /^\d+$/.test(slug);
}

/** 存在性判定（**可注入**：单测用它把贪心解码变成确定性用例，不需要真的盘符路径） */
export type CursorPathExists = (candidate: string) => Promise<boolean>;

/**
 * 一个段块的候选目录名（段内的 `.` 被编码成了 `-`，必须试回原形）。
 *
 * 与参考实现 `nameVariants` 逐字对齐：整段拼接；两段再试 `a.b`；三段再试 `a.b-c` / `a.b.c`。
 * 只对 ≤3 段的块试点号 —— 候选数在块长上是线性的，配合预算上限不会爆炸。
 */
function cursorSegmentNames(parts: readonly string[]): string[] {
  const out = [parts.join('-')];
  if (parts.length === 2) out.push((parts[0] ?? '') + '.' + (parts[1] ?? ''));
  if (parts.length === 3) {
    out.push((parts[0] ?? '') + '.' + (parts[1] ?? '') + '-' + (parts[2] ?? ''));
    out.push((parts[0] ?? '') + '.' + (parts[1] ?? '') + '.' + (parts[2] ?? ''));
  }
  return out;
}

/**
 * Cursor 的 `projects/<slug>` → 真实工作区绝对路径（**贪心解码 + 存在性检查**）。
 *
 * 为什么必须贪心：编码是有损的（`-` 同时是分隔符与段内 `.` 的替身），段边界只能**回到盘上验证**
 * 才能确定 —— 每层优先「剩余整段」，再逐段合并 ≤2/≤3 段，命中即返回；全程不命中返回 undefined
 * （下游按 session-missing-cwd 跳过，**绝不伪造一条指向不存在目录的 cwd**）。
 * `budget` 是探测次数上限：病态 slug（长且全不命中）会组合爆炸，触顶即 fail-closed（返回 undefined）。
 */
export async function decodeCursorSlugPath(
  slug: string,
  exists: CursorPathExists,
  budget: number = CURSOR_DECODE_BUDGET,
): Promise<string | undefined> {
  if (isCursorNonRepoSlug(slug)) return undefined;
  const m = /^([A-Za-z])-(.*)$/.exec(slug);
  if (m === null || m[1] === undefined) return undefined;
  const segments = (m[2] ?? '').split('-').filter((s) => s !== '');
  if (segments.length === 0) return undefined;
  const root = m[1].toUpperCase() + ':' + BS;
  let spent = 0;
  const probe = async (candidate: string): Promise<boolean> => {
    if (spent >= budget) return false;
    spent += 1;
    return exists(candidate);
  };
  const walk = async (i: number, prefix: string): Promise<string | undefined> => {
    if (i >= segments.length) return (await probe(prefix)) ? prefix : undefined;
    for (let n = segments.length - i; n >= 1; n--) {
      for (const name of cursorSegmentNames(segments.slice(i, i + n))) {
        const next = prefix + name;
        if (!(await probe(next))) continue;
        if (i + n >= segments.length) return next;
        const rest = await walk(i + n, next + BS);
        if (rest !== undefined) return rest;
      }
    }
    return undefined;
  };
  return walk(0, root);
}

/** fs 版解码（存在性 = 本机真实目录）；解不出来返回 undefined（绝不伪造 cwd） */
export async function cursorCwdFromSlug(slug: string): Promise<string | undefined> {
  return decodeCursorSlugPath(slug, isDirectory);
}

/* --- 转录解析（纯函数；与参考实现 lib/convert/cursor.mjs 的记录语义逐条对齐） --- */

/** Cursor 的隐私哨兵：客户端把被剥离的内容写成 `[REDACTED]`；整段只剩它时该块不产出 */
function cursorAssistantText(text: string): string {
  return text.replace(/\[REDACTED\]/g, '').trim();
}

/**
 * `agent-transcripts/<composer>.jsonl` 原文 → 归一记录。
 *
 * 与参考实现逐条对齐：
 *  - 一行一条 `{role, message:{content:[…]}}`；坏行只计数（`bad`）、未迁移角色/块逐类计数（`ignored`）；
 *  - **用户轮**：text 块剥离 `<user_query>` / `<timestamp>` 后拼接；空轮不产出（计数 user-empty）；
 *  - **助手步**：text 剥 `[REDACTED]`；tool_use 缺 id 时铸**稳定**兜底 id
 *    `cursor-<轮>-<步>-<块序>`（轮/步/块序都是 1 起，与参考实现同式）；
 *  - **首个用户轮之前的助手记录**丢弃并计数（assistant-without-turn）—— 没有提问的回复在 DSH 里
 *    会凭空开一轮，参考实现同样丢弃；**源里没有 tool_result**，本函数也不自造；
 *  - 没有任何会话内时间字段：createdAt 只来自首个提问内嵌的 `<timestamp>`（解析不出即 undefined，
 *    由下游用导入时刻兜底，绝不伪造）；cwd 由读盘层按 slug 推导后补进 parsed，本函数一律返回 undefined。
 */
export function parseCursorTranscript(raw: string): ParsedTranscript {
  const records: TranscriptRecord[] = [];
  const ignored: Record<string, number> = {};
  let rawCount = 0;
  let bad = 0;
  let createdAt: IrTimeMs | undefined;
  let turn = 0;
  let step = 0;
  for (const line of raw.split(NL)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      bad += 1;
      continue;
    }
    rawCount += 1;
    const role = typeof parsed['role'] === 'string' ? parsed['role'] : '';
    if (role !== 'user' && role !== 'assistant') {
      irBump(ignored, role === '' ? 'unknown-role' : role);
      continue;
    }
    const message = isRecord(parsed['message']) ? parsed['message'] : undefined;
    const content = message === undefined ? undefined : message['content'];
    if (!Array.isArray(content)) {
      irBump(ignored, 'content-not-array');
      continue;
    }
    if (role === 'user') {
      const texts: string[] = [];
      const rawTexts: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) { irBump(ignored, 'block:unmapped'); continue; }
        const type = typeof block['type'] === 'string' ? block['type'] : '';
        if (type !== 'text') { irBump(ignored, 'block:' + (type === '' ? 'unmapped' : type)); continue; }
        const text = typeof block['text'] === 'string' ? block['text'] : '';
        rawTexts.push(text);
        const stripped = stripCursorTitleDecorations(text);
        if (stripped !== '') texts.push(stripped);
      }
      const prompt = texts.join(NL).trim();
      if (prompt === '') { irBump(ignored, 'user-empty'); continue; }
      turn += 1;
      step = 0;
      // 内嵌时间戳只属于**它自己那一轮**（绝不能把首轮时间刷到后续轮次上）；解析的是**原文**，
      // 因为剥离函数会把 <timestamp>…</timestamp> 整段删掉（参考实现先剥后解析 → 那一步恒不命中）。
      const embedded = parseCursorEmbeddedTimestamp(rawTexts.join(NL));
      if (createdAt === undefined) createdAt = embedded;
      records.push({ role: 'user', blocks: [irTextBlock(prompt)], time: embedded });
      continue;
    }
    if (turn === 0) { irBump(ignored, 'assistant-without-turn'); continue; }
    const blocks: IrBlock[] = [];
    let toolIndex = 0;
    for (const block of content) {
      if (!isRecord(block)) { irBump(ignored, 'block:unmapped'); continue; }
      const type = typeof block['type'] === 'string' ? block['type'] : '';
      if (type === 'text') {
        const text = typeof block['text'] === 'string' ? block['text'] : '';
        const cleaned = cursorAssistantText(text);
        if (cleaned !== '') blocks.push(irTextBlock(cleaned));
        continue;
      }
      if (type === 'tool_use') {
        toolIndex += 1;
        const given = typeof block['id'] === 'string' && block['id'] !== '' ? block['id'] : undefined;
        const id = given ?? 'cursor-' + String(turn) + '-' + String(step + 1) + '-' + String(toolIndex);
        const name = typeof block['name'] === 'string' && block['name'] !== '' ? block['name'] : 'unknown';
        blocks.push(irToolCallBlock(id, name, block['input'] ?? {}));
        continue;
      }
      irBump(ignored, 'block:' + (type === '' ? 'unmapped' : type));
    }
    if (blocks.length === 0) { irBump(ignored, 'assistant-empty'); continue; }
    step += 1;
    records.push({ role: 'assistant', blocks });
  }
  return { records, cwd: undefined, createdAt, title: firstUserText(records), raw: rawCount, bad, ignored };
}

/* --- 会话读盘 --- */

/** 读一个会话文件（大小闸门在前，绝不截断）；0 字节 / 超限 / 读失败都变成稳定机器码 */
async function readSessionText(
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
 * 枚举 `~/.cursor/projects/<slug>/agent-transcripts/<composer>/*.jsonl` 并解析成归一记录。
 *
 * 四条纪律（与档 B 会话读盘层同口径）：
 *  ① cwd **只**来自 slug 的贪心解码 + 存在性检查；解不出来就留 undefined（下游按
 *     `session-missing-cwd` 如实跳过），**绝不伪造**；推出来的每条都报 `session-cwd-derived`；
 *  ② 会话 id = composer uuid（真机布局里目录名 == 文件名 stem）；目录名与文件名不一致的异常布局
 *     以文件名 stem 为准 —— 避免同一 composer 目录里的多个文件互相撞 id（撞了会报 session-id-conflict）；
 *  ③ 文件数上限触顶**可见**（max-sessions-reached），绝不静默截断；
 *  ④ 0 字节 / 超限 / 读失败各自成码，绝不抛。
 */
export async function readCursorSessions(opts: CursorSessionsReadOptions): Promise<CursorSessionsReadResult> {
  const projectsDir = path.join(resolveCursorHome(opts), 'projects');
  const maxBytes = resolveLimit(opts.limits?.maxFileBytes, opts.maxFileBytes, DEFAULT_MAX_FILE);
  const maxSessions = resolveLimit(opts.limits?.maxSessionFiles, opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const findings: ForeignSkip[] = [];
  const files: CursorSessionInput[] = [];
  if (!(await isDirectory(projectsDir))) {
    return { files, readFindings: findings, extraCounts: { 'sessions.candidates': 0 } };
  }
  let truncated = false;
  for (const slug of await listDirNames(projectsDir)) {
    if (files.length >= maxSessions) { truncated = true; break; }
    const transcriptsDir = path.join(projectsDir, slug, CURSOR_TRANSCRIPTS_DIR);
    const cwd = await cursorCwdFromSlug(slug);
    for (const composer of await listDirNames(transcriptsDir)) {
      const composerDir = path.join(transcriptsDir, composer);
      for (const name of await listFileNames(composerDir, (n) => CURSOR_SESSION_FILE_RE.test(n))) {
        if (files.length >= maxSessions) { truncated = true; break; }
        const label = CURSOR_PROJECTS_REL + '/' + slug + '/' + CURSOR_TRANSCRIPTS_DIR + '/' + composer + '/' + name;
        const text = await readSessionText(path.join(composerDir, name), label, maxBytes, findings);
        if (text === null) continue;
        const stem = stemOf(name);
        const id = stem === composer ? composer : stem;
        const parsed = parseCursorTranscript(text);
        files.push({ id, parsed: cwd === undefined ? parsed : { ...parsed, cwd } });
        if (cwd !== undefined) findings.push({ code: 'session-cwd-derived', origin: id, detail: 'project-slug-encoding' });
      }
    }
  }
  if (truncated) {
    findings.push({ code: 'source-unreadable', origin: 'cursor', detail: 'max-sessions-reached', count: maxSessions });
  }
  return { files, readFindings: findings, extraCounts: { 'sessions.candidates': files.length } };
}

/* ---------------- 入口 ---------------- */

export async function readCursor(opts: CursorReadOptions): Promise<CursorReadResult> {
  const home = resolveCursorHome(opts);
  const projectDir = opts.projectDir;
  const maxFileBytes = resolveLimit(opts.limits?.maxFileBytes, opts.maxFileBytes, DEFAULT_MAX_FILE);
  const maxSkillFiles = resolveLimit(opts.limits?.maxSkillFiles, opts.maxSkillFiles, DEFAULT_MAX_SKILL_FILES);
  const maxSkills = resolveLimit(opts.limits?.maxSkills, opts.maxSkills, DEFAULT_MAX_SKILLS);
  const readFindings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: CursorInput = {};

  const homeStat = await statOrNull(home);
  const projectCursorDir = projectDir === undefined ? undefined : path.join(projectDir, '.cursor');
  const projectStat = projectCursorDir === undefined ? null : await statOrNull(projectCursorDir);

  /* mcp.json（用户级 + 项目级） */
  if (homeStat !== null) {
    const value = await readJsonConfig(
      path.join(home, 'mcp.json'), MCP_LABEL['user'], maxFileBytes, 'user', readFindings, unreadable,
    );
    if (value !== undefined) input.mcpJson = value;
  }
  if (projectCursorDir !== undefined) {
    const value = await readJsonConfig(
      path.join(projectCursorDir, 'mcp.json'), MCP_LABEL['project'], maxFileBytes, 'project', readFindings, unreadable,
    );
    if (value !== undefined) input.projectMcpJson = value;
  }

  /* rules/*.mdc：项目级在前（更具体的作用域先被看到） */
  const rules: CursorRuleInput[] = [];
  if (projectCursorDir !== undefined) {
    rules.push(...(await readRules(path.join(projectCursorDir, 'rules'), 'project', maxFileBytes, readFindings, unreadable)));
  }
  if (homeStat !== null) {
    rules.push(...(await readRules(path.join(home, 'rules'), 'user', maxFileBytes, readFindings, unreadable)));
  }
  if (rules.length > 0) input.rules = rules;

  /* skills/**​/SKILL.md：项目级在前（同名先到先得 → 项目级胜出并报 skill-id-conflict） */
  const skills: CursorSkillInput[] = [];
  const skillStats: DirWalkStats & { truncated?: boolean } = {};
  if (projectCursorDir !== undefined) {
    skills.push(...(await findSkillUnits(path.join(projectCursorDir, 'skills'), maxSkillFiles, maxFileBytes, maxSkills, skillStats)));
  }
  if (homeStat !== null) {
    skills.push(...(await findSkillUnits(path.join(home, 'skills'), maxSkillFiles, maxFileBytes, maxSkills, skillStats)));
  }
  if (skillStats.truncated === true) {
    readFindings.push({ code: 'source-unreadable', origin: 'skills', detail: 'max-skills-reached', count: maxSkills });
  }
  // t36：技能文件遍历的条数/字节触顶同样必须可见（与 max-skills-reached 同族，共用同一口径）
  readFindings.push(...dirWalkSkips(skillStats, 'skills', maxSkillFiles));
  if (skills.length > 0) input.skills = skills;

  /* 旧式 .cursorrules：只 stat（正文连内存都不进） */
  const legacy = await legacyScopes(opts.homeDir, projectDir);
  if (legacy.length > 0) input.legacyRules = legacy;

  /* 会话：<home>/.cursor/projects/<slug>/agent-transcripts/<composer>/<composer>.jsonl */
  const sessions = await readCursorSessions(opts);
  readFindings.push(...(sessions.readFindings ?? []));
  if (sessions.files.length > 0) input.sessions = [...sessions.files];

  input.readFindings = readFindings;
  const hasData =
    input.mcpJson !== undefined ||
    input.projectMcpJson !== undefined ||
    (input.rules?.length ?? 0) > 0 ||
    (input.skills?.length ?? 0) > 0 ||
    legacy.length > 0;
  const found =
    (homeStat !== null && homeStat.isDirectory()) ||
    (projectStat !== null && projectStat.isDirectory()) ||
    hasData;
  return { found, home, projectDir, input, unreadable };
}
