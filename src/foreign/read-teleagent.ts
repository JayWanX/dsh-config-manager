/**
 * TeleAgent 用户目录的**读盘层** + 真值表路径（**每账户一个库**）。
 *
 * 真值表（chat-import discovery.mjs:127-129,1211-1223 + sources/teleagent.mjs:23-42；
 * read-vault §10.2 teleagent 行、read-sessions-manager ⑧.4 第 26 行核对为同一条）：
 *  - 根 = `<home>/.local/share/TeleAgent/users`（**Windows 也走 ~/.local/share**，issue #60 实测）
 *  - `$TELEAGENT_HOME` = **替换**基座（→ `<home>/users`），不是追加
 *  - 每账户一个库：`<users>/<账户>/teleagent.db`（opencode 三表同构 → 复用家族读器）
 *
 * 三层「不静默」：
 *  ① 账户目录存在但没有 teleagent.db = 正常（该账户没数据），不报码；
 *  ② 库存在但打不开 / 形状不符 = 一条 source-unreadable（详情码区分）；
 *  ③ 账户枚举在计数里如实回传（`teleagent.accounts` / `teleagent.databases`），
 *     「枚举到 0 个账户」与「枚举失败」不会都显示成 0。
 *
 * 取证强度 = `fixture`（真机未验证；真实临时库夹具 + 单测端到端）。
 */
import { absoluteEnvPath, joinFor, normalizePlatform, posixLocalShare } from './platform-paths.ts';
import { isDirectory, isFile, labelForPath, listDirNames } from './session-read.ts';
import { readOpencodeFamily } from './read-opencode.ts';
import type { SqliteDeps, SqliteSessionFile } from './read-opencode.ts';
import type { SessionReadOutcome } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

export interface TeleagentPathInput {
  readonly homeDir: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `$TELEAGENT_HOME`（**仅绝对路径**生效）替换基座 → `<base>/users`；否则 `~/.local/share/TeleAgent/users` */
export function teleagentUsersDir(opts: TeleagentPathInput): string {
  const platform = normalizePlatform(opts.platform);
  const explicit = absoluteEnvPath(opts.env, 'TELEAGENT_HOME', platform);
  const base = explicit !== undefined
    ? explicit
    : joinFor(platform, posixLocalShare(platform, opts.homeDir), 'TeleAgent');
  return joinFor(platform, base, 'users');
}

/** 账户名在真值表里是**路径段**：只接受单段名字（含分隔符/.. 的目录名一律不探测） */
function isSafeAccountName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  return name.indexOf('/') < 0 && name.indexOf(String.fromCharCode(92)) < 0;
}

export interface TeleagentReadOptions extends TeleagentPathInput {
  /** 仅测试注入 */
  readonly sqliteDeps?: SqliteDeps | undefined;
}

/** 读盘入口（wiring 的 `read`：枚举账户 → 每库一次家族读） */
export async function readTeleagent(opts: TeleagentReadOptions): Promise<SessionReadOutcome<SqliteSessionFile>> {
  const usersDir = teleagentUsersDir(opts);
  const files: SqliteSessionFile[] = [];
  const skipped: ForeignSkip[] = [];
  if (!(await isDirectory(usersDir))) {
    // 未安装：正常状态，不报码
    return { files: [], readFindings: [], extraCounts: { 'teleagent.accounts': 0, 'teleagent.databases': 0, 'teleagent.sessions': 0 } };
  }
  const accounts = (await listDirNames(usersDir)).filter(isSafeAccountName);
  const platform = normalizePlatform(opts.platform);
  let databases = 0;
  for (const account of accounts) {
    const dbFile = joinFor(platform, usersDir, account, 'teleagent.db');
    if (!(await isFile(dbFile))) continue;
    databases++;
    const read = await readOpencodeFamily(dbFile, labelForPath(opts.homeDir, dbFile), opts.sqliteDeps);
    files.push(...read.files);
    skipped.push(...read.skipped);
  }
  return {
    files,
    readFindings: skipped,
    extraCounts: {
      // 「枚举到几个账户」与「有几个库」必须分开可见：只有前者大、后者小 = 账户目录存在但没数据
      'teleagent.accounts': accounts.length,
      'teleagent.databases': databases,
      'teleagent.sessions': files.length,
    },
  };
}
