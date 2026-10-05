/**
 * Profiles 模块公共出口：**DSH 自带 profile**（`$DSH_HOME/profiles/<name>`）管理。
 *
 * 历史说明：本模块此前是插件自有的「配置档案」（配置快照集 + 切换导入），
 * 已整体替换为 DSH profile 管理（用户决策 2026-09）。
 * 分层：`dsh-profile-shared.ts`（零依赖类型/常量/纯函数，双端可用）→
 * `dsh-profile-manager.ts`（node fs 引擎：列表/详情/新建/重命名/物理删）、`process-control.ts`（存活判定 /
 * 优雅→强杀的唯一实现）、`dsh-profile-launcher.ts`（把所选档案作为**独立实例**拉起来并记住它——DSH 没有
 * 「默认 profile」状态，这是「切换档案」唯一真正可用的形态）与 `dsh-profile-runtime.ts`（心跳注册表：
 * 每个实例自报 pid/端口，「这台机器上哪些 profile 在跑」对所有实例可见，防同名多开）→
 * `src/ui/dsh-profiles-view.ts`（视图模型）。
 */
export {
  DshProfileManager, DshProfileError,
  PROFILES_DIR, PROFILE_PATCH_FILENAME,
  type DshProfileManagerOptions,
} from './dsh-profile-manager.ts';

export {
  DshProfileLauncher, defaultResolveCli, buildLaunchArgs, parseLaunchUrl, pickFreePortCandidates, logTail,
  parseLaunches, serializeLaunches, LAUNCHES_FILENAME,
  type DshProfileLauncherOptions, type DshProfileLauncherDeps, type DshCliCommand, type DshProfileLaunchInput,
  type DshProfileStopResult,
} from './dsh-profile-launcher.ts';

export {
  DshProfileRuntimeRegistry, parseRuntimeRecord, runtimeRecordLive,
  RUNTIME_DIR_NAME, RUNTIME_SCHEMA_VERSION, RUNTIME_REFRESH_MS, RUNTIME_STALE_MS,
  type DshProfileRuntimeRecord, type DshProfileRuntimeOptions,
} from './dsh-profile-runtime.ts';

export {
  PROFILE_STOP_GRACE_MS, PROFILE_STOP_GRACE_MS_WINDOWS, stopPid, resolveProcessControl, defaultStopGraceMs,
  type StopPidOutcome, type ProcessControlDeps, type ResolvedProcessControl,
} from './process-control.ts';

export {
  DSH_PROFILE_TEMPLATES, RESERVED_PROFILE_NAMES, PROFILE_COPY_MARKER_FILENAME,
  classifyShape, checkProfileName, isLaunchableShape,
  type DshProfileMeta, type DshProfileDetail,
  type DshProfileTemplate, type DshProfileShape, type DshProfilePatchReload,
  type DshProfileIssue, type DshProfileErrorCode, type DshProfilesSnapshot,
  DSH_PROFILE_LAUNCH_TIMEOUT_MS,
  type DshProfileLaunchRecord, type DshProfileLaunchResult, type DshProfileLaunchWarning,
  type DshProfileRunningView, type DshProfileStopOutcome,
  type DshProfileCopyWarning, type DshProfileCopyResult,
  type DshProfileCopyMarker, type DshProfileIncompleteCopy,
} from './dsh-profile-shared.ts';
