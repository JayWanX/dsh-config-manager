# Codex 来源的测试 fixture（合成，**不是**真机数据）

形态取自官方文档，**未经真机验证**（契约 §8.2 对该来源的取证标注就是「文档取证」；本机无 `~/.codex`，
只有 `~/.agents` 目录存在且为空）：

- `basic/.codex/config.toml` —— 覆盖 TOML 子集的三形态：**引号**（基本 `"…"` 与字面量 `'…'`）、
  **数组**（跨行 + 尾逗号）、**表头**（`[mcp_servers.<id>]` 点分表 + `[projects.'D:\proj\x']` 带引号键），
  另有内联表与数字/布尔标量。值全部是假值，`_DO_NOT_SHIP` 后缀的假凭据用于断言「不进包」。
- `basic/.agents/skills/hello/SKILL.md` —— 一层技能（直取目录名）。
- `basic/.agents/skills/wrapper/nested/SKILL.md` —— 嵌套技能，必须**压平为叶子名**并报
  `skill-category-flattened`（DSH 技能是单层 `<名>/SKILL.md`）。
- `override/.codex/{AGENTS.md,AGENTS.override.md}` —— 发现层级用例：**override 优先**，
  命中必须报 `instructions-override-selected`；两份正文都能被断言区分，才能证明选中的是哪一份。
- `malformed/.codex/config.toml` —— 畸形 TOML（未闭合数组）：必须变成
  `source-unreadable`（`detail=toml-error`）且**不抛异常、不产出空 mcp 分区**。

- `sessions/.codex/sessions/2026/10/06/rollout-*.jsonl`（**会话双根**，2026-10-06 起）：
  - `…11111111-…` 主会话 —— session_meta（cwd/id）→ turn_context（模型）→ user 消息（含
    `<environment_context>` 注入块，必须被过滤）+ 人类提问 → reasoning（无 IR 承载块，只计数）→
    assistant 正文 → `function_call`/`function_call_output`（call_id 配对）→ event_msg（与
    response_item 重复，不记账）→ `local_shell_call`（未知类型计数）→ `compacted`（计数）→
    `custom_tool_call`（JS 形参原样保留）+ 块数组形态的工具输出（图片块无承载块，计数）→
    **一行坏 JSON**（只计入 bad）+ developer 消息（角色计数）
  - `…33333333-…` / `…55555555-…` —— **子代理 rollout**（`thread_source='subagent'` /
    `source.subagent`）：必须被剔除并报 `unsupported-session-record`
  - `…44444444-…` —— **fork 会话**（`forked_from_id`/`parent_thread_id`）：必须保留
  - `sessions/notes.jsonl` —— 非 `rollout-*.jsonl`：**绝不读**（读了就是造垃圾会话）
- `sessions/.codex/archived_sessions/rollout-*.jsonl` —— 扁平第二根 + Windows 反斜杠 cwd。

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@` 也是合成的）：任何一条出现在产物或 ZIP 字节里，
`codex.test.ts` 的 t3/t8 都会红；子代理 rollout 的两条哨兵值出现在输入结构里则 t11 红。
