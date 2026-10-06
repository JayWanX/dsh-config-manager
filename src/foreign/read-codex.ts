/**
 * Codex CLI（~/.codex + ~/.agents/skills）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（契约 §8.2；**文档取证**：developers.openai.com/codex/config-basic +
 * learn.chatgpt.com 的 agent-configuration；本机无 ~/.codex —— 取证强度必须如实标注，见 §8.7）：
 *  - ~/.codex/config.toml（用户级；CODEX_HOME 可整体替换该目录）
 *  - ~/.codex/AGENTS.override.md **优先于** ~/.codex/AGENTS.md（全局层只取第一个非空文件）
 *  - ~/.agents/skills/<名>/SKILL.md（also 允许外层目录嵌套；本机实测 ~/.agents 目录存在且为空）
 *
 * 本层只做「读得到就读、读不到如实报」，绝不猜、绝不截断：
 *  ① 只读 home 下的固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② config.toml 走**自写的最小 TOML 子集解析器**（零新运行时依赖）。解析器自身**也不抛** ——
 *     失败返回 { ok:false, reason }，畸形输入一律变成 source-unreadable(detail=toml-error)
 *  ③ 指令文件按 Codex 发现层级选一个（命中 override 即报 instructions-override-selected）
 *  ④ 与 read-claude-code.ts / read-hermes.ts 同口径，但**刻意不互相 import 私有实现**：
 *     三个读盘层各自持有自己的边界与错误口径，真正共享的是纯内核 kernel.ts。
 *
 * **范围**：config.toml 的 [mcp_servers.*]、AGENTS(.override).md、~/.agents/skills，
 * 以及**会话**（2026-10-06 起）——双根 rollout：sessions/YYYY/MM/DD/rollout-*.jsonl 与
 * archived_sessions/rollout-*.jsonl（chat-import discovery.mjs:108-110）。
 * history.jsonl 仍不读（请求历史，不是会话转录；读了就是造垃圾会话）。
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

// 共享遍历器与本文件私有的 walkFiles（带文件内容）同名 → 显式别名，避免静默用错那一个
import { dirWalkSkips, resolveLimit, walkFiles as walkTree, type DirWalkStats } from './session-read.ts';
import { parseCodexRollout } from './codex.ts';
import type { ForeignLimitOverrides, ForeignSkip } from './types.ts';
import type { CodexInput, CodexSessionInput, CodexSkillInput } from './codex.ts';

export interface CodexHomeOptions {
  /** 用户 home（Windows = %USERPROFILE%，macOS/Linux = $HOME） */
  homeDir: string;
  /** 进程环境（只用于位置覆盖判定：CODEX_HOME） */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface CodexResolvedHome {
  /** Codex 配置目录绝对路径 */
  home: string;
  /** 是否由 CODEX_HOME 覆盖（命中即报 source-location-overridden） */
  overridden: boolean;
}

/**
 * Codex 配置目录：CODEX_HOME > ~/.codex（三平台同形）。
 * 不猜、不回退到「看起来像」的目录 —— 解析出来的路径就是唯一候选。
 */
export function resolveCodexHome(opts: CodexHomeOptions): CodexResolvedHome {
  const env = opts.env ?? {};
  const explicit = env['CODEX_HOME'];
  if (typeof explicit === 'string' && explicit !== '') return { home: explicit, overridden: true };
  return { home: path.join(opts.homeDir, '.codex'), overridden: false };
}

export interface CodexReadOptions extends CodexHomeOptions {
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
  /** 单个技能目录的文件数上限（默认 200） */
  maxSkillFiles?: number;
  /** 技能数上限（默认 500） */
  maxSkills?: number;
  /** 会话条数上限（默认 500；超过即报 max-sessions-reached） */
  maxSessions?: number;
  /** 可选上限覆盖（t36，装配层透传；缺省 = 上面各默认值逐字不变） */
  limits?: ForeignLimitOverrides;
}

