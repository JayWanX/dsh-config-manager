/**
 * 会话事件的**行级事实**与「合成收尾块」判定 —— 宿主侧唯一实现（体检扫描与修复计划共用）。
 *
 * 为什么必须共用：体检说「这条可修」与执行器「真的去修」必须是同一份判据。
 * 两处各写一份必然分叉 —— 界面给按钮、执行器却拒绝（或反过来静默不改），用户看到的是自相矛盾。
 *
 * 分层纪律：本模块只解析**已经解压出来的行文本**，不碰容器字节（那是 utils/zstd-frame.ts），
 * 也不写任何字节；core 禁止 import。
 */

/** 一行会话事件里我们**能证明**的字段（读不出的一律缺省，绝不猜）。 */
export interface SessionRowFacts {
  /** 事件类型（如 turn/end；不是字符串 = 缺省） */
  type?: string;
  /** 序号（DSH 的 seq；非安全整数 = 缺省） */
  seq?: number;
  /** 所属回合（data.turn；非安全整数 = 缺省） */
  turn?: number;
}

/**
 * 解析一行 JSON；不是对象 / 解析失败 → null（不猜，交给调用方记成「不可解析」事实）。
 */
export function parseSessionRowFacts(line: string): SessionRowFacts | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const out: SessionRowFacts = {};
    if (typeof rec['type'] === 'string' && rec['type'] !== '') out.type = rec['type'];
    const seq = rec['seq'];
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) out.seq = seq;
    const data = rec['data'];
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const turn = (data as Record<string, unknown>)['turn'];
      if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) out.turn = turn;
    }
    return out;
  } catch {
    return null;
  }
}

/** 收尾类型（设计稿 §10.2 的 closer 形状判据）。 */
export const SESSION_CLOSER_TYPES: ReadonlySet<string> = new Set([
  'tool/result',
  'step/end',
  'turn/end',
  'session/end-seed',
]);

/** 收尾块的形态上限：≤8 行（超长的收尾块不是崩溃恢复补出来的样子）。 */
export const SESSION_MAX_CLOSER_ROWS = 8;

/** 可证明的合成收尾块（要丢弃的行区间为 [start, end)）。 */
/**
 * 「续写事件」类型白名单：只有这些类型出现在收尾块之后，才算「回合结束后**还在继续对话**」。
 *
 * 为什么必须有它（真机证据）：`turn/end#824` 之后紧跟 `workspace/changes#825`（同属 turn 17）——
 * 那是**回合正常结束后的收尾元数据**，不是续写。旧判据只看 `data.turn` 相等，于是把这种正常会话
 * 判成「合成收尾块撞上真实续写」，进而拒绝修复（用户看到「写前校验未通过，已拒绝修复」）。
 * 白名单只收真正代表「还在说话/干活」的事件：消息、流式块、工具调用/结果、回合与步骤的开始。
 */
export const SESSION_CONTINUATION_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'assistant/chunk',
  'tool/call',
  'tool/result',
  'step/start',
  'turn/start',
]);

export interface SyntheticCloserRun {
  start: number;
  end: number;
  /** 收尾块关闭的回合（判据：块内最后一个带 turn 的行） */
  turn: number;
}

/**
 * 找出**可证明是崩溃恢复补写**的合成收尾块（设计稿 §10.2）。
 *
 * 形状判据（≤8 行收尾类型、含 `turn/end`）只是**必要条件**：任何一次正常的「回合结束 → 下个回合开始」
 * 都满足它。真机实测（2026-10-04）：只看形状会把同一台机器上 86 条健康会话误报成崩溃残留。
 *
 * 所以必须再证明「撞上真实续写」：收尾块之后、下一个 `turn/start` 之前，**同一个 turn 还在继续**
 * （有行带相同的 `data.turn`）—— 回合已经结束却还在续写，那个 closer 才是合成块。
 * 证明不了 = undefined（绝不猜：宁可漏报，也不把健康会话标红、更不拿它去改字节）。
 */
export function findSyntheticCloserRun(rows: readonly SessionRowFacts[]): SyntheticCloserRun | undefined {
  for (let i = 0; i < rows.length; i += 1) {
    const first = rows[i];
    if (first?.type !== 'tool/result' && first?.type !== 'step/end' && first?.type !== 'turn/end') continue;
    let j = i;
    let hasTurnEnd = false;
    let closedTurn: number | undefined;
    while (j < rows.length && j - i < SESSION_MAX_CLOSER_ROWS) {
      const row = rows[j];
      const type = row?.type;
      if (type === undefined || !SESSION_CLOSER_TYPES.has(type)) break;
      if (type === 'turn/end') hasTurnEnd = true;
      if (row?.turn !== undefined) closedTurn = row.turn;
      j += 1;
    }
    // 末尾的收尾块 = 正常的会话结尾（后面没有任何东西可以撞）→ 不报
    if (!hasTurnEnd || closedTurn === undefined || j <= i || j >= rows.length) continue;
    for (let k = j; k < rows.length; k += 1) {
      const row = rows[k];
      if (row?.type === 'turn/start') break;
      // 必须同时是「续写事件」类型：只有元数据行（workspace/changes / session/title…）不算续写
      if (row?.turn === closedTurn && row.type !== undefined && SESSION_CONTINUATION_TYPES.has(row.type)) {
        return { start: i, end: j, turn: closedTurn };
      }
    }
  }
  return undefined;
}
