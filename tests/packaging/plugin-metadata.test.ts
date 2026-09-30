import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 插件在 DSH 插件管理页里显示的标题/简介/头像，只来自两处声明（实现在
 * `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`，DSH >= 0.1.7-rc.1）：
 *   - `package.json` 顶层的 `icon`（相对路径，包内，SVG/PNG/JPEG/WebP，<= 256 KiB）
 *   - `locale/<语言 id>.json` 里的 `meta.title` / `meta.description`
 * 两处都必须经 `exports` 才读得到；`locale/en.json` 是「是否扫描该目录」的开关，
 * 且目录里**每个** .json 都要被 `./locale/*.json` 覆盖 —— 任何一个解析不到都会让
 * 整个元数据降级成 `{ error }`（界面退回包名 + 英文简介 + 默认图标）。
 * 这些失败在界面上是静默的，所以在这里逐条钉住。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON_MEDIA_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_ICON_BYTES = 256 * 1024;
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const manifest = readJson(join(ROOT, 'package.json'));
const exportsMap = manifest.exports as Record<string, unknown>;
const files = manifest.files as string[];

test('package.json 导出 DSH 读元数据所需的两条出口', () => {
  assert.equal(exportsMap['./package.json'], './package.json', '缺它则标题/简介/图标一起读不到');
  assert.equal(exportsMap['./locale/*.json'], './locale/*.json', '缺它则 locale 目录里每个文件都会解析失败');
});

test('icon 是包内相对路径、受支持格式、不超 256 KiB、且进 files 白名单', () => {
  const icon = manifest.icon;
  assert.equal(typeof icon, 'string', 'package.json 顶层必须有 icon 字段');
  const file = resolve(ROOT, icon as string);
  const local = relative(ROOT, file);
  assert.ok(!local.startsWith('..'), '图标必须留在包目录内（DSH 会对 realpath 后的位置做同样校验）');
  assert.ok(ICON_MEDIA_TYPES.has(extname(file).toLowerCase()), `图标扩展名必须是 ${[...ICON_MEDIA_TYPES].join('/')}`);
  assert.ok(statSync(file).size <= MAX_ICON_BYTES, '图标不得超过 256 KiB');
  assert.ok(files.includes(local), `${local} 必须写进 files，否则发布出去的包里没有它`);
});

test('locale 目录：en.json 存在、每个 .json 都是语言 id、且被 exports 通配符覆盖', () => {
  assert.ok(files.includes('locale'), 'locale 必须写进 files，否则发布出去的包里没有它');
  const dir = join(ROOT, 'locale');
  const entries = readdirSync(dir, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  assert.ok(jsonFiles.some((entry) => entry.name === 'en.json'), 'locale/en.json 是 DSH 扫描该目录的开关');
  for (const entry of jsonFiles) {
    assert.ok(LANGUAGE_ID.test(entry.name.slice(0, -'.json'.length)), `${entry.name} 必须是语言 id（如 zh.json、zh-CN.json）`);
  }
  for (const entry of entries) {
    assert.ok(!entry.isDirectory(), 'locale 必须是平铺目录，./locale/*.json 覆盖不到子目录');
  }
});

test('每个 locale 文件都带非空的 meta.title / meta.description', () => {
  const dir = join(ROOT, 'locale');
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = readJson(join(dir, entry.name));
    const meta = parsed.meta as Record<string, unknown> | undefined;
    assert.ok(meta !== undefined, `${entry.name} 缺少 meta（DSH 只读 meta.title / meta.description）`);
    for (const field of ['title', 'description'] as const) {
      // 显式 unknown：`meta` 经 assert.ok 窄化后 TS 无法推断该索引表达式的类型（TS7022 自引用推断）
      const value: unknown = meta[field];
      assert.ok(typeof value === 'string' && value.trim() !== '', `${entry.name} 的 meta.${field} 必须是非空字符串`);
    }
  }
});
