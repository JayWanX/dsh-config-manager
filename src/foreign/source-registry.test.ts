/**
 * **来源清单收敛为单一事实源**的护栏（t4 验收项 ③）。
 *
 * 背景（逐处核见 outputs/competitor-recon-2026-10-05/read-chat-import.md §8.2）：加第 N 个来源
 * 此前要动**至少 9 处**，其中能被编译挡住的只有一处（`ui/foreign-view.ts` 的 `Record<ForeignSourceId, …>`），
 * 其余靠人肉同步 —— 漏掉的**静默降级**（UI 显示裸 key `foreign.source.<src>`、CLI help 与本机能力
 * 不一致、契约文档与实现分叉）。
 *
 * 收敛后的口径：**`source-modules.ts` 的 `FOREIGN_SOURCE_MODULE_SHAPES` 是单一事实源**，
 * 本文件把「其余每一处清单」都反查回它 —— 任一处漏配/漂移即红灯。
 *
 * 为什么断言要**读源码文本**而不是 import：这四处硬编码本来就活在**测试文件**与 **CLI 源码**里
 * （`registry.test.ts` / `routes/foreign.test.ts` / `cli/import-source.test.ts` /
 * `ui/foreign-view.test.ts` / `cli/index.ts`），import 它们等于把「别人的测试」当库用。
 * 范式照抄本仓库既有的源码级守卫 `tests/packaging-contract.test.ts`（正则读 `PLUGIN_VERSION`）。
 *
 * 覆盖面（每条漏配都会让某处的用户看到不一致的东西）：
 *  1. 运行期词表 `FOREIGN_SOURCE_IDS`（registry.ts）
 *  2. 注册表装配 `builtinForeignSources()`（registry.ts，运行期真值，import 后逐项比对）
 *  3. `registry.test.ts` 的冻结快照
 *  4. `routes/foreign.test.ts` 的硬编码快照
 *  5. `cli/import-source.test.ts` 的硬编码循环
 *  6. `ui/foreign-view.test.ts` 的硬编码清单
 *  7. `cli/index.ts` 的 help 文本（人肉同步的老大难）
 *  8. `labelKey` 命名契约（`foreign.source.<id>`，运行期逐项比对）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FOREIGN_SOURCE_IDS, builtinForeignSources } from './registry.ts';
import {
  FOREIGN_SOURCE_IDS_FROM_SHAPES,
  FOREIGN_SOURCE_MODULE_SHAPES,
  FOREIGN_SESSION_SOURCE_IDS,
  foreignSourceLabelKey,
} from './source-modules.ts';

/** 换行常量（避免在源码里写转义序列，可读性优先） */
const NL = String.fromCharCode(10);

const FOREIGN_DIR = import.meta.dirname;
const SRC_DIR = path.dirname(FOREIGN_DIR);
const REPO_DIR = path.dirname(SRC_DIR);

/** 单一事实源派生出的 id 清单（顺序稳定） */
const EXPECTED = [...FOREIGN_SOURCE_IDS_FROM_SHAPES];

async function readSource(relFromRepo: string): Promise<string> {
  return fsp.readFile(path.join(REPO_DIR, relFromRepo), 'utf8');
}

/**
 * 从源码文本里抠出**字符串数组字面量**的全部元素。
 *
 * 写法刻意保守：只认 `['a', 'b', ...]` 这一种形态（含跨行的），因为要断言的四处硬编码恰好
 * 都是这个形态。抠不到就返回 `null` —— 由调用方断言失败并给出「请改回可识别的形态」的指引，
 * 绝不静默放过（抠不到 = 这条护栏失效，比漂移更危险）。
 */
