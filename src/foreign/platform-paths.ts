/**
 * **目标平台**的目录真值（档 B 全量来源的共享地基，零 I/O、零依赖）。
 *
 * 为什么参数里必须有 `platform`（不是洁癖，是取证纪律）：竞品 dsh-chat-import 的
 * `defaultRoots({home})` 在 Windows 上用 `joinFor('win32', ...)` **按目标平台**拼接，
 * 因此「在任一台机器上算出 Windows 真值路径」是它的既有能力（`convert/goose.mjs:48-50` 同款）。
 * 我们若用 `process.platform` 拼路径，同一个函数在三平台 CI 上会给出三种结果：
 * Windows 分支在 macOS/Linux 的测试进程里**永远跑不到**，单测就无法离线覆盖真值表。
 * ⇒ 规则：**真值表函数必须显式收 platform**；只有装配层（`registry.ts`）在把宿主事实
 * 投影进 `ForeignSourceContext` 时才允许碰 `process.platform`（全仓唯一一处）。
 *
 * 两个基准函数的区别（**别混用**）：
 *  · `roamingAppDataDir` = **配置风格**目录（VS Code 的 `<User>`：win `%APPDATA%`、
 *    mac `~/Library/Application Support`、linux `$XDG_CONFIG_HOME|~/.config`）；
 *  · `xdgDataHome` = **数据风格**目录（crush / zed：win `%LOCALAPPDATA%`、
 *    mac `~/Library/Application Support`、linux `$XDG_DATA_HOME|~/.local/share`）。
 */

/** 三个被四份调研报告共同承认的目标平台 */
export type ForeignPlatform = 'win32' | 'darwin' | 'linux';

/**
 * 归一化平台取值：不认识的平台（aix / freebsd / android / 空串）一律按 **linux（posix）** 处理，
 * 与 Node 自己「非 win32 即 posix」的口径一致；**绝不**当成 win32
 * （那会让分隔符、%APPDATA%、VS Code 目录三件事同时错）。
 */
export function normalizePlatform(raw: string | undefined | null): ForeignPlatform {
  if (raw === 'win32') return 'win32';
  if (raw === 'darwin') return 'darwin';
  return 'linux';
}

/** 反斜杠字符（本模块刻意不写转义字面量，跨层写入时不易被解释掉） */
const BS = String.fromCharCode(92);

/** 目标平台的分隔符（**不是** path.sep —— 那取决于运行平台） */
export function sepFor(platform: ForeignPlatform): string {
  return platform === 'win32' ? BS : '/';
}

/** 段间拼接（按目标平台的分隔符；空段跳过；前导分隔符与盘符原样保留） */
export function joinFor(platform: ForeignPlatform, ...parts: readonly string[]): string {
  const sep = sepFor(platform);
  let out = '';
  for (const part of parts) {
    if (part === '') continue;
    if (out === '') { out = part; continue; }
    const last = out.charAt(out.length - 1);
    if (last === '/' || last === BS) out += part;
    else out += sep + part;
  }
  return out;
}

/** 目标平台下的绝对路径判定（Windows 认盘符与 UNC；posix 认前导 /） */
export function isAbsoluteFor(platform: ForeignPlatform, p: string): boolean {
  if (p === '') return false;
  if (platform === 'win32') {
    if (p.startsWith(BS + BS)) return true; // UNC
    if (p.length < 3) return false;
    const upper = p.charAt(0).toUpperCase();
    if (upper < 'A' || upper > 'Z') return false;
    if (p.charAt(1) !== ':') return false;
    const third = p.charAt(2);
    return third === BS || third === '/';
  }
  return p.charAt(0) === '/';
}

/** 环境变量的**非空**字符串取值（空串与缺失同解：绝不把 '' 当成一个目录） */
export function envValue(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const raw = env[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * 目标平台下的「绝对路径环境变量」取值：竞品的 `GOOSE_PATH_ROOT` / `CRUSH_GLOBAL_DATA` /
 * `XDG_*` 都有一条共同语义 —— **只有绝对路径才生效**（相对路径忽略，绝不 join 到 home 上）。
 */
export function absoluteEnvPath(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: ForeignPlatform,
): string | undefined {
  const raw = envValue(env, key);
  if (raw === undefined || !isAbsoluteFor(platform, raw)) return undefined;
  return raw;
}

/**
 * **配置风格**的平台基准目录：win32 = `%APPDATA%`（缺失回落 `<home>\\AppData\\Roaming`）；
 * darwin = `~/Library/Application Support`；linux = `$XDG_CONFIG_HOME`（绝对才生效）→ `~/.config`。
 * 这就是 VS Code 系（trae / cline legacy）产品数据根的基准，也是 `XDG_CONFIG_HOME` 的唯一消费者。
 */
export function roamingAppDataDir(
  platform: ForeignPlatform,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA');
    return appData !== undefined ? appData : joinFor('win32', homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') return joinFor('darwin', homeDir, 'Library', 'Application Support');
  const xdg = absoluteEnvPath(env, 'XDG_CONFIG_HOME', 'linux');
  return xdg !== undefined ? xdg : joinFor('linux', homeDir, '.config');
}

/**
 * **数据风格**的平台基准目录：win32 = `%LOCALAPPDATA%`（缺失回落 `<home>\\AppData\\Local`）；
 * darwin = `~/Library/Application Support`；linux = `$XDG_DATA_HOME`（**仅绝对、仅 linux 列**）
 * → `~/.local/share`。crush / zed 的默认根基准即此。
 */
export function xdgDataHome(
  platform: ForeignPlatform,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    const local = envValue(env, 'LOCALAPPDATA');
    return local !== undefined ? local : joinFor('win32', homeDir, 'AppData', 'Local');
  }
  if (platform === 'darwin') return joinFor('darwin', homeDir, 'Library', 'Application Support');
  const xdg = absoluteEnvPath(env, 'XDG_DATA_HOME', 'linux');
  return xdg !== undefined ? xdg : joinFor('linux', homeDir, '.local', 'share');
}

/**
 * VS Code 系产品的用户数据目录：`<User>`（其下有 `workspaceStorage` / `globalStorage`）。
 *
 * 三分支逐字对齐竞品 `traeUserDataDirs` / `clineLegacyStorageDirs`：
 *  win32 = `%APPDATA%/<product>/User`；darwin = `~/Library/Application Support/<product>/User`；
 *  linux = `$XDG_CONFIG_HOME|<~/.config>/<product>/User`。
 */
export function vscodeUserDataDir(
  platform: ForeignPlatform,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  product: string,
): string {
  return joinFor(platform, roamingAppDataDir(platform, homeDir, env), product, 'User');
}

/**
 * 三平台同形的 `~/.local/share`（竞品 opencode 家族的真值：**Windows 也不走 %APPDATA%**）。
 * 用目标平台的分隔符拼接，因此 win32 下给出 `<home>\\AppData` 之外的 `<home>\\.local\\share\\...`
 * —— 这正是竞品在 Windows 上真实扫描的位置（`discovery.mjs:125-131`）。
 */
export function posixLocalShare(platform: ForeignPlatform, homeDir: string): string {
  return joinFor(platform, homeDir, '.local', 'share');
}

/** 把任意分隔符形态的串归一成 POSIX 形态（**位置标签**与人读文案一律 POSIX） */
export function toPosixLabel(p: string): string {
  return p.split(BS).join('/');
}