export interface CodexReadResult {
  /** 是否找到 Codex 的痕迹（~/.codex 目录 或 ~/.agents/skills 目录）；未安装是正常状态 */
  found: boolean;
  /** 解析出的配置目录（诊断用） */
  home: string;
  locationOverridden: boolean;
  input: CodexInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILLS = 500;
/** 指令文件是纯文本，单独给上限（正常只有几十 KB） */
const INSTRUCTIONS_MAX_FILE = 1024 * 1024;
/** 技能目录的最大下钻深度（防病态深层树；超深即不再下钻） */
const MAX_SKILL_DEPTH = 4;

/* ---------------- 会话（rollout）常量 ---------------- */

/** rollout 双根（chat-import discovery.mjs:108-110）：sessions/YYYY/MM/DD 与扁平的 archived_sessions/ */
const SESSION_ROOTS: readonly string[] = ['sessions', 'archived_sessions'];
/** 会话文件名前缀：同目录别的 jsonl 不是会话转录 */
const ROLLOUT_PREFIX = 'rollout-';
/** 会话遍历的最大下钻深度（sessions/YYYY/MM/DD = 3 层，留一层余量） */
const SESSION_WALK_DEPTH = 4;
/** 会话条数上限（与 read-hermes 同口径，可被 limits.maxSessionFiles 覆盖） */
const DEFAULT_MAX_SESSIONS = 500;

/* ================= 最小 TOML 子集解析器（零依赖、绝不抛） ================= */

/**
 * 解析失败的原因。**稳定机器码、只描述结构、绝不含值**：
 * 调用方一律映射成 source-unreadable(detail=toml-error)，绝不把解析器异常抛给上层。
 */
export type TomlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

/** 内部信号：解析器只在自身内部抛，parse() 一定捕获（外部看到的永远是 ok:false） */
class TomlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'TomlError';
    this.reason = reason;
  }
}

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BARE_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const DIGITS = '0123456789';
const HEX = '0123456789abcdefABCDEF';

function isSpace(c: string): boolean { return c === ' ' || c === '\t'; }
function isNl(c: string): boolean { return c === NL || c === CR; }
function isBareKeyChar(c: string): boolean { return c !== '' && BARE_KEY_CHARS.indexOf(c) >= 0; }
function isDigit(c: string): boolean { return c !== '' && DIGITS.indexOf(c) >= 0; }
function isHex(c: string): boolean { return c !== '' && HEX.indexOf(c) >= 0; }

/**
 * 数值判定（不用 Number() 直接吃 token：那会把 0x10 / 1e 之类非法形态也当成数）。
 * 返回 null = 不是本子集认可的数值 → 调用方按「未类型化标量」原样保留。
 */
function numericValueOf(token: string): number | null {
  let s = token;
  let sign = 1;
  const head = s.charAt(0);
  if (head === '+' || head === '-') {
    if (head === '-') sign = -1;
    s = s.slice(1);
  }
  if (s === '') return null;
  let digits = 0;
  let dot = false;
  let inExp = false;
  let expDigits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '_') continue;
    if (isDigit(c)) { if (inExp) expDigits++; else digits++; continue; }
    if (c === '.' && !dot && !inExp) { dot = true; continue; }
    if ((c === 'e' || c === 'E') && !inExp && digits > 0) { inExp = true; continue; }
    if ((c === '+' || c === '-') && inExp && expDigits === 0) continue;
    return null;
  }
  if (digits === 0) return null;
  if (inExp && expDigits === 0) return null;
  const value = Number(s.split('_').join(''));
  return Number.isFinite(value) ? sign * value : null;
}

/** 按点分键路径写入（中间层不是普通对象就地建一层；同名标量按最后写入者胜出） */
function assignPath(container: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let cur = container;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] ?? '';
    const next = cur[k];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cur[k] = created;
    cur = created;
  }
  const last = keys[keys.length - 1];
  if (last === undefined) throw new TomlError('bad-key');
  cur[last] = value;
}

