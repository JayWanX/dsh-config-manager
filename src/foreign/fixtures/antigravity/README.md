# Antigravity 来源的测试 fixture（合成，**不是**真机数据）

- `empty/gemini/**` —— **本机真值**（实测取证）：`config/mcp_config.json` 与
  `antigravity/mcp_config.json` 都是 0 字节，另有 `mcp_oauth_tokens.json`（凭据文件，只 stat 不读）。
  这里刻意保持 0 字节：它钉住「0 字节报 `source-empty-file`、绝不产出空 mcp 分区、绝不抛」。
- `basic/gemini/config/mcp_config.json` —— 全局配置：`serverUrl`（Antigravity 现行 remote 形态，
  已不支持 url/httpUrl）、`envVar`（值是环境变量名，映射后按名字剥离）、`type: "sse"`（报码后按 http 处理）、
  空条目。
- `basic/gemini/antigravity/mcp_config.json` —— IDE 侧同形位置：多一个 `ideOnly` 条目，
  以及与全局同名的 `remote`（**先到先得**，后者跳过并报码）。

目录名用 `gemini/` 而不是 `.gemini/`：仓库根 `.gitignore` 会特殊对待点开头的目录，且部分检出/打包
工具链会**丢掉点开头目录之后的相对路径**（本任务实测踩过：写 `.gemini/config/x.json` 时 `config/x.json`
被吞掉、只剩一个空目录）。`readAntigravity({ geminiDir })` 因此接受「已解析的 .gemini 目录」本身，
fixture 用 `gemini/` 平铺，测试把它当作 geminiDir 传入。

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@` 也是合成的）：任何一条出现在产物或 ZIP 字节里，
test 都会红。
