# 给新会话的提示词（直接整段粘贴）

你在仓库 `D:\Projects\personal\dsh-config-manager`（DSH 插件 dsh-config-manager）里工作。请**先读这三份文件再动手**：

1. `docs/handoff/NEXT-SESSION-PLAN-session-health.md` —— 本轮计划（T1–T7，含落点、验收、验证与全局硬约束）
2. `docs/design/2026-09-30-session-format-disposition-design.md` —— 处置开关设计 + §9 已落地进度 + §10 **会话修复域调研**（损坏分类与安全姿态）
3. `AGENTS.md` 与 `DEVELOPERS.md` —— 分层/样式/i18n/测试/路由等仓库硬规范

**任务**：严格按计划里的顺序执行 T1 → T7（每项验证通过再开下一项）。核心背景一句话：DSH 的会话日志按 `header.version` 分版本，读不出的格式会被 DSH **静默跳过**（不报错、不在工作区列表），本插件的导出/导入/同步是逐字节搬运，所以「导入成功但对话消失」有两类成因——**格式版本超前**（已做：告警 + 档案页版本展示）与**会话文件损坏**（本轮要做：只读体检 + 离线安全修复）。

**硬约束（违反即返工）**
- 不 bump 版本号、不打 tag、不发布；改动写进 `CHANGELOG.md` 的「未发布」段。
- `src/core/` 禁止 import 会话字节工具（`utils/session-log*`、`utils/zstd-frame`）；应用内**只读**，任何写会话字节只允许在离线 CLI/宿主侧。
- 绝不猜：读不到就是 unknown；不发明 message id、不发明 tool/result、不宣称「已验证」。
- 离线修复必须：先重跑「连续性 + 引用完整性」校验（不过即拒绝）→ 时间戳备份 → 临时文件 + rename 原子换入 → 写后复验；并检测 DSH 是否在跑，在跑就拒绝写。
- 验证阶梯：`npm run typecheck` → `npm run typecheck:tests` → `npm test`；动 client 后 `npm run build` + `node --test src/client/bundle-selfcontained.test.ts`。新增路由**必须**更新 `tests/route/route-parity.test.ts` 快照；新文案必须进 zh/en 两套字典。
- 工作区可能有另一个写入者：动手前先 `git status`，共享文件（`src/client/locales.ts`、`config-manager.module.css`、路由快照）用最小 `edit`，不要整文件重写。

**交付**：实现 + 测试 + 文档收口；最后按「任务 / 落点 / 验证（命令 + 通过数）」逐项汇报，未做成的如实写明原因与剩余工作。