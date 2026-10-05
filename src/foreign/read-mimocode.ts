/**
 * mimocode（opencode 的 fork）用户目录的**读盘层** + 真值表路径。
 *
 * 真值表（chat-import discovery.mjs:126 + sources/mimocode.mjs：opencode fork、三表同构）：
 *  三平台同形 `<home>/.local/share/mimocode/mimocode.db`（**Windows 也不走 %APPDATA%**）；
 *  无环境变量覆盖；表形态 = session / message / part（含 V2 的 session_v2 / session_message）。
 *
 * 取证强度 = `fixture`（本机无该工具、真机未验证；用真实临时库夹具端到端跑同一形态）。
 * 读盘逻辑**不在这里重复实现**：三表 + JSON TEXT 列的解析与 opencode 完全同构，
 * 复用 `read-opencode.ts` 的家族读器（同一来源族只允许一份实现）。
 */
import { posixShareDbPath, prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';

/** mimocode 的库：`<home>/.local/share/mimocode/mimocode.db` */
export function mimocodeDbPath(opts: SqlitePathInput): string {
  return posixShareDbPath(opts.platform, opts.homeDir, 'mimocode', 'mimocode.db');
}

export interface MimocodeReadOptions extends SqlitePathInput {
  /** 仅测试注入（默认走 sqlite.ts 的真实能力探测与只读打开） */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`；读不到 = 0 文件 + source-unreadable，绝不抛） */
export async function readMimocode(opts: MimocodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(mimocodeDbPath(opts), 'mimocode.db', opts.sqliteDeps);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'mimocode.sessions': read.files.length, ...prefixCounts('mimocode', read.counts) },
  };
}