function stringArrayLiterals(text: string): string[][] {
  const out: string[][] = [];
  const re = /\[([^\[\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? '';
    const items = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => (x[1] ?? x[2] ?? ''));
    if (items.length > 0) out.push(items);
  }
  return out;
}

/** 文本里是否出现这组 id（作为字面量清单，顺序也要一致） */
function findLiteralList(text: string, expected: readonly string[]): string[] | null {
  for (const items of stringArrayLiterals(text)) {
    if (items.length === expected.length && expected.every((id, i) => items[i] === id)) return items;
  }
  return null;
}

/* ---------------- 1. 单一事实源 ↔ 运行期词表 ---------------- */

test('事实源：形状枚举派生出的 id 与运行期词表 FOREIGN_SOURCE_IDS 逐项同序', () => {
  assert.deepEqual(
    [...FOREIGN_SOURCE_IDS],
    EXPECTED,
    'FOREIGN_SOURCE_IDS（registry.ts）必须与 source-modules.ts 的形状表逐项同序 —— ' +
    '新增来源只改 source-modules.ts 一处，词表由它派生',
  );
});

test('事实源：形状枚举本身自洽（id 不重复、模块名不重复、模块名与 id 对应）', () => {
  const ids = FOREIGN_SOURCE_MODULE_SHAPES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, '形状表里不能有重复 id');

  const seen = new Set<string>();
  for (const shape of FOREIGN_SOURCE_MODULE_SHAPES) {
    assert.equal(shape.modules.length, 2, shape.id + ' 必须恰好两个模块（read-<id>.ts + <id>.ts）');
    assert.deepEqual(
      [...shape.modules],
      ['read-' + shape.id + '.ts', shape.id + '.ts'],
      shape.id + ' 的模块名必须与 id 对应（读盘层在前、翻译层在后）',
    );
    for (const m of shape.modules) {
      assert.equal(seen.has(m), false, '模块 ' + m + ' 被两个来源共用（形状枚举不允许共享模块）');
      seen.add(m);
    }
  }
});

test('事实源：带会话的来源集合是形状表的投影（会话类来源必须经 IR 层）', () => {
  assert.deepEqual(
    [...FOREIGN_SESSION_SOURCE_IDS],
    FOREIGN_SOURCE_MODULE_SHAPES.filter((s) => s.sessions).map((s) => s.id),
    'FOREIGN_SESSION_SOURCE_IDS 必须是形状表 sessions 标记的投影',
  );
  assert.ok(FOREIGN_SESSION_SOURCE_IDS.includes('claude-code'), 'claude-code 必须带会话（唯一已实现的会话转码器）');
});

/* ---------------- 2. 装配真值（运行期，不是文本） ---------------- */

test('装配：builtinForeignSources() 的 id 集合与顺序与事实源逐项一致', () => {
  assert.deepEqual(
    builtinForeignSources().map((s) => s.id),
    EXPECTED,
    '装配清单漏配/多配/换序：新增来源必须在 builtinForeignSources() 里也装配一份',
  );
});

test('装配：labelKey 一律由事实源派生（不得各写各的）', () => {
  for (const source of builtinForeignSources()) {
    assert.equal(
      source.labelKey,
      foreignSourceLabelKey(source.id),
      source.id + ' 的 labelKey 必须等于 foreign.source.<id>（契约命名，字典侧按同一口径登记）',
    );
  }
});

/* ---------------- 3-6. 四处硬编码测试快照（编译挡不住的那批） ---------------- */

const HARDCODED_SNAPSHOTS: readonly { readonly file: string; readonly what: string }[] = [
  { file: 'src/foreign/registry.test.ts', what: 'registry.test.ts 的冻结快照' },
  { file: 'src/routes/foreign.test.ts', what: 'routes/foreign.test.ts 的硬编码快照' },
  { file: 'src/cli/import-source.test.ts', what: 'cli/import-source.test.ts 的硬编码循环' },
  { file: 'src/ui/foreign-view.test.ts', what: 'ui/foreign-view.test.ts 的硬编码清单' },
];

for (const snap of HARDCODED_SNAPSHOTS) {
  test('清单同步：' + snap.what + ' 与事实源逐项一致（漏配一处即红）', async () => {
    const text = await readSource(snap.file);
    assert.notEqual(
      findLiteralList(text, EXPECTED),
      null,
      snap.file + ' 里找不到与事实源一致的来源 id 字面量清单。' + NL +
      '  两种可能：① 新增来源时漏改了这里（应为 ' + EXPECTED.join(', ') + '）；' + NL +
      '  ② 有人把它改成了别的形态 —— 那样这条护栏会静默失效，请改回数组字面量形态。' + NL +
      '  事实源：src/foreign/source-modules.ts 的 FOREIGN_SOURCE_MODULE_SHAPES。',
    );
  });
}

test('清单同步：CLI help 文本里的来源清单与事实源一致（人肉同步的老大难）', async () => {
  const text = await readSource('src/cli/index.ts');
  const line = text.split(NL).find((l) => l.includes('claude-code') && l.includes('antigravity'));
  assert.ok(line !== undefined, 'CLI help 里必须有一行列出全部来源（找不到 = 被删了，请补回并同步事实源）');
  // 形态 = `来源 source：a | b | c`：先切掉标签（取**最后一个**全角/半角冒号之后），再按竖线切
  const body = (line ?? '').replace(/^.*[：:]/u, '');
  // 每个 token 还要剥掉包围它的 JS 字符串字面量标点（行尾的 `',`）。
  // **必须保留数字**：来源 id 允许数字（`dsh4`），只保留 [a-z-] 会把它静默剥成 `dsh`，
  // 于是这条断言对含数字的 id **恒红**（2026-10-05 档 B 加 dsh4 时实测踩到）。
  const listed = body
    .split('|')
    .map((s) => s.replace(/[^a-z0-9-]/g, ''))
    .filter((s) => s !== '');
  assert.deepEqual(
    listed,
    EXPECTED,
    'CLI --help 的来源清单与事实源不一致：用户看到的可用来源与本机能力分叉（漏配即红）。' + NL +
    '  实际：' + listed.join(' | ') + NL + '  应为：' + EXPECTED.join(' | '),
  );
});

/* ---------------- 7. 覆盖度自检（护栏自己的护栏） ---------------- */

test('覆盖度：事实源至少被反查 7 处（防止有人把某条断言删掉）', () => {
  const checks = HARDCODED_SNAPSHOTS.length + 3; // 3 = 词表 + 装配 + labelKey
  assert.ok(
    checks >= 7,
    '来源清单的同步面只剩 ' + String(checks) + ' 处，低于下限 7 —— 加来源要动的位置只会更多，' +
    '不会更少；删断言请先改这条下限并说明理由',
  );
});
