# 远程同步通道子 tab 面板与按通道独立配置设计（2026-08-19）

## 背景与动机

远程同步面板此前只有一个通道选择下拉（Git/WebDAV），且**自动同步（autosync）、同步模式与分区勾选（sync-selection）、是否加密、远端快照列表全部是全局一份**——切换通道时这些设置共享，无法让 Git 仓库与 WebDAV 服务器各用各的策略（例如 GitHub 自动同步 30 分钟、WebDAV 手动推送加密快照）。

需求：远程同步下增加**子 tab 面板**切换 GitHub / WebDAV，两个选项各自拥有独立的：

1. 自动同步（enabled / 间隔 / 运行状态）
2. 同步模式（默认快速导出 / 高级自定义勾选）
3. 是否加密（encrypt / includeSecrets，密码仅内存）
4. 快照（各自远端历史快照列表与选择）

## 数据模型（Host 侧，schema v2 + v1 迁移）

### sync-autosync.json（`src/sync/autosync-config.ts`）

v1（顶层单通道）→ **v2 按通道命名空间**：

```json
{
  "schemaVersion": 2,
  "channels": {
    "git":    { "enabled": false, "interval": "30m", "startupMinIntervalMs": 300000, "consecutiveFailures": 0, "lastRunAt": "…" },
    "webdav": { "enabled": true,  "interval": "5m",  "startupMinIntervalMs": 300000, "consecutiveFailures": 0 }
  }
}
```

- 读取 v1（顶层字段或缺 schemaVersion）→ 归一为 v2 的 **git 通道**（webdav 回退缺省），首次 v2 写回时持久化迁移。
- API：`readAutosyncConfig(dir, channel)` / `writeAutosyncConfig(dir, channel, cfg)`（写一个通道保留另一通道）/ `readAllAutosyncConfigs(dir)`（status 一次返回两通道）。

### sync-selection.json（`src/sync/sync-selection.ts`）

v1（顶层单通道）→ **v2 按通道命名空间**：

```json
{
  "schemaVersion": 2,
  "channels": {
    "git":    { "mode": "default",   "sections": [], "encrypt": false, "includeSecrets": false },
    "webdav": { "mode": "advanced",  "sections": ["settings", "skills"], "encrypt": true, "includeSecrets": true }
  }
}
```

- v1 迁移同 autosync（→ git 通道）；安全兜底不变（`includeSecrets` 必须伴随 `encrypt`）。
- API：`readSyncSelection(dir, channel)` / `writeSyncSelection(dir, channel, sel)` / `readAllSyncSelections(dir)`。

### AutoSyncScheduler（`src/sync/autosync-scheduler.ts`）

- `runOnce(channel, opts)`：按通道读 autosync 配置与 sync-config（新增 `sync-config.ts#readSyncConfigFor(dir, channel)`，从双命名空间取对应通道构造可辨识联合）。
- 定时器按通道各自排期（`timers: Map<channel, timer>`）；`start()` 对每个 enabled 通道执行启动触发下载合并。
- **全局防重保留**（`runs.register('autosync')` + `this.running`）：同一时刻至多执行一个通道的 runOnce，避免两个引擎并发写本地配置；另一通道的定时触发在本轮结束后自然补跑（事件驱动检测兜底，不丢同步）。

## API 路由（`src/index.ts`）

- `GET /sync/status`：新增 `syncSelectionByChannel` / `autosyncByChannel`（两通道 map，一次拉全，UI 按当前 tab 取）；保留旧 `syncSelection` / `autosync`（当前激活通道，兼容旧调用方）。
- `POST /sync/autosync`：body 新增 `transport`（缺省 git），写指定通道后 `scheduler.reload()` 重排双通道定时器；响应为该通道单个状态。`GET` 返回 `{ git, webdav }` map。
- `POST /sync/selection`：body 新增 `transport`（缺省 git），写指定通道并更新该通道的 `selectionCache`；`makeSyncEngine` 按 `cfg.transport` 取对应通道的分区选择。
- `selectionCache` 由单值改为 `Partial<Record<SyncTransportType, SyncSelection>>`。

## UI（Client 侧）

### 通道子 tab 面板（`SyncSettingsView.tsx`）

