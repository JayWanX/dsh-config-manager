/**
 * SQLite 只读读器（档 B 的 9 个 SQLite 来源共用；动态 import + 能力探测）。
 *
 * **为什么必须动态 import**（t5 实测 + 本任务硬约束）：`node:sqlite` 是 Node 22.5+ 才有的内建，
 * 且在三平台/各小版本上的可用性并不一致（Node 24 可用但打印 ExperimentalWarning；Node 22.19
 * 未验证）。**静态 `import ... from 'node:sqlite'` 会在缺该能力的宿主上把整个插件加载失败**
 * —— 表现是「插件没装」而不是「这一个来源读不到」，用户完全无法定位。
 * ⇒ 一律 `await import(<变量>)`（非字面量，因此打包器/类型检查都不会静态解析它）+ `typeof` 能力探测。
 *
 * **与竞品的三处刻意不同**（read-chat-import §7.2 / read-vault §8.1）：
 *  ① 竞品「打不开 / 表不对 / 锁定」一律 `return null`，用户看到的是**未安装**；本模块把三类
 *     失败分开（能力缺失 / 打不开 / 表结构不符），由调用方映射成 `source-unreadable` 的不同 detail
 *     —— 「读不到」与「没装」必须能区分，否则用户会以为源工具没装。
 *  ② 只读打开仍可能落 `-shm`/`-wal` 伴生文件（t1 警告）：本模块用 `readOnly: true` + **绝不开 WAL
 *     写路径**；但这一点**依赖 SQLite 自身实现**，因此读盘层在只读打开失败时不重试、不切读写模式。
 *  ③ 「读不到返回 null」的约定统一在**每一个**公开方法上（`all` / `tables` / `columns`），
 *     不出现「有的抛、有的返回 null」两种语气。
 *
 * 本模块**不 import node:fs**：打开失败（文件不存在 / 被独占 / 不是库）由 `DatabaseSync` 自己抛，
 * 我们捕获后返回 null —— 少一个 fs 依赖，也让分层白名单保持最小。
 */

/** 一行结果（列名 → 原值；BLOB 列以 Uint8Array 返回） */
export type SqliteRow = Record<string, unknown>;

/** 只读句柄：**每个方法都可能返回 null**（读不到 ≠ 空表） */
export interface SqliteHandle {
  /** 查全（参数化绑定；表不存在 / 语句错 / 锁定 → null） */
  all(sql: string, ...params: readonly unknown[]): SqliteRow[] | null;
  /** 库里的表名清单（读不到 → null） */
  tables(): string[] | null;
  /** 某张表的列名清单（PRAGMA table_info 自适应列；读不到 → null） */
  columns(table: string): string[] | null;
  /** 关闭句柄（幂等；Windows 上不关会让临时目录删不掉 —— 竞品注释同款教训） */
  close(): void;
}

/** 能力探测结果（缺能力时 reason 是稳定机器码片段，进 skip 的 detail，不进用户文案） */
export interface SqliteCapability { available: boolean; reason?: 'module-unavailable' | 'api-unavailable' }

/**
 * 模块说明符**刻意不是字面量**：
 *  ① 静态字面量会让 tsc 去解析 `node:sqlite` 的类型（@types/node 未覆盖时直接编译失败）；
 *  ② 也会让任何打包器把 `node:sqlite` 当成真实依赖静态内联。
 */
const SQLITE_MODULE_SPECIFIER = 'node:sqlite';

interface SqliteStatementLike { all(...params: readonly unknown[]): unknown }
interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}
interface SqliteConstructorLike {
  new (path: string, options?: { readOnly?: boolean }): SqliteDatabaseLike;
}

let probe: SqliteCapability | undefined;
let ctor: SqliteConstructorLike | null = null;

function isConstructorLike(v: unknown): v is SqliteConstructorLike {
  return typeof v === 'function';
}

async function loadConstructor(): Promise<SqliteConstructorLike | null> {
  if (probe !== undefined) return ctor;
  let mod: unknown;
  try {
    mod = await import(SQLITE_MODULE_SPECIFIER);
  } catch {
    probe = { available: false, reason: 'module-unavailable' };
    ctor = null;
    return null;
  }
  const candidate = (mod as { DatabaseSync?: unknown }).DatabaseSync;
  if (!isConstructorLike(candidate)) {
    probe = { available: false, reason: 'api-unavailable' };
    ctor = null;
    return null;
  }
  probe = { available: true };
  ctor = candidate;
  return ctor;
}

