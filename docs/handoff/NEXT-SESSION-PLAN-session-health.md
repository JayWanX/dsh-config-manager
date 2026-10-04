# 下一轮计划：会话体检（P1）+ 处置开关 + 离线修复

> 交接性质文档（写给下一个会话/Agent）。背景与证据见：
> - `docs/design/2026-09-30-session-format-disposition-design.md`（处置开关设计 + §9 落地进度 + §10 **会话修复域调研**）
> - `docs/spec/known-gaps.md` **G-23**（会话格式版本单向兼容 + DSH 静默跳过）
> - `CHANGELOG.md` 顶部「未发布」段（已落地内容）
>
> **已落地，不要重做**
> 1. 宿主探针 `src/utils/session-format.ts`：`parseSessionFormatVersion` / `readSessionFormatVersionAt` / `resolveSessionFormatVersion` / `probeSessionFormats`（**单元级** `units[{unitId,version}]`，上限 200）。
> 2. `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe`（`ImporterOptions` 同名）→ `Analyzer.resolveSessionFormats`（**每份归档只算一次**）→ 告警 `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`。
> 3. `PlanItem.formatUnsupported = {version,target}`；`ImportAnalysis.sessionFormats = {target,unreadable,sampled,skipped}`。
> 4. 档案页显示各档案的 DSH 版本与会话格式版本（`profileVersionFacts` / `sessionFormatRisk`）。
> 5. 同步 `pull()` 把 `analysis.warnings` 并进差异报告 message。
>
> **环境**：仓库 `D:\Projects\personal\dsh-config-manager`；Node ≥22；命令与规范见 `AGENTS.md`。
> **红线**：**不 bump 版本号、不打 tag、不发布**；改动只写进 `CHANGELOG.md` 的「未发布」段。

## 0. 总览（按顺序，前一项验证通过再开下一项）

| ID | 任务 | 优先级 | 依赖 |
|---|---|---|---|
| T1 | 导入/同步「不可读会话」处置开关（中止 / 跳过 / 引导升级） | P0 | 无 |
| T2 | 导入会话后的「需要重启/刷新」提示 | P0 | 无 |
| T3 | 会话体检数据层（core 纯分类 + 宿主只读采集） | P0 | 无 |
| T4 | 会话体检只读路由 | P1 | T3 |
| T5 | 会话体检面板（事故恢复子 tab） | P1 | T4 |
| T6 | 离线 CLI：重放族 + header 重建两类安全修复 | P1 | T3 |
| T7 | 文档 / 规格 / CHANGELOG 收口 | P0 | 全部 |

---

## T1 处置开关（中止 / 跳过 / 引导升级）

**目标**：向导与一键同步的确认页，对「本机读不了的会话」给出三选一，**默认 `abort`**；三种选择都必须显式可见、结果写进报告。

**落点**
- core：**无需新逻辑**（`analyzed.sessionFormats` 已够）。
- host：`src/routes/import.ts` 的 `/plan`、`/execute` 与 `src/routes/sync.ts` 的 preview/apply 接受 `sessionFormatDisposition: 'abort' | 'skip' | 'guide'`（缺省读插件配置项，再缺省 `abort`）。
  - `abort`：**计划阶段**返回带 code 的拒绝（HTTP 409，code `sessionFormatUnsupported`，附 `{ unreadable, target }`），**零写入**。
  - `skip`：不新增服务端过滤；把这些单元**默认不勾选**（复用既有 `includeItems` 机制），报告显式写「跳过 N 条（v{newer} > 本机 v{target}）」。
  - `guide`：不改变写入行为，只带升级/重导出指引（可复制命令）。
- ui：新增 `src/ui/session-format-disposition.ts`（纯函数：由 `analysis.sessionFormats` + 用户选择推导「阻断理由 / 待跳过单元 / 指引文案」）+ 单测。
- client：`ImportWizardView` 确认页三选一 radio + 阻断态；结果页回显选择与实际跳过数。
- i18n：core 文案进 `src/core/messages.ts`，UI 文案进 `src/client/locales.ts`（**zh + en**）。

