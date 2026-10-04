/**
 * 导入流水线的跨端共享常量（**零依赖**：两端都可 import）。
 *
 * 为什么单独成文件：client 半的 `lib/client.js` 是单文件 cjs bundle，任何**运行时**
 * import 都会把整条依赖链打进去。`security/container-kind.ts` 读起来人畜无害，但它 import
 * 了同目录的 `encryption.ts`（node:crypto / node:util），于是扫描器会看到
 * `require("node:crypto")` —— DSH 的 client loader 直接报 "missed the module table"，
 * **整个插件不加载**（仓库既有铁律：`src/client/**` 不得运行时跨端 import 到 node 模块）。
 *
 * 因此把「常量」与「判定实现」分开：
 *  - 常量（错误码字面量）放这里，client 只 import 它 → 打包后是内联字符串，零 node 依赖；
 *  - 判定实现（读字节 / 读文件）留在 `security/container-kind.ts`（宿主侧使用）。
 * 同仓先例：`utils/guards.ts`（isRecord / isENOENT）、`profiles/dsh-profile-shared.ts`。
 */

/**
 * 加密容器的判别错误码（HTTP 响应 body.code）。
 *
 * 有码才能让调用方「据此插入解锁流程」，而不是只把一段文案显示给用户 ——
 * 与 mutation gate 的 `code: 'mutation-locked'`、会话格式处置的
 * `code: 'sessionFormatUnsupported'` 同一约定。客户端据它把「这是加密备份」从普通错误里
 * 分出来（旧宿主不回 containerType 时的降级路径，issue #55）。
 */
export const ENCRYPTED_CONTAINER_CODE = 'encrypted-container';