/** 表头路径解析：[a.b] 取既有表（或建一个）；[[a.b]] 追加新表并返回它 */
function descend(
  root: Record<string, unknown>,
  keys: readonly string[],
  arrayOfTables: boolean,
): Record<string, unknown> {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] ?? '';
    const isLast = i === keys.length - 1;
    const existing = cur[k];
    if (isLast && arrayOfTables) {
      let arr: unknown[];
      if (Array.isArray(existing)) arr = existing;
      else { arr = []; cur[k] = arr; }
      const created: Record<string, unknown> = {};
      arr.push(created);
      return created;
    }
    if (Array.isArray(existing)) {
      const lastEl = existing[existing.length - 1];
      if (typeof lastEl === 'object' && lastEl !== null && !Array.isArray(lastEl)) {
        if (isLast) return lastEl as Record<string, unknown>;
        cur = lastEl as Record<string, unknown>;
        continue;
      }
    }
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      if (isLast) return existing as Record<string, unknown>;
      cur = existing as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cur[k] = created;
    if (isLast) return created;
    cur = created;
  }
  return cur;
}

class TomlReader {
  private i = 0;
  private readonly s: string;
  private readonly n: number;

  constructor(s: string) {
    this.s = s;
    this.n = s.length;
  }

  parse(): TomlParseResult {
    const root: Record<string, unknown> = {};
    let current: Record<string, unknown> = root;
    try {
      for (;;) {
        this.skipWsAndComments();
        if (this.eof()) break;
        if (this.peek() === '[') {
          current = this.parseHeader(root);
          this.expectLineEnd();
          continue;
        }
        const keyPath = this.parseKeyPath();
        this.skipSpaces();
        if (this.peek() !== '=') throw new TomlError('missing-equals');
        this.i++;
        this.skipSpaces();
        const value = this.parseValue();
        assignPath(current, keyPath, value);
        this.expectLineEnd();
      }
      return { ok: true, value: root };
    } catch (e) {
      return { ok: false, reason: e instanceof TomlError ? e.reason : 'bad-value' };
    }
  }

  /* ---- 字符级原语 ---- */

  private peek(): string { return this.i < this.n ? this.s.charAt(this.i) : ''; }
  private eof(): boolean { return this.i >= this.n; }

  private skipSpaces(): void {
    while (!this.eof() && isSpace(this.peek())) this.i++;
  }

  private skipComment(): void {
    if (this.peek() !== '#') return;
    while (!this.eof() && !isNl(this.peek())) this.i++;
  }

  private skipWsAndComments(): void {
    for (;;) {
      this.skipSpaces();
      if (this.peek() === '#') { this.skipComment(); continue; }
      if (!this.eof() && isNl(this.peek())) { this.i++; continue; }
      return;
    }
  }

  /** 行尾：允许空白 + 注释 + 换行/EOF；其余字符 = 语法错误（绝不静默吃掉半行） */
  private expectLineEnd(): void {
    this.skipSpaces();
    if (this.peek() === '#') this.skipComment();
    if (this.eof()) return;
    if (isNl(this.peek())) { this.i++; return; }
    throw new TomlError('trailing-characters');
  }

  /* ---- 键 / 表头 ---- */

