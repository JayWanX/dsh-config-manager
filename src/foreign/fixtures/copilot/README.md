# Copilot CLI 来源的测试 fixture（合成，**不是**真机数据）

形态取自官方文档（docs.github.com 的 GitHub Copilot CLI configuration directory），**未经真机验证**
（契约 §8.2 对该来源的取证标注就是「文档取证」；本机无 `~/.copilot`）：

- `basic/mcp-config.json` —— 顶层 `mcpServers` 映射：stdio 条目（含假凭据 `_DO_NOT_SHIP`）、
  带 URL userinfo 的 http 条目、既无 command 也无 url 的空条目。
- `basic/copilot-instructions.md` + `basic/instructions/*.instructions.md` ——
  **多份指令必须合并成一个 AGENTS.md 并报 `instructions-merged`**；`empty.instructions.md` 是空白文件，
  不进合并。
- `basic/skills/hello/SKILL.md` —— 官方形态是**一层** `<名>/SKILL.md`；手工嵌套会被压平并报
  `skill-category-flattened`（该用例在测试里现造，不入库）。
- `overridden/mcp-config.json` —— `COPILOT_HOME` 覆盖目录：`homeDir` 下故意没有 `.copilot`，
  证明实现真的读了覆盖目录。

**目录名不叫 `.copilot/`**：仓库根 `.gitignore` 会特殊对待点开头的目录，而且本任务实测发现
「点开头的目录段之后的内容会被某些写入路径吞掉/错位」（写 `.copilot/x.json` 时 x.json 落到了外层）。
fixture 因此平铺在 `basic/` 之下，测试把该目录当作配置目录（`COPILOT_HOME`）传入 ——
读盘层本来就把「配置目录」当参数，不需要真的叫 `.copilot`。

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@` 也是合成的）：任何一条出现在产物或 ZIP 字节里，
test 都会红。