**验收**：三选一都在 UI 可见；`abort` 时零写入且给可复制指引；`skip` 时跳过的条数与报告逐条一致；`guide` 写入行为不变但带指引。

**验证**：`node --test src/core/import-sessions-visibility.test.ts`（扩三种选择各一条）、`src/ui/import-wizard.test.ts`（阻断 / 跳过分支）。

**不做**：不做格式转换；不自动升级 DSH。

---

## T2 导入会话后的重启提示

**目标**：写入会话后明确提示「会话列表需要重启 DSH 才刷新（桌面端：退出应用重开）」——这是生态实测的必需提示（dsh-chatsync 同结论）。

**落点**：`src/adapters/sessions.ts` 的 `finalizeApply` 结果带 `needsRestart`（或专用条目）→ `src/ui/next-steps.ts` 的 `importNextSteps` 增加对应分组 → i18n zh/en。

**验收**：导入含会话的包后结果页出现重启提示；只导设置时不出现。

**验证**：`src/ui/import-wizard.test.ts` 的 needsRestart 用例扩展；`src/adapters/sessions.test.ts`。

---

## T3 会话体检数据层（只读）

**目标**：一个只读的「本机会话体检」分类器 + 宿主采集器，覆盖设计稿 §10.2 的损坏分类与既有可见性维度。

**落点**
- `src/core/session-health.ts`（新，**纯函数**）：
  - 输入：每会话 `{unitId, projectKey, headerVersion?, headerCwd?, origin?, parentSessionId?, sizeBytes, mtimeMs, hasLog, structural: {ok, reason?}}` + 工作区记录 + `targetFormatVersion` + 本机已知会话 id 集合。
  - 输出：每行 `{unitId, severity, issues[]}` + 摘要（按严重级计数、截断计数）。
  - 分类清单（判据见设计稿 §10.2）：重放重复行 / 合成 closer 块 / 撕裂尾帧 / header 不可读 / seq 空洞 / 不可解析事件 / 缺 message id / 空或悬空 tool-call / settlement 字段非法 / 位置与 `projectKey(header.cwd)` 不一致 / 未登记工作区 / 子代理缺父 / 格式版本超前。
  - 严重级排序：`blocksStartup` > `unloadable` > `nextRequestFails` > `invisible` > `ok`。
- `src/utils/session-health-scan.ts`（新，**宿主侧**）：结构扫描复用 `utils/zstd-frame.ts` 的帧扫描与 `utils/session-log.ts` 的首帧解析，**不解码正文**；深度校验为**可选**：能力探测后动态 import 已装 DSH 同树的 `@deepseek-ai/dsh-session-format-catalog`（`installAnchor` 同源解析），`createRestore(strict) + decodeRow + finish`；任何失败一律记「未验证」，**绝不宣称已验证**。
- `src/index.ts`：会话存储门面新增只读采集方法（或独立门面），供路由调用。

**验收**：分类器每类一条单测 + 严重级排序 + 读不到一律 unknown；采集器在真实 home 上只读跑通、有上限（默认深检 ≤200 条）与截断计数、不抛错。

**验证**：`node --test src/core/session-health.test.ts`、`src/utils/session-health-scan.test.ts`。

**不做**：应用内**绝不写会话字节**；不猜、不修补。

---

## T4 会话体检只读路由

**目标**：`GET /api/dsh-config-manager/recovery/sessions`（只读；支持分页/上限），返回摘要 + 行。

**落点**：`src/routes/recovery.ts` 加一条 `endpoint({ path, methods: ['GET'] }, handler)`（围栏由 kit 统一包装，**不要**手写 guard）。

**验收 / 验证**：**必须同步更新 `tests/route/route-parity.test.ts` 的路由快照**（当前 70 条 → 71 条）；route-fence / route-channel-guard 全绿；真机 `curl` 无 cookie 也 200。

---

## T5 会话体检面板

