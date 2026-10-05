/**
 * Hermes（NousResearch/hermes-agent）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 与 hermes.ts 的纯翻译层分开：读盘只做「读得到就读、读不到如实报」，绝不猜、绝不截断。
 *
 * 位置真值（契约 §8.2，本机实测）：
 *  - Windows：%LOCALAPPDATA%\Hermes（本机实测；HERMES_HOME 可整体覆盖）
 *  - macOS / Linux：~/.hermes（官方文档 hermes-agent.nousresearch.com/docs/user-guide/configuration）
 *
 * 四条安全边界（与 read-claude-code.ts 同口径；**刻意不 import 它的私有实现** ——
 * 每个读盘层自带边界与错误口径，真正共享的是纯内核 kernel.ts）：
 *  ① 只读 home 下的固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② .env **只 stat 不读**：值连内存都不进（凭据铁律）
 *  ③ memories/*.md **只列名不读内容**（用户决策：只报告不导入）
 *  ④ 分类目录名与技能名只在内存里做映射，绝不参与写盘路径（写盘路径由翻译层按规定生成）
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import type { ForeignSkip, HermesInput, HermesSkillInput } from './types.ts';

export interface HermesHomeOptions {
  /** 用户 home（Windows 一般传 %USERPROFILE%） */
  homeDir: string;
  /** 进程环境（只用于位置覆盖判定：HERMES_HOME / LOCALAPPDATA） */
  env?: Readonly<Record<string, string | undefined>>;
  /** 平台（缺省 = process.platform；测试注入） */
  platform?: string;
}

export interface HermesResolvedHome {
  /** Hermes 数据目录绝对路径 */
  home: string;
  /** 是否由 HERMES_HOME 覆盖（命中即报 source-location-overridden） */
  overridden: boolean;
}

/**
 * Hermes 数据目录：HERMES_HOME > Windows 的 %LOCALAPPDATA%\Hermes > ~/.hermes。
 * 不猜、不回退到「看起来像」的目录：解析出来的路径就是唯一候选。
 */
export function resolveHermesHome(opts: HermesHomeOptions): HermesResolvedHome {
  const env = opts.env ?? {};
  const explicit = env['HERMES_HOME'];
  if (typeof explicit === 'string' && explicit !== '') return { home: explicit, overridden: true };
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    const lad = env['LOCALAPPDATA'];
    const base = typeof lad === 'string' && lad !== '' ? lad : path.join(opts.homeDir, 'AppData', 'Local');
    return { home: path.join(base, 'Hermes'), overridden: false };
  }
  return { home: path.join(opts.homeDir, '.hermes'), overridden: false };
}

export interface HermesReadOptions extends HermesHomeOptions {
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
}

