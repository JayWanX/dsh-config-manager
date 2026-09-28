/**
 * P-1 / P-2 / P-3 打包契约回归护栏（L1）。
 *
 * 背景：`package.json` 的 `peerDependenciesMeta`（16 个 peer 全 `optional`）与 `files`
 * （含 `!lib/**` + `*.map` 排除项）此前**没有任何自动化测试覆盖**——全库无测试读这两个字段，
 * 回归时不会报警（例如把 UI 包误加回 runtime `dependencies`，或删掉 sourcemap 排除项）。
 * P-3 补上 DSH 兼容闸关心的 `peerDependencies` 范围（issue #53）。
 *
 * 本文件只读 `package.json`，零依赖（`node:test` + `node:assert`），不触碰网络与磁盘其它位置。
 * 每一条断言都做过变异验证（见文件末注释）：把对应字段改坏必须红灯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJson {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
  exports?: Record<string, { types?: string; default?: string }>;
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;

/* ---------------------------------------------------------------- P-1: peers */

test('P-1: peerDependencies 的每一个键都在 peerDependenciesMeta 中且 optional === true', () => {
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};

  assert.ok(peers.length > 0, 'peerDependencies 不应为空');
  assert.ok(
    pkg.peerDependenciesMeta !== undefined,
    'peerDependenciesMeta 必须存在：缺少它时 npm 会尝试安装全部 peer（headless 消费者被迫装 React UI 栈）',
  );

  const missing = peers.filter((name) => meta[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `以下 peer 缺少 peerDependenciesMeta 条目（会被强制安装）: ${missing.join(', ')}`,
  );

  const notOptional = peers.filter((name) => meta[name]?.optional !== true);
  assert.deepEqual(
    notOptional,
    [],
    `以下 peer 的 optional 不为 true: ${notOptional.join(', ')}`,
  );

  // 数量一致：meta 里不得有 peer 之外的悬空键（防止改名后留下陈旧条目）
  const metaKeys = Object.keys(meta);
  assert.equal(
    metaKeys.length,
    peers.length,
    `peerDependenciesMeta 条目数（${metaKeys.length}）必须与 peerDependencies 键数（${peers.length}）一致`,
  );
  const stray = metaKeys.filter((name) => !peers.includes(name));
  assert.deepEqual(stray, [], `peerDependenciesMeta 含非 peer 键: ${stray.join(', ')}`);
});

test('P-1: dependencies 仅含 js-yaml（UI 包不得回到 runtime 依赖）', () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    deps,
    ['js-yaml'],
    `运行时 dependencies 只允许 js-yaml，实际: ${deps.join(', ') || '(空)'}。` +
      'lucide-react / @radix-ui/* 已由 tsdown alwaysBundle 内联进 lib/client.js，' +
      '放回 dependencies 会迫使 headless 消费者安装整套 React UI 栈。',
  );
  // 显式点名：即使将来允许更多 runtime 依赖，这两个也必须留在 devDependencies
  for (const ui of ['lucide-react', '@radix-ui/react-dialog']) {
    assert.ok(!deps.includes(ui), `${ui} 不得出现在 dependencies`);
  }
});

/* ---------------------------------------------------------------- P-2: files */

test('P-2: files 含 !lib/**/*.map 排除项', () => {
  const files = pkg.files;
  assert.ok(Array.isArray(files), 'files 必须是数组');
  assert.ok(
    files.includes('!lib/**/*.map'),
    `files 必须保留 '!lib/**/*.map' 排除项（否则 sourcemap 随包发布，体积显著增加）。实际: ${JSON.stringify(files)}`,
  );
});

test('P-2: files 仍包含 lib、src、cordis.patch.yml', () => {
  const files = pkg.files ?? [];
  for (const required of ['lib', 'src', 'cordis.patch.yml']) {
    assert.ok(files.includes(required), `files 必须包含 '${required}'。实际: ${JSON.stringify(files)}`);
  }
  // 排除项必须排在 'lib' 之后（npm 的 files 数组按顺序求值，顺序错则排除项失效）
  assert.ok(
    files.indexOf('!lib/**/*.map') > files.indexOf('lib'),
    "'!lib/**/*.map' 必须排在 'lib' 之后，否则排除不生效",
  );
});

