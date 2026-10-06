/**
 * kilocode（opencode 的 fork）用户目录的**读盘层** + 真值表路径 + 子会话/归档会话剔除。
 *
 * 真值表（chat-import discovery.mjs:130 + sources/kilocode.mjs:24,34,36,63,65；read-vault
 * §10.1 的 kilo 行核对为同一条）：
 *  三平台同形 `<home>/.local/share/kilo/kilo.db`（**注意目录名是 kilo，不是 kilocode**）；
 *  无环境变量覆盖；表形态 = session / message / part（同族读器）。
 *
 * **只导主会话**（竞品 sources/kilocode.mjs:33-34 口径）：子会话（`parent_id` 非空，subagent/分叉产物）
 * 与已归档会话（`time_archived` 非空）不进结果集。这两列是 Kilo 相对 opencode 的新增列，因此
 * **按列存在性判定**（缺列 = 旧库/降级形态，不误伤）。`parent_id = ''` 按「没有父会话」处理
 * （与竞品摘要查询的 `parent_id IS NULL OR parent_id = ''`、zcode 的 SQL 口径一致）。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 * 竞品在这里做过的一处**已知取舍**我们不复刻：它把「读不到」抛错（kilocode.mjs:49/74），
 * 而本仓库统一为「库层返回 null → 上层一条 source-unreadable」（t1 结论：不要两种语气并存）。
 */
import { pickString, posixShareDbPath, prefixCounts, readOpencodeFamily } from './read-opencode.ts';
import type { FamilyReadOptions, FamilySessionView, SqliteDeps, SqlitePathInput, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';

/** kilocode 的库：`<home>/.local/share/kilo/kilo.db` */
export function kilocodeDbPath(opts: SqlitePathInput): string {
  return posixShareDbPath(opts.platform, opts.homeDir, 'kilo', 'kilo.db');
}

/**
 * kilocode 的辅助会话判定（纯函数）：子会话（`parent_id` 非空）或已归档会话（`time_archived` 非空）。
 *
 * 列不存在（旧库/降级形态）时取不到值 → 判为非辅助（不误伤）；`time_archived = 0` 也是**非空**值
 * （对齐竞品 `time_archived IS NOT NULL` 的口径）。
 */
export function isKilocodeAuxSession(session: FamilySessionView): boolean {
  if (pickString(session.row, ['parent_id', 'parentId']) !== undefined) return true;
  const archived = session.row['time_archived'];
  return archived !== undefined && archived !== null && archived !== '';
}

/** 家族读器的逐源差异：跳过子会话与已归档会话 */
const KILOCODE_READ_OPTIONS: FamilyReadOptions = { dropSession: isKilocodeAuxSession };

export interface KilocodeReadOptions extends SqlitePathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`） */
export async function readKilocode(opts: KilocodeReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const read = await readOpencodeFamily(kilocodeDbPath(opts), 'kilo.db', opts.sqliteDeps, KILOCODE_READ_OPTIONS);
  return {
    files: read.files,
    readFindings: read.skipped,
    extraCounts: { 'kilocode.sessions': read.files.length, ...prefixCounts('kilocode', read.counts) },
  };
}
