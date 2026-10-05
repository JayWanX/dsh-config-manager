/**
 * foreign-view 测试：检测结果 → 界面行的纯函数映射（t17）。
 *
 * 钉住四条最容易悄悄坏掉的纪律：
 *  ① **码全量映射**：27 个冻结 ForeignSkipCode 逐个有字典键，且键在 uiZh 里真实存在
 *     （缺一个 = 界面上冒出一个裸机器码，而用户不知道那是什么）；
 *  ② **未检测到不是错误**：badge 必须是 info（写成 error 会让用户以为自己的机器坏了）；
 *  ③ **未知来源不编造**：非六来源 id 显示「未识别的来源」+ 保留原始 id；
 *  ④ **未检测到 ≠ 空**：empty 只对 found=true 成立（否则「没装」会被读成「装了但读不出来」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOREIGN_LOSSY_KINDS,
  FOREIGN_SKIP_KEY,
  foreignLossyRows,
  foreignPathsText,
  foreignSkipLine,
  foreignSourceRow,
  foreignSourcesViewModel,
  isKnownForeignSource,
} from './foreign-view.ts';
import { makeUiT, uiZh } from './i18n.ts';
import type { ForeignSkipCode } from '../foreign/types.ts';
import type { ForeignLossyKind, ForeignLossyRow, ForeignSourceStatusInput } from './foreign-view.ts';
import type { UiTextKey } from './i18n.ts';

const zh = makeUiT('zh');
const en = makeUiT('en');

/** 冻结码全量（与 src/foreign/types.ts 的 ForeignSkipCode 同集；此处显式抄一份是为了
 *  「漏配文案」在测试里立刻可见，而不是被动等编译器）。 */
const ALL_CODES: ForeignSkipCode[] = [
  'unsupported-hooks', 'unsupported-commands', 'credentials-not-migrated',
  'skill-missing-file', 'skill-invalid-frontmatter', 'skill-invalid-name',
  'mcp-server-empty', 'mcp-type-sse-coerced', 'mcp-credential-redacted',
  'source-unreadable', 'session-format-version-unknown', 'session-format-unsupported',
  'session-missing-cwd', 'session-unsafe-id', 'session-empty', 'session-unparsable',
  'unsupported-session-record', 'session-id-conflict', 'skill-id-conflict',
  'sessions-not-migrated', 'memory-report-only', 'skill-category-flattened',
  'legacy-rules-file', 'instructions-merged', 'instructions-override-selected',
  'source-empty-file', 'source-location-overridden',
];

function src(overrides: Partial<ForeignSourceStatusInput> = {}): ForeignSourceStatusInput {
  return { id: 'claude-code', found: true, paths: ['.claude/settings.json'], skipped: [], ...overrides };
}

test('foreign-view：27 个冻结码逐个有字典键，且键在字典里真实存在（缺一个即裸机器码）', () => {
  assert.equal(ALL_CODES.length, 27, '冻结码应为 27 个；本清单与 types.ts 漂移时此断言先红');
  for (const code of ALL_CODES) {
    const key = FOREIGN_SKIP_KEY[code];
    assert.equal(key, 'foreign.skip.' + code, code + ' 的键形必须是 foreign.skip.<code>');
    assert.ok(
      Object.prototype.hasOwnProperty.call(uiZh, key),
      code + ' 的字典键 ' + key + ' 在 uiZh 里不存在 —— 界面会显示裸机器码',
    );
    // 文案必须真的被翻译（不是回退成键名）
    assert.notEqual(zh(key), key, code + ' 的 zh 文案缺失（回退成了键名）');
    assert.notEqual(en(key), key, code + ' 的 en 文案缺失（回退成了键名）');
  }
});

test('foreign-view：foreignSkipKey 的未知码回退为可搜索的稳定标识（绝不 undefined）', () => {
  const line = foreignSkipLine({ code: 'brand-new-code-from-third-party' as ForeignSkipCode }, zh);
  assert.equal(line.code, 'brand-new-code-from-third-party');
  // UiT 对未注册键**原样返回键名** → 界面显示 'foreign.skip.brand-new-code-from-third-party'
  assert.equal(line.text, 'foreign.skip.brand-new-code-from-third-party');
});

test('foreign-view：skip 行保留 origin 与 count（有值才带，零/空不占位）', () => {
  const withMeta = foreignSkipLine({ code: 'skill-id-conflict', origin: 'dogfood', count: 3 }, zh);
  assert.equal(withMeta.origin, 'dogfood');
  assert.equal(withMeta.count, 3);
  const bare = foreignSkipLine({ code: 'source-empty-file', origin: '', count: 0 }, zh);
  assert.equal(bare.origin, undefined, '空 origin 不占位');
  assert.equal(bare.count, undefined, 'count=0 不占位（不谎报有 0 项）');
});

