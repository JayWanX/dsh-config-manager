/**
 * Claude Code 用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 与 claude-code.ts 的纯翻译层分开：纯函数好测；读盘只做「读得到就读、读不到如实报」，
 * 绝不猜测、绝不静默截断（超限的文件直接不带，并计入 unreadable）。
 *
 * 安全边界：只读用户 home 下的固定位置（.claude / .claude.json），不跟随符号链接，
 * 单文件有字节上限；本层读到的**值**只交给纯翻译层，翻译层负责剥离凭据后才允许进包。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { ClaudeCodeInput, ClaudeSessionInput, ClaudeSkillInput, ForeignSkip } from './types.ts';

export interface ClaudeCodeReadOptions {
  /** 用户 home（含 .claude 目录 / .claude.json） */
  homeDir: string;
  /** 单文件读取上限（默认 8 MiB）；超过即不读，并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个 skill 目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 会话文件数上限（默认 500） */
  maxSessionFiles?: number;
  /** 单个会话文件的上限（默认 32 MiB）；超限即不读并计入 unreadable，绝不截断 */
  maxSessionFileBytes?: number;
}

export interface ClaudeCodeReadResult {
  /** 是否找到 Claude Code 的痕迹（~/.claude 目录或 ~/.claude.json） */
  found: boolean;
  input: ClaudeCodeInput;
  skipped: ForeignSkip[];
  /** 读不到 / 超限 / JSON 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SESSION_FILES = 500;
const DEFAULT_MAX_SESSION_FILE = 32 * 1024 * 1024;
/** 全局指令文件（CLAUDE.md）单独给上限：它是纯文本，正常只有几十 KB */
const MEMORY_MAX_FILE = 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

interface JsonRead { ok: boolean; value?: unknown }

async function readTextSafe(p: string, max: number): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > max) return null;
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonSafe(p: string, max: number): Promise<JsonRead> {
  const text = await readTextSafe(p, max);
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

interface SkillFile { relativePath: string; data: Uint8Array }

/** 递归收集一个 skill 目录下的普通文件（不跟随符号链接；条目数与单文件字节都有上限） */
async function walkFiles(
  root: string,
  start: string,
  maxFiles: number,
  maxBytes: number,
): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
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
        // 单个文件读不到就不带：该 skill 的成员数会随之少一个，用户在计数上看得见
      }
    }
  }
  return out;
}

async function readSkills(
  skillsDir: string,
  maxFiles: number,
  maxBytes: number,
): Promise<ClaudeSkillInput[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ClaudeSkillInput[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(skillsDir, d.name);
    const files = await walkFiles(dir, dir, maxFiles, maxBytes);
    if (files.length === 0) continue;
    out.push({ name: d.name, files });
  }
  return out;
}

/**
 * 会话文件：只扫 <projects>/<项目>/<uuid>.jsonl 这一层（不递归子目录、不跟随符号链接）。
 * 读不到 / 超限的文件**不静默跳过**：进 unreadable 并变成一条 source-unreadable finding。
 */
async function readSessions(
  projectsDir: string,
  maxFiles: number,
  maxBytes: number,
): Promise<{ files: ClaudeSessionInput[]; unreadable: string[] }> {
  const files: ClaudeSessionInput[] = [];
  const unreadable: string[] = [];
  let projectDirs: Dirent[];
  try {
    projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { files, unreadable };
  }
  for (const pd of projectDirs) {
    if (files.length >= maxFiles) break;
    if (!pd.isDirectory() || pd.isSymbolicLink()) continue;
    const dir = path.join(projectsDir, pd.name);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      if (!e.isFile() || e.isSymbolicLink()) continue;
      if (!e.name.endsWith('.jsonl')) continue;
      const rel = '.claude/projects/' + pd.name + '/' + e.name;
      const text = await readTextSafe(path.join(dir, e.name), maxBytes);
      if (text === null) {
        unreadable.push(rel);
        continue;
      }
      files.push({ id: e.name.slice(0, e.name.length - '.jsonl'.length), text });
    }
  }
  return { files, unreadable };
}

async function countCommands(commandsDir: string): Promise<number> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(commandsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const d of dirents) if (d.isFile()) n++;
  return n;
}

export async function readClaudeCode(opts: ClaudeCodeReadOptions): Promise<ClaudeCodeReadResult> {
  const home = opts.homeDir;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const maxSkillFiles = opts.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES;
  const skipped: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: ClaudeCodeInput = {};

  const claudeDir = path.join(home, '.claude');
  const dirStat = await statOrNull(claudeDir);
  const hasDir = dirStat !== null && dirStat.isDirectory();
  const jsonPath = path.join(home, '.claude.json');
  const hasLegacyJson = (await statOrNull(jsonPath)) !== null;
  if (!hasDir && !hasLegacyJson) return { found: false, input, skipped, unreadable };

  const jr = await readJsonSafe(jsonPath, maxFileBytes);
  if (jr.ok) input.claudeJson = jr.value;
  else if (hasLegacyJson) {
    unreadable.push('.claude.json');
    skipped.push({ code: 'source-unreadable', origin: '.claude.json' });
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  const sr = await readJsonSafe(settingsPath, maxFileBytes);
  if (sr.ok) input.settings = sr.value;
  else if ((await statOrNull(settingsPath)) !== null) {
    unreadable.push('.claude/settings.json');
    skipped.push({ code: 'source-unreadable', origin: '.claude/settings.json' });
  }

  const memoryPath = path.join(claudeDir, 'CLAUDE.md');
  const memory = await readTextSafe(memoryPath, MEMORY_MAX_FILE);
  if (memory !== null) input.memory = memory;
  else if ((await statOrNull(memoryPath)) !== null) {
    unreadable.push('.claude/CLAUDE.md');
    skipped.push({ code: 'source-unreadable', origin: '.claude/CLAUDE.md' });
  }

  const skills = await readSkills(path.join(claudeDir, 'skills'), maxSkillFiles, maxFileBytes);
  if (skills.length > 0) input.skills = skills;

  const commandCount = await countCommands(path.join(claudeDir, 'commands'));
  if (commandCount > 0) input.commandCount = commandCount;

  const sessions = await readSessions(
    path.join(claudeDir, 'projects'),
    opts.maxSessionFiles ?? DEFAULT_MAX_SESSION_FILES,
    opts.maxSessionFileBytes ?? DEFAULT_MAX_SESSION_FILE,
  );
  if (sessions.files.length > 0) input.sessions = sessions.files;
  for (const rel of sessions.unreadable) {
    unreadable.push(rel);
    skipped.push({ code: 'source-unreadable', origin: rel });
  }

  return { found: true, input, skipped, unreadable };
}