  private parseKeyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '' ) throw new TomlError('bad-key');
      let key: string;
      if (c === '"' || c === "'") {
        key = this.parseString();
      } else {
        let raw = '';
        while (isBareKeyChar(this.peek())) { raw += this.peek(); this.i++; }
        if (raw === '') throw new TomlError('bad-key');
        key = raw;
      }
      keys.push(key);
      this.skipSpaces();
      if (this.peek() === '.') { this.i++; continue; }
      return keys;
    }
  }

  private parseHeader(root: Record<string, unknown>): Record<string, unknown> {
    this.i++;
    const arrayOfTables = this.peek() === '[';
    if (arrayOfTables) this.i++;
    this.skipSpaces();
    const keyPath = this.parseKeyPath();
    this.skipSpaces();
    if (arrayOfTables) {
      if (this.peek() !== ']' || this.s.charAt(this.i + 1) !== ']') throw new TomlError('bad-header');
      this.i += 2;
    } else {
      if (this.peek() !== ']') throw new TomlError('bad-header');
      this.i++;
    }
    return descend(root, keyPath, arrayOfTables);
  }

  /* ---- 值 ---- */

  private parseValue(): unknown {
    const c = this.peek();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();
    if (c === '') throw new TomlError('bad-value');
    return this.parseScalar();
  }

  private parseString(): string {
    const q = this.peek();
    if (q === '"') {
      if (this.s.startsWith('"""', this.i)) return this.parseMultiline('"');
      return this.parseBasicString();
    }
    if (q === "'") {
      if (this.s.startsWith("'''", this.i)) return this.parseMultiline("'");
      return this.parseLiteralString();
    }
    throw new TomlError('bad-value');
  }

  private parseBasicString(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) throw new TomlError('unterminated-string');
      const c = this.peek();
      if (isNl(c)) throw new TomlError('unterminated-string');
      if (c === '"') { this.i++; return out; }
      if (c === '\\') { this.i++; out += this.readEscape(); continue; }
      out += c;
      this.i++;
    }
  }

  private parseLiteralString(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) throw new TomlError('unterminated-string');
      const c = this.peek();
      if (isNl(c)) throw new TomlError('unterminated-string');
      if (c === "'") { this.i++; return out; }
      out += c;
      this.i++;
    }
  }

  private parseMultiline(q: string): string {
    const triple = q + q + q;
    this.i += 3;
    if (this.peek() === CR) this.i++;
    if (this.peek() === NL) this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.n) throw new TomlError('unterminated-string');
      if (this.s.startsWith(triple, this.i)) { this.i += 3; return out; }
      const c = this.peek();
      if (q === '"' && c === '\\') {
        this.i++;
        if (isNl(this.peek()) || this.eof()) {
          if (isNl(this.peek())) this.i++;
          while (!this.eof() && (isSpace(this.peek()) || isNl(this.peek()))) this.i++;
          continue;
        }
        out += this.readEscape();
        continue;
      }
      if (c === CR) {
        out += NL;
        this.i++;
        if (this.peek() === NL) this.i++;
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private readEscape(): string {
    const c = this.peek();
    this.i++;
    if (c === 'n') return NL;
    if (c === 't') return '\t';
    if (c === 'r') return CR;
    if (c === '"') return '"';
    if (c === '\\') return '\\';
    if (c === 'b') return String.fromCharCode(8);
    if (c === 'f') return String.fromCharCode(12);
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      let hex = '';
      for (let k = 0; k < len; k++) {
        const h = this.peek();
        if (!isHex(h)) throw new TomlError('bad-escape');
        hex += h;
        this.i++;
      }
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code) || code > 0x10ffff) throw new TomlError('bad-escape');
      return String.fromCodePoint(code);
    }
    throw new TomlError('bad-escape');
  }

  private parseArray(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.eof()) throw new TomlError('unterminated-array');
      if (this.peek() === ']') { this.i++; return out; }
      out.push(this.parseValue());
      this.skipWsAndComments();
      const d = this.peek();
      if (d === ',') { this.i++; continue; }
      if (d === ']') { this.i++; return out; }
      throw new TomlError('bad-array');
    }
  }

  private parseInlineTable(): Record<string, unknown> {
    this.i++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      this.skipSpaces();
      if (this.eof()) throw new TomlError('unterminated-inline-table');
      if (this.peek() === '}') { this.i++; return obj; }
      const keyPath = this.parseKeyPath();
      this.skipSpaces();
      if (this.peek() !== '=') throw new TomlError('missing-equals');
      this.i++;
      this.skipSpaces();
      assignPath(obj, keyPath, this.parseValue());
      this.skipSpaces();
      const d = this.peek();
      if (d === ',') { this.i++; continue; }
      if (d === '}') { this.i++; return obj; }
      throw new TomlError('bad-inline-table');
    }
  }

  /**
   * 未加引号的标量：true/false/数值，其余（日期时间等）**原样作字符串**。
   * 刻意的宽松：本子集只做「结构解析」，不认识的标量形态保留原值 —— 绝不猜、也绝不吃掉。
   */
  private parseScalar(): unknown {
    const start = this.i;
    for (;;) {
      const c = this.peek();
      if (c === '' || isSpace(c) || isNl(c) || c === ',' || c === ']' || c === '}' || c === '#') break;
      this.i++;
    }
    const token = this.s.slice(start, this.i);
    if (token === '') throw new TomlError('bad-value');
    if (token === 'true') return true;
    if (token === 'false') return false;
    const num = numericValueOf(token);
    if (num !== null) return num;
    return token;
  }
}

