/**
 * 会话格式「处置开关」的纯逻辑（T1）—— 框架无关、node 可测。
 *
 * 背景（G-23）：DSH 读到**非本 build 的**会话格式版本直接拒绝，而会话列表对该错误
 * `continue` —— 不报错、不在工作区列表里，用户看到的只是「对话消失」。本插件的
 * 导出/导入/同步是**逐字节**搬运 `.jsonl.zstd`，所以「导入成功但对话不在」必须由
 * 用户在**导入前**显式决定怎么办：
 *
 *  - `abort`（默认）：计划阶段就拒绝（宿主返回 409 code=sessionFormatUnsupported），**零写入**；
 *  - `skip`：这些会话单元**默认不勾选**（复用既有 Selection/includeItems 机制，不新增第二套过滤），
 *    报告逐条写明跳过数；
 *  - `guide`：不改变导入行为，只把升级/离线体检指引摆出来（不阻塞）。
 *
 * 为什么判定放在这里而不是 core：core 只消费「本机支持版本」与探针抽查结果这两个数字
 * （AGENTS.md 分层纪律：core 不得 import 会话字节工具）；处置是 UI/宿主的**决策**层。
 * 宿主（/plan、/execute、同步 preview/apply）与浏览器半共用本模块的同一套判定。
 *
 * 绝不猜：`target` 未知（本机版本解析不到）或探针没给出可读性结论时，一律**不阻断、
 * 不跳过**，只按「未验证」如实呈现。
 */
import type { ImportAnalysis, PlanItem, SessionFormatDisposition } from '../core/types.ts'
import type { Selection } from './selection-model.ts'
import { isPlanItemExcluded } from './selection-model.ts'

/** 三种处置（类型定义在 core/types.ts —— 它是 client ↔ host 的线上契约）。 */
export type { SessionFormatDisposition }

/** 全部合法取值（UI 的三选一 radio 直接渲染它，顺序即展示顺序）。 */
export const SESSION_FORMAT_DISPOSITIONS: readonly SessionFormatDisposition[] = ['abort', 'skip', 'guide']

/**
 * 缺省处置 = `abort`（设计稿 §6 方案 A）。
 *
 * 为什么默认阻断而不是默认跳过：「你会丢一批对话」必须是用户显式决定的事；
 * 默认 skip 会让用户在没看清的情况下少导一批对话（盘上少了几百 MB、对话也没了）。
 */
export const DEFAULT_SESSION_FORMAT_DISPOSITION: SessionFormatDisposition = 'abort'

/** 解析用户/宿主传入的处置值；非法/缺失 → undefined（调用方回退缺省，绝不猜）。 */
export function parseSessionFormatDisposition(raw: unknown): SessionFormatDisposition | undefined {
  return raw === 'abort' || raw === 'skip' || raw === 'guide' ? raw : undefined
}

/** 探针给出的「本机读不了」的一个会话单元。 */
export interface SessionFormatUnreadableUnit {
  /** 计划项/选择模型的单元 id（`sessions:<projectKey>/<会话目录>`） */
  unitId: string
  /** 该单元的会话格式版本（高于本机支持的版本） */
  version: number
}

/**
 * 处置判定的输入事实（全部来自探针产物，绝不含猜测）。
 *
 * 注意：`target` 恒为具体版本 —— 「本机版本读不到」的输入**根本构造不出 facts**
 * （工厂函数一律返回 null），因此消费方不需要再判空，也绝不会拿 0 当「未知版本」。
 */
export interface SessionFormatFacts {
  /** 本机 DSH 支持的会话格式版本 */
  target: number
  unreadable: SessionFormatUnreadableUnit[]
  /** 已体检的会话条数（超限时为抽查） */
  inspected?: number
  /** 因超限**未**体检的会话条数（>0 时报告必须写明「另有 N 条未检查」） */
  unsampled?: number
}

/** 会话单元的 plan-item id 前缀（与 file-collection 的 `${adapter.id}:${unit}` 同形）。 */
const SESSION_UNIT_PREFIX = 'sessions:'

/**
 * 探针的单元键（`projectKey/会话目录`，来自分区内的相对路径）→ 计划项单元 id。
 * 两种形态都接受：已经带前缀的原样返回（幂等），便于宿主与浏览器半共用。
 */
export function sessionUnitId(raw: string): string {
  return raw.startsWith(SESSION_UNIT_PREFIX) ? raw : SESSION_UNIT_PREFIX + raw
}