**目标**：事故恢复子 tab 新增「会话体检」区块：一键只读扫描 → 摘要（按严重级）→ 行列表（版本 / 归属工作区 / 父对话 / 位置 / 大小 / 最近活动）→ 每行「复制修复命令」。

**落点**：`src/client/recovery/RecoveryPanel.tsx`（装配）+ `src/ui/session-inventory-view.ts`（纯函数与展示模型 + 单测）+ `src/client/config-manager.module.css`（样式）+ `src/client/locales.ts`（zh/en）。若引入 DESIGN.md 未覆盖的 pattern，先定义并写回 `DESIGN.md`。

**验收**：空态 / 加载 / 错误 / 截断（未检查条数可见）/ 只读提示齐全；长列表限高内滚（`reportScroll` 等既有类），不撑长整页。

---

## T6 离线 CLI 安全修复

**目标**：`dsh-config-manager sessions repair` 增加两类**零/低损失**修复，其余只报告并给非破坏性出路。

**落点**
- `src/core/session-repair.ts`（已有位置归位计划，纯数据）扩展为「修复计划」：重放族（字节相同重复行 / 合成 closer 块，判据见设计稿 §10.2–10.3）与 header 重建。
- `src/utils/session-log-repair.ts`（新，**宿主/CLI 侧**）执行：写前**重跑连续性 + 引用完整性校验**（不过即拒绝，绝不「修得更狠」）→ 时间戳备份 → 临时文件 + `rename` 原子换入 → 写后复验。
- `src/cli/sessions-repair.ts` 接线：`list` / `doctor`（只读）/ `repair`（预览）/ `--apply`（写）/ `export`（Markdown 转写保内容）/ `quarantine`（移出 DSH 视野，**不删除**）。
- **必须检测 DSH 是否在跑**（有活心跳 / 台账记录即拒绝写，提示先停 DSH）。

**验收**：每条修复路径有合成夹具（构造破坏样本 → 修复 → 用 DSH codec 复验可读）；备份存在；未通过校验的计划**零写入**。

**验证**：`node --test src/core/session-repair.test.ts`、新增 `src/utils/session-log-repair.test.ts`、CLI 冒烟。

---

## T7 收口

- `docs/spec/known-gaps.md`：新增 **G-24**（本地会话损坏缺诊断/安全修复通道），修复后更新状态。
- `docs/spec/compat-matrix.md`：若涉及读侧校验补一行。
- `AGENTS.md` 常见坑：补一条「重放族是主导损坏 + 修复必须离线 + 校验不过就拒绝（postmortem #2257）」。
- `CHANGELOG.md` 未发布段：补本轮亮点（双语）。
- 设计稿 §9：更新落地进度。

---

## 全局硬约束（每个任务都适用）

1. **分层**：`src/core/` 不得 import 会话字节工具（`utils/session-log*`、`utils/zstd-frame`）；写操作只能在宿主/CLI 侧。
2. **绝不猜**：读不到 = unknown；不写、不判、不宣称兼容。
3. **只读优先**：应用内零写入；离线写操作必须「校验计划 → 备份 → 原子换入 → 复验」。
4. **验证阶梯**：`npm run typecheck` → `npm run typecheck:tests` → `npm test`；动 client 后 `npm run build` + `node --test src/client/bundle-selfcontained.test.ts`。
5. **新增路由必须更新 `tests/route/route-parity.test.ts` 快照**；新增用户可见文案必须进 zh/en 两套字典。
6. **并发**：工作区可能有另一个写入者（共享文件：`src/client/locales.ts`、`config-manager.module.css`、路由快照）。动手前 `git status`；共享文件用最小 `edit`；改完全量验证。
7. **不 bump 版本、不打 tag、不发布**。

## 完成定义（DoD）

- T1–T7 实现完毕，测试全绿，文档/CHANGELOG 已更新。
- 汇报格式：每项一行「任务 / 落点 / 验证（命令 + 通过数）」；未做成如实写原因与剩余工作，不夸大。