- 顶部 `modeTabs` 双子 tab：GitHub / WebDAV（复用「模式切换」现有 Pattern，非新样式；busy 时禁用切换防并发）。
- 每个子 tab 内容 = 该通道的：配置表单（git：repoUrl/token/OAuth；webdav：url/username/password/预设）→ 同步状态卡 → 同步模式（默认/高级）→ 加密与密钥导出 → 解密密码 → 一键同步 + 推送/拉取 → 选择历史快照下拉（该通道远端快照）→ 自动同步（该通道开关/间隔/状态）。
- 私有仓库提示 Banner 仅 git 子 tab 常驻；同步历史（`SyncHistoryView`）保持全局置于底部（记录两通道全部操作）。
- 渲染模型纯函数新增（`sync-view.ts`）：`ChannelSyncState`（每通道状态）、`defaultChannelSyncState()`、`channelTabModels(active, busy)`。

### 仓库选择器（选择已有仓库 / 新建仓库，2026-10-04 增补）

git 通道的仓库地址此前只能手填 —— 用户得先去 GitHub 建好仓库、复制 clone URL、再贴回来，且容易漏掉「必须私有」这条安全前提。现在配置弹窗的 git 分支在地址输入框上方多了一个仓库选择器（`src/client/sync/SyncRepositoryPicker.tsx`，自包含组件；地址输入框保留 —— ssh、本地路径、不在列表里的仓库仍可手填）：

- **选择已有仓库**：下拉列出当前 token 可见的**私有**仓库（公开仓库不进列表 —— 同步仓库公开即等于把配置内容公开），按最近更新排序，标签带更新时间与 fork 徽章；选中即把 clone URL 写进表单（走既有的 `onFormChange` + 防抖自动保存）。
- **新建私有仓库**：下拉末项是「新建私有仓库」，选中后在**同一弹窗内**展开内联表单（仓库名 + 可选描述）。**没有「公开」开关**，请求体也不传 `private` —— 宿主对这条端点恒定以 `private:true` 建仓，客户端连表达「公开」这个意图的途径都没有（安全约束落在宿主侧，UI 不重复也不放宽）。建仓成功后自动选中新仓库。
- 列表**惰性加载**（首次展开下拉、或进弹窗时地址已非空才请求）；失败不静默：内联红字 + toast，宿主下发的文本一律先过 `redact()` 再渲染。
- 纯逻辑（过滤/排序/地址归一/名称校验/请求体拼装/时间格式化）在 `src/ui/sync-repository-picker.ts`，与 React 解耦、可被 node:test 直接覆盖。

宿主侧新增一条端点（`src/routes/sync.ts`）：`GET /api/dsh-config-manager/sync/github/repositories`（列仓库，只读）与 `POST`（新建，宿主强制 private）**共用同一路径** —— 路由围栏按 `(kind, path)` 去重，同一路径拆成两条会撞车，仓库内已有 `/sync/autosync`、`/backup-schedule` 同款先例。REST 能力落在 `src/market/github-repos.ts`：新增 `createRepo(name, { private, description })`（`createPublicRepo` 改为委托它，签名不变）与 `listRepos(limit)`（`GET /user/repos?sort=updated&per_page=100`，只取第一页）。两条分支都不挂 mutation gate：列举是只读、建仓是幂等元操作，挂上会让 SAFE MODE 下的用户连仓库都选不了。

### run-store 切片（`SyncStoreSlice`）

- 顶层保留通道表单字段（repoUrl/token/webdavUrl/username/password），新增 `byChannel: { git: ChannelSyncState, webdav: ChannelSyncState }`。
- **安全白名单深处理**：`toPersistedState` 除剔除顶层 token/webdavPassword 外，对 `byChannel` 内每通道的 `encryptPassword/encryptPasswordConfirm/decryptPassword` 同样硬性剔除（测试断言不落盘）。
- 旧版 sessionStorage（顶层 syncMode 形状）→ 迁移为 git 通道的 byChannel 状态。

## 兼容与迁移

- 磁盘配置 v1 → v2 读取时自动归一（git 通道），不破坏既有用户数据；webdav 通道首次使用回退缺省。
- sessionStorage 旧形状 → git 通道迁移（run-store `applyPersisted`）。
- 旧 API 字段（`syncSelection`/`autosync`）保留返回，避免破坏其他调用方。

## 安全约束（不变量不变）

- 密码/token 仍仅内存：推送成功后清空、`toPersistedState` 白名单剔除（含 byChannel 密码类）、刷新后要求重输。
- `includeSecrets` 必须同时 `encrypt`（读写两侧均强制）。
- autosync 无密码，遇加密快照仍跳过并在历史提示（按通道独立记录）。