function factsOf(target: number | null, units: readonly SessionFormatUnreadableUnit[], inspected?: number, unsampled?: number): SessionFormatFacts | null {
  if (target === null) return null
  if (units.length === 0) return null
  const seen = new Set<string>()
  const unreadable: SessionFormatUnreadableUnit[] = []
  for (const unit of units) {
    const unitId = sessionUnitId(unit.unitId)
    if (seen.has(unitId)) continue
    seen.add(unitId)
    unreadable.push({ unitId, version: unit.version })
  }
  return {
    target,
    unreadable,
    ...(inspected !== undefined ? { inspected } : {}),
    ...(unsampled !== undefined ? { unsampled } : {}),
  }
}

/**
 * 分析结果 → 处置事实（浏览器半的主入口；`/analyze` 已回传单元级结论）。
 * 缺字段 / 本机版本未知 / 没有读不了的单元 → null（界面据此**不**渲染处置控件）。
 */
export function sessionFormatFactsFromAnalysis(analysis: Pick<ImportAnalysis, 'sessionFormats'> | null): SessionFormatFacts | null {
  const facts = analysis?.sessionFormats
  if (facts === undefined) return null
  return factsOf(facts.target, facts.unreadable, facts.sampled, facts.skipped)
}

/**
 * 计划项 → 处置事实（宿主 /plan 阶段用：此时只有计划，没有 analysis）。
 *
 * 判据 = 计划项上的 `formatUnsupported` 标记（由 analyzer 在计划生成期打上），
 * 它本身就是「探针结论 ∩ 本次计划」的交集，因此这里不需要再跑一次探针。
 */
export function sessionFormatFactsFromPlan(items: readonly PlanItem[]): SessionFormatFacts | null {
  const marked = items.filter((item) => item.formatUnsupported !== undefined)
  if (marked.length === 0) return null
  const units: SessionFormatUnreadableUnit[] = []
  let target: number | null = null
  for (const item of marked) {
    const flag = item.formatUnsupported
    if (flag === undefined) continue
    target = flag.target
    units.push({ unitId: item.unitId ?? item.id, version: flag.version })
  }
  return factsOf(target, units)
}

/** 最高的「读不了」版本（报告文案用；无条目 → null）。 */
export function sessionFormatNewest(facts: SessionFormatFacts | null): number | null {
  if (facts === null || facts.unreadable.length === 0) return null
  return facts.unreadable.reduce((max, unit) => (unit.version > max ? unit.version : max), 0)
}

/**
 * 本次处置是否**阻断**导入计划生成（宿主据此返回 409；客户端据此渲染阻断态）。
 *
 * 只有 `abort` + 确有读不了的单元 + 本机版本已知才阻断；skip/guide 一律放行（它们在
 * 计划/执行阶段另有语义）。
 */
export function sessionFormatBlocksPlan(facts: SessionFormatFacts | null, disposition: SessionFormatDisposition): boolean {
  return disposition === 'abort' && facts !== null && facts.unreadable.length > 0
}

/**
 * `skip` 处置下**默认不勾选**的单元 id（其余处置一律空数组）。
 *
 * 为什么不在宿主侧做过滤：条目级白名单是用户意图的唯一事实（AGENTS.md：引擎不得
 * 替用户做「向下展开」的取舍）。这里只给出「默认不勾」的初值，用户仍可在选择器里
 * 手动勾回来 —— 勾回来就是显式意愿，照常导入。
 */
export function sessionFormatSkipUnits(facts: SessionFormatFacts | null, disposition: SessionFormatDisposition): string[] {
  if (disposition !== 'skip' || facts === null) return []
  return facts.unreadable.map((unit) => unit.unitId)
}

/**
 * 被处置规则跳过的计划项（`skip` 生效后）：`formatUnsupported` 命中且被选择排除的项。
 *
 * 报告里的「跳过 N 条（v{newer} > 本机 v{target}）」必须与本函数逐条同源 ——
 * 否则界面说的数字与真正没导入的条目会对不上（用户报过的那类「数字自相矛盾」）。
 */
export function sessionFormatSkippedItems(plan: { items: readonly PlanItem[] } | null, selection: Selection | null): PlanItem[] {
  if (plan === null || selection === null) return []
  return plan.items.filter((item) => item.formatUnsupported !== undefined && isPlanItemExcluded(item, selection))
}

/**
 * 离线只读体检命令（可复制）。
 *
 * 为什么给这一条而不是「升级命令」：升级 DSH 的方式随安装形态而变（桌面端在应用内、
 * CLI 用各自包管理器），插件**不知道**也不该猜用户的安装方式（AGENTS.md：绝不猜）；
 * 而本插件自己的 CLI 命令是确定可复制的，且它正是「先看清楚本机到底怎么了」的入口。
 */
export const SESSION_FORMAT_DOCTOR_COMMAND = 'dsh-config-manager sessions doctor'
