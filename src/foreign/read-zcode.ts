/**
 * zcode 用户目录的**读盘层** + 真值表路径 + 主会话过滤。
 *
 * 真值表（chat-import discovery.mjs:131 + sources/zcode.mjs:27-30,37,65；read-sessions-manager
 * ⑧.4 第 9 行、read-vault §10.2 核对为同一条）：
 *  三平台同形 `<home>/.zcode/cli/db/db.sqlite`；无环境变量覆盖；
 *  表形态 = session / message / part（同族读器）；
 *  **message 表可能缺失**（极简/降级形态）——那时会话元数据仍在，但一条消息都读不到，
 *  由统一出口报 session-empty（绝不假装「没有会话」）。
 *
 * **只导主会话**（竞品 sources/zcode.mjs:62 的 `WHERE parent_id IS NULL OR parent_id = ''`）：
 * 非空 `parent_id` = 子会话（subagent/分叉产物），不进结果集；`''` 与 NULL 同等视为没有父会话。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 */
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { pickString, prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { FamilyReadOptions, FamilySessionView, SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';

/** zcode 的库：`<home>/.zcode/cli/db/db.sqlite`（三平台同形） */
export function zcodeDbPath(opts: SqlitePathInput): string {
  const platform = normalizePlatform(opts.platform);
  return joinFor(platform, opts.homeDir, '.zcode', 'cli', 'db', 'db.sqlite');
}

/** zcode 的子会话判定（纯函数）：`parent_id` 非空 = 子会话；`''` 与 NULL 同等视为主会话 */
export function isZcodeChildSession(session: FamilySessionView): boolean {
  return pickString(session.row, ['parent_id', 'parentId']) !== undefined;
}

/** 家族读器的逐源差异：只导主会话（竞品 `parent_id IS NULL OR parent_id = ''`） */
const ZCODE_READ_OPTIONS: FamilyReadOptions = { dropSession: isZcodeChildSession };

export interface ZcodeReadOptions extends SqlitePathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readZcode(opts: ZcodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(zcodeDbPath(opts), 'db.sqlite', opts.sqliteDeps, ZCODE_READ_OPTIONS);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'zcode.sessions': read.files.length, ...prefixCounts('zcode', read.counts) },
  };
}
