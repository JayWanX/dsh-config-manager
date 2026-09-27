/**
 * 启动关键配置文件清单（相对 homeDir）。
 *
 * 为什么单独成文件：这份清单有两个互不相关的消费者，生命周期也不同 ——
 *  1. core/boot-safety.ts（导入安全闸门）：判断「盘面是否还自洽到能启动」，长期在用；
 *  2. 灾备快照线（已按产品定位收敛下线）：曾用它做变更监听与恢复回声候选文件。
 *
 * 灾备线删除时不能连带删掉这份清单 —— 导入/恢复的启动自洽审计仍在用它。
 * 因此把它放在一个与灾备无关的模块里，避免下次清理功能时被误删。
 */

/** 启动关键配置文件（相对 homeDir） */
export const BOOT_CRITICAL_RELS: readonly string[] = [
  'settings.yaml',
  'settings.json',
  'cordis.patch.yml',
  '.env',
  'AGENTS.md',
];

/** profile 下启动关键配置文件（相对 homeDir） */
export function profileCriticalRels(profile: string): string[] {
  return [
    'profiles/' + profile + '/cordis.patch.yml',
    'profiles/' + profile + '/package.json',
    'profiles/' + profile + '/cordis.yml',
    'profiles/' + profile + '/pnpm-workspace.yaml',
  ];
}