test('foreign-view：六来源显示名走字典，未知 id 不编造（保留原始 id）', () => {
  const ids = ['claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity'];
  for (const id of ids) {
    assert.ok(isKnownForeignSource(id), id + ' 必须属于冻结词表');
    const row = foreignSourceRow(src({ id }), zh);
    assert.equal(row.known, true);
    assert.notEqual(row.label, zh('foreign.source.unknown'), id + ' 不该走「未识别」分支');
  }
  assert.equal(isKnownForeignSource('some-future-agent'), false);
  const unknown = foreignSourceRow(src({ id: 'some-future-agent' }), zh);
  assert.equal(unknown.known, false);
  assert.ok(unknown.label.includes('some-future-agent'), '未知来源必须保留原始 id（否则用户无从上报）');
  assert.ok(unknown.label.includes(zh('foreign.source.unknown')));
});

test('foreign-view：未检测到 = info 徽章（不是错误），检测到且有未迁移项 = warn', () => {
  const missing = foreignSourceRow(src({ found: false, paths: [] }), zh);
  assert.equal(missing.badge, 'info', '「本机没装这个工具」是正常状态，不得标红');
  assert.equal(missing.statusText, zh('foreign.found.no'));
  assert.equal(missing.empty, false, '未检测到 ≠ 空来源（那是「装了但读不到」）');

  const clean = foreignSourceRow(src(), zh);
  assert.equal(clean.badge, 'ok');
  assert.equal(clean.statusText, zh('foreign.found.yes'));

  const withSkips = foreignSourceRow(src({ skipped: [{ code: 'memory-report-only' }] }), zh);
  assert.equal(withSkips.badge, 'warn', '有未迁移项必须升到 warn（用户需要知道有东西没搬）');
});

test('foreign-view：empty 只对 found=true 且零命中路径成立（界面据此禁用导入）', () => {
  const foundButNothing = foreignSourceRow(src({ found: true, paths: [] }), zh);
  assert.equal(foundButNothing.empty, true, '装了却读不到任何位置 → 界面禁用「导入」');
  assert.equal(foreignSourceRow(src({ found: true, paths: ['.claude'] }), zh).empty, false);
});

test('foreign-view：命中路径文本 —— 无命中给明确的说明而不是空白', () => {
  const row = foreignSourceRow(src({ paths: ['.claude', '.claude.json'] }), zh);
  const text = foreignPathsText(row, zh);
  assert.ok(text.includes('.claude'), '路径必须逐条出现');
  assert.ok(text.includes('.claude.json'));
  const none = foreignPathsText(foreignSourceRow(src({ found: false, paths: [] }), zh), zh);
  assert.equal(none, zh('foreign.pathsNone'), '无命中时必须明说，不能留空白');
});

test('foreign-view：null 响应 → null（界面走加载态），不编造空表', () => {
  assert.equal(foreignSourcesViewModel(null, zh), null);
});

test('foreign-view：整表模型 —— 六来源齐全、anyFound、冲突策略透传', () => {
  const vm = foreignSourcesViewModel({
    conflictPolicy: 'skip-no-overwrite',
    projectScoped: false,
    sources: [
      src({ id: 'claude-code', found: true }),
      src({ id: 'hermes', found: false, paths: [] }),
      src({ id: 'cursor', found: false, paths: [] }),
      src({ id: 'codex', found: false, paths: [] }),
      src({ id: 'copilot', found: false, paths: [] }),
      src({ id: 'antigravity', found: false, paths: [] }),
    ],
  }, zh);
  assert.ok(vm !== null);
  assert.equal(vm.rows.length, 6, '六来源一条都不能少（未装的也要列出来）');
  assert.equal(vm.anyFound, true);
  assert.equal(vm.conflictPolicy, 'skip-no-overwrite');

  const allMissing = foreignSourcesViewModel({
    sources: [src({ id: 'hermes', found: false, paths: [] })],
  }, zh);
  assert.equal(allMissing?.anyFound, false, '全未检测到 → 界面据此提示「没有可导入的来源」');
  assert.equal(allMissing?.conflictPolicy, null, '宿主未回策略 → null（界面不渲染该行，绝不编造）');
});

