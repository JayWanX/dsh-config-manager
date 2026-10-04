/**
 * 事故恢复接线守卫（原 Phase 1 灾备接线守卫的替代）。
 *
 * 背景：灾备快照线（自动快照 / 撤销重做 / 快照库）已按产品定位收敛下线
 * （定位 = 迁移 / 同步 / 市场），只保留**崩溃归因 + 救援模式**并并入「事故恢复」子 tab。
 * 删功能时最容易留下的正是「双开关 / 悬空路由 / 悬空字段」这类半套状态，本守卫把它们钉在盘上。
 *
 * 全部断言都是**源码级**（读文件字符串）：要守的是「接线是否存在」；
 * 行为测试在 crash-report.test.ts / boot-rescue.test.ts / recovery-view.test.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => fs.readFileSync(ROOT + rel, 'utf8');
const exists = (rel: string): boolean => fs.existsSync(ROOT + rel);

const INDEX = read('src/index.ts');
const ROUTES = read('src/client/common/routes.ts');
const RUN_STORE = read('src/client/run-store.ts');
const SECTION = read('src/client/ConfigManagerSection.tsx');
const PANEL = read('src/client/recovery/RecoveryPanel.tsx');
const LOCALES = read('src/client/recovery/recovery-locales.ts');
const CRASH = read('src/core/crash-report.ts');
const BOOT_PATHS = read('src/core/boot-paths.ts');

test('incident-01 灾备快照线已整体下线：模块文件不存在', () => {
  for (const rel of [
    'src/core/watcher.ts', 'src/core/watcher.test.ts',
    'src/core/undo.ts',
    'src/core/config-state.ts', 'src/core/config-state.test.ts',
    'src/core/config-snapshot.ts', 'src/core/config-snapshot.test.ts',
    'src/core/config-lifecycle.ts', 'src/core/config-lifecycle.test.ts',
    'src/client/lifecycle/LifecyclePanel.tsx', 'src/client/lifecycle/lifecycle-api.ts',
    'src/ui/lifecycle-view.ts', 'src/ui/lifecycle-view.test.ts',
  ]) {
    assert.equal(exists(rel), false, '已删除的灾备模块不应回归: ' + rel);
  }
});

test('incident-02 宿主不再有灾备开关与 /lifecycle 路由', () => {
  assert.ok(!INDEX.includes('LIFECYCLE_ENABLED'), '灾备 kill switch 应随自动快照一起删除');
  assert.ok(!INDEX.includes('API.lifecycle'), '/lifecycle 路由应删除');
  assert.ok(!INDEX.includes('ConfigLifecycle'), 'ConfigLifecycle 接线应删除');
});

test('incident-03 保留的两条事故路由仍在盘上', () => {
  assert.ok(INDEX.includes("endpoint({ path: API.crash, methods: ['GET'] }"), '崩溃归因路由缺失');
  assert.ok(INDEX.includes("endpoint({ path: API.rescue, methods: ['GET', 'POST'] }"), '救援模式路由缺失');
  assert.ok(!INDEX.includes('lastGoodSnapshotId'), 'last-good 快照已随灾备库下线，不得留下悬空字段');
});

test('incident-04 boot-state 独立目录 + 老位置一次性搬迁', () => {
  assert.ok(INDEX.includes('BOOT_STATE_DIR_NAME'), 'boot-state 目录名应取自 crash-report 常量');
  assert.ok(INDEX.includes('adoptLegacyBootState'), '老位置（config-snapshots）搬迁接线缺失');
  assert.ok(CRASH.includes('export const BOOT_STATE_DIR_NAME'), 'crash-report 应导出 boot-state 目录名');
  assert.ok(CRASH.includes('export const LEGACY_BOOT_STATE_DIR_NAME'), 'crash-report 应导出历史目录名');
  assert.ok(CRASH.includes('export async function adoptLegacyBootState'), '搬迁原语缺失');
  assert.ok(!CRASH.includes('selectLastGoodSnapshot'), '最后正常快照选择应随灾备库删除');
});

test('incident-05 启动关键文件清单搬进独立模块（导入安全审计仍在用）', () => {
  const BOOT_SAFETY = read('src/core/boot-safety.ts');
  assert.ok(BOOT_PATHS.includes('export const BOOT_CRITICAL_RELS'), '清单应留在与灾备无关的模块里');
  assert.ok(BOOT_SAFETY.includes("from './boot-paths.ts'"), 'boot-safety 必须改指新模块');
  assert.ok(!BOOT_SAFETY.includes('config-lifecycle'), 'boot-safety 不得再依赖已删除的灾备模块');
});

test('incident-06 客户端路由族：INCIDENT_API 在、LIFECYCLE_API 亡', () => {
  assert.ok(ROUTES.includes('export const INCIDENT_API'), 'INCIDENT_API 应存在');
  assert.ok(!ROUTES.includes('LIFECYCLE_API'), 'LIFECYCLE_API 应删除');
  assert.ok(ROUTES.includes('/crash') && ROUTES.includes('/rescue'), 'crash / rescue 路径应保留');
});

test('incident-07 导航与面板迁移：不再有灾备页，旧持久化值落到事故恢复', () => {
  assert.ok(!SECTION.includes('LifecyclePanel'), '灾备页引用应删除');
  assert.ok(!SECTION.includes("'nav.recovery'"), '灾备导航项应删除');
  assert.ok(RUN_STORE.includes("case 'lifecycle':"), '旧 panel=lifecycle 必须有迁移分支');
  // UI v2：迁移目标从「备份页的恢复子 tab」改为**环境页**（维护与诊断是它的子视图）。
  // 这里钉住「迁移到环境」，不再钉某一行赋值语句 —— 钉实现细节会让合理的重构假红。
  assert.ok(
    /case 'lifecycle':[\s\S]{0,200}panel = 'profiles'/.test(RUN_STORE),
    'lifecycle 迁移目标应为环境页',
  );
  assert.ok(!/PanelId = [^\n]*'lifecycle'/.test(RUN_STORE), 'PanelId 不应再含 lifecycle');
});

test('incident-08 崩溃归因 + 救援模式已并入 RecoveryPanel（含文案）', () => {
  assert.ok(PANEL.includes('incidentApi'), 'RecoveryPanel 应注入 IncidentApi');
  assert.ok(PANEL.includes('recovery.crash.title'), '崩溃横幅缺失');
  assert.ok(PANEL.includes('recovery.rescue.enter'), '救援模式入口缺失');
  assert.ok(PANEL.includes('rescueOn()') && PANEL.includes('rescueOff()'), '救援开/关两个动作都应接线');
  for (const key of [
    "'recovery.crash.title'", "'recovery.crash.reason.session-corrupt'",
    "'recovery.crash.advice.check-bundles'", "'recovery.rescue.enter'", "'recovery.rescue.confirm'",
  ]) {
    assert.ok(LOCALES.includes(key), '文案键缺失: ' + key);
  }
});
