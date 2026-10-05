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
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { isRecord } from '../utils/guards.ts';
import { splitFrontmatter } from './kernel.ts';
import type { ForeignSkip } from './types.ts';
import type { CursorInput, CursorRuleActivation, CursorRuleInput, CursorScope, CursorSkillInput } from './cursor.ts';

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

export interface CursorReadOptions extends CursorHomeOptions {
  /** 可选的项目目录（项目级 .cursor/ 与 .cursorrules 在这里；缺省 = 只读用户级） */
  projectDir?: string;
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
}

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
      if (out.length >= maxFiles) break;
      if (d.isSymbolicLink()) continue;
      const full = path.join(cur, d.name);
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await statOrNull(full);
      if (st === null || st.size > maxBytes) continue;
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
): Promise<CursorSkillInput[]> {
  const out: CursorSkillInput[] = [];
  const visit = async (dir: string, parents: string[]): Promise<void> => {
    if (out.length >= maxSkills || parents.length > MAX_SKILL_DEPTH) return;
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
      if (out.length >= maxSkills) break;
      const child = path.join(dir, name);
      if (await hasSkillMd(child)) {
        // 自带 SKILL.md 就是一个技能单元：它的子目录只作资产（walkFiles 递归带走），不再单独成技能
        const files = await walkFiles(child, child, maxFiles, maxBytes);
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

/* ---------------- 入口 ---------------- */

export async function readCursor(opts: CursorReadOptions): Promise<CursorReadResult> {
  const home = resolveCursorHome(opts);
  const projectDir = opts.projectDir;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const maxSkillFiles = opts.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES;
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
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
  if (projectCursorDir !== undefined) {
    skills.push(...(await findSkillUnits(path.join(projectCursorDir, 'skills'), maxSkillFiles, maxFileBytes, maxSkills)));
  }
  if (homeStat !== null) {
    skills.push(...(await findSkillUnits(path.join(home, 'skills'), maxSkillFiles, maxFileBytes, maxSkills)));
  }
  if (skills.length > 0) input.skills = skills;

  /* 旧式 .cursorrules：只 stat（正文连内存都不进） */
  const legacy = await legacyScopes(opts.homeDir, projectDir);
  if (legacy.length > 0) input.legacyRules = legacy;

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
