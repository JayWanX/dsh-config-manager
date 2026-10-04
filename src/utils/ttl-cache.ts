/**
 * 极小的短 TTL 异步结果缓存（零依赖；进程内）。
 *
 * 用途（2026-09 的唯一调用点）：宿主会话存储门面的 `parentRelations()` —— 它走 DSH 的
 * `sessionPersistence.list()`，实测**每次约 0.7 s**，而 `/export-preview` 每次都要它
 * （选择器要据此做「勾父带子 / 勾子带父」联动）。父子的变化频率是「有新子代理会话时」，
 * 秒级陈旧对选择器毫无影响，于是给它一个几秒的缓存。
 *
 * 三条语义（都有单测）：
 *  ① **同 key 的并发调用合并成一次执行**（in-flight 去重）：两个预览同时打进来不会读两遍；
 *  ② **失败不缓存**：`load()` 抛错时立即把该 key 从 in-flight 里摘掉，下一次调用会重试
 *     —— 绝不把一次瞬时故障变成 TTL 内的「永久空结果」；
 *  ③ **过期即失效**（`now() - at >= ttlMs` 即重算），时钟可注入（测试不靠 sleep）。
 *
 * 注意：调用方若把「失败」自己吞成了空值（例如返回空 Map），那空值就**会**被缓存 TTL ——
 * 这是调用方的选择，本模块只负责「不缓存异常」。
 */

/** 缓存条目上限（防御性：键通常只有 1 个，留着防止误用时无界增长） */
export const DEFAULT_TTL_CACHE_MAX_ENTRIES = 64;

export interface TtlAsyncCache<T> {
  /**
   * 取缓存值；过期 / 缺失则调用 `load()` 并写入缓存。
   * 同 key 的并发调用共享同一个 Promise（去重）；`load` 抛错不写缓存。
   */
  resolve(key: string, load: () => Promise<T>): Promise<T>;
  /** 清空所有条目与在途记录（测试 / 显式失效用） */
  clear(): void;
  /** 当前已缓存（未过期或已过期但未重算）的键数；仅供测试与诊断 */
  size(): number;
}

export interface TtlAsyncCacheOptions {
  /** 存活时长（毫秒；<= 0 表示永不命中缓存 —— 等价于关闭缓存） */
  ttlMs: number;
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number;
  /** 条目上限（缺省 64；超出时淘汰最早写入的条目） */
  maxEntries?: number;
}

/** 建一个短 TTL 异步缓存（见文件头三条语义） */
export function createTtlAsyncCache<T>(options: TtlAsyncCacheOptions): TtlAsyncCache<T> {
  const ttlMs = options.ttlMs;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_TTL_CACHE_MAX_ENTRIES;
  const entries = new Map<string, { at: number; value: T }>();
  const pending = new Map<string, Promise<T>>();

  const evictIfNeeded = (): void => {
    while (entries.size > maxEntries) {
      // Map 保序：最早的键在最前（不是按 at 排序，但写入顺序足够近似）
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  return {
    resolve(key, load) {
      const inflight = pending.get(key);
      if (inflight !== undefined) return inflight;
      const hit = entries.get(key);
      if (hit !== undefined && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      const promise = load().then(
        (value) => {
          pending.delete(key);
          entries.set(key, { at: now(), value });
          evictIfNeeded();
          return value;
        },
        (error: unknown) => {
          // 失败不缓存：摘掉在途标记，下一次调用重新 load
          pending.delete(key);
          throw error;
        },
      );
      pending.set(key, promise);
      return promise;
    },
    clear() {
      entries.clear();
      pending.clear();
    },
    size() {
      return entries.size;
    },
  };
}
