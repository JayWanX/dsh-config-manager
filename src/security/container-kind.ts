/**
 * 备份容器形态探测（单一事实源）。
 *
 * 本插件的「备份」有两种物理形态，且**扩展名相同**（都是 .zip）：
 *  - `zip`       明文备份 ZIP（Exporter 直接产出；勾选加密时它会被整体包进容器）
 *  - `encrypted` 整体加密备份容器（DCA1：magic + version + salt/iv/authTag + AES-256-GCM 密文）
 *
 * 为什么必须集中在一处：任何「拿到一个备份路径或字节」的入口都要先做同一判定，否则就会
 * 把密文当 ZIP 解析 —— 用户看到的是「不是合法的 ZIP 文件（缺少中央目录结束记录）」，
 * 真实原因却是「这条入口没先解锁」。历史上只在上传接口做过这一判定：宿主侧路径
 * （备份文件列表的导入 / 查看）与内部入口（analyze / plan / execute）都漏了（issue #55）。
 *
 * 性能：文件形态只读**前 4 字节**（open + read + close），绝不整文件读入内存 ——
 * 备份动辄上百 MB，为判定形态读整份是纯浪费（上传接口此前正是 `fs.readFile` 后只看前 4 字节）。
 */
import fs from 'node:fs/promises'
import { isArchiveBlob } from './encryption.ts'
// 错误码常量定义在零依赖模块里（client 半只能 import 它，绝不能连带把本文件拖进浏览器 bundle）
export { ENCRYPTED_CONTAINER_CODE } from '../utils/shared-constants.ts'

/** 备份容器形态。 */
export type BackupContainerKind = 'zip' | 'encrypted'

/** 判定所需的最小字节数（DCA1 magic 长度）。 */
export const CONTAINER_MAGIC_BYTES = 4

/** 字节 → 容器形态（head 至少含前 4 字节；不足按明文处理）。 */
export function containerKindOfBytes(head: Uint8Array): BackupContainerKind {
  return isArchiveBlob(head) ? 'encrypted' : 'zip'
}

/**
 * 文件 → 容器形态（只读前 4 字节）。
 *
 * 读不到（ENOENT / 权限 / 目录 / 空文件）一律返回 `'zip'`：交给下游 ZIP 解析器
 * 给出它自己的精确错误，而不是在这里编造「这是个加密备份」的结论。判不出形态
 * 只说明「按老行为（明文路径）走」，老行为即既有语义。
 */
export async function readContainerKind(filePath: string): Promise<BackupContainerKind> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(CONTAINER_MAGIC_BYTES)
    const { bytesRead } = await handle.read(buf, 0, CONTAINER_MAGIC_BYTES, 0)
    return containerKindOfBytes(buf.subarray(0, bytesRead))
  } catch {
    return 'zip'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
