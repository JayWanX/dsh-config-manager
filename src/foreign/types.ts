/**
 * 外部 agent 配置 → DSH bundle 的转换层（v1，2026-10-04）。
 *
 * 为什么单独一层，而不是再写一批 ConfigAdapter：
 * `src/adapters/*` 的契约前提是「源机也是 DSH，只是 homeDir 不同」（读写都按 $DSH_HOME 布局、
 * 路径可重定基）。第三方工具没有 $DSH_HOME、没有分区语义，硬套会污染 schema / section-registry /
 * 版本契约 —— 所以本层的职责只有一件事：把外部格式**翻译成标准 bundle v1 的载荷**，
 * 之后完全复用既有管道（Importer.analyzeImport → createImportPlan → executeImportPlan）：
 * 冲突不默认覆盖、导入前强制快照、dry-run、逐条计划可见性全部自动生效。
 *
 * 本层必须自己守住的三条不变量：
 *  ① **凭据值绝不进包**：外部配置里的 token/key（MCP 的 env/headers、settings.env）由
 *     **导出侧同一个** defaultSecretScanner 剥离（命中字段值置空串），只保留字段名 + 一个引用名；
 *     URL 里的 userinfo（https://user:pass@host）额外单独剥离（字段名扫描器看不到它）。
 *  ② **不猜**：对不上的字段/格式一律进 skipped（带稳定机器码），绝不静默丢弃。
 *  ③ **不产生用户可见字符串**：findings 只给机器码，文案由 UI 字典映射（i18n 铁律）。
 */
import type { SectionId } from '../schema/types.ts';
import type { ParsedTranscript } from './session-source.ts';

/**
 * 外部来源 id（**契约冻结**，§8.1/§8.2，2026-10-04；档 B 全量补齐 2026-10-05）。
 *
 * 每个来源一个转换器 + 一个读盘层；id 是稳定机器标识（进 PlanItem 说明、CLI `--from`、宿主路由），
 * **不随文案变化**。新增来源 = 向本 union 追加一个值（additive），既有值一字不改。
 *
 * 档 B（t6）一次补齐 dsh-chat-import 的 `FORMATS` 清单（`lib/discovery.mjs:33-39`，29 项）：
 * 我方的 copilot 不在该清单内（额外来源），其余 29 项**逐项**对应到下面的 id
 * （claude → claude-code、dsh/dsh4 → 同源两代次）。
 *
 * **取证强度逐来源如实标注**（见 registry.ts 的 ForeignSource.evidence 与
 * docs/design/2026-10-04-foreign-import-v1.md §8.2 的真值表）：
 *  - measured ：本机实测（目录/库确实存在过，且读盘层据此实现）
 *  - fixture  ：真机未验证，但有**可复现取证方式**（夹具 + 单测端到端跑同一份布局）
 *  - documented：只有四份调研报告的落点（尚未有可复现夹具时**必须**是这个值）
 *  任何来源都**不得**在未取证的情况下被标成 measured —— 该字段由
 *  `truth-table.test.ts` 与各来源单测共同钉住。
 */
export type ForeignSourceId =
  /* ---- 配置类（v1 既有六个） ---- */
  | 'claude-code'
  | 'hermes'
  | 'cursor'
  | 'codex'
  | 'copilot'
  | 'antigravity'
  /* ---- 会话类（档 B 一次补齐 dsh-chat-import FORMATS 的其余 24 项；顺序 = FORMATS 清单顺序） ---- */
  | 'gemini'
  | 'reasonix'
  | 'opencode'
  | 'mimocode'
  | 'zcode'
  | 'grokbuild'
  | 'openclaw'
  | 'pi'
  | 'kimi'
  | 'kilocode'
  | 'qoder'
  | 'chatgpt'
  | 'workbuddy'
  | 'qwen'
  | 'continue'
  | 'cline'
  | 'goose'
  | 'dsh4'
  | 'zed'
  | 'crush'
  | 'teleagent'
  | 'trae'
  | 'vibe'
  | 'dsh';

