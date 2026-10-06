/**
 * 插件自更新弹窗的纯函数模型（node 可测，无 React / 无 DOM）。
 *
 * 只有一件事：把宿主返回的**失败码**映射到本地化文案键。
 *
 * 为什么不让组件直接渲染 host 的 error：那是英文技术细节（还可能带路径），界面必须给用户
 * 可读的中文/英文文案；只有**未知码**才回落到宿主原始文本（此时至少不隐藏真实原因）。
 */
import type { ConfigManagerKey } from '../locales.ts';
import type { SelfUpdateFailureCode } from '../../utils/shared-constants.ts';

/** 失败码 → 文案键（穷尽映射：共享常量新增码时这里编译报错，逼着同时补 zh/en 字典）。 */
export const UPDATE_FAILURE_KEYS: Readonly<Record<SelfUpdateFailureCode, ConfigManagerKey>> = {
  'invalid-version': 'about.update.code.invalidVersion',
  'profile-unknown': 'about.update.code.profileUnknown',
  'unsupported-profile': 'about.update.code.unsupportedProfile',
  'non-registry-install': 'about.update.code.nonRegistryInstall',
  'not-newer': 'about.update.code.notNewer',
  'install-failed': 'about.update.code.installFailed',
};

/** 失败码 → 文案键；未知码回 null（调用方回落宿主原始文本）。 */
export function updateFailureKey(code: string): ConfigManagerKey | null {
  const table: Record<string, ConfigManagerKey | undefined> = UPDATE_FAILURE_KEYS;
  return table[code] ?? null;
}
