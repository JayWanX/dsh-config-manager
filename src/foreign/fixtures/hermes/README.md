# Hermes 来源的测试 fixture（合成，**不是**真机数据）

形态取自本机实测的 `%LOCALAPPDATA%\Hermes`（契约 §8.2，2026-10-04 只读取样）：

- `basic/config.yaml` 的**顶层键名与真机逐字一致**（30 个键，实测取样），值全部是假值/占位 ——
  入库的是「形态」，不是任何真实配置；`hermes.test.ts` 的 t9 只断言键名与计数。
- `basic/skills/` 复刻真机的**两层分类**（`skills/<分类>/<技能>/SKILL.md`，另有分类目录自带 SKILL.md）；
  分类目录自带 SKILL.md 时它自己就是技能，`examples/` 这类子目录只作它的资产（不单独成技能）。
- `basic/dotenv.fixture` 由测试改名为 `.env` 后再读：仓库根 `.gitignore` 排除 `.env`，
  直接入库会变成「本地有、干净检出没有」。
- `basic/state.db` 只是「对话存在 SQLite 里」的痕迹（只判存在，不解析）。
- `empty/config.yaml` 是 0 字节用例（报 `source-empty-file`，绝不产出空分区）。

假值一律带 `_DO_NOT_SHIP` 后缀（URL 里的 `user:pw@` 也是合成的）：任何一条出现在产物或 ZIP 字节里，测试都会红。