/**
 * 解析 TOML 的最小有用子集：注释 / 空行 / 表头（[a.b]、[[a]]）/ 点分键 / 基本与字面量字符串
 * （含多行与转义）/ 整数与浮点 / 布尔 / 数组（可跨行、可尾逗号）/ 内联表。
 *
 * 刻意不做的：日期时间类型化（原样字符串）、字符串插值、UTF-16 代理对校验之外的 TOML 细节。
 * **任何失败都从返回值给出**（ok:false + 稳定 reason），绝不抛异常。
 */
export function parseTomlSubset(text: string): TomlParseResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new TomlReader(body).parse();
}

/* ================= 读盘 ================= */

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
      const full = path.join(cur, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { stack.push(full); continue; }
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
 * ~/.agents/skills 的技能发现。
 *
 * 判据（与 Hermes 同口径，不猜）：**目录自带 SKILL.md 就是一个技能**，它的子目录只作资产不再成技能；
 * 不带 SKILL.md 的目录继续下钻，技能名取**叶子目录名**，外层目录名作为 category（→ 报
 * skill-category-flattened）。DSH 技能是单层 <名>/SKILL.md，深层嵌套不压平就会「导入全绿但一个技能都不出现」。
 * 以 . 开头的目录/文件不是技能；符号链接不跟随；目录顺序先排序（同名冲突的「先到先得」必须确定）。
 */
async function readSkillsLevel(
  dir: string,
  depth: number,
  category: string | undefined,
  out: CodexSkillInput[],
  limits: SkillLimits,
  stats?: DirWalkStats & { truncated?: boolean },
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return;
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
    // 技能数触顶绝不静默（audit-foreign F4）：置标志，由调用方推一条 source-unreadable。
    if (out.length >= limits.maxSkills) { if (stats !== undefined) stats.truncated = true; return; }
    const full = path.join(dir, d.name);
    if (await hasSkillMd(full)) {
      const files = await walkFiles(full, full, limits.maxFiles, limits.maxBytes, stats);
      if (files.length === 0) continue;
      const unit: CodexSkillInput = { name: d.name, files };
      if (category !== undefined) unit.category = category;
      out.push(unit);
      continue;
    }
    await readSkillsLevel(full, depth + 1, category ?? d.name, out, limits, stats);
  }
}

/**
 * 全局指令文件的发现层级：AGENTS.override.md **优先于** AGENTS.md，只取第一个**非空**文件。
 * 命中 override 报 instructions-override-selected；空文件报 source-empty-file 后继续往下找
 * （绝不把「override 是空文件」当成「没有指令」而静默不报）。
 */
async function readInstructions(
  codexDir: string,
  findings: ForeignSkip[],
  unreadable: string[],
): Promise<string | undefined> {
  const overridePath = path.join(codexDir, 'AGENTS.override.md');
  const override = await readTextSafe(overridePath, INSTRUCTIONS_MAX_FILE);
  if (override !== null) {
    if (override.trim() !== '') {
      findings.push({ code: 'instructions-override-selected', origin: 'AGENTS.override.md' });
      return override;
    }
    findings.push({ code: 'source-empty-file', origin: 'AGENTS.override.md' });
  } else if ((await statOrNull(overridePath)) !== null) {
    unreadable.push('AGENTS.override.md');
    findings.push({ code: 'source-unreadable', origin: 'AGENTS.override.md' });
  }

  const basePath = path.join(codexDir, 'AGENTS.md');
  const base = await readTextSafe(basePath, INSTRUCTIONS_MAX_FILE);
  if (base !== null) {
    if (base.trim() !== '') return base;
    findings.push({ code: 'source-empty-file', origin: 'AGENTS.md' });
    return undefined;
  }
  if ((await statOrNull(basePath)) !== null) {
    unreadable.push('AGENTS.md');
    findings.push({ code: 'source-unreadable', origin: 'AGENTS.md' });
  }
  return undefined;
}