/**
 * 取证强度（**如实标注，不可美化**）。
 *
 * 为什么要有这个**类型化**字段：t5 的结论是 cursor / codex 长期处于「文档取证但被列出来」
 * 的状态，而没有任何地方在界面上说明这件事 —— 用户以为「已支持 = 已验证」。
 * 把它变成来源定义的必填字段后，「未验证却列出」在类型层就不可能悄悄发生：
 * 新增来源必须显式回答「我凭什么」，答案落在真值表里并出现在 CLI 摘要里。
 */
export type ForeignEvidenceKind =
  /** 本机实测：真机上确实存在过该布局/库，读盘层据此实现 */
  | 'measured'
  /** 有可复现取证方式：夹具 + 单测端到端跑同一份布局（真机未验证） */
  | 'fixture'
  /** 只有调研报告的落点（真机与夹具都还没有） */
  | 'documented';

/** 未能迁移的外部内容（响亮失败：宁可在计划里报出来，也不静默丢） */
export interface ForeignSkip {
  /** 稳定机器码（UI 用它映射文案；禁止渲染裸枚举） */
  code: ForeignSkipCode;
  /** 外部侧位置（server 名 / skill 名 / 文件名；**不含任何值**） */
  origin?: string;
  /** 机器可读的细分原因（如 no-frontmatter / yaml-error），同样交给 UI 映射 */
  detail?: string;
  /** 同码聚合时的条数 */
  count?: number;
}

export type ForeignSkipCode =
  /** settings.json 的 hooks：DSH 无对等结构 */
  | 'unsupported-hooks'
  /** commands/*.md（斜杠命令）：与 DSH prompts 不是同一语义，本期不搬 */
  | 'unsupported-commands'
  /** settings.json 的 env 里出现凭据名：只计数与记名，**值不读** */
  | 'credentials-not-migrated'
  /** SKILL.md 缺失 */
  | 'skill-missing-file'
  /** frontmatter 不是合法 YAML / 缺 name|description（DSH 会**静默丢弃**该 skill，这里必须报） */
  | 'skill-invalid-frontmatter'
  /** 目录名/文件相对路径非法（含分隔符、.. 等），无法作为 skill 单元 */
  | 'skill-invalid-name'
  /** MCP 条目既无 command 也无 url */
  | 'mcp-server-empty'
  /** MCP type=sse（DSH 只支持 stdio / streamable-http）→ 按带 url 的 http 处理 */
  | 'mcp-type-sse-coerced'
  /** MCP 值里发现凭据字段（值已丢弃，只留字段名与引用名） */
  | 'mcp-credential-redacted'
  /** 外部文件读不到 / 超限 / 解析失败 */
  | 'source-unreadable'
  /** 会话：目标机未提供 DSH 会话格式版本（不猜版本，宁可整批不转） */
  | 'session-format-version-unknown'
  /** 会话：目标机格式版本不是本模块已实现的行式 */
  | 'session-format-unsupported'
  /** 会话：记录里没有 cwd（DSH 要求「日志位置 == projectKey(cwd)/id」，没有 cwd 无法归位） */
  | 'session-missing-cwd'
  /** 会话：文件名不能自证是安全路径段 */
  | 'session-unsafe-id'
  /** 会话：没有任何可迁移的事件 */
  | 'session-empty'
  /** 会话：存在解析不出来的行 */
  | 'session-unparsable'
  /** 会话：某类 Claude 记录本期不迁移（sidechain / attachment / queue-operation / system …） */
  | 'unsupported-session-record'
  /* ---- 六来源契约冻结码（§8.4/§8.5，2026-10-04）：语义以文档为准，实现只允许 additive 扩展 ---- */
  /** 同 id 会话（包内重复 / 目标机已存在，含「另一 projectKey 下同 id」）：**不覆盖、跳过并报码**（用户决策，§8.4） */
  | 'session-id-conflict'
  /** 外部技能重名（压平分类后同名，或两次来源同名）：先到先得，其余跳过并报码（§8.4） */
  | 'skill-id-conflict'
  /** 该来源的对话存储形态本版不迁移（如 Hermes 的 SQLite state.db）：只报告，绝不产出 sessions 分区 */
  | 'sessions-not-migrated'
  /** 记忆文件只报告不导入（如 Hermes memories/MEMORY.md、USER.md）：用户决策，正文绝不进包 */
  | 'memory-report-only'
  /** 外部技能带分类层级（如 Hermes skills/<分类>/<技能>）：压平为 DSH 单层 <技能>/SKILL.md 并报码 */
  | 'skill-category-flattened'
  /** 旧式规则文件（如 .cursorrules）：DSH 无对等结构，只报告 */
  | 'legacy-rules-file'
  /** 多份指令源被合并为单个 AGENTS.md（DSH 只读一个全局指令文件）：如实报告合并来源数 */
  | 'instructions-merged'
  /** 命中更高优先级的指令文件（如 Codex 的 AGENTS.override.md 优先于 AGENTS.md）：报告被选中的那一个 */
  | 'instructions-override-selected'
  /** 配置文件存在但为 0 字节（如实测的 Antigravity mcp_config.json）：报码，绝不产出空分区 */
  | 'source-empty-file'
  /** 配置目录位置被环境变量/命令行覆盖（CLAUDE_CONFIG_DIR / HERMES_HOME / CODEX_HOME / COPILOT_HOME） */
  | 'source-location-overridden'
  /* ---- 档 B（t6）新增两条：把「推导」与「缺路径」也变成可见事实，绝不静默 ---- */
  /**
   * 会话 cwd 由**源侧路径/编码目录名推导**（记录里没有 cwd 字段），且推导结果在本机**真实存在**
   * —— 才允许落盘（存在性检查把「猜」变成「有证据的推断」）；不存在的推导一律按
   * `session-missing-cwd` 跳过，绝不产出一条指向不存在目录的会话。
   */
  | 'session-cwd-derived'
  /**
   * 该来源**没有自动根**（竞品 `defaultRoots.chatgpt = null`）—— 必须由用户显式给出导出文件
   * 路径；本机自动探测永远不会命中，如实报码而不是假装「未安装」。
   */
  | 'source-needs-explicit-path';

