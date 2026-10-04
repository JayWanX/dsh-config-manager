/**
 * T13 守卫：会话体检弹窗必须**条件挂载**。
 *
 * 背景（真机反馈）：弹窗常驻时，卡片每次重渲染都会带着它一起走；它内部持有整屏内容
 * （真机 1024 条会话的预览数据），一旦渲染成本失控，整个设置页会变成空白。
 * 关闭即卸载是这条缺陷的最小结构性防线 —— 用源码级断言钉住，避免被后续重构改回常驻。
 * 为什么源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PANEL = path.join(ROOT, 'src/client/recovery/RecoveryPanel.tsx');

test('T13：会话体检弹窗只在 open 时挂载（关闭即卸载）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  const at = source.indexOf('<SessionHealthDialog');
  assert.ok(at > 0, '找不到 SessionHealthDialog 的挂载点');
  // 挂载点上方 400 字符内必须出现条件渲染（{open && …）
  const before = source.slice(Math.max(0, at - 400), at);
  assert.match(before, /\{open && \(/, '弹窗必须条件挂载（真机：常驻会让设置页变空白）');
  assert.equal(/<SessionHealthDialog[^>]*\/>/.test(source), false, '不得再出现无条件自闭合挂载');
});

test('T13：长列表必须限高内滚（DESIGN §8 硬性规则）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  assert.match(source, /snapshotList\} \$\{css\.reportScroll\}/, '会诊列表必须带限高内滚类');
});

test('T14：SessionHealthDialog 的 state 声明必须在被使用之前（TDZ 会把整个面板打白）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  const start = source.indexOf('function SessionHealthDialog(');
  const end = source.indexOf('function RecoveryPanel(', start);
  assert.ok(start > 0 && end > start, '找不到 SessionHealthDialog 源码窗口');
  const body = source.slice(start, end);
  // 声明位置必须早于首个使用位置（真机：后置声明 → ReferenceError → slot entry crashed → 面板空白）
  const declAt = body.indexOf("const [repairedUnits, setRepairedUnits] = useState");
  const useAt = body.indexOf('!repairedUnits.has(');
  assert.ok(declAt > 0, '找不到 repairedUnits 的声明');
  assert.ok(useAt > declAt, 'repairedUnits 必须在使用之前声明（否则 TDZ 直接把插件面板打崩）');
  assert.equal(body.split('const [repairedUnits, setRepairedUnits] = useState').length - 1, 1, '不得重复声明');
});

test('T15：会话体检的卡片与容器必须留白（真机反馈「挤在一起」）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8');
  // 卡片自身内边距：不再是 9px 12px
  const row = /\.snapshotRow \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(row, /padding: 12px 14px/, '卡片内边距必须加大');
  // 限高容器里的列表必须自带上下左右留白
  const scrolled = /\.snapshotList\.reportScroll \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(scrolled, /padding: 10px 12px 10px 10px/, '内滚列表必须留白');
  // 行间距
  const list = /\.snapshotList \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(list, /gap: 10px/, '行间距必须加大');
});
