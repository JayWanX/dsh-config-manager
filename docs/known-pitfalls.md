# 常见坑与事故记录（详细版）

> **来源**：原 `AGENTS.md`「📌 常见坑」章节全文（2026-10-05 逐字移出，未改写）。
> **为什么移出**：`AGENTS.md` 每轮对话都要进模型上下文，受 DSH 的 workspace instruction 预算（65536 B）限制 —— 项目 `AGENTS.md` 一旦 ≳64 KB，全局 `~/.dsh/AGENTS.md` 会被**整份丢弃**（dsh-agent-instructions 的 `renderInstructionContext`：文件按「最宽泛 → 最具体」排序，超预算时从最宽泛的整份丢弃）。压缩后 `AGENTS.md` 只保留**铁律与硬约束** + 指向本文的指针，本文保留**完整叙事、真机证据、量化数据与复核脚本**。
> **怎么用**：改相关模块前先读 `AGENTS.md` 对应铁律；需要「当时为什么这么定」「真机复现路径」「量化数字」「复核脚本在哪」时来这里。
> **维护约定**：新增坑 → `AGENTS.md` 写铁律 + 本文写细节，**两处都要**，不要只写一处。

---

- **DSH 没有「默认 / 下次启动 profile」这种状态（档案切换的真实根因，2026-09 真机定位并据此重做）**：profile 只由启动参数决定 ——
  `dsh <名>` / `--profile <名>`，`dsh web` 是硬编码别名（`apps/cli/src/args.ts` 里缺 `--profile` 直接报错退出），
  启动日志/状态文件里**没有任何「上次用的是哪个 profile」**；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 上的 home 层补丁，
  换不了 profile。**曾经写过 `<dataDir>/next-profile` 标记 + 「设为下次启动」按钮 —— 那是写了个没人读的文件**（用户自己敲的
  `dsh web` 重启后当然还是 web；真机：设 PROVA 为下次启动 → 重启仍进 web）——2026-09 该标记与按钮**整体移除**：它只会让用户以为
  切换成功了。真正可用的切换只有两种：① **另起独立实例**（本插件「启动/停止该档案」= `dsh --profile <名> --port <空闲端口>` detached +
  从子进程日志抓带 token 的认证 URL + HTTP 探活 + 按 `process.kill(pid,0)` 判活；生态里的 dshm / DSH Launcher 走的都是这条）；
  ② 把用户的启动命令/快捷方式换成 `dsh --profile <名>`（插件无法远程改别人的启动入口，所以只能给命令）。**当前档案的识别（issue #52，2026-09）**：宿主在 boot 时 `provide('profileContext', { name, dir, … })`（DSH ≥ 0.1.7 取证）—— Desktop 外壳**不传 `--profile`**，只认 argv 会把 desktop 认成 web（插件清单来源 / 档案页「当前运行」/ 备份·导出·恢复目标全落到 `profiles/web`）；解析链恒为 `config.profile` → `profileContext` → `--profile` → `DSH_PROFILE`/`DSH_PROFILE_DIR` → `web`（`src/index.ts` 的 `resolveProfileName` + `src/core/plugin-cli.ts`，由 `src/core/plugin-cli.test.ts` 钉住）。五条硬约束：
  ⓐ **只对 web 形态可启动**（headless/generic 如 base 模板 spawn 出去是用户看不见的进程 → `notLaunchable` + 终端命令，绝不假装成功）；
  ⓑ **实例台账是唯一事实**（`<dataDir>/launches.json`：pid/port/url/log；`listRunning` 按 pid 存活过滤并清死记录，UI 的「启动 ↔ 停止」就是它的投影——
  DSH 不认识插件启动的进程，不记账就永远关不掉）；
  ⓒ **同一 profile 不许重复启动，判据是「心跳」而不是「台账」**（真机 bug：从 web 启动 cmtest 后，在 cmtest 的界面里还能再启动 web —— web 是手动敲起来的，不在任何台账里）：
  每个加载本插件的实例在 apply 时往 `<dataDir>/running/<profile>.json` 自报 `{pid, port, startedAt, updatedAt}`（`dsh-profile-runtime.ts`；20s 刷、60s 判死、pid 死或过期即清理；**绝不写认证 token**——那等于把该实例的 DSH RPC 交给本机任意进程）。
  `GET /profiles` 的 `running` = 台账 ∪ 心跳的合并视图（`owned` 标谁启动的、`current` 标是不是自己），`launch` 前同时过台账与心跳 → 已在跑就 `alreadyRunning`，**启动当前档案直接 `currentProfile`**；
  心跳里的**别的实例也能被停**（`stopExternal` 按它的心跳 pid 走同一套优雅→强杀），但**不能停自己**（`currentProfile`：进程会死在响应途中，UI 给禁用按钮 + 「关窗口」提示）；
  「实例运行中」的判据同样用合并视图（删除档案前挡住）；存活判定/优雅期/终止只有一份实现（`process-control.ts`，Windows 无优雅通道 → 1.5s 后必然强杀）。
  ⓓ **launch / stop 不过 mutation gate**：它们不写任何配置文件，而 gate 会把环境锁占到 handler 返回（launch 最长等 20s 就绪）——
  真机实测：gated 版本会在「启动完成后 1s 内点删除/停止」时回 423 mutation-locked，且那 20s 里导入/恢复全被挡（无 gate 后改用
  「就绪后再查一次台账，撞名就杀掉自己那个并报 alreadyRunning」兜住双开窗口）；
  ⓔ **绝不静默**：每个失败码都带原因，`launchFailed` / `stopFailed` 附子进程日志尾部或 pid；停止如实区分 graceful / killed / already-stopped。
  ⓕ **进行中态必须住进 runStore 切片**（真机两轮定位）：`launching/stopping/creating/renaming/deleting` 放进 `runStore.profiles`，
  面板用 `useSyncExternalStore(runStore.subscribe, selectProfilesSlice)` **订阅读取**（`PanelState = ProfilesStoreSlice`，不另存 useState 副本）——
  ① 留在组件 state 里，切页签（卸载）就归零：正在启动的按钮切走再回来变回「启动」，用户以为没点上而重复点；
  ② 只写 store 不订阅，上一次挂载遗留的那次请求（launch 最长 20s，必然踩到）回来时界面不刷新 → 「启动中」一直转。
  进行中态/弹窗目标/启动回执**不落 sessionStorage**（发起请求的页面已随刷新销毁，重放 spinner 只会骗人；`launchResult.url` 还带 token）。
  新增字段必须同时进 `toProfilesStoreSlice`（`run-store.test.ts` 的键集合 + 镜像不漏字段用例会红）。详见 `DEVELOPERS.md` 状态管理细则。
  改这块前先读 `src/profiles/dsh-profile-launcher.ts` 的文件头与 `src/profiles/dsh-profile-launcher.test.ts`
  （真机验证脚本：`outputs/launch-verify/`）。