/**
 * 冲突语义（**契约冻结**，§8.4）：同 id 会话恒「不覆盖、跳过并报码」。
 *
 * 该 union 只有一个取值是刻意的 —— 语义上**不存在覆盖分支**：外部来源导入不得打开
 * `resolution: 'useImported'` / 全局 `replace` 策略这两条会写目标机既有会话的通道。
 * 目标机已存在同 id 时，既有管道判为 `Conflict`（未决策 → 执行期不写），并在计划里可见。
 */
export type ForeignConflictPolicy = 'skip-no-overwrite';

/** 一个分区的翻译结果：JSON 类给 data，文件类给 files */
export interface ForeignSectionOut {
  sectionId: SectionId;
  data?: unknown;
  files?: { relativePath: string; data: Uint8Array }[];
}

/* ---------------- 来源侧的输入形态（读盘层产出、翻译层消费） ---------------- */

/** 一个外部 skill 单元：目录名 + 目录内文件（相对该目录） */
export interface ClaudeSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
}

/** Claude Code 用户目录的已读形态（纯数据；翻译层不做任何 fs 访问） */
export interface ClaudeCodeInput {
  /** ~/.claude.json（已解析；缺失或解析失败 = undefined） */
  claudeJson?: unknown;
  /** ~/.claude/settings.json（已解析） */
  settings?: unknown;
  /** ~/.claude/skills/* 的单元（frontmatter 校验在翻译层做） */
  skills?: ClaudeSkillInput[];
  /** ~/.claude/CLAUDE.md 原文（全局指令） */
  memory?: string;
  /** ~/.claude/commands/* 的普通文件数（本期只报不搬） */
  commandCount?: number;
  /** ~/.claude/projects/<项目>/<uuid>.jsonl 的原文（转码在翻译层做） */
  sessions?: ClaudeSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并逐条报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
}

/** 一个待转码的 Claude Code 会话文件 */
export interface ClaudeSessionInput {
  /** 文件名（不含 .jsonl）；同时作为 DSH 侧会话 id */
  id: string;
  text: string;
}

/* ---------------- Hermes（~/.hermes，Windows 为 %LOCALAPPDATA%\Hermes） ---------------- */

/** 一个 Hermes skill 单元：**已压平**的叶子技能名 + 目录内文件（category 只用于报告，不参与命名） */
export interface HermesSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 外部侧分类目录名（skills/<分类>/<技能>）——有值即报 skill-category-flattened */
  category?: string;
}

