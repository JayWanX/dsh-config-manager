# Cursor 来源的测试 fixture（合成，**不是**真机数据）

形态取自契约 §8.2 的 Cursor 行（**文档取证**：cursor.com/help/customization/mcp.md 与 rules.md）。
**本机没有 ~/.cursor（2026-10-04 实测）→ 未经真机验证**：本目录只是按官方文档复刻的合成形态，
不得当作「已在真机 Cursor 上验证过」的证据（t13/t14 必须标注「文档取证、未经真机验证」）。

| 用例 | 覆盖 |
|---|---|
| `basic/` | 用户级 + 项目级两层：mcp.json（stdio/remote/凭据）、四种激活的 rules/*.mdc、两层 skills、旧式 .cursorrules |
| `malformed/` | 畸形 mcp.json（JSON 截断）与损坏的规则 frontmatter（未闭合 flow 序列） |
| `shape/` | mcpServers 不是映射（数组）→ mcp-server-empty(detail=not-a-mapping) |
| `alt/` | 顶层只有 servers 映射、没有 mcpServers → mcp-server-empty(detail=unexpected-container-key) |
| `empty/` | 0 字节 mcp.json → source-empty-file，绝不产出空分区 |

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@`、`Bearer …` 也是合成的）：任何一条出现在
产物或 ZIP 字节里，测试都会红。`.cursorrules` 的哨兵正文**故意只 stat 不读**：它的存在就是断言
「旧式规则只报告不导入」的反例素材。
