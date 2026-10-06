/**
 * mimocode（opencode 的 fork）用户目录的**读盘层** + 真值表路径 + 后台任务会话剔除。
 *
 * 真值表（chat-import discovery.mjs:126 + sources/mimocode.mjs：opencode fork、三表同构）：
 *  三平台同形 `<home>/.local/share/mimocode/mimocode.db`（**Windows 也不走 %APPDATA%**）；
 *  无环境变量覆盖；表形态 = session / message / part（V2 的 session_v2 / session_message 同读）。
 *
 * **剔除后台任务会话**（竞品 sources/mimocode.mjs:28-38 的**双信号**口径）：mimocode 的记忆巩固 /
 * 工作流蒸馏后台任务（checkpoint-writer / Auto Dream / Auto Distill）无用户交互价值 —— 标题前缀与
 * 消息级 `data.agent` 任一命中即剔除；过滤在读盘层一处完成（导入与发现同口径）。
 *
 * 取证强度 = `fixture`（本机无该工具、真机未验证；用真实临时库夹具端到端跑同一形态）。
 * 读盘逻辑**不在这里重复实现**：三表 + JSON TEXT 列的解析与 opencode 完全同构，
 * 复用 `read-opencode.ts` 的家族读器（同一来源族只允许一份实现）。
 */
import { jsonCell, MESSAGE_DATA_KEYS, posixShareDbPath, prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { FamilyReadOptions, FamilySessionView, SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SqliteRow } from './sqlite.ts';
import type { SessionReadOutcome } from './session-source.ts';
import { isRecord } from '../utils/guards.ts';

/** mimocode 的库：`<home>/.local/share/mimocode/mimocode.db` */
export function mimocodeDbPath(opts: SqlitePathInput): string {
  return posixShareDbPath(opts.platform, opts.homeDir, 'mimocode', 'mimocode.db');
}

/** 后台任务会话的**标题**前缀（实测：`checkpoint-writer: ...` / `Auto Dream` / `Auto Distill`） */
const MIMOCODE_BG_TITLE = /^(checkpoint[-_ ]?writer|auto[-_ ]?(dream|distill))\b/i;
/** 后台任务会话的**消息级**标记（`message.data.agent`；与标题构成双信号，任一命中即真） */
const MIMOCODE_BG_AGENTS = new Set(['checkpoint-writer', 'dream', 'distill']);

/** 消息行的 `data.agent`（源侧字段；家族读器把消息行原样交给谓词，逐源自己抽取） */
function messageAgentOf(row: SqliteRow): string | undefined {
  const cell = jsonCell(row, MESSAGE_DATA_KEYS);
  if (!cell.ok || !isRecord(cell.value)) return undefined;
  const agent = cell.value['agent'];
  return typeof agent === 'string' && agent !== '' ? agent : undefined;
}

/** mimocode 后台任务会话判定（纯函数）：标题前缀或任一条消息 agent 命中即真 */
export function isMimocodeBackgroundSession(session: FamilySessionView): boolean {
  if (MIMOCODE_BG_TITLE.test(session.title.trim())) return true;
  for (const row of session.messages) {
    const agent = messageAgentOf(row);
    if (agent !== undefined && MIMOCODE_BG_AGENTS.has(agent.toLowerCase())) return true;
  }
  return false;
}

/** 家族读器的逐源差异：剔除后台任务会话（opencode / teleagent 不传，即全量） */
const MIMOCODE_READ_OPTIONS: FamilyReadOptions = { dropSession: isMimocodeBackgroundSession };

export interface MimocodeReadOptions extends SqlitePathInput {
  /** 仅测试注入（默认走 sqlite.ts 的真实能力探测与只读打开） */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`；读不到 = 0 文件 + source-unreadable，绝不抛） */
export async function readMimocode(opts: MimocodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(mimocodeDbPath(opts), 'mimocode.db', opts.sqliteDeps, MIMOCODE_READ_OPTIONS);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'mimocode.sessions': read.files.length, ...prefixCounts('mimocode', read.counts) },
  };
}
