/**
 * audit-foreign F4 同族残余（t36）：cursor / codex / copilot / hermes / claude-code 的**技能文件遍历**
 * 触顶（单技能文件数 / 单文件字节）必须可见，且上下文里的可选上限必须**原样透传**到读器。
 *
 * 口径（与 t17 的 max-sessions-reached / max-skills-reached / too-large 同族）：
 *  - 单技能文件数触顶 → source-unreadable + detail=max-skill-files-reached（count=上限）
 *  - 单文件字节上限触顶 → source-unreadable + detail=too-large（count=被跳过的文件数）
 *
 * base 3f42a8b 上的红：五个来源都在各自的 walkFiles 里静默 break / 静默 continue ——
 * 超限的文件既不在载荷里、skipped 里也一个字都没有（「导入全绿但内容缺失」）。
 *
 * 断言刻意不依赖 readdir 顺序（CI 是三平台矩阵）：条数触顶按「载荷里剩几个文件」判，不指定剩哪几个。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ForeignSectionOut, ForeignSkip } from './types.ts';
import type { ForeignSource, ForeignSourceContext } from './registry.ts';
import { builtinForeignSources } from './registry.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { sessionSourceOf } from './session-source.ts';
import { resolveHermesHome } from './read-hermes.ts';

const NL = String.fromCharCode(10);
/** 合法技能（name + description 必备）+ 42 字节 */
const SKILL_MD = ['---', 'name: demo', 'description: t36 fixture', '---', '', '# body', ''].join(NL);
const SKILL_BYTES = Buffer.byteLength(SKILL_MD);
/** 64 字节：超过「字节上限 = SKILL_BYTES + 1」→ 必须报 too-large */
const BODY = 'x'.repeat(64);

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-t36-'));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function sourceOf(id: string): ForeignSource {
  const found = builtinForeignSources().find((s) => s.id === id);
  assert.ok(found !== undefined, '来源必须已注册：' + id);
  return found;
}
function ctxOf(home: string, limits?: Record<string, number>): ForeignSourceContext {
  return limits === undefined
    ? { homeDir: home, env: {}, platform: 'linux' }
    : { homeDir: home, env: {}, platform: 'linux', limits };
}
function skipOf(skips: readonly ForeignSkip[], detail: string): ForeignSkip | undefined {
  return skips.find((s) => s.code === 'source-unreadable' && s.detail === detail);
}
/** 技能分区（五个来源都落在 skills 分区；取不到就报错，避免静默通过） */
function skillsSection(sections: readonly ForeignSectionOut[]): { files: readonly { relativePath: string }[] } {
  const found = sections.find((s) => s.sectionId === 'skills');
  assert.ok(found !== undefined, '技能分区必须存在（实际分区=' + sections.map((s) => s.sectionId).join(',') + '）');
  return found as unknown as { files: readonly { relativePath: string }[] };
}
/**
 * 载荷里实际带走的技能文件总数。
 * 条数触顶时**剩哪几个文件取决于 readdir 顺序**（本地 walkFiles 不排序）→ 只断言「总数 < 目录里的 3 个」，
 * 不指定剩哪几个（CI 三平台矩阵下才稳定）。
 */