/** 本宿主是否具备只读 SQLite 能力（探测结果进程内缓存；探测本身绝不抛） */
export async function sqliteCapability(): Promise<SqliteCapability> {
  await loadConstructor();
  return probe ?? { available: false, reason: 'module-unavailable' };
}

function rowsOf(raw: unknown): SqliteRow[] {
  if (!Array.isArray(raw)) return [];
  const out: SqliteRow[] = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) out.push(item as SqliteRow);
  }
  return out;
}

/**
 * 只读打开一个 SQLite 库。
 *
 * 四类失败（能力缺失 / 打不开 / 不是该库 / 查询错）都返回 null —— **绝不抛**：
 * 一个来源读不到不得拖垮整次导入。调用方用 `sqliteCapability()` 区分「能力缺失」与「读不到」。
 *
 * `readOnly: true` 是**硬要求**：导入是只读操作，绝不允许我们的进程在用户的库上落任何写入；
 * 同时它也避免 SQLite 在打开时做恢复写。
 */
export async function openSqliteReadOnly(file: string): Promise<SqliteHandle | null> {
  const Ctor = await loadConstructor();
  if (Ctor === null) return null;
  let db: SqliteDatabaseLike;
  try {
    db = new Ctor(file, { readOnly: true });
  } catch {
    return null;
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      // 关不掉不影响只读语义；Windows 上句柄会随进程退出释放
    }
  };
  const all = (sql: string, ...params: readonly unknown[]): SqliteRow[] | null => {
    try {
      return rowsOf(db.prepare(sql).all(...params));
    } catch {
      return null;
    }
  };
  const tables = (): string[] | null => {
    const rows = all("SELECT name FROM sqlite_master WHERE type = 'table'");
    if (rows === null) return null;
    const out: string[] = [];
    for (const row of rows) {
      const name = row['name'];
      if (typeof name === 'string' && name !== '') out.push(name);
    }
    return out;
  };
  const columns = (table: string): string[] | null => {
    // 表名走 PRAGMA，不能参数化绑定 → 只允许调用方给**编译期常量**表名（各来源都是字面量）
    const rows = all('PRAGMA table_info(' + table + ')');
    if (rows === null) return null;
    const out: string[] = [];
    for (const row of rows) {
      const name = row['name'];
      if (typeof name === 'string' && name !== '') out.push(name);
    }
    return out;
  };
  return { all, tables, columns, close };
}

/** 表 + 关键列的**签名判定**（竞品同款：不靠文件名，靠结构自证；不符 → 关闭句柄并返回 null） */
export async function openSqliteIfShape(
  file: string,
  required: Readonly<Record<string, readonly string[]>>,
): Promise<SqliteHandle | null> {
  const db = await openSqliteReadOnly(file);
  if (db === null) return null;
  const tables = db.tables();
  if (tables === null) { db.close(); return null; }
  for (const [table, cols] of Object.entries(required)) {
    if (!tables.includes(table)) { db.close(); return null; }
    const actual = db.columns(table);
    if (actual === null) { db.close(); return null; }
    for (const col of cols) {
      if (!actual.includes(col)) { db.close(); return null; }
    }
  }
  return db;
}

/** 把一列取值按「首行可用」取出（SQLite 的 NULL 与缺列都归 undefined） */
export function cell(row: SqliteRow, key: string): unknown {
  return row[key];
}

/** 单元格 → 文本（BLOB 与数字按各自约定；null/undefined → undefined，绝不伪造空串） */
export function cellText(row: SqliteRow, key: string): string | undefined {
  const v = row[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return undefined;
}

/** 单元格 → Uint8Array（TEXT 列也编码成字节；其它类型 → undefined） */
export function cellBytes(row: SqliteRow, key: string): Uint8Array | undefined {
  const v = row[key];
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return undefined;
}

/** 单元格 → 毫秒时间（安全整数直接采信；ISO 字符串走 Date.parse；其余 undefined） */
export function cellTime(row: SqliteRow, key: string): number | undefined {
  const v = row[key];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