/* ------------------------------------------------- exports["./schema"] 指向 */

test('exports["./schema"] 指向 lib/schema/index.{js,d.ts}（而非纯类型产物 types.js）', () => {
  const entry = pkg.exports?.['./schema'];
  assert.ok(entry !== undefined, 'exports["./schema"] 必须存在');
  assert.equal(entry.default, './lib/schema/index.js', 'default 必须指向 lib/schema/index.js');
  assert.equal(entry.types, './lib/schema/index.d.ts', 'types 必须指向 lib/schema/index.d.ts');
});
/* ---------------------------------- P-3: DSH peer 范围（issue #53，2026-09） */

/**
 * DSH ≥ 0.1.7 的兼容闸（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）对每一条
 * 形如 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 逐个跑
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，任一不满足 → 整份 bundle
 * 在启动时被跳过（stderr 只多一行 skipping profile bundle，进程照常起来、功能静默消失）。
 *
 * 为什么不能用「带预发布版的 caret」：semver 会给它补一个 `-0` 上界 ——
 *   validRange('^0.1.0-rc.6') === '>=0.1.0-rc.6 <0.2.0-0'
 * 于是 0.2.0 的任何预发布版（含 0.2.0-rc.1）都落在区间外 → 0.2 线整体被闸掉。
 *
 * 现行区间（显式上下界，`-0` 锚住整条 0.2 线的上界）：
 *   >=0.1.0-rc.6 <0.3.0-0
 * 实测（DSH 自带 semver，与闸门同一份实现）：
 *   0.1.0-rc.5 ✗ ｜ 0.1.0-rc.6 ✓ ｜ 0.1.5-rc.2 ✓ ｜ 0.1.7-rc.2 ✓ ｜ 0.2.0-rc.1 ✓ ｜ 0.2.0 ✓
 *   0.3.0-0 ✗ ｜ 0.3.0-rc.1 ✗ ｜ 1.0.0 ✗
 * 另用 dsh-app-boot@0.2.0-rc.1 的 `evaluatePluginCompatibility` 真跑过本插件 manifest：
 *   改前（^0.1.0-rc.6）+ runtime 0.2.0-rc.1 → INCOMPATIBLE（14 条 peer 全中）；
 *   改后 + runtime 0.1.5-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 → 全部 COMPATIBLE。
 */
const DSH_PEER_RANGE = '>=0.1.0-rc.6 <0.3.0-0';

test('P-3: 全部 @deepseek-ai/dsh* peer 都用显式上下界（不得回退到带预发布版的 caret）', () => {
  const dshPeers = Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
  assert.equal(
    dshPeers.length,
    14,
    `DSH peer 应恒为 14 条，实际 ${dshPeers.length}: ${dshPeers.map(([n]) => n).join(', ')}`,
  );
  for (const [name, range] of dshPeers) {
    assert.equal(
      range,
      DSH_PEER_RANGE,
      `${name} 的范围必须是 ${DSH_PEER_RANGE}（当前 ${range}）：带预发布版的 caret 上界是 <0.2.0-0，会把整条 0.2 线挡在兼容闸之外（issue #53）`,
    );
  }
});

test('P-3: 区间形态 = 显式下界 + `-0` 上界（caret/tilde 一律不匹配）', () => {
  const shape = /^>=\d+\.\d+\.\d+-[0-9A-Za-z.-]+ <\d+\.\d+\.\d+-0$/;
  assert.match(DSH_PEER_RANGE, shape, '必须是「显式下界 + -0 上界」形态');
  assert.ok(!/[\^~]/.test(DSH_PEER_RANGE), '区间不得使用 caret / tilde');
  // 变异验证：被禁形态必须真的不匹配，否则这条规则形同虚设
  for (const bad of ['^0.1.0-rc.6', '~0.1.0-rc.6', '^0.2.0-rc.1', '>=0.1.0-rc.6 <0.3.0']) {
    assert.ok(!shape.test(bad), `${bad} 不应通过形态校验`);
  }
});