function carriedSkillFiles(sections: readonly ForeignSectionOut[]): number {
  let total = 0;
  for (const s of sections) {
    if (s.sectionId !== 'skills') continue;
    total += (s as unknown as { files: readonly unknown[] }).files.length;
  }
  return total;
}
/** 技能目录布局：各来源**用户级** skills/ 的真实形态（Hermes 的 home 与平台相关 → 用它的解析器） */
const LAYOUTS: readonly { readonly id: string; readonly skillDir: (home: string) => string }[] = [
  { id: 'cursor', skillDir: (h) => path.join(h, '.cursor', 'skills', 'demo') },
  { id: 'codex', skillDir: (h) => path.join(h, '.agents', 'skills', 'demo') },
  { id: 'copilot', skillDir: (h) => path.join(h, '.copilot', 'skills', 'demo') },
  { id: 'hermes', skillDir: (h) => path.join(resolveHermesHome({ homeDir: h, env: {} }).home, 'skills', 'cat', 'demo') },
  { id: 'claude-code', skillDir: (h) => path.join(h, '.claude', 'skills', 'demo') },
];
async function lay(home: string, skillDir: string): Promise<void> {
  await write(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  await write(path.join(skillDir, 'a.txt'), BODY);
  await write(path.join(skillDir, 'b.txt'), BODY);
}

for (const layout of LAYOUTS) {
  const id = layout.id;

  test('t36 / ' + id + '：单技能文件数触顶必须可见（max-skill-files-reached）', async () => {
    await withHome(async (home) => {
      await lay(home, layout.skillDir(home));
      // 3 个文件 > 上限 2
      const result = await sourceOf(id).build(ctxOf(home, { maxSkillFiles: 2 }));
      const skip = skipOf(result.skipped, 'max-skill-files-reached');
      assert.ok(
        skip !== undefined,
        id + ' 触顶必须报 max-skill-files-reached（skipped=' + JSON.stringify(result.skipped) + '）',
      );
      assert.equal(skip.origin, 'skills', '位置标签只含包内相对名，不得泄漏机器路径');
      assert.equal(skip.count, 2, 'count = 上限本身');
      const carried = carriedSkillFiles(result.sections);
      assert.ok(carried <= 2, id + ' 载荷里不得带超过上限的文件（实际 ' + String(carried) + '）');
      assert.ok(carried < 3, id + ' 目录里有 3 个文件 → 触顶必须真的丢掉了内容（实际带走 ' + String(carried) + '）');
    });
  });

  test('t36 / ' + id + '：单文件字节上限触顶必须可见（too-large）', async () => {
    await withHome(async (home) => {
      await lay(home, layout.skillDir(home));
      // SKILL.md 恰好不超限（' > maxBytes' 是严格大于）；两个 64 字节文件必须被跳过并计数
      const result = await sourceOf(id).build(ctxOf(home, { maxFileBytes: SKILL_BYTES + 1 }));
      const skip = skipOf(result.skipped, 'too-large');
      assert.ok(skip !== undefined, id + ' 字节上限触顶必须报 too-large（skipped=' + JSON.stringify(result.skipped) + '）');
      assert.equal(skip.origin, 'skills');
      assert.equal(skip.count, 2, '两个超大文件都要计数');
      const files = skillsSection(result.sections).files;
      assert.equal(files.length, 1, '只有未超限的 SKILL.md 被带走');
      assert.equal(files[0]?.relativePath, 'demo/SKILL.md');
    });
  });

  test('t36 / ' + id + ' 对照：不传 limits 时逐字同行为（无触顶告警、三个文件都在）', async () => {
    await withHome(async (home) => {
      await lay(home, layout.skillDir(home));
      const result = await sourceOf(id).build(ctxOf(home));
      assert.equal(skipOf(result.skipped, 'max-skill-files-reached'), undefined, '默认不得凭空报触顶');
      assert.equal(skipOf(result.skipped, 'too-large'), undefined, '默认不得凭空报 too-large');
      assert.equal(skillsSection(result.sections).files.length, 3, '默认三个文件都要带走');
    });
  });
}

test('t36：脏上限值（0 / 负数）不得覆盖默认值', async () => {
  await withHome(async (home) => {
    await lay(home, LAYOUTS[0]!.skillDir(home));
    const result = await sourceOf('cursor').build(ctxOf(home, { maxSkillFiles: 0, maxFileBytes: -5 }));
    assert.equal(skipOf(result.skipped, 'max-skill-files-reached'), undefined, '0 不得被当成「上限 0」');
    assert.equal(skipOf(result.skipped, 'too-large'), undefined, '负数不得被当成有效上限');
    assert.equal(skillsSection(result.sections).files.length, 3, '脏值必须落到默认值');
  });
});

test('t36：sessionSourceOf 把 ctx.limits 原样透传给读器；不给则一个键都不加', async () => {
  const seen: { limits: unknown; hasKey: boolean }[] = [];
  const wiring: SessionSourceWiring<{ id: string }> = {
    id: 'qwen',
    evidence: 'measured',
    probePaths: () => [],
    read: async (opts) => {
      seen.push({ limits: opts.limits, hasKey: 'limits' in opts });
      return { files: [] };
    },
    draftOf: () => ({ skip: { code: 'unsupported-session-record' } }),
  };
  const source = sessionSourceOf(wiring);
  const limits = { maxSessionFiles: 7, maxFileBytes: 1024 };
  await source.build({ homeDir: '/nowhere', env: {}, platform: 'linux', limits });
  await source.build({ homeDir: '/nowhere', env: {}, platform: 'linux' });

  assert.equal(seen.length, 2, '两次 build 都要走到读器');
  assert.deepEqual(seen[0]?.limits, limits, '可选上限必须**原样**传出（不是子集、不是空对象）');
  assert.equal(seen[0]?.hasKey, true);
  assert.equal(seen[1]?.hasKey, false, '不传 limits 时不得凭空加键（逐字同行为）');
  assert.equal(seen[1]?.limits, undefined);
});