export interface HermesReadResult {
  /** 是否找到 Hermes 数据目录（未安装是正常状态，不是错误） */
  found: boolean;
  /** 解析出的数据目录（诊断用） */
  home: string;
  locationOverridden: boolean;
  input: HermesInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILLS = 500;
/** SOUL.md 是纯文本身份文件，单独给上限（正常只有几百字节） */
const SOUL_MAX_FILE = 1024 * 1024;

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

/** 递归收集一个目录下的普通文件（不跟随符号链接；条目数与单文件字节都有上限） */
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

/**
 * skills/ 的两层形态（本机实测：24 个分类，其中 5 个分类目录自己带 SKILL.md、19 个分类下挂技能目录）。
 *
 * 判定（不猜）：
 *  - 分类目录自己带 SKILL.md → 该分类就是一个技能（子目录是它的资产，不再单独当技能）；
 *  - 否则遍历它的子目录：带 SKILL.md 的才是一个技能（技能名取**叶子目录名** = 压平分类），
 *    不带 SKILL.md 的子目录是资产，既不产出也不报错。
 *  - 以 . 开头的目录/文件不是技能（.hub / .curator_backups / .bundled_manifest / .usage.json …）。
 */
async function readSkills(
  skillsDir: string,
  maxFiles: number,
  maxBytes: number,
  maxSkills: number,
): Promise<HermesSkillInput[]> {
  let categories: Dirent[];
  try {
    categories = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: HermesSkillInput[] = [];
  for (const c of categories) {
    if (out.length >= maxSkills) break;
    if (!c.isDirectory() || c.isSymbolicLink()) continue;
    if (c.name.startsWith('.')) continue;
    const catDir = path.join(skillsDir, c.name);
    if (await hasSkillMd(catDir)) {
      const files = await walkFiles(catDir, catDir, maxFiles, maxBytes);
      if (files.length > 0) out.push({ name: c.name, files });
      continue;
    }
    let subs: Dirent[];
    try {
      subs = await fs.readdir(catDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (out.length >= maxSkills) break;
      if (!s.isDirectory() || s.isSymbolicLink()) continue;
      if (s.name.startsWith('.')) continue;
      const skillDir = path.join(catDir, s.name);
      if (!(await hasSkillMd(skillDir))) continue;
      const files = await walkFiles(skillDir, skillDir, maxFiles, maxBytes);
      if (files.length === 0) continue;
      out.push({ name: s.name, files, category: c.name });
    }
  }
  return out;
}

/** memories/ 下的记忆文件名（**只列名**；.lock 之类的伴随文件不算） */
async function memoryFileNames(memoriesDir: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(memoriesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    if (!d.isFile() || d.isSymbolicLink()) continue;
    if (!d.name.endsWith('.md')) continue;
    out.push(d.name);
  }
  return out.sort();
}

export async function readHermes(opts: HermesReadOptions): Promise<HermesReadResult> {
  const resolved = resolveHermesHome(opts);
  const home = resolved.home;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const maxSkillFiles = opts.maxSkillFiles ?? DEFAULT_MAX_SKILL_FILES;
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
  const readFindings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: HermesInput = {};

  if (resolved.overridden) {
    // 如实报告位置被覆盖（绝不静默换目录）；不把绝对路径写进 finding（那是机器身份）
    readFindings.push({ code: 'source-location-overridden', origin: 'HERMES_HOME' });
  }

  const dirStat = await statOrNull(home);
  if (dirStat === null || !dirStat.isDirectory()) {
    input.readFindings = readFindings;
    return { found: false, home, locationOverridden: resolved.overridden, input, unreadable };
  }

  /* config.yaml（唯一的结构化配置来源） */
  const configPath = path.join(home, 'config.yaml');
  const cfgStat = await statOrNull(configPath);
  if (cfgStat !== null && cfgStat.isFile()) {
    if (cfgStat.size === 0) {
      readFindings.push({ code: 'source-empty-file', origin: 'config.yaml' });
    } else if (cfgStat.size > maxFileBytes) {
      unreadable.push('config.yaml');
      readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'too-large' });
    } else {
      let text: string | null = null;
      try {
        text = await fs.readFile(configPath, 'utf8');
      } catch {
        unreadable.push('config.yaml');
        readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'read-error' });
      }
      if (text !== null && text !== '') {
        try {
          input.config = yaml.load(text);
        } catch {
          unreadable.push('config.yaml');
          readFindings.push({ code: 'source-unreadable', origin: 'config.yaml', detail: 'yaml-error' });
        }
      }
    }
  }

  /* SOUL.md = 主身份（导入） */
  const soulPath = path.join(home, 'SOUL.md');
  const soul = await readTextSafe(soulPath, SOUL_MAX_FILE);
  if (soul !== null) input.soul = soul;
  else if ((await statOrNull(soulPath)) !== null) {
    unreadable.push('SOUL.md');
    readFindings.push({ code: 'source-unreadable', origin: 'SOUL.md' });
  }

  /* skills/（两层分类） */
  const skills = await readSkills(path.join(home, 'skills'), maxSkillFiles, maxFileBytes, maxSkills);
  if (skills.length > 0) input.skills = skills;

  /* memories/（只列名） */
  const memoryFiles = await memoryFileNames(path.join(home, 'memories'));
  if (memoryFiles.length > 0) input.memoryFiles = memoryFiles;

  /* .env（只 stat） */
  const envStat = await statOrNull(path.join(home, '.env'));
  if (envStat !== null && envStat.isFile()) input.dotEnvPresent = true;

  /* 对话存储（只判存在） */
  const dbStat = await statOrNull(path.join(home, 'state.db'));
  if (dbStat !== null && dbStat.isFile()) {
    input.sessionStore = { present: true, detail: 'state.db' };
  } else {
    const sessStat = await statOrNull(path.join(home, 'sessions'));
    if (sessStat !== null && sessStat.isDirectory()) input.sessionStore = { present: true, detail: 'sessions/' };
  }

  input.readFindings = readFindings;
  return { found: true, home, locationOverridden: resolved.overridden, input, unreadable };
}
