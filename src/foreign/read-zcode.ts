/**
 * zcode 用户目录的**读盘层** + 真值表路径。
 *
 * 真值表（chat-import discovery.mjs:131 + sources/zcode.mjs:27-30,37,65；read-sessions-manager
 * ⑧.4 第 9 行、read-vault §10.2 核对为同一条）：
 *  三平台同形 `<home>/.zcode/cli/db/db.sqlite`；无环境变量覆盖；
 *  表形态 = session / message / part（同族读器）；
 *  **message 表可能缺失**（极简/降级形态）——那时会话元数据仍在，但一条消息都读不到，
 *  由统一出口报 session-empty（绝不假装「没有会话」）。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 */
import { joinFor, normalizePlatform } from './platform-paths.ts';
import { prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';

/** zcode 的库：`<home>/.zcode/cli/db/db.sqlite`（三平台同形） */
export function zcodeDbPath(opts: SqlitePathInput): string {
  const platform = normalizePlatform(opts.platform);
  return joinFor(platform, opts.homeDir, '.zcode', 'cli', 'db', 'db.sqlite');
}

export interface ZcodeReadOptions extends SqlitePathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readZcode(opts: ZcodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(zcodeDbPath(opts), 'db.sqlite', opts.sqliteDeps);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'zcode.sessions': read.files.length, ...prefixCounts('zcode', read.counts) },
  };
}
