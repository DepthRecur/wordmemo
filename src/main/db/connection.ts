import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SqliteDatabase } from './sqlite'
import { SCHEMA, DECKS_SCHEMA_VERSION, SCHEMA_VERSION } from './schema'
import { newUid } from './uid'
import { dedupeItems } from './dedupe'

let db: SqliteDatabase | null = null

export function openDb(file: string): SqliteDatabase {
  db = new DatabaseSync(file, { timeout: 8000 })
  txDepth = 0
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

function migrate(database: SqliteDatabase): void {
  // 迁移前先记下老版本号：migrateDecks 只在「还没升到多个库」的老库上建默认库
  const fromVersion = toInt(
    (database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
      ?.user_version
  )
  const itemColumns = database.prepare('PRAGMA table_info(items)').all() as unknown as { name: string }[]
  if (!itemColumns.some((c) => c.name === 'learned_at')) {
    database.exec('ALTER TABLE items ADD COLUMN learned_at TEXT')
    // 老数据里已经复习过的词条视为“已学”，没复习过的留给新的学习流程
    database.exec(`
      UPDATE items SET learned_at = created_at
      WHERE id IN (SELECT item_id FROM cards WHERE reps > 0)
    `)
  }
  if (!itemColumns.some((c) => c.name === 'collocations')) {
    database.exec("ALTER TABLE items ADD COLUMN collocations TEXT NOT NULL DEFAULT '[]'")
  }

  const cardColumns = database.prepare('PRAGMA table_info(cards)').all() as unknown as { name: string }[]
  if (!cardColumns.some((c) => c.name === 'needs_check')) {
    database.exec('ALTER TABLE cards ADD COLUMN needs_check INTEGER NOT NULL DEFAULT 0')
  }
  if (!cardColumns.some((c) => c.name === 'learn_mark')) {
    database.exec('ALTER TABLE cards ADD COLUMN learn_mark INTEGER NOT NULL DEFAULT 0')
  }
  if (!cardColumns.some((c) => c.name === 'buried_until')) {
    database.exec('ALTER TABLE cards ADD COLUMN buried_until TEXT')
  }

  // 草稿列表只读摘要，避免为了算条目数把 OCR 原文和全部词条都解析一遍
  const draftColumns = database.prepare('PRAGMA table_info(import_drafts)').all() as unknown as {
    name: string
  }[]
  if (draftColumns.length && !draftColumns.some((c) => c.name === 'summary')) {
    database.exec("ALTER TABLE import_drafts ADD COLUMN summary TEXT NOT NULL DEFAULT '{}'")
  }

  // 多供应商（P0）：缓存与用量以前没有 provider 维度，A 家的答案会被当成 B 家的。
  addColumnIfMissing(database, 'ai_cache', 'provider', "TEXT NOT NULL DEFAULT 'deepseek'")
  addColumnIfMissing(database, 'ai_usage', 'provider', "TEXT NOT NULL DEFAULT 'deepseek'")
  // 价格来源（P2）：区分「按目录价 / 按快照 / 没有价」；没有价的调用只记 token
  addColumnIfMissing(database, 'ai_usage', 'cost_source', 'TEXT')
  addColumnIfMissing(database, 'ai_usage', 'priced_at', 'TEXT')
  // 缓存唯一键带上 provider（P2）：老表的 UNIQUE(kind, cache_key) 是建表时写死的，
  // 只能重建表；ai_cache 是纯缓存，重建不会影响任何用户数据
  migrateAiCacheUnique(database)

  // 旧的 (headword, pos, kind) 唯一键会阻止合并不同词性/类型的重复词条
  database.exec('DROP INDEX IF EXISTS ux_items')
  dedupeItems(database)
  // 一个 headword 只允许一个词条；pos/kind 不再参与去重键
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_items_headword_norm ON items(headword_norm)')

  // 多个库（PLAN-DECKS D0）：老库的笔记全部进默认库
  database.exec('BEGIN IMMEDIATE')
  try {
    migrateDecks(database, fromVersion < DECKS_SCHEMA_VERSION)
    migrateUids(database)
    database.exec('COMMIT')
  } catch (err) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** 同步要用的表：表名 + 回填 uid 时取时间前缀的列（PLAN-SYNC §3.2） */
const UID_TABLES: { table: string; timeColumn: string }[] = [
  { table: 'notes', timeColumn: 'created_at' },
  { table: 'items', timeColumn: 'created_at' },
  { table: 'reviews', timeColumn: 'reviewed_at' },
  { table: 'exams', timeColumn: 'created_at' },
  // decks.uid 从多库那一版就有，但一直没建唯一索引；库现在也进同步了（S1），
  // 顺手补上回填与索引，避免两台设备出现同一个 deck uid
  { table: 'decks', timeColumn: 'created_at' }
]

/**
 * 稳定 id（PLAN-SYNC §3.2）：同步用表各加 `uid`、回填老行、建唯一索引。
 *
 * 唯一索引不能放进 SCHEMA：老库还没有这一列时 `CREATE UNIQUE INDEX ... (uid)` 会
 * 直接报 "no such column"（和 ix_notes_deck 是同一个坑）。
 *
 * 回填必须做，不能只加列：SQLite 的唯一索引允许多个 NULL，老行全是 NULL 就等于没有 uid。
 */
function migrateUids(database: SqliteDatabase): void {
  for (const { table, timeColumn } of UID_TABLES) {
    addColumnIfMissing(database, table, 'uid', 'TEXT')
    fillMissingUids(database, table, timeColumn)
    repairDuplicateUids(database, table, timeColumn)
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_uid ON ${table}(uid)`)
  }
}

/** 拔掉 NULL / 空串的 uid；时间前缀取行自己的创建时间，让 uid 仍然「时间有序」 */
function fillMissingUids(database: SqliteDatabase, table: string, timeColumn: string): void {
  const rows = database
    .prepare(`SELECT id, ${timeColumn} AS at FROM ${table} WHERE uid IS NULL OR uid = ''`)
    .all() as unknown as { id: number; at: string | null }[]
  if (!rows.length) return
  const update = database.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`)
  for (const row of rows) {
    update.run(uidForTime(row.at), toInt(row.id))
  }
}

/**
 * 极端情况兜底：库里已有重复 uid（手工改过库、或早期的实验版本写过）。
 * 保留 id 最小的那行，其余重新生成——否则建唯一索引会失败，整个应用起不来。
 */
function repairDuplicateUids(database: SqliteDatabase, table: string, timeColumn: string): void {
  const dupes = database
    .prepare(
      `SELECT uid FROM ${table} WHERE uid IS NOT NULL AND uid <> ''
       GROUP BY uid HAVING COUNT(*) > 1`
    )
    .all() as unknown as { uid: string }[]
  for (const dupe of dupes) {
    const rows = database
      .prepare(`SELECT id, ${timeColumn} AS at FROM ${table} WHERE uid = ? ORDER BY id ASC`)
      .all(dupe.uid) as unknown as { id: number; at: string | null }[]
    const update = database.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`)
    for (const row of rows.slice(1)) update.run(uidForTime(row.at), toInt(row.id))
  }
}

function uidForTime(at: string | null): string {
  const time = at ? Date.parse(at) : NaN
  return newUid(Number.isFinite(time) ? time : undefined)
}

/**
 * decks 表由 SCHEMA 建好；这里只补列、建索引、建默认库并回填。
 *
 * `legacy` = 这个库还没升到「多个库」的版本。只有这时才建默认库；
 * 已经升过的库允许「一个库都没有」（用户把库删光了），启动时不许再补一个。
 */
function migrateDecks(database: SqliteDatabase, legacy: boolean): void {
  addColumnIfMissing(database, 'notes', 'deck_id', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(database, 'import_drafts', 'deck_id', 'INTEGER')
  database.exec('CREATE INDEX IF NOT EXISTS ix_notes_deck ON notes(deck_id, note_date)')

  if (legacy) {
    const row = database.prepare('SELECT COUNT(*) AS c FROM decks').get() as { c?: number } | undefined
    if (!toInt(row?.c)) {
      database
        .prepare('INSERT INTO decks (uid, name, position, created_at) VALUES (?, ?, 0, ?)')
        .run(newUid(), '默认库', localIso())
    }
  }

  // 兜底：deck_id 指向不存在的库（补列时老笔记拿到的 1 未必是默认库的 id）。
  // deck_id = 0 是「未归类」（用户删光了库），这是正常状态，不要把它扫进任何库。
  const first = database
    .prepare('SELECT id FROM decks ORDER BY position ASC, id ASC LIMIT 1')
    .get() as { id?: number } | undefined
  if (first?.id) {
    database
      .prepare(
        `UPDATE notes SET deck_id = ?
         WHERE COALESCE(deck_id, -1) <> 0
           AND COALESCE(deck_id, -1) NOT IN (SELECT id FROM decks)`
      )
      .run(first.id)
  }
}

/**
 * 迁移前备份（总览 §7 的坑 1）：openDb() 内部就迁移，dailyBackup() 要晚得多，
 * 所以必须在 openDb 之前调用。不需要迁移时什么都不做。
 *
 * 打开库只为 checkpoint WAL（否则复制出来的可能是迁移前的旧页），读完立刻关闭。
 * 已经存在同版本的 pre-migrate 备份时保留旧的——那才是真正的「迁移前」。
 */
export function backupBeforeMigrate(dbFile: string, backupDir: string): string | null {
  if (!fs.existsSync(dbFile)) return null
  let version = 0
  let hasDecks = false
  const probe = new DatabaseSync(dbFile, { timeout: 4000 })
  try {
    const row = probe.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    version = toInt(row?.user_version)
    hasDecks = Boolean(
      probe.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'decks'").get()
    )
    probe.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // 读不出结构（更坏的库）：照样备份，至少给用户留一份可以发过来的文件
  } finally {
    try {
      probe.close()
    } catch {
      /* ignore */
    }
  }
  if (version >= SCHEMA_VERSION && hasDecks) return null

  fs.mkdirSync(backupDir, { recursive: true })
  const target = path.join(backupDir, `wordmemo-pre-migrate-v${version}.db`)
  if (fs.existsSync(target)) return target
  fs.copyFileSync(dbFile, target)
  return target
}

/**
 * 缺列才 ADD COLUMN——SQLite 给老库补列的标准做法。
 * 已有行会被填上 definition 里的 DEFAULT（这里就是回填 'deepseek'）。
 */
function addColumnIfMissing(
  database: SqliteDatabase,
  table: string,
  column: string,
  definition: string
): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string
  }[]
  // PRAGMA 返回空 = 表不存在，交给 SCHEMA 去建，不在这里加列
  if (!columns.length || columns.some((c) => c.name === column)) return false
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

/**
 * ai_cache 的唯一键从 (kind, cache_key) 换成 (provider, kind, cache_key)。
 * SQLite 改不了约束，只能重建表；ai_cache 是纯缓存（丢了会重新请求），重建不动任何用户数据。
 * 失败就保持原样继续跑——跨家串缓存的风险，比启动失败小得多。
 */
function migrateAiCacheUnique(database: SqliteDatabase): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_cache'")
    .get() as unknown as { sql?: string } | undefined
  const sql = row?.sql ?? ''
  if (!sql) return
  if (/UNIQUE\s*\(\s*provider\s*,\s*kind\s*,\s*cache_key\s*\)/i.test(sql)) return

  try {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE ai_cache_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'deepseek',
        kind TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        model TEXT,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider, kind, cache_key)
      );
      INSERT INTO ai_cache_new (id, provider, kind, cache_key, model, response_json, created_at)
        SELECT id, provider, kind, cache_key, model, response_json, created_at FROM ai_cache;
      DROP TABLE ai_cache;
      ALTER TABLE ai_cache_new RENAME TO ai_cache;
      COMMIT;
    `)
  } catch {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    try {
      database.exec('DROP TABLE IF EXISTS ai_cache_new')
    } catch {
      /* ignore */
    }
  }
}

export function getDb(): SqliteDatabase {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

export function closeDb(): void {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
  txDepth = 0
}

/**
 * 事务。**可重入**：已经在事务里时直接搭外层那条事务。
 *
 * 同步层要求「写操作和它那条 sync_ops 同一条事务」，而写入口会互相调用
 * （`applyReview` → `addAcceptedZh`、`copyNotes` → 每条笔记的 withSync、
 * 导入入库 → `createNote` + `upsertItem`）。如果这里一见 BEGIN 就开，
 * 嵌套调用会直接报 "cannot start a transaction within a transaction"，
 * 所以内层只身参与外层事务：内层失败由最外层统一 ROLLBACK。
 */
let txDepth = 0

export function tx<T>(fn: () => T): T {
  const d = getDb()
  if (txDepth > 0) return fn()
  d.exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    txDepth--
  }
}

/** 本地时区的 ISO 字符串（不带时区后缀，保证字符串排序 = 时间排序） */
export function localIso(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function localDate(d: Date = new Date()): string {
  return localIso(d).slice(0, 10)
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function toInt(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