- **DSH Desktop（Electron 桌面端）的保留档案 `desktop`：插件操作必须走桌面端自带的 CLI 载体**（2026-09 真机：导入 10 个插件全红，每条都是 `error: profile "desktop" is managed exclusively by the Electron application`）。硬事实与接线：
  ⓐ `desktop` 是 **Electron 独占保留档案** —— 普通 CLI 对 `--profile desktop` **无条件**拒绝（`@deepseek-ai/dsh@0.1.5-rc.1` / `0.2.0-rc.2` 的 `lib/bin.js` 里 `rejectElectronProfile`；`plugin` 子命令只在 `manageDesktopProfile` 为真时跳过它，0.2.0 还额外要求该档案的 `package.json` 已存在）；
  ⓑ **唯一放行的入口 = 桌面端自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`**（它以 `runCli({ manageDesktopProfile: true, packageManager })` 启动，用桌面端内置 runtime + 内置 pnpm）。宿主进程由 Electron 主进程以 Node 模式拉起：`process.argv[1]` 就是同包的 `lib/index.js`，同目录的 `cli.js` 即载体 → 识别在 `src/utils/desktop-carrier.ts`，接线在 `core/plugin-cli.ts` 的 `dshArgv(profile)`（目标是 desktop 时改用它，并补 `ELECTRON_RUN_AS_NODE=1`；检测不到载体则落回原路径，由新的失败分类 `desktop-profile-reserved` 给可操作说明）；
  ⓒ **桌面端在 `app.asar` 里跑 0.2.0-rc.2，磁盘上 `<home>/profiles/node_modules/@deepseek-ai/dsh` 却是 web 档案 hoisted 出来的 0.1.5-rc.1** —— 「当前 DSH 版本」只能从 `profileContext.installAnchor`（= 拉起本宿主的那份 `package.json`）取（`resolveDshVersion`），按磁盘猜一定报错版本号（「关于」页 + 导出 manifest 同源）；
  ⓓ `desktop` 的 bundles 里**确实有** `@deepseek-ai/dsh-web-app`（`classifyShape` 判定为 web），所以**只看形态会误放行「启动」**（spawn 出去只会拿到上面那条英文拒绝）；删除/改名会让桌面端下次启动按 web 模板重建一个空档案（插件全丢）→ 启动/删除/改名三者一律以 `managedProfile` 拒绝（连 `allowCurrent` 也不行），UI 文案不再给 `dsh --profile desktop` 那条本就是被拒的命令；
  ⓔ **只装了桌面端（PATH 上没有 `dsh`）的机器**，启动器此前恒 `launcherUnavailable` → 现在回退到载体；**PATH 上的 `dsh` 仍然优先**（各档案的 `node_modules` 就是那份装的，同一份启动最不容易踩版本混用）；
  ⓕ 插件安装失败提示里的 profile 必须与**实际安装目标**同源（`ctx.target.profile ?? resolveProcessProfileName()`）—— 桌面端外壳不传 `--profile`，只调 `resolveProcessProfileName()` 会写出「装的是 desktop、提示却让用户跑 `--profile web`」的自相矛盾。
- **复制档案（`POST /profiles/copy`）的三条硬约束**（2026-09 实测落地）：① **必须跑链接重指向** —— async
  `fs.promises.cp` 与 `cpSync` 行为不同：cpSync 会把 junction 展开成真实目录，而 `promises.cp` 只把链接照抄，
  留下的是**指向源档案**的绝对路径（实测真机 cmtest：48 个 junction 里 37 个在源档案树内），源档案一删副本就缺包；
  所以拷完走 `relinkCopiedTree`：**只重指向树内链接**（unlink + 重建 junction，Windows 上 junction 不需要管理员权限），
  指向树外的（`link:` 依赖指向用户仓库、DSH 从安装目录投影出的 fallback）一律原样保留。判链接用
  `readdir(withFileTypes).isSymbolicLink()`（Windows 对 junction 也返回 true）→ 无需逐条 lstat。
  ② **整档案拷贝必须走 async fs**：285 MB / 1.7 万条目实测 cpSync 25 s、`promises.cp` + 重指向 ≈ 30 s，但前者把宿主
  事件循环卡住整整 25 s（DSH 界面全冻）；③ `includeNodeModules=false` 时**同时跳过 `node_modules` 与 DSH 投影出来的
  `.dsh-module-fallback`**（后者是派生目录，单独搬运只会留下一堆悬空链接，DSH 启动时会重建），并让缺依赖回到
  回执里（`warnings: ['depsNotInstalled']` + `dsh plugin --profile <副本> install`），绝不静默成功；中途失败回滚目标目录。
  真机复核脚本：`outputs/profile-copy-verify/verify.mjs`（拷 cmtest → 数链接重指向 → 删探针副本）。
- **复制档案的中断残留：标记先行 + 「只认自己的标记」**（cross-F3，t39；真路由 8/8 PASS 见
  `outputs/bug-audit/cross-v3v8/VERIFY-t39-route.{mjs,log}`）。复制是「mkdir 目标 → 逐条 cp → 重写
  package.json」的多步长事务，被强杀/断电会留下「有文件、无 package.json」的半截目录；既有口径
  「有 package.json 才算 profile」会**跳过**它 —— 用户既看不见（不在列表），也删不掉（`requireProfile` → notFound）。
  ① **标记先落盘**：`mkdir(dest)` 之后、拷第一个条目之前写 `.dcm-copy-in-progress.json`
     （`PROFILE_COPY_MARKER_FILENAME`，`dsh-profile-shared.ts:192`；字段
     `sourceName/newName/startedAt/includeNodeModules/pid`，`dsh-profile-manager.ts:215-222`，原子写 `mode 0o644`）。
  ② **三种结局**：成功 → 删标记（`manager.ts:246-251`；删失败也无害，列表以 package.json 为准）；
     抛错 → 整个目标目录回滚（`manager.ts:238-244`），磁盘上不留半截；**只有进程被强杀**才会把标记留在盘上
     —— 这正是要辨识的情形。
  ③ **可见 + 可删**：`list()` 对「无 package.json 但有标记」的目录产出 `incomplete: true` 条目
     （`shape='generic'` ⇒ `isLaunchableShape` 恒假、**绝不给启动按钮**；`dir` 是目标绝对路径；
     `copiedFrom`/`copyStartedAt` 仅在标记可解析且字段非空时出现），同一条判定也用于 `detail()` 与恢复面板的
     `listIncompleteCopies()`（`manager.ts:406-469`）⇒ **不会「列表说没有、面板说有」**。
     删除走既有 `POST /profiles/delete` → `remove()` → `requireManagedDir()`：**有 package.json 或有标记**都接受
     （`manager.ts:344-367`），`managedProfile`（desktop）仍一律拒绝；删除进 mutation gate —— SAFE MODE 下 423
     且**目录保持原位**（真路由实测：base 列 `[]` + 删除 404 `notFound` → 修复后列出条目 + 删除 200 且目录消失）。
  ④ **读标记只判存在性**（`manager.ts:378-395`）：内容坏掉（手工改过/写盘中断）仍算半截副本 —— 宁可多报一个可疑残留，
     也绝不把孤儿目录重新变成「查不到也删不掉」；`pid` 只作诊断（列表/面板都不消费它，也不据此判「是否还在写」——
     pid 会复用）。
  ⑤ **边界不放宽（最重要）**：既无 `package.json` 又无标记的目录仍**跳过**、`detail`/`remove` 仍报 `notFound`；
     判据只有**我们自己的标记**，绝不引入「看着像残留就删」的启发式（否则会删掉用户手工建、还没装好的目录）。
  ⑥ **残余限制（如实登记）**：修复（t39）之前就存在的**无标记**孤儿目录与「用户手工建的目录」在磁盘上**不可区分**，
     没有安全的自动判据 → 唯一处置是用户手工删（t39 倾向不做显式清理通道）。
- **pnpm 发布年龄**：`@latest` 装旧版是 pnpm 11 `minimumReleaseAge`（<30天被排除）；解决：精确版本装一次白名单，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。
- **通配删除源文件之前，必须先确认目标里没有「未跟踪但在用」的文件**（2026-10-03 实测事故：
  `Remove-Item src/client/snapshots/*.tsx` 一次删掉了三个仍在使用的组件，其中
  `DiskUsageCard.tsx` / `BackupScheduleCard.tsx` 在 git 里**从未被跟踪**（一直是 `??`）
  —— 它们在更早的会话里创建后就没提交过，所以**没有可 `git show` 的版本**，只能从
  `lib/client.js` 的**编译产物**逐段翻译还原（JSX→jsx()、CSS Modules→对象、类型全丢）。
  铁律：① 删任何源文件前先跑 `git status --porcelain <路径>`，**看到 `??` 就必须停下**，
  逐个确认它是不是活代码；② 存活时间长的组件应尽早提交，别让「工作区里有、git 里没有」
  变成常态；③ 真要整目录清理，先 `git add -A <目录>` 把它纳管，再删——至少留得住。
  **为什么编译产物救得回来**：`lib/client.js` 是自包含单文件，每个组件连同文件头注释都在里面，
  按 `function <Name>(` 定位、前后取 `/**` 与 `//#endregion` 就能切出完整实现；
  还原后必须逐项核对**文案键与 CSS 类**（脚本比对 `t("...")" 与 `css.xxx`）才算数。
  **绝对不要**用「看起来对」的重写冒充原文件——还原版要在文件头注明是还原的。
- **绝不要用 `git checkout -- <文件>` 回滚这个仓库的工作区文件**（2026-10-03 实测事故，比通配删除更隐蔽）：
  为了撤销一次过度剪枝，我对四本字典跑了 `git checkout --`，它们的**工作区版本比 HEAD 新得多**
  —— 本仓库长期有大量**未提交**改动，回滚一个文件 = 抹掉此前所有会话的在途工作。
  `npm run typecheck` 从 0 个错误变成 **170 个**，其中 130 个是「字典键凭空消失」。
  铁律：① 回滚任何文件前，先 `git diff --stat HEAD -- <文件>` 看清**差异是不是自己造成的**；
  ② 要撤销自己的改动，用**针对性的 edit 反向操作**，不要用 git 的整文件回滚；
  ③ 真要整文件回滚，先把当前版本 `cp` 到 `.tmp/` 备份。
  **怎么救回来（可复用）**：`lib/client.js` 是**回滚前构建产物的快照**，字典整本内联在其中
  （`"key": "值"`）。写脚本按「tsc 报错点名的键 → 正则回捞 zh/en 值 → 注入字典」逐轮迭代，
  直到 tsc 不再报新键为止——130 个键两轮补完，且**值逐字与回滚前一致**（抽样比对通过）。
  三个必须注意的坑：① 编译产物里的转义是 `\\"` 形态，注入时要还原；② 值里含单引号
  （如 "DSH's plugin page"）必须转义，否则整行语法崩；③ `PaletteTitleKey` /
  `CompatibilityNoteKey` 这类**联合类型**的键不会被 tsc 的报错文本点名（只报类型名），
  必须**去类型定义处逐个抄**——只靠报错文本会永远修不完。
- **Windows LF→CRLF 警告**：无害噪音。
- 根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore。
- `dist/` 需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 否则 ENOENT）。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`。
- **`src/client/` 不 import node 模块**（`PathMappingForm` 因 `utils/paths.ts` 依赖 node:path 做了轻量等价实现，刻意为之）。
- **style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回 `isSymbolicLink()===true`（`isDirectory()` 为 false），自己写 `if (isDirectory())` 分支会**静默丢掉整块内容**且备份仍报成功（issue #37 实测丢 12 MB）。新文件类 adapter 用 `adapters/link-report.ts` 的 `listFilesDetailed` + `linkWarnings`，别直接调 `ctx.fs.listRecursive`。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**（issue #35）：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`（`Failed to read patch file`）。导入端写入前必须剔除目标机无法满足的 `patchedDependencies` 条目（`adapters/pnpm-workspace.ts`），并让剔除在计划里可见；市场通道对 `patchFiles` 与 `localTarballs` 同级双端拒收。
- **会话日志的字节改写只允许在宿主侧**（issue #45）：DSH 会话日志（`session*.jsonl.zstd`）是**拼接的多帧 zstd 容器**，改写 cwd 必须只换第 1 帧 + 尾部**流式**拷贝 + 发布前自检（长度 / 首帧 cwd / 尾部抽查），且 **Windows 上 rename 覆盖前必须关闭读句柄**（否则 EPERM，实测踩过）。`src/utils/zstd-frame.ts` 是纯字节帧工具；`src/utils/session-log.ts`（首帧 cwd 读取 / 多 generation 改写 / 发布前自检 / 失败回滚）是**宿主适配器与 CLI 的唯一实现**——core 禁止 import（不得把 DSH 存储格式带进引擎）。改写后尽力刷新注册表索引（`reindexSessionHeader`，d.ts 标 private、已能力探测；不要用会清空 sessionPaths 的 replaceHeaderIndex），刷新不了就如实汇报、绝不谎报。**头等硬约束（实测）**：DSH 启动时校验「日志位置 == `projectKey(header.cwd)/id`」，位置与 header 不一致会让 `dsh web` 直接报 `corrupt session log ... header id ... and cwd identify ...`（同一 id 出现在两个 projectKey 目录则报 `duplicate JSONL session id ... in multiple project directories`）——所以**改写 header 必须连目录一起归位**，搬不动就回滚改写，绝不留半套。**应用内修复（T8，2026-10）**：`utils/session-repair-service.ts` + `POST /recovery/sessions/{repair,rollback}`（recovery prefix 内子路径，**不新增注册路由条目**）只做**能从字节证明的修复**（重放重复行 / 可证明的合成收尾块 = 零损失；seq 空洞 / 不可解析行的截断 = **有损，需显式 allowLossy**）：三道写入门（unitId 只能解析到会话根内 / 无 `session.lock` / 文件不在 30s 静止期内）+ 预览-应用指纹一致（TOCTOU）+ SAFE MODE 与 mutation lock + 写前自校验 / 时间戳备份 / 原子换入 / 写后复验；**回滚只认台账 `repairId`**（`<dataDir>/session-repairs.json`，客户端不传路径）。其余损坏类别仍只给离线命令。**一键修复全部（T11）**必须逐条独立（一条被拒不牵连其余）、**有损不批量**（lossy 计划跳过并计入被拒）、结果如实计数；列表默认只显示「需要处理」的行，被隐藏的正常会话数必须在界面上说明（绝不静默少显示）。不要因为「有了按钮」就放宽这几道门。
- **本插件是 bundle 包，隔离实例里挂载必须进 `dsh.profile.bundles`**（E2E 实测）：包的 `package.json` 有 `dsh.bundle.patch`，DSH 只会把它作为 bundle 组合进 profile 树；只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行是**非 bundle 包**的做法，插件不会挂载（表现为宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库（免 pnpm 联网）→ 把 `dsh-config-manager` 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**（`/` 与 DSH 的 `/api` 承载路由；插件 exact 路由无 cookie 同样可达，见「安全不变量 / 架构心智」的认证边界条）：先 `curl.exe -c jar "http://127.0.0.1:3099/?token=<token>"`（token 取自启动输出），再 `-b jar` 调那些路由；POST 体用 `--data-binary @<file>`（PowerShell 传 `-d '{"x":1}'` 会丢引号 → 路由报 `invalid JSON body`）。脚本留存于 `outputs/e2e-45/`。
- **文件集合分区永不参与导入期前缀映射**（issue #45）：`ConfigAdapter.fileCollection`（`FileCollectionAdapter` 置 true）标记的分区（sessions / pluginFiles / skills …）里，`relativePath` 是**身份**不是配置 —— 前缀映射一旦命中它的首段（`--projectKey--`），文件就会落到 `projectKeyOf(首帧 cwd)` 之外，目标机**下次启动直接失败**；`analyzer.applyMappingsToSections` 已按该标记整段跳过（`src/core/analyzer-mapping.test.ts` 钉住）。会话侧走**专用通道**：`SessionsAdapter.finalizeApply` 在整个分区写完后逐会话把 `ctx.pathMappings` 应用到**首帧 cwd**（`rewriteLogDir` 只换第 1 帧）再归位到 `projectKeyOf(映射后 cwd)`，搬不动就回滚首帧；没命中映射只做原有位置护栏。**导出会话时自动连带其所属工作区**（`exporter.coupleSessionWorkspaces`），因为会话要在目标机显示就必须有工作区指向它的 cwd；**这条不变量必须硬保证**（真机事故：用户只勾「历史会话」时导出过一个 `sections.sessions=true / workspaces=false` 的包，目标机上会话看不见 = 「对话丢了」）：① 归属匹配不上时**整分区带上全部工作区记录**，② 本机一条记录都没有 / 注册表读不到时如实告警，③ 连带白名单与分区选定**共用同一份 includeItems**（否则用户「全部取消勾选工作区」下发的 `includeItems.workspaces = []` 会在第二道过滤里把刚强制选中的分区再挡掉），④ 四种结果各有一条报告文案（`export.sessionsWorkspacesCoupled` / `export.sessionsWorkspacesCarriedAll` / `export.sessionsWithoutWorkspaces` / `export.sessionsWorkspacesUnreadable`）绝不静默，⑤ 导入侧对「有会话但没有任何工作区数据」的包（旧构建导出的历史包就是这种）在**分析阶段**告警 `import.sessionsWithoutWorkspaces`（`analyzer.analyzeBundle` 共享给分析与执行两条路径）；宿主半在 DSH 启动时加载、**没有热重载**——改了导出/导入逻辑后必须重启 DSH 才生效；工作区记录里的 `sessionIds` 由 `WorkspacesAdapter.finalizeImport` 在**全部分区收尾之后**（APPLY_ORDER 里 workspaces 在 sessions 之前）逐个 `attachSession` 登记，未登记成功记 warning。DSH 起不来时的唯一通道仍是离线 CLI（`dsh-config-manager sessions repair`）；隔离实例里复位 `storages/workspace.json` **必须先停宿主再改文件**（插件运行时 DSH registry 的内存是权威域）。**选择器层的联动**：勾了会话自动勾上拥有它的工作区、取消工作区自动取消它的会话（`src/ui/selection-model.ts` 的 `applySessionWorkspaceCoupling`；导出页与导入向导共用 `ContentPicker`，所以只写一份）。**方向必须显式传入**（`focus: 'sessions' | 'workspaces' | 'both'`）：这两条规则在「会话勾着、它的工作区被取消」时会互相抵消，按本次动作方向定夺才确定。工作区单元与会话单元配对用**两套判据**（`WorkspacesAdapter.listUnits` / `analyzeImport` 带上 `sessionIds` 与 `projectKey`）：
① 注册表 `sessionIds`（经 `sessionIdKey` 去掉 `session-` 前缀后比较 —— 会话目录名有 `session-<uuid>` / 裸 `<uuid>` 两种形态并存）；
② **cwd 目录键相同**（工作区 `path` 的 `projectKeyOf(path)`，客户端在旧宿主未回传该字段时用单元 `detail`=绝对路径现算）。
**为什么必须有 ②**（真机实测）：DSH 的 `sessionIds` 覆盖率极低 —— 一次可选择的 **570 条会话里只有 23 条**在里面，只认 sessionIds 时「点一个对话不带工作区」是常态；
而界面又按 cwd 目录键把会话显示在该工作区下（`session-meta` 分组同口径），联动必须与看到的一致。**绝不按会话路径做前缀匹配**（跨机路径不可靠）。
导出页的清单是逐分区惰性拉的：勾了会话就必须把 `workspaces` 清单一起读（`couplingInventorySections`），清单到货后再补一次联动（`ExportView` 的 effect，方向固定 `sessions`，用 `sameSelection` 防自激）。**跨机基础路径自动重定基**：导出时把本机 `$DSH_HOME` 写进 `manifest.sourceHome`；导入时若与本机 home 不同，`analyzer.rebaseMapping` 生成一条 `{oldPrefix: 源home, newPrefix: 本机home, appliesTo: []}` 并**插到用户映射之前**（`createImportPlan` 与 `executeImportPlan` 都走 `plan.pathMappings`，所以结构化分区路径 + 会话首帧 cwd + 目录归位一起生效），计划里通过 `ImportPlan.automaticMappings` 可见。只对**绝对路径**、且落在**段边界**的前缀生效（相对路径 / 两边相同 / 旧包缺字段一律不猜，行为与改造前一致）；用户映射排在其后可覆盖。
- **导出/导入的会话可见性必须由「包内实际带走的会话」驱动**（issue #45 ③，真机事故）：DSH 工作区注册表的 `sessionIds` 覆盖率极低（真机实测 570 条会话里只有 23 条），所以**绝不能只搬注册表原样的 `sessionIds`** —— 导出侧 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`，由 `Exporter.export` 在收集完分区后调用）按「cwd 目录键相同」把本次真正带走的会话声明进所属工作区记录（按 `sessionIdKey` 裸键去重、只增不减、写**日志侧原名**），报告出 `export.sessionsDeclaredInWorkspaces`；导入侧 `WorkspacesAdapter.finalizeImport` 的登记目标 = 记录声明的 ∪ 包内带数据的，失败**必须按「这次有没有带它的数据」分类**（带数据的失败 = warning + 真实原因；包外会话 = 不计失败的信息行 `adapter.workspaceSessionsOutsideBundle`），且每个 id 先试声明形态、再试另一种命名形态 —— DSH 只认会话日志首帧 header 的 `id`，它 `session-<uuid>` / 裸 `<uuid>` 两种并存（实测目录名与 header id 逐字相同），只试一种会以 `session persistence holds no such session` 被拒，用户看到的就是「导入后对话不显示」。复核：`outputs/e2e-45b/run.ps1`（隔离实例真导入，直接看 `storages/workspace.json` 的 `sessionIds`）。
- **子代理会话（origin='subagent'）不是工作区里的对话：导出时必须连带父对话**（真机事故：导入全部「成功」，工作区里一条都看不见）：DSH 客户端 `dsh-client-ui-workspace` 的 `sessionVisible()` 是 `session.origin !== "subagent" && ...` —— 工作区列表**只显示**顶层会话，子代理会话只作为**父对话的下一级**出现；只把子会话导出/同步过去，目标机导入侧一切成功（文件落盘、`workspace.json` 也登记了），用户在 DSH 工作区里却一条都看不到（真机：用户勾了 4 条子代理会话导出再导入，全无踪影 —— 它们的父对话都不在包里）。修复（**双向**）：`SessionsAdapter.export()` 收尾调用 `coupleSessionParents`（`src/adapters/sessions.ts`）——① **向上**：选中子代理会话就补父对话（父对话本身也可能是子代理会话 → 继续往上追），报告 `export.sessionParentsCoupled`；② **向下（2026-09 改为界面联动，引擎不再自己做）**：勾父时由**界面**自动勾上它的子代理会话（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，ContentPicker 的 `commit` 在每次单元点击后调用）——为什么要挪走：条目级白名单是用户意图的唯一事实，而引擎看不到「界面为什么没勾这条子会话」，自己向下补会把「用户单独取消的子会话」无声加回包里（真机：只勾 2 条 → 导出 41 个目录）；子会话清单由宿主 `SessionStoreFacade.parentRelations()`（`src/index.ts` 用 DSH `sessionPersistence.list()` 的 header `parentSession`+`origin` 实现，**不读日志字节**）提供，只收 `origin='subagent'` 的子会话（非 subagent 的会话即使带 parentSession 也是顶层行），经 `/export-preview` 的 `ExportUnit.parentSessionId`（裸键）下发给浏览器；**注意 `export.sessionChildrenCoupled` 已不再产生**（字典键保留备用）；追不到（本机没有 / 超出分区上限）报 `export.sessionParentsUncoupled`，绝不静默；**BFS 的「已排队」与「已展开」必须分成两个集合**（某个会话可能既是被选中的父对话、又是别人的子会话；混用一个集合会把它当「已见过」而不再展开 → 它的子代理会话静默丢失，真机实测踩过）；导入侧 `finalizeApply` 对「父对话不在包内」的子代理会话报 `import.subagentSessionsWithoutParents`（旧包兜底，把「导入成功却看不见」变成可读告警）。**父对话 id 在磁盘 header 里叫 `parentSession`，DSH 的 RPC 投影才改名 `parentSessionId`**（只认后者一个都认不出来，静默失效 —— 已由 `src/utils/session-log.test.ts` 钉住两种写法）。复核：`outputs/subagent-fix/export-check.ps1`（只勾 4 条子会话 → 包内 8 个会话文件 + 「已连带导出 4 个父对话」）与 `import-check.ps1`（干净目标导入 → DSH `session/list` 8 条，其中 4 条顶层会话 `cwd == workspace.path` 且在 `sessionIds` 里 = 工作区可见，4 条子会话按其父之下显示）。**②.1 父子联动的方向语义（白名单即权威）**（真机第二轮：用户只勾 2 条子代理会话，导出却打了 41 个会话目录 = 2 个父对话 + 37 条**从未勾选**的兄弟子会话，导入页显示「43 个历史会话」）：界面侧 = 勾父带子（传递）、勾子带父（父链向上）、取消父连带取消子、**取消子只取消这一条**；批量动作（分区/分组/全选、清单到货后补跑）走**正向闭包**（只补齐、绝不取消任何勾选项）。方向必须显式传入（`SessionParentChange`）——这两条规则会互相抵消（取消父后若还跑「已勾选的子 ⇒ 勾上父」，父立刻被勾回来，与工作区联动同一个坑）。引擎侧**只保留向上补父对话**（父缺席 = 导入后完全看不见）、**绝不再向下展开**：白名单即权威。复核测试：`src/ui/selection-model.test.ts` 的 5 条「父对话 ↔ 子代理会话联动」与 `src/adapters/sessions.test.ts` 的「只勾子会话 …不把用户没勾的兄弟会话一起打包」。
- **导出选择器里「历史对话」的排序时间有两个来源**（用户报告「没有按最新到最旧排」）：第一口径 = `storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`），第二口径 = `SessionsAdapter.unitActivityTimes()` 现算的**会话日志 mtime**（`/export-preview` 注入 `applySessionMeta`）。为什么必须有第二口径：那份缓存只覆盖一部分会话（真机实测同一项目 **731 个目录里 347 个不在缓存内**），缺时间的会话会退化成组尾的 uuid 字典序。**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`，单元 id 末段是目录名，`session-<uuid>` / 裸 `<uuid>` 两种形态并存 —— 不归一化会同时丢掉标题与时间）。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning`（非致命失败，§34.17）与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35 实测）。

- **备份有两种物理形态，而「形态判定」必须只有一份实现（issue #55，2026-10）**：勾了加密的导出产物是
  **DCA1 整包容器**（整份 ZIP 被 AES-256-GCM 包住），文件名却仍是 `.zip`、还躺在备份文件列表里。三条硬约束：
  ① **判定单一事实源 = `src/security/container-kind.ts`**（`containerKindOfBytes` / `readContainerKind`）——
  凡是「拿到一个备份路径或字节」的入口（上传 / 备份列表 / analyze / plan / execute）都要走它，各写一份必然分叉；
  ② **文件形态只读前 4 字节**（open+read(4)+close）——上传接口此前为看这 4 个字节把整份备份 `readFile` 进内存，
  `container-kind.test.ts` 有「只允许读 4 字节」的实测断言；**读不到一律回落 `'zip'`**（判不出形态 ≠ 判定为加密，
  交给 ZIP 解析器给精确错误，绝不猜）；
  ③ **未解锁的容器必须得到可判别的错误**：`/analyze`、`/plan`、`/execute` 一律
  `400 { code: 'encrypted-container' }`（`ENCRYPTED_CONTAINER_CODE`）+ `import.encryptedContainerNeedsUnlock`
  文案；客户端据码**自动进入解锁阶段**（旧宿主 / 脚本直调也兜得住）。历史事故：备份列表的「一键导入」把宿主
  路径直送分析 → 用户看到「不是合法的 ZIP 文件（缺少中央目录结束记录）」，以为备份坏了，其实只差解锁一步
  （浏览器选文件那条入口一直有探测）。**形态字段在列表里是可选探测**（`listBackupFiles(dir, { withContainerKind: true })`
  → `BackupFileMeta.containerType`），保留策略 / 磁盘体检保持零额外 I/O。
  **客户端半铁律**：`src/client/**` 只能 import **零依赖**的 `utils/shared-constants.ts` 拿
  `ENCRYPTED_CONTAINER_CODE` —— 若 import `security/container-kind.ts`，会把 security 桶 → `encryption.ts`
  （`node:crypto`/`node:util`）打进 `lib/client.js`，DSH 的 client loader 报 missed the module table，
  **整个插件不加载**（本轮实测踩到，已由 `bundle-selfcontained` 护栏复核）。

- **SAFE MODE 的可见性与出口（issue #56，2026-10；与 issue #31 的残留锁同一类缺陷复发）**：durable标记
  `<dataDir>/transactions/safe-mode` 一旦落盘就跨重启生效，而**解除它的判据必须只有一份实现**
  （`recovery-orchestrator` 的 `resolveSafeMode`：active 全部为已解决终态才清，NEEDS_ATTENTION 视为未解决，
  扫描失败 fail-closed）。四条不得回退：
  ① **dismiss 之后必须调用它** —— 「放弃恢复」= 该 incident 结案；此前 dismiss 只 quarantine，唯一的清除点挂在
  `verify(ROLLED_BACK)` 上，而事务已移出 `active/` ⇒ 那条分支永远走不到，用户看到的是「面板显示暂无待处理、
  写操作持续 423、重启无效」，只能手工删标记；
  ② **阻断态必须可见**：`GET /recovery/status` 回传 `safeMode: { blocked, clearable }`（`clearable` = 没有未解决
  incident，即「结案但保护仍开着」），投影为 `safeModeStuck`/ `recoveryRequired`，面板据此渲染**显式解除入口**
  —— 这正是 issue #31 「423 文案指向空面板」在 SAFE MODE 上的重演；
  ③ **显式出口** `POST /recovery/safe-mode/clear`（recovery prefix 子路径，不新增注册路由条目）**故意不过
  withMutationGate**（要解开的正是挡住写操作的保护，走 gate 必然 423），但**绝不无条件清标记**：还有未解决
  incident 时拒绝并给 `reason: 'unresolved-incidents'`，本来没阻断则幂等回 `not-blocked`；
  ④ **注入面是动态探测**（`RecoveryOrchestratorDeps.safeModeBlocked` ← 宿主 `phase3Recovery.safeModeActive`）：
  与 mutation gate 的 `isBlocked` 同源，保证「界面说保护开着 ⟺ 写操作真的被 423 挡着」，绝不能创建期捕获快照。

- **灾备快照线已按产品定位收敛下线（2026-09），只保留崩溃归因 + 救援模式**：定位 = 迁移 / 同步 / 市场 ——
  自动快照（watcher）、撤销/重做、手动快照、快照库与 `/lifecycle` 路由整体删除（`core/{watcher,undo,config-state,config-snapshot,config-lifecycle}.ts`、
  `client/lifecycle/`、`ui/lifecycle-view.ts`、`LIFECYCLE_ENABLED` / `SHOW_LIFECYCLE_NAV` 双开关）。**保留**：`core/crash-report.ts`
  （崩溃检测 / 归因 / boot-state）与 `core/boot-rescue.ts`（救援模式），两者并入「事故恢复」子 tab（`client/recovery/RecoveryPanel.tsx`）——
  崩溃后的处置只剩「先让 DSH 起得来」（救援模式）与「从最近备份恢复」（备份文件），**不再自建第二条恢复通道**（`/crash` 已无 `lastGoodSnapshotId`）。
  三条不许回退的接线：① `boot-state.json` 独立在 `<dataDir>/boot-state/`，老位置 `<dataDir>/config-snapshots/` 由 `adoptLegacyBootState` 一次性搬迁（幂等、best-effort）；
  ② `BOOT_CRITICAL_RELS` / `profileCriticalRels` 搬进 `core/boot-paths.ts` —— **导入安全闸门 `boot-safety.ts` 仍在用，删灾备不许连带删**；
  ③ `PanelId` 不再含 `'lifecycle'`，旧持久化值在 `run-store` 迁移到 `snapshots` + `subTab='recovery'`。守卫：`src/core/incident-wiring.test.ts`（源码级接线）
  + `tests/route/route-parity.test.ts`（71 条路由快照）+ `src/core/crash-report.test.ts`（归因与老位置搬迁）。
  分区注册表的 `configSnapshot` 字段保留为**语义声明**（配置类 vs 内容数据类），当前无消费者；旧实现与踩坑史见 `docs/handoff/PHASE1_HANDOFF.m
d`。

- **救援模式与 `reconcileBundles` 的硬冲突（2026-09 真机复现「救援完全没用」的根因，两条修法不许拆开）**：
  进入救援会把 `dsh.profile.bundles` 收窄为「DSH 核心 + 本插件」，但插件自己的 `reconcileBundles`
  （`src/core/plugin-cli.ts`，规则 = 「声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`」，由
  `listInstalledPlugins` 在**每次读插件清单**时调用：导出预览 / 自动快照的 `plugins` 分区 / 插件页都会触发）
  会在**约 1.5 秒**内用 `dependencies` 里的依赖行把用户插件全部加回 —— 用户重启 DSH 后插件一个不少，
  救援名存实亡（实测轨迹：`t+0ms` 收窄到 3 条 → `t+1500ms` 变回 5 条）。因此：① `enterRescueMode`
  （`disableUserBundles`）**必须同时把被禁用的包从 profile 的 `dependencies` 摘掉**（`stripDependencies`；
  包不卸载，退出时整份 `package.json` 从备份逐字节还原）——manifest 自洽后**任何** reconcile（含 DSH 官方
  `dsh plugin`）都无从加回；② `reconcileBundles` 在救援激活期间**一律停手**（`isRescueActiveSync`，
  同步探测，与 `rescueModeStatus().active` 同口径、stale 不算激活），因为救援是操作者的显式决定。
  **验证口径**：只在文件层断言「bundles 被收窄」不够 —— 必须真机四阶段（救援前挂载 → 进救援且清单持续
  数秒不被改写 → 重启后用户插件不挂载 → 退出后逐字节还原 → 重启后插件回来）。夹具有一个坑：假插件若
  同时进 `dependencies` 又由 home patch 插入，会被 reconcile 加进 bundles 并与 patch 行重复挂载
  （`duplicate loader entry id`）—— 走 patch 层的插件**不要**写进 `dependencies`。
  复核脚本：`outputs/rescue-e2e/`（隔离 `DSH_HOME` + 两个假插件，浏览器实操）。

- **会话日志的格式版本（`header.version` = DSH 的 `SESSION_FORMAT_VERSION`）跨版本是「单向兼容 + 静默跳过」，必须体检而不是等用户发现**（2026-09 源码 + 真机取证，登记为 known-gaps **G-23**）：DSH 读会话时对**非本 build 的版本直接拒绝**（`refuseForeignFormatVersion` → `SessionFormatUnsupportedError`），而会话列表 `listArtifacts()` 对该错误 **`continue`** —— 不报错、不在工作区列表里，用户看到的只是「对话消失」。高版本可读低版本（DSH 自带 V0→V4 迁移链），**反向不可读**；实测桌面端内置 0.2.0-rc.2 = **v4**，磁盘 CLI 档案 0.1.5-rc.1 = **v3**（本机 401 个日志分布 `{v0:200, v3:201}`，多版本共存是常态）。本插件的导出/导入/同步是**逐字节搬运** `.jsonl.zstd`，不体检就会「导入全部成功、对话一个不显示」。接线：宿主探针 `src/utils/session-format.ts`（只解**首帧**、每会话一条、上限 200、读不出如实计数；常量解析优先从 `installAnchor` 同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 semver 猜格式版本**）→ `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe`（`ImporterOptions` 同名）→ `Analyzer.sessionFormatWarnings` 产出 `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`；同步 `pull()` 把 `analysis.warnings` 并进差异报告 message（那条链路只有 message 通道）。档案页用 `profileVersionFacts` / `sessionFormatRisk`（`src/ui/dsh-profiles-view.ts`）展示每个档案的 DSH 版本与会话格式版本并提示错配；**任一侧读不到版本一律不提示**（不猜、不给假结论）。**core 侧仍禁止 import 会话日志存储格式**（只消费数字）。

- **离线救急台（`dsh-config-manager web` / `dcm web`，阶段 1，2026-10）**：只读的**本机网页**，
  给「DSH 已经起不来」的场景用。四条不得回退：
  ① **服务端复用 `src/routes/kit.ts`**（`endpoint()` 声明 + `registerRoutes` 注册）—— 围栏/方法白名单/统一错误映射
     与插件那 70 余条宿主路由**同一份实现**，不另写围栏；页面**服务端直出 HTML**（零脚本、零外链，
     `writeHtml` 里收口的 CSP `default-src 'none'`），因此它没有 client bundle 自包含问题、也不进 `lib/client.js`。
  ② **token 是这一层的边界，不是可选项**：kit 的 `isLoopbackRequest` 对「无 Origin 头的请求」直接放行
     （本机任何进程都满足），所以必须 启动时生成 32 字节随机 token → 只打印到当前终端 → `/?token=…` 换
     HttpOnly + SameSite=Strict 的会话 cookie（**用过即废**）；其余请求一律 403。
  ③ **读路径只读、写路径有门**（旧口径「本阶段只暴露 GET，写动作留到后续阶段」已过期）：打开任何页面**不产生任何写入**
     （`web.test.ts` 的 W-04 断言连目录都不建），但实现已有 **11 条 POST 写路由**：`/sessions/repair`、`/sessions/inline-repair`、
     `/disk/cleanup`、`/lock/recover`、`/profiles/launch`、`/profiles/stop`、`/unlock/run`、`/restore/run`、`/export/run`、
     `/reinstall/plan`、`/reinstall/run`（`src/cli/web/routes.ts:253-479`，唯一声明处）。`GET /healthz` 自报 `readOnly: false` +
     `writes`（3 项能力名，既有契约刻意不动）+ `writeRoutes`（由已声明路由派生，cli-F6 修，杜绝手写清单漂移）。
     **写路径的真实边界**：① 回环围栏（非回环 403，`server.ts:141`）；② 一次性 token → HttpOnly + SameSite=Strict 会话
     cookie，之后**每个请求（含写）**都要 cookie，缺 token/cookie 一律 403（`server.ts:146-174`）；③ 方法白名单 405（HTML，
     cli-F4）。**写动作各自过 CLI 同源的写入门**（`src/cli/actions.ts` 的 `checkWriteGates`：SAFE MODE → 残留锁 → DSH 未运行，
     fail-closed）；`/reinstall/*` 另持环境锁 `runWithMutationLock({ op: 'console-reinstall' })`（`actions.ts:1365-1396`）。
     两个**刻意例外**（都被测试钉住）：磁盘清理只碰可重建缓存（tmp / 过期导出产物 / market cache+work），故**不过**
     SAFE MODE 门（`web.test.ts` W2-03「清理缓存不受该门影响」）；档案启动/停止是「DSH 起不来」时的出口，**不过** SAFE MODE
     与「DSH 已停止」两道门（`web.test.ts` W3-04）。**不得据此写成「插件 API 无认证」**：这是救急台自己的 token 边界；
     宿主插件路由的边界仍是 `src/routes/kit.ts` 的 `endpoint()` 围栏（见本文件「插件 HTTP API 的真实认证边界」一节）。
  ④ **判定不许重写**：网页与 CLI 共用 `src/cli/actions.ts`（只读动作层）—— `verify` 的收集、磁盘体检、会话体检、
     心跳/锁/SAFE MODE 读取都只有一份实现；CLI 只负责排版。**改判定就改 actions.ts**，不许在页面里再算一遍。
  附带的两个修正：**心跳候选根**（旧 `runningDshInstances` 把 `--data-dir`（快照目录）当 dataDir 用 → 缺省路径下
  永远找不到心跳，「DSH 在跑就别写会话字节」那道门形同虚设；现在与 SAFE MODE 同一套 `resolveControlRoots` 候选根）；
  **退出必须真的退出**（`close()` 之后进程仍持有 stdin/stdout，事件循环不会排空 → 空闲超时 / Ctrl+C 用
  `close().finally(() => process.exit(0))`，测试注入 `shouldSelfExit: false`）。

- **issue #57–#60 的四条硬约束（2026-10，均为真机复现后修复）**：
  ⓐ **`file:` spec 有两种形态，打包前必须 `stat` 判形态**（`src/core/local-plugin-pack.ts` 的 `statKind`）：目录走 `npm pack`，
  **`.tgz` 文件直接读取收编**（它本身就是 `npm pack` 的产物），**判不出来一律回落目录流程**（绝不猜成文件）。此前一律当目录 `cwd`
  → `file:/abs/x.tgz` 必然 `spawn ENOTDIR`，插件静默不进备份而**备份仍报 `ok:true`**；归档名用 `safeTarballFileNameFor`（保留源文件名，
  丢目录 + 折叠非法字符）。profile 目录用 `HostContext.profileDir`，**不要**按 `<home>/profiles/<name>` 硬拼。
  ⓑ **同步快照的 JSON 体积上限必须读写同口径**（issue #59）：`deserializeSnapshot` 走 `MAX_OWN_PAYLOAD_JSON_BYTES`（512 MiB，**自产载荷**），
  **不是** `parseJsonSafe` 的缺省 64 MiB（那是防不可信输入的闸门）。加密单文件布局经 base64 双膨胀 ~1.78×，勾 sessions 后轻易越界；
  越界的后果是**静默**（列表恒空 / download 报损坏 / 自动同步恒 upToDate，而 push 报成功）—— 现在读不出来的一律经 `unreadableSnapshots` 回传可见。
  改这条链路时必须同时想「写侧产出什么、读侧拿什么上限读」两件事。
  ⓒ **`runStore.patch()` 会清空密码字段**（持久化白名单把 token/webdav 密码写成空串，是**安全不变量**）：任何**无关** patch
  （远端快照到货、GitHub 轮询结束）都会抹掉用户正在输入的密码 → 「输入几个字符就被清空、粘贴也清空」。修法固定为：`commit()` 在 patch 之后
  调 `runStore.patchSyncPasswords()` 把**在途输入**写回**内存**（绝不触发落盘）。新增任何 patch 路径都要检查这一条。
  ⓓ **git 源安装需要 `scripts.prepare`**（npm 上是预构建 `lib/`，git 安装是现构建）：本包已补 `prepare: npm run build`；
  **pnpm 11 仍会拦截**，用户必须在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`，键要**逐字照抄 pnpm 打印的那一行**（含 URL + sha，
  只写包名不生效）。三条门禁在 `tests/packaging-contract.test.ts` 的 `G-21`；README 中英各有「从 GitHub 源码安装」段。

- **`skippedLinks` 的 `too-deep` 不再必然等于「链接」**（cli-F2 让普通目录超深可见 + t37 修正措辞，2026-10）：
  深度上限 `MAX_DEPTH = 64`（`src/utils/recursive-walk.ts:42`）在 `walk()` 顶端判定；cli-F2 之前只在 `viaLink !== null` 时记
  too-deep，**普通目录**超深时整块内容被裁掉却既不在 `skippedLinks` 也不在 `unreadableDirs` 里 —— 备份照样报成功但缺内容
  （issue #37 同类症状）。cli-F2 起改为 `skippedLinks.push({ path: viaLink ?? rel(dir), reason: 'too-deep' })`（同文件 `:78-81`）；
  于是 `too-deep` 既可能来自链接、也可能来自**普通目录**，措辞必须按真实来源分派（t37，`src/core/backup-plan.ts:196-199`）：
  `too-deep` → 「层级超过上限未进备份（目录或链接目标超出深度上限） / nesting limit exceeded…」；
  `loop` / `outside-home` / `broken` / `unreadable`（皆为链接特有原因）→ 保留「链接未进备份 / link NOT in this backup」。
  修前实测（base 3f42a8b + cli-F2 增量 + 仅测试）：用例红，断言打印的 base 措辞是
  `链接未进备份 / link NOT in this backup: skills/skills/d/d/…（too-deep）` —— 「为什么会缺内容」的原因被误述成链接问题。
  回归护栏：`src/core/backup-plan.test.ts:150`（t37：70 层普通目录 + 指向 home 之外的 junction 两条对照，断言超深条目措辞匹配
  「层级超过上限」且**不得**匹配「链接未进备份」，链接条目仍须是链接措辞）、`src/utils/recursive-walk.test.ts` 的 cli-F2 用例
  （普通目录超深必须记 too-deep）。原始输出与证据：`outputs/bug-audit/message-t37/`。
- **文件类分区「存在但读不到」必须显式失败，不得静默跳过**（ui-F2，t23；2026-10）：
  收集内核（`src/adapters/file-collection.ts`）对 `ctx.fs.readFile` 失败是**上抛**的 —— 分区 `export()` 抛错由
  `src/core/exporter.ts:340` 收敛成 `export.sectionFailed` + 一条 warning，属**分区级可见失败**（EACCES 从不静默）。
  `pluginFiles`（`src/adapters/plugin-files.ts`）此前把「读不到」与「不存在」一视同仁地 `continue` → 同一类输入在基类与子类之间
  出现两种语义（同一份 ACL 故障在一处是警告、在另一处是无声缺项）。修法：两个读失败分支改成
  `if (await this.absentOnDisk(ctx, rel)) continue; throw err;`（`:60` / `:82`；`absentOnDisk` 在 `:102`）——
  只有真不存在（ENOENT）才跳过，其余 errno 一律上抛。**判据方向不能反**：`exists()` 自己抛错时按「**存在**」处理
  （读不到 ≠ 没有），否则一次 ACL 故障会把「读不到」降级成「本来就没有」。
  回归护栏：`src/adapters/files.test.ts:517`、`:534`（白名单文件 / 约定配置目录里「存在但读不到」都必须显式失败；base 红 → 修复后绿）。
- **清理时「缺失的可选目录」（ENOENT）不计入 `errors`**（e2e-F3，t14 修订；即 `AGENTS.md`「磁盘占用体检与手动清理的硬边界」的 ⑤）：
  `src/core/cache-cleaner.ts` 四处可选目录（`:212-218` tmp、`:238-239` exports、`:297-300` market/cache、`:320-323` market/work）
  一律 `if (!isENOENT(err)) result.errors += 1` —— **ENOENT（不存在）≠ 读失败**：全新安装时 `market/cache`、`market/work`
  尚未创建，若计入 `errors`，前端就会在**本次真的删掉了文件**的那次清理里弹红色「清理失败 N 项」（真机 p9b：`errors` 恰等于缺失目录数，
  `detail` 为空、无可操作信息）。其它 errno（EACCES / EBUSY / …）仍必须计数。判据单点在 `src/utils/guards.ts` 的 `isENOENT`。
  回归护栏：`src/core/cache-cleaner.test.ts:334-337`（四个可选目录缺失 → `errors === 0`）与 `:344-362`
  （「可选目录不存在时，真删了文件也不得报错」）。

- **值形状判定（`matchSecretValuePattern`）的大小写边界**（t58-F1 / t72；即 `AGENTS.md`「值形状判定的大小写边界」那条，known-gaps **G-36**）：
  `src/security/secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS` 全是**大小写敏感**正则。**收口的是 `Bearer`**：RFC 7235 / 6750 规定 auth-scheme 名
  **大小写不敏感**，所以 `Authorization: bearer <token>` / `BEARER <token>` 都是合法写法，改动前在「键名不敏感」的通道（MCP `headers:{'X-Custom':'bearer …'}`、`env`、url 段）
  **明文进包且完全不可见**（`refs=[]`、`skipped=[]`）。现在由新增的 `bearer-token-anycase` 命中（scheme 用逐位大小写类 `[Bb][Ee][Aa][Rr][Ee][Rr]`，**刻意不给整条正则加 `i`**
  —— 加了会让 token 侧「含大写」「含小写」两个 lookahead 互相等价而失效）。防英文散文过剥的边界：token 需**含非字母字符**、或**大小写混排**、或**长度 ≥ 24**，因此
  `bearer credentials are required` / `bearer authentication failed` / `BEARER HEADER NOT SET` 都**不**命中；规范 `Bearer …` 仍由原条目命中（命中名 `bearer-token`、行为逐字不变）。
  **厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）刻意保持大小写敏感**：`SK-…` / `Sk-…` / `akia…` / `GHP_…` / `GITHUB_PAT_…` **不会被剥离**（真实厂商形态大小写固定；
  判定是全仓共用单一来源，加 `i` 会连带放宽日志脱敏 `src/utils/logger.ts`、导出/导入的字段值扫描、界面渲染前的 `redact()` 三条通道）—— 已知残余见 known-gaps G-36；其中「`redaction.ts` 另有独立重复表」一条**已由 t78 订正**：
  `REDACTION_VALUE_PATTERNS` 现派生自 `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（单一来源，仅补 `g` flag），守卫 = `src/security/redaction.test.ts` 的 `t78-a`（结构）/ `t78-b`（行为）。
  **仍存的差异**（如实保留）：显示层比 scanner **更宽** —— 示例/占位形态（`sk-your-key-here` / `Bearer example-token-here`）scanner **放行**、`redact()` **仍掩**；base 与现状同结果，属显示层**既有产品取舍**，由 `t78-f` 钉成 characterization。**要收先单独决策**，别顺手改。
  另两条同批口径：① `env:{K:'<sk-…>'}` 这类**尖括号占位符在值形状通道同样被剥空**（降噪只看命中片段，而 `sk-…` 的命中片段不含尖括号；多剥是安全方向）；
  ② `redactMcpSection` **自身**过滤非字符串载体（`env` 嵌套对象 / headers 数组 / `args` 对象元素按上游 `mcpEntryOf` 同口径**丢弃**，被滤空的字段直接删）—— 此前这条保证只活在上游，
  而 `antigravity.ts:103` 是直连调用点。
  证据：来源 = t58 评审（`outputs/bug-audit/review-foreign-envhdr/REVIEW-t58-t40-report.md` §1 的 payload 原文、`t58-pipeline-check.mjs` 的真实管道复现、BASE↔FIXED 谓词逐字对照）；
  回归护栏 = `src/security/secret-scanner.test.ts`（`t72-a` 大小写命中 / `t72-b` 规范形态不变 / `t72-c` 过剥控制 / `t72-d` 厂商前缀边界钉事实）与 `src/foreign/mcp-value-shape.test.ts` 的 `t72-e/f/g`。


---

## t93 容量腾挪：从 `AGENTS.md` 下移的细节（与 `AGENTS.md` §📌 常见坑 **同序**）

> AGENTS.md 与全局 `~/.dsh/AGENTS.md` 合计受 65536 B 预算约束（超限会让全局那份被整份丢弃）。按仓规「AGENTS.md 只留铁律/硬约束，证据与量化数据进本文件」，以下三段的**证据/行号/清单**自 AGENTS.md 下移；技术结论与铁律未变。

### 1) 插件 HTTP API 的真实认证边界（下移自 AGENTS.md 同名条目）

- **DSH 源码位置**：`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `requestRejection()` **L553-556** = Host/Origin 403 + browserAuth 401，只被 `register()` **L605-618** 的 prefix 路由调用；`@deepseek-ai/dsh-host-webserver/lib/index.js` 的 `match()` **L321-331**：先查 exact 表，未命中才按 prefix 最长匹配。安装位置 `.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-host-webserver,dsh-client-connection}/lib/index.js`。
- **四路实测打点**：无 cookie 的 `GET /api/dsh-config-manager/status` → **200 + 完整 JSON**；DSH 自己的 `GET /api/<未认领路径>` 与 `GET /` 无 cookie → **401**（认证确实存在，只是不覆盖插件 exact 路由）；跨站 `Origin` → **403**，同源对照 → **200**（CSRF 围栏在生效）。
- **复核路径**：线上复核 `powershell -NoProfile -File outputs/e2e-w2/run-e2e.ps1 -Strict`（本机无 pwsh 7，脚本支持 5.1；探针 `outputs/e2e-w2/probe.mjs`）；原始打点与结论见 `outputs/e2e-w2/FINDINGS.md` **§4 / §6 D1**。

### 2) 离线救急台（下移自 AGENTS.md 同名条目）

- **11 条 POST 写路由清单**（`src/cli/web/routes.ts:253-479`）：`/sessions/repair`、`/sessions/inline-repair`、`/disk/cleanup`、`/lock/recover`、`/profiles/launch`、`/profiles/stop`、`/unlock/run`、`/restore/run`、`/export/run`、`/reinstall/plan`、`/reinstall/run`。
- **行号**：真实边界里的会话 cookie 判定在 `server.ts:141/167`；GET 打开页面零写入由 `web.test.ts` 的 **W-04** 钉住（连目录都不建）。
- **两个已修的坑**：① 心跳候选根必须与 SAFE MODE 同一套 `resolveControlRoots`（旧实现把 `--data-dir` 当 dataDir → 缺省路径永远找不到心跳）；② 退出必须真退出（`close().finally(() => process.exit(0))`，测试注入 `shouldSelfExit: false`）。

### 3) 值形状判定 / G-36：显示层细节 + t83 载荷形状守卫（下移/写实自 AGENTS.md 同名条目）

- **附带两条口径**：`env:{K:'<sk-…>'}` 这类**尖括号占位符在值形状通道同样被剥空**（多剥是安全方向）；`redactMcpSection` **自身**过滤非字符串载体（`env` 嵌套对象 / `args` 对象元素按上游同口径**丢弃**，不再依赖调用方先过滤）。
- **t78 订正（此前注记已不实）**：`src/security/redaction.ts` **不再有独立重复表** —— `REDACTION_VALUE_PATTERNS` 直接派生自 `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（同一份，仅补 `g` flag）；守卫 = `src/security/redaction.test.ts` 的 `t78-a`（结构：每个形状都在）/ `t78-b`（行为：scanner 判 secret 的语料 `redact()` 必须真掩）。**仍然存在的差异（不得写成「已彻底一致」）**：显示层比 scanner **更宽** —— 示例/占位形态（`sk-your-key-here` / `Bearer example-token-here`）scanner **放行**、`redact()` **仍掩**；base 与现状同结果，属显示层**既有产品取舍**，由 `t78-f` 钉成 characterization（t83 后其范围已收窄）。
- **t83 载荷形状守卫（写实）**：`sk-` 由 `/sk-[A-Za-z0-9_-]{8,}/` 改为 **载荷形状守卫** `/sk-(?![a-z-]{1,24}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/` —— `sk-` 后若是 **1–24 个纯小写字母/连字符**（词形态）则放行；直接动因是修**既有过剥**：`task-management` / `risk-assessment` / `disk-space-report` / `mosk-abcdefgh` / `ask-management`（误剥 = 静默改写用户内容，属数据保真问题，实测 `redact('risk-assessment')` → `ri***REDACTED***`）。
- **边界 ①（残余，如实登记）**：`sk-` + **≤24 个纯小写字母/连字符**（无数字、无大写）**不再命中**；**≥25 位**纯小写载荷仍命中（`t83-g` 钉成事实）。真实 OpenAI 形态（`sk-` + 40+ 位 base62，含数字/大写）与 `sk-proj-…` / `sk-ant-api03-…` 不受影响。
- **边界 ②（为什么不用左词边界）**：左边界 `(?<![A-Za-z0-9])` 会漏剥 **`'p'.repeat(10000) + 'sk-<key>'`** 这种真实**长串内嵌**形态（密钥紧贴长串之后）⇒ **明文进包**；第一版左边界方案因此让 `t40-b` / `t40-c` / `t78-g` 变红。**取舍**：为治「词误剥」绝不能削弱「真检测」——载荷形状守卫两者兼得。
- **其余模式未加任何边界，理由各异**：`AKIA` / `ghp_` / `github_pat_`（无自然语言触发词，普通文本不会产出这些前缀）、`jwt` / `pem`（加边界会与 `sk-` 同样削弱长串内嵌检出）、`bearer`（t72 已用 token 侧 guards 控制过剥）。守卫用例：`t83-a`（左邻字母数字的普通内容不被误剥）/ `t83-b`（被剥侧不削弱，含紧贴 `=`/`:`/引号）/ `t83-c`（t72 边界未回退）/ `t83-d`（未加边界的模式行为逐字不变）/ `t83-e`（`redact()` 通道同步受益）/ `t83-f`（1 万字符内嵌仍被剥）/ `t83-g`（残余边界钉事实）。

### 4) 其余下移碎片（t93 第二批；与 AGENTS.md 同序）

- **认证边界**：`recovery` 是本插件的**私有前缀**（不是 DSH 的 `/api`）；破坏性路由清单 = `/profiles/delete`、`/execute`、`/sync/rollback`、`/snapshots/delete`、`/recovery/**` 等。
- **只读预览与导出同口径的实测收益**：本机会话树 941 个文件 / 528 MB，预览从 **2271 ms / RSS +306 MiB** 降到 **~0.4 s / 近零常驻**。
- **已验证归档缓存的配套实测**：29 MiB 归档全量同步解压曾阻塞事件循环 **108 ms**（改走 `readEntryAsync` 后消除）。
- **profile 切换两条路的实现细节**：`dsh --profile <名> --port <空闲端口>` detached + 从子进程日志抓带 token 的认证 URL + HTTP 探活 + 按 `process.kill(pid,0)` 判活。
- **事件驱动递归遍历/救援/子代理复核路径**：真机四阶段验证复核 `outputs/rescue-e2e/`；子代理会话导出连带的复核 `outputs/subagent-fix/`。
- **会话日志格式版本**：拒绝实现 = `refuseForeignFormatVersion` → `SessionFormatUnsupportedError`。
- **救急台过期口径提醒**：旧文档曾写「只读（写方法 405）」——已过期，现在读路径只读、写路径有门（原因见 §2）。
- **只读预览 vs 真实导出的量化数据（第二批）**：真机 agentInstructions 预览 4.8 s／4016 文件；self 预览 2460 文件／11.44 MB，而真实导出 1936 B；本机会话树 941 文件 / 528 MB 的预览已降至 ~0.4 s。
- **`readSessionMeta` 缓存动机的量化数据**：`storages/session_projcache.json` = **1.57 MB**，每次预览 / 每次 `/plan` 都要解析，实测 **7.3 ms**。
- **磁盘清理那次的原始症状（2026-09）**：`includeRecent` 只影响可重建区，但导出区仍按保留期回收 ⇒ 界面说「只清缓存」却删了备份；守卫 = `tests/route/disk-usage-routes.test.ts`。
- **救援冲突的时间尺度**：`reconcileBundles` 约 **1.5 s** 内就把插件加回（文档正文表述为「秒级」）。
