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

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@` 也是合成的）：任何一条出现在产物或 ZIP 字节里，
`codex.test.ts` 的 t3/t8 都会红。