/* ================= 会话：读盘（源格式解析在 codex.ts 的纯函数里） ================= */

/** 会话读盘结果（0 会话也是正常结果；子代理 rollout 已剔除并在 readFindings 里报码） */
export interface CodexSessionPart {
  readonly files: readonly CodexSessionInput[];
  readonly readFindings: readonly ForeignSkip[];
}

/**
 * 读 <CODEX_HOME> 的**双根** rollout（sessions/YYYY/MM/DD 与扁平的 archived_sessions/）。
 *
 * 三条纪律：
 *  ① 只认 `rollout-*.jsonl`（同目录别的 jsonl 不是会话转录，读了就是造垃圾会话）；
 *  ② 子代理 rollout（thread_source=subagent / source.subagent）**剔除并报码**，绝不产出碎片会话；
 *  ③ 读不到 / 超限 / 触顶如实报码，绝不静默少读。
 */
export async function readCodexSessions(
  codexHome: string,
  maxSessions: number,
  maxBytes: number,
): Promise<CodexSessionPart> {
  const readFindings: ForeignSkip[] = [];
  const files: CodexSessionInput[] = [];
  let truncated = false;
  for (const rootName of SESSION_ROOTS) {
    if (files.length >= maxSessions) {
      truncated = true;
      break;
    }
    const root = path.join(codexHome, rootName);
    const stat = await statOrNull(root);
    if (stat === null || !stat.isDirectory()) continue; // 目录不存在 = 这里没有会话（不是错误）
    // 多收一个用来判定「还有没读完的」（walkFiles 到上限即停，不报触顶）
    const walked = await walkTree(root, {
      match: (name) => name.startsWith(ROLLOUT_PREFIX) && name.endsWith('.jsonl'),
      maxDepth: SESSION_WALK_DEPTH,
      maxFiles: maxSessions - files.length + 1,
    });
    for (const hit of walked) {
      if (files.length >= maxSessions) {
        truncated = true;
        break;
      }
      // origin 一律是包内相对标签（root/ 相对路径），绝不含机器路径
      const label = rootName + '/' + hit.rel;
      // 超限与读不到分开报：长会话 rollout 超过单文件上限时必须是 too-large，
      // 报成 read-error 会把「文件太大没读」说成「读失败」（排查方向完全不同）
      const fileStat = await statOrNull(hit.abs);
      if (fileStat !== null && fileStat.isFile() && fileStat.size > maxBytes) {
        readFindings.push({ code: 'source-unreadable', origin: label, detail: 'too-large' });
        continue;
      }
      const text = await readTextSafe(hit.abs, maxBytes);
      if (text === null) {
        readFindings.push({ code: 'source-unreadable', origin: label, detail: 'read-error' });
        continue;
      }
      const rollout = parseCodexRollout(text, hit.name);
      if (rollout.subagent !== null) {
        // 子代理 rollout 不是独立会话（对齐 claude/qoder 的「辅助 transcript 跳过」）
        readFindings.push({
          code: 'unsupported-session-record',
          origin: label,
          detail: 'codex-subagent:' + rollout.subagent,
          count: 1,
        });
        continue;
      }
      files.push({ id: rollout.id, parsed: rollout.parsed });
    }
  }
  if (truncated) {
    readFindings.push({ code: 'source-unreadable', origin: 'sessions', detail: 'max-sessions-reached', count: maxSessions });
  }
  return { files, readFindings };
}

