/**
 * GitHub Copilot CLI（~/.copilot）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（契约 §8.2；**文档取证**：docs.github.com 的「GitHub Copilot CLI configuration directory」；
 * **本机无 ~/.copilot** —— 未经真机验证，取证强度如实标注）：
 *  - ~/.copilot/（config.json / mcp-config.json / permissions-config.json / agents/ / skills/ /
 *    hooks/ / logs/ / session-state/ / session-store.db / installed-plugins/ / ide/）
 *  - COPILOT_HOME 可整体替换该目录（命令行 --config-dir 优先级更高，但那是进程参数、不在 env 里）
 *  - copilot-instructions.md / instructions/*.instructions.md：官方 CLI 配置目录表里**没有列出**，
 *    那是 VS Code / 项目级约定 → 存在即读、不存在不报错，**绝不凭空造分区**
 *
 * 本层只做「读得到就读、读不到如实报」，绝不猜、绝不截断：
 *  ① 只读 home 下的固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② JSON 解析失败 → source-unreadable(detail=json-error)，**绝不抛**
 *  ③ 与 read-claude-code.ts / read-codex.ts / read-hermes.ts 同口径，但**刻意不互相 import 私有实现**：
 *     四个读盘层各自持有自己的边界与错误口径，真正共享的是纯内核 kernel.ts
 *
 * **范围**：本任务只搬 mcp-config.json、指令文件、skills/。其它文件（permissions / agents / hooks /
 * logs / session-state / session-store.db / installed-plugins / ide）不在本期范围：不读、不报，
 * 绝不因此产出 sessions/workspaces 分区。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { ForeignSkip } from './types.ts';
import type { CopilotInput, CopilotSkillInput } from './copilot.ts';

export interface CopilotHomeOptions {
  /** 用户 home（Windows = %USERPROFILE%，macOS/Linux = $HOME） */
  homeDir: string;
  /** 进程环境（只用于位置覆盖判定：COPILOT_HOME） */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface CopilotResolvedHome {
  /** Copilot CLI 配置目录绝对路径 */
  home: string;
  /** 是否由 COPILOT_HOME 覆盖（命中即报 source-location-overridden） */
  overridden: boolean;
}

/**
 * Copilot CLI 配置目录：COPILOT_HOME > ~/.copilot（三平台同形）。
 * 不猜、不回退到「看起来像」的目录 —— 解析出来的路径就是唯一候选。
 */
export function resolveCopilotHome(opts: CopilotHomeOptions): CopilotResolvedHome {
  const env = opts.env ?? {};
  const explicit = env['COPILOT_HOME'];
  if (typeof explicit === 'string' && explicit !== '') return { home: explicit, overridden: true };
  return { home: path.join(opts.homeDir, '.copilot'), overridden: false };
}

export interface CopilotReadOptions extends CopilotHomeOptions {
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
  /** instructions/*.instructions.md 的文件数上限（默认 100） */
  maxInstructionFiles?: number;
}

export interface CopilotReadResult {
  /** 是否找到 Copilot CLI 的痕迹（配置目录存在）；未安装是正常状态，不是错误 */
  found: boolean;
  /** 解析出的配置目录（诊断用） */
  home: string;
  locationOverridden: boolean;
  input: CopilotInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILLS = 500;
const DEFAULT_MAX_INSTRUCTION_FILES = 100;
/** 指令文件是纯文本，单独给上限（正常只有几十 KB） */
const INSTRUCTIONS_MAX_FILE = 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readTextSafe(p: string, max: number): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > max) return null;
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

interface JsonRead { ok: boolean; value?: unknown; empty: boolean }

async function readJsonSafe(p: string, max: number): Promise<JsonRead> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return { ok: false, empty: false };
  if (st.size === 0) return { ok: false, empty: true };
  if (st.size > max) return { ok: false, empty: false };
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return { ok: false, empty: false };
  }
  try {
    return { ok: true, value: JSON.parse(text), empty: false };
  } catch {
    return { ok: false, empty: false };
  }
}

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
      const full = path.join(cur, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { stack.push(full); continue; }
      if (!d.isFile()) continue;
      const st = await statOrNull(full);
      if (st === null || st.size > maxBytes) continue;
      try {
        const data = await fs.readFile(full);
        out.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), data });
      } catch {
        // 单个文件读不到就不带：该技能的成员数会随之少一个，用户在计数上看得见
      }
    }
  }
  return out;
}

async function hasSkillMd(dir: string): Promise<boolean> {
  const st = await statOrNull(path.join(dir, 'SKILL.md'));
  return st !== null && st.isFile();
}

interface SkillLimits { maxFiles: number; maxBytes: number; maxSkills: number }