/**
 * 一个已读成**归一记录**的 Hermes 会话（读盘层产出；翻译层只负责装配）。
 *
 * 与 Claude 的 `ClaudeSessionInput`（原文进、翻译层再解析）刻意不同：Hermes 的会话在
 * SQLite（state.db）里，解析**必须**发生在宿主侧的读盘层 —— 那是 `node:sqlite` 动态 import
 * 的唯一边界（见 read-opencode.ts 文件头纪律 ①）。因此在读盘层就已经归一成型，
 * 翻译层保持纯函数、零 fs、零 sqlite。
 */
export interface HermesSessionInput {
  /** 会话 id（state.db 的 sessions.id；同时作为 DSH 侧会话 id） */
  id: string;
  /** 归一记录（读盘层已解析；parsed.raw = 消息行原始条数） */
  parsed: ParsedTranscript;
}

/**
 * Hermes 用户目录的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 三条**结构性**保证（不是靠翻译层自觉）：
 *  - memories/MEMORY.md、USER.md 的**正文根本不在本结构里**（只有文件名）→ 无从进包；
 *  - .env 只有「存在与否」一个布尔 → 值无从进包；
 *  - 会话只以**已归一记录**进本结构（原始 SQLite 行与库文件都留在宿主侧）。
 */
export interface HermesInput {
  /** config.yaml（已解析；缺失 / 解析失败 / 0 字节 = undefined） */
  config?: unknown;
  /** skills/** 的单元（frontmatter 校验在翻译层做） */
  skills?: HermesSkillInput[];
  /** SOUL.md 原文（主身份 → agentInstructions） */
  soul?: string;
  /** memories/ 下的记忆文件名（**只报告不导入**） */
  memoryFiles?: string[];
  /** .env 是否存在（**只报告**；值绝不读） */
  dotEnvPresent?: boolean;
  /** 会话存储痕迹（state.db / sessions/）：**读不出来**时在这里如实报，绝不静默 */
  sessionStore?: { present: boolean; detail?: string };
  /** state.db（SQLite）里读出的会话（已归一记录；库读不到时回退 sessions/*.jsonl） */
  sessions?: HermesSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并逐条报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
  /** 读盘层发现的问题（0 字节 / 位置被覆盖 / 读不到）——由翻译层原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

/**
 * 可选上限覆盖（t36）：宿主路由 / CLI **将来**放开上限时的**唯一通道**。
 *
 * 语义：缺省（不传）= 各来源读盘层的默认值**逐字不变**；只有显式给了某个键才覆盖它。
 * 字段 = 各读盘层**已经存在**的可选上限（不新造语义）；装配层把上下文的 limits 原样透传进读器。
 */
export interface ForeignLimitOverrides {
  /** 单文件读取上限（字节；超过即不读并报 source-unreadable/too-large） */
  readonly maxFileBytes?: number;
  /** 单个技能目录的文件数上限（超过即报 source-unreadable/max-skill-files-reached） */
  readonly maxSkillFiles?: number;
  /** 技能数上限（超过即报 source-unreadable/max-skills-reached） */
  readonly maxSkills?: number;
  /** instructions/*.instructions.md 的文件数上限（Copilot 专用） */
  readonly maxInstructionFiles?: number;
  /** 会话条数上限（超过即报 max-sessions-reached） */
  readonly maxSessionFiles?: number;
  /** 目录走盘的文件数上限（reasonix / trae 的会话遍历） */
  readonly maxFiles?: number;
  /** 单会话节点数上限（chatgpt / trae；超过即逐类计数） */
  readonly maxNodes?: number;
}

export interface ForeignImportResult {
  source: ForeignSourceId;
  sections: ForeignSectionOut[];
  skipped: ForeignSkip[];
  /**
   * 发现但**未搬运**的凭据引用名（形如 mcp:gitnexus:GITHUB_TOKEN / settings.env:ANTHROPIC_AUTH_TOKEN）。
   * **只有名字，没有任何值** —— 导入后由用户在 DSH 里补录。
   */
  credentialRefs: string[];
  counts: Record<string, number>;
}