export async function readCodex(opts: CodexReadOptions): Promise<CodexReadResult> {
  const resolved = resolveCodexHome(opts);
  const codexHome = resolved.home;
  const maxFileBytes = resolveLimit(opts.limits?.maxFileBytes, opts.maxFileBytes, DEFAULT_MAX_FILE);
  const maxSkillFiles = resolveLimit(opts.limits?.maxSkillFiles, opts.maxSkillFiles, DEFAULT_MAX_SKILL_FILES);
  const maxSkills = resolveLimit(opts.limits?.maxSkills, opts.maxSkills, DEFAULT_MAX_SKILLS);
  const maxSessions = resolveLimit(opts.limits?.maxSessionFiles, opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const findings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const input: CodexInput = {};

  if (resolved.overridden) {
    // 如实报告位置被覆盖（绝不静默换目录）；不把绝对路径写进 finding（那是机器身份）
    findings.push({ code: 'source-location-overridden', origin: 'CODEX_HOME' });
  }

  const codexStat = await statOrNull(codexHome);
  const hasCodexDir = codexStat !== null && codexStat.isDirectory();
  const skillsRoot = path.join(opts.homeDir, '.agents', 'skills');
  const skillsStat = await statOrNull(skillsRoot);
  const hasSkillsDir = skillsStat !== null && skillsStat.isDirectory();

  if (hasCodexDir) {
    /* config.toml（唯一的结构化配置来源） */
    const configPath = path.join(codexHome, 'config.toml');
    const cfgStat = await statOrNull(configPath);
    if (cfgStat !== null && cfgStat.isFile()) {
      if (cfgStat.size === 0) {
        findings.push({ code: 'source-empty-file', origin: 'config.toml' });
      } else if (cfgStat.size > maxFileBytes) {
        unreadable.push('config.toml');
        findings.push({ code: 'source-unreadable', origin: 'config.toml', detail: 'too-large' });
      } else {
        let text: string | null = null;
        try {
          text = await fs.readFile(configPath, 'utf8');
        } catch {
          unreadable.push('config.toml');
          findings.push({ code: 'source-unreadable', origin: 'config.toml', detail: 'read-error' });
        }
        if (text !== null) {
          const parsed = parseTomlSubset(text);
          if (parsed.ok) input.config = parsed.value;
          else {
            unreadable.push('config.toml');
            findings.push({ code: 'source-unreadable', origin: 'config.toml', detail: 'toml-error' });
          }
        }
      }
    }

    /* 全局指令（override 优先） */
    const instructions = await readInstructions(codexHome, findings, unreadable);
    if (instructions !== undefined) input.instructions = instructions;

    /* 会话：sessions/ 与 archived_sessions/ 双根 rollout（读得出就读，读不出如实报码） */
    const sessions = await readCodexSessions(codexHome, maxSessions, maxFileBytes);
    findings.push(...sessions.readFindings);
    if (sessions.files.length > 0) input.sessions = [...sessions.files];
  }

  if (!hasCodexDir && !hasSkillsDir) {
    input.readFindings = findings;
    return { found: false, home: codexHome, locationOverridden: resolved.overridden, input, unreadable };
  }

  /* ~/.agents/skills（一层或嵌套；嵌套压平并报码） */
  if (hasSkillsDir) {
    const skills: CodexSkillInput[] = [];
    const skillStats: DirWalkStats & { truncated?: boolean } = {};
    await readSkillsLevel(skillsRoot, 0, undefined, skills, {
      maxFiles: maxSkillFiles,
      maxBytes: maxFileBytes,
      maxSkills,
    }, skillStats);
    if (skillStats.truncated === true) {
      findings.push({ code: 'source-unreadable', origin: 'skills', detail: 'max-skills-reached', count: maxSkills });
    }
    // t36：技能文件遍历的条数/字节触顶同样必须可见（与 max-skills-reached 同族）
    findings.push(...dirWalkSkips(skillStats, 'skills', maxSkillFiles));
    if (skills.length > 0) input.skills = skills;
  }

  input.readFindings = findings;
  return { found: true, home: codexHome, locationOverridden: resolved.overridden, input, unreadable };
}
