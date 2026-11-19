import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SqliteDatabase } from './sqlite'
import { SCHEMA, SCHEMA_VERSION } from './schema'
import { newUid } from './uid'
import { dedupeItems } from './dedupe'

let db: SqliteDatabase | null = null

export function openDb(file: string): SqliteDatabase {
  db = new DatabaseSync(file, { timeout: 8000 })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

function migrate(database: SqliteDatabase): void {
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
    migrateDecks(database)
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

/** decks 表由 SCHEMA 建好；这里只补列、建索引、建默认库并回填 */
function migrateDecks(database: SqliteDatabase): void {
  addColumnIfMissing(database, 'notes', 'deck_id', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing(database, 'import_drafts', 'deck_id', 'INTEGER')
  database.exec('CREATE INDEX IF NOT EXISTS ix_notes_deck ON notes(deck_id, note_date)')

  const row = database.prepare('SELECT COUNT(*) AS c FROM decks').get() as { c?: number } | undefined
  if (!toInt(row?.c)) {
    database
      .prepare('INSERT INTO decks (uid, name, position, created_at) VALUES (?, ?, 0, ?)')
      .run(newUid(), '默认库', localIso())
  }

  // 兜底：deck_id 指向不存在的库（补列时老笔记拿到的 1 未必是默认库的 id）
  const first = database
    .prepare('SELECT id FROM decks ORDER BY position ASC, id ASC LIMIT 1')
    .get() as { id?: number } | undefined
  if (first?.id) {
    database
      .prepare('UPDATE notes SET deck_id = ? WHERE deck_id IS NULL OR deck_id NOT IN (SELECT id FROM decks)')
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
}

export function tx<T>(fn: () => T): T {
  const d = getDb()
  d.exec('BEGIN IMMEDIATE')
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