test('foreign-view：shapes 与既有 UiT 对齐（en 也有全部新键，无回退）', () => {
  for (const code of ALL_CODES) {
    assert.notEqual(en(FOREIGN_SKIP_KEY[code]), zh(FOREIGN_SKIP_KEY[code]), code + ' 的 en 与 zh 不得同文');
  }
  for (const key of ['foreign.source.unknown', 'foreign.found.yes', 'foreign.found.no', 'foreign.pathsNone'] as const) {
    assert.notEqual(en(key), key);
    assert.notEqual(zh(key), key);
  }
});

/* ------------------------------------------------ F-5：三类已知有损的展示行 */

/** 按 kind 取一条（找不到即断言失败，顺带完成窄化）。 */
function lossyRowOf(rows: readonly ForeignLossyRow[], kind: ForeignLossyKind): ForeignLossyRow {
  const row = rows.find((r) => r.kind === kind);
  assert.ok(row !== undefined, kind + ' 必须出现在展示行里');
  return row;
}

test('foreign-view：三类有损的键在 zh/en 两本字典里都真实存在且不同文（缺键即回退键名）', () => {
  assert.deepEqual(
    [...FOREIGN_LOSSY_KINDS],
    ['file-section-secrets', 'entry-backslash', 'prompt-persona-reshape'],
    '三类有损的标识与顺序是固定的（界面按此顺序渲染）',
  );
  for (const kind of FOREIGN_LOSSY_KINDS) {
    for (const suffix of ['title', 'detail'] as const) {
      const key = ('foreign.lossy.' + kind + '.' + suffix) as UiTextKey;
      assert.ok(
        Object.prototype.hasOwnProperty.call(uiZh, key),
        key + ' 在 uiZh 里不存在 —— 界面会显示裸键名',
      );
      assert.notEqual(zh(key), key, key + ' 的 zh 文案缺失');
      assert.notEqual(en(key), key, key + ' 的 en 文案缺失');
      assert.notEqual(zh(key), en(key), key + ' 的 zh/en 不得同文');
    }
  }
  // 卡片 chrome 的 4 个键属客户端外壳，在 src/client/locales.ts（由
  // src/client/import/foreign-import-view-guard.test.ts 按源码守卫覆盖），此处不重复断言。
});

test('foreign-view：尚未产包 → 三条 applicable 全为 null（界面不给徽章，绝不写「不适用」）', () => {
  const rows = foreignLossyRows(null, zh);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.applicable, null, row.kind + ' 在未产包时不得声称适用或不适用');
    assert.equal(row.title, zh(('foreign.lossy.' + row.kind + '.title') as UiTextKey));
    assert.equal(row.detail, zh(('foreign.lossy.' + row.kind + '.detail') as UiTextKey));
  }
  assert.equal(lossyRowOf(rows, 'file-section-secrets').severity, 'warn');
  assert.equal(lossyRowOf(rows, 'entry-backslash').severity, 'warn');
  assert.equal(lossyRowOf(rows, 'prompt-persona-reshape').severity, 'info', '形状变化、文本无损 → 中性语义');
});

test('foreign-view：包内只有结构化分区 → 秘密不剥离与 prompts 形状两条「不涉及」，反斜杠仍如实提示', () => {
  const rows = foreignLossyRows(['mcp', 'settings'], zh);
  assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, false, '无文件类分区 → 该条不适用');
  assert.equal(lossyRowOf(rows, 'prompt-persona-reshape').applicable, false, '无 prompts 分区 → 该条不适用');
  assert.equal(
    lossyRowOf(rows, 'entry-backslash').applicable,
    true,
    '条目名在浏览器里看不到 → 只要产了包就如实提示（不得谎称不涉及）',
  );
});

test('foreign-view：文件类分区的判定取注册表（skills/agentPresets/.../self 六个），不另抄清单', () => {
  for (const id of ['skills', 'agentPresets', 'agentInstructions', 'pluginFiles', 'sessions', 'self']) {
    const rows = foreignLossyRows([id], zh);
    assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, true, id + ' 是文件类分区');
  }
  // 未注册 / 结构化分区一律不算文件类（未知 id 不得被当成文件类而误报）
  for (const id of ['settings', 'providers', 'workspaces', 'credentialsStatus', 'some-future-section']) {
    const rows = foreignLossyRows([id], zh);
    assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, false, id + ' 不是文件类分区');
  }
});

test('foreign-view：prompts 分区 / 六文件类分区同时命中 → 三条全「适用」', () => {
  const rows = foreignLossyRows(['skills', 'prompts'], zh);
  for (const row of rows) assert.equal(row.applicable, true, row.kind + ' 在本包里应当适用');
});
