/**
 * Google Antigravity（~/.gemini）用户目录的**读盘**层（宿主侧，node:fs）。
 *
 * 位置真值（契约 §8.2）：
 *  - ~/.gemini/config/mcp_config.json（**全局** MCP）：**实测取证**（存在；本机 **0 字节**）
 *  - ~/.gemini/antigravity/mcp_config.json（IDE 侧同形位置）：**实测取证**（存在；0 字节）
 *  - ~/.gemini/antigravity/mcp_oauth_tokens.json：**凭据文件** → 只 stat、绝不读
 *  - ~/.gemini/antigravity-cli/**：本机实测存在（settings.json / conversations/ / knowledge/ /
 *    brain/ …），但契约**未冻结**其中哪些属于配置导入范围 → **本层不读、不报**，
 *    绝不因此产出 sessions/workspaces 分区
 *
 * 两个入口（**不移进 kernel** —— 其它来源的读盘层各自持有自己的边界，共享的是纯内核）：
 *  - resolveGeminiHome({ homeDir })：~/.gemini 的路径解析（三平台同形，无环境变量覆盖）
 *  - readAntigravity({ geminiDir })：直接对着一个已解析的 .gemini 目录读盘
 * 调参用 .gemini 目录而不是 homeDir：**位置解析与读盘解耦**，测试可以对着临时目录建
 * \`<任意目录>/config/mcp_config.json\`（绕开「点开头目录在测试环境里不好造」的问题），
 * 而且调用方（t22 的宿主装配）本来就要自己决定 homeDir。
 *
 * 本层只做「读得到就读、读不到如实报」，绝不猜、绝不截断；0 字节文件**绝不抛**：
 *  ① 只读固定位置、不跟随符号链接、单文件有字节上限（超限即**不读**并计入 unreadable）
 *  ② 0 字节 → source-empty-file（Antigravity 本机就是这种情形），随后**不解析、不产出任何分区**
 *  ③ JSON 解析失败 → source-unreadable(detail=json-error)
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ForeignSkip } from './types.ts';
import type { AntigravityInput } from './antigravity.ts';

/** Antigravity 的 gemini 目录名（真值表用一个值固定下来，调用方不该各写一份字符串） */
export const ANTIGRAVITY_GEMINI_DIR_NAME = '.gemini';

/**
 * ~/.gemini 的路径解析（三平台同形，无环境变量覆盖：契约 §8.2 没有给 Antigravity 列覆盖变量）。
 */
export function resolveGeminiHome(opts: { homeDir: string }): { dir: string } {
  return { dir: path.join(opts.homeDir, ANTIGRAVITY_GEMINI_DIR_NAME) };
}

export interface AntigravityReadOptions {
  /** 已解析的 .gemini 目录绝对路径（宿主用 resolveGeminiHome(...).dir） */
  geminiDir: string;
  /** 单文件读取上限（默认 8 MiB）；超过即不读并如实计入 unreadable */
  maxFileBytes?: number;
}

export interface AntigravityReadResult {
  /** 是否找到 Antigravity 的痕迹（.gemini 目录存在）；未安装是正常状态，不是错误 */
  found: boolean;
  /** 命中的相对路径（诊断用；**只允许路径，绝不含任何值**） */
  paths: string[];
  input: AntigravityInput;
  /** 读不到 / 超限 / 解析失败的**相对路径**（不含任何内容） */
  unreadable: string[];
}

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

interface JsonRead { ok: boolean; value?: unknown; empty: boolean; present: boolean }

async function readJsonSafe(p: string, max: number): Promise<JsonRead> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) return { ok: false, empty: false, present: false };
  if (st.size === 0) return { ok: false, empty: true, present: true };
  if (st.size > max) return { ok: false, empty: false, present: true };
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return { ok: false, empty: false, present: true };
  }
  try {
    return { ok: true, value: JSON.parse(text), empty: false, present: true };
  } catch {
    return { ok: false, empty: false, present: true };
  }
}

export async function readAntigravity(opts: AntigravityReadOptions): Promise<AntigravityReadResult> {
  const geminiDir = opts.geminiDir;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const findings: ForeignSkip[] = [];
  const unreadable: string[] = [];
  const paths: string[] = [];
  const input: AntigravityInput = {};

  const geminiStat = await statOrNull(geminiDir);
  if (geminiStat === null || !geminiStat.isDirectory()) {
    input.readFindings = findings;
    return { found: false, paths, input, unreadable };
  }

  /* 两个 mcp_config.json 位置都探测（全局在前，IDE 侧在后） */
  const mcpTargets: { rel: string; assign: (v: unknown) => void }[] = [
    { rel: 'config/mcp_config.json', assign: (v) => { input.globalMcp = v; } },
    { rel: 'antigravity/mcp_config.json', assign: (v) => { input.ideMcp = v; } },
  ];
  for (const t of mcpTargets) {
    const full = path.join(geminiDir, t.rel);
    const read = await readJsonSafe(full, maxFileBytes);
    if (!read.present) continue;
    paths.push(ANTIGRAVITY_GEMINI_DIR_NAME + '/' + t.rel);
    if (read.empty) {
      // 本机真值就是 0 字节：报码、不解析、绝不产出空 mcp 分区（见 convertAntigravity）
      findings.push({ code: 'source-empty-file', origin: t.rel });
      continue;
    }
    if (read.ok) { t.assign(read.value); continue; }
    unreadable.push(path.join(ANTIGRAVITY_GEMINI_DIR_NAME, t.rel).split(path.sep).join('/'));
    const size = (await statOrNull(full))?.size ?? 0;
    findings.push({
      code: 'source-unreadable',
      origin: t.rel,
      detail: size > maxFileBytes ? 'too-large' : 'json-error',
    });
  }

  /* 凭据文件：只 stat（值绝不读、绝不进内存、绝不进包） */
  const oauthRel = 'antigravity/mcp_oauth_tokens.json';
  if ((await statOrNull(path.join(geminiDir, 'antigravity', 'mcp_oauth_tokens.json'))) !== null) {
    paths.push(ANTIGRAVITY_GEMINI_DIR_NAME + '/' + oauthRel);
    input.oauthTokensPresent = true;
  }

  input.readFindings = findings;
  return { found: true, paths, input, unreadable };
}