/**
 * skills/ 的技能发现。
 *
 * 文档说 Copilot 个人技能是**一层** <名>/SKILL.md；但若用户手工嵌套（与 Hermes/Codex 同样的现实），
 * 判据与它们保持同一口径（不猜）：**目录自带 SKILL.md 就是一个技能**，子目录只作资产不再成技能；
 * 不带 SKILL.md 的目录继续下钻，技能名取**叶子目录名**、外层目录名作 category（→ 报
 * skill-category-flattened）；以 . 开头的不算技能；符号链接不跟随；目录名排序保证「先到先得」确定。
 */
async function readSkillsLevel(
  dir: string,
  depth: number,
  category: string | undefined,
  out: CopilotSkillInput[],
  limits: SkillLimits,
): Promise<void> {
  if (depth > 4) return;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = dirents
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirs) {
    if (out.length >= limits.maxSkills) return;
    const full = path.join(dir, d.name);
    if (await hasSkillMd(full)) {
      const files = await walkFiles(full, full, limits.maxFiles, limits.maxBytes);
      if (files.length === 0) continue;
      const unit: CopilotSkillInput = { name: d.name, files };
      if (category !== undefined) unit.category = category;
      out.push(unit);
      continue;
    }
    await readSkillsLevel(full, depth + 1, category ?? d.name, out, limits);
  }
}

/** instructions/*.instructions.md：只收文件名以 .instructions.md 结尾的普通文件（非空才收） */
async function readInstructionFiles(
  dir: string,
  maxFiles: number,
): Promise<{ name: string; text: string }[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = dirents
    .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.endsWith('.instructions.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: { name: string; text: string }[] = [];
  for (const d of files) {
    if (out.length >= maxFiles) break;
    const text = await readTextSafe(path.join(dir, d.name), INSTRUCTIONS_MAX_FILE);
    if (text === null || text.trim() === '') continue;
    out.push({ name: d.name, text });
  }
  return out;
}

export async function readCopilot(opts: CopilotReadOptions): Promise<CopilotReadResult> {
  const resolved = resolveCopilotHome(opts);
  const home = resolved.home;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const maxSkillFiles = opts.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES;
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxInstructionFiles = opts.maxInstructionFiles ?? DEFAULT_MAX_INSTRUCTION_FILES;
  const findings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: CopilotInput = {};

  if (resolved.overridden) {
    // 如实报告位置被覆盖（绝不静默换目录）；不把绝对路径写进 finding（那是机器身份）
    findings.push({ code: 'source-location-overridden', origin: 'COPILOT_HOME' });
  }

  const dirStat = await statOrNull(home);
  if (dirStat === null || !dirStat.isDirectory()) {
    input.readFindings = findings;
    return { found: false, home, locationOverridden: resolved.overridden, input, unreadable };
  }

  /* mcp-config.json（用户级 MCP） */
  const mcpPath = path.join(home, 'mcp-config.json');
  const mcpRead = await readJsonSafe(mcpPath, maxFileBytes);
  if (mcpRead.ok) {
    input.mcpConfig = mcpRead.value;
  } else if (mcpRead.empty) {
    findings.push({ code: 'source-empty-file', origin: 'mcp-config.json' });
  } else if ((await statOrNull(mcpPath)) !== null) {
    unreadable.push('mcp-config.json');
    findings.push({ code: 'source-unreadable', origin: 'mcp-config.json', detail: 'json-error' });
  }

  /* 指令文件：copilot-instructions.md，以及 instructions/*.instructions.md */
  const instructionsPath = path.join(home, 'copilot-instructions.md');
  const instructions = await readTextSafe(instructionsPath, INSTRUCTIONS_MAX_FILE);
  if (instructions !== null && instructions.trim() !== '') input.instructions = instructions;
  else if ((await statOrNull(instructionsPath)) !== null && instructions !== null) {
    findings.push({ code: 'source-empty-file', origin: 'copilot-instructions.md' });
  } else if ((await statOrNull(instructionsPath)) !== null) {
    unreadable.push('copilot-instructions.md');
    findings.push({ code: 'source-unreadable', origin: 'copilot-instructions.md' });
  }
  const extraInstructions = await readInstructionFiles(path.join(home, 'instructions'), maxInstructionFiles);
  if (extraInstructions.length > 0) input.instructionFiles = extraInstructions;

  /* skills/（一层；手工嵌套则压平） */
  const skills: CopilotSkillInput[] = [];
  await readSkillsLevel(path.join(home, 'skills'), 0, undefined, skills, {
    maxFiles: maxSkillFiles,
    maxBytes: maxFileBytes,
    maxSkills,
  });
  if (skills.length > 0) input.skills = skills;

  input.readFindings = findings;
  return { found: true, home, locationOverridden: resolved.overridden, input, unreadable };
}
