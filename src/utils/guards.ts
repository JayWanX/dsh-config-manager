/**
 * 零依赖运行时类型守卫（host 与浏览器半**共用**的唯一实现）。
 *
 * 为什么必须是独立模块、且**零 import**：
 * `isRecord` 的消费者里有 `src/client/run-store.ts`（持久化载荷校验），而 client 半禁止任何
 * node 依赖（`tests/architecture-boundaries.test.ts` 直接扫 import 语句；bundle 自包含护栏还会
 * 检查产物）。任何 node: import 落进本文件都会把 node 依赖打进浏览器 bundle，插件整体加载失败。
 */
/** 普通对象判定（数组 / null / 原始值均不算）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ENOENT 判定（「文件/目录不存在」的唯一口径；其余错误必须原样上抛）。 */
export function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
