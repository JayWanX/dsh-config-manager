/**
 * kilocode（opencode 的 fork）用户目录的**读盘层** + 真值表路径。
 *
 * 真值表（chat-import discovery.mjs:130 + sources/kilocode.mjs:24,34,36,63,65；read-vault
 * §10.1 的 kilo 行核对为同一条）：
 *  三平台同形 `<home>/.local/share/kilo/kilo.db`（**注意目录名是 kilo，不是 kilocode**）；
 *  无环境变量覆盖；表形态 = session / message / part（同族读器）。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 * 竞品在这里做过的一处**已知取舍**我们不复刻：它把「读不到」抛错（kilocode.mjs:49/74），
 * 而本仓库统一为「库层返回 null → 上层一条 source-unreadable」（t1 结论：不要两种语气并存）。
 */
import { posixShareDbPath, prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';

/** kilocode 的库：`<home>/.local/share/kilo/kilo.db` */
export function kilocodeDbPath(opts: SqlitePathInput): string {
  return posixShareDbPath(opts.platform, opts.homeDir, 'kilo', 'kilo.db');
}

export interface KilocodeReadOptions extends SqlitePathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readKilocode(opts: KilocodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(kilocodeDbPath(opts), 'kilo.db', opts.sqliteDeps);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'kilocode.sessions': read.files.length, ...prefixCounts('kilocode', read.counts) },
  };
}
