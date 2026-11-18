import { DatabaseSync, type SqliteDatabase } from './sqlite'
import { SCHEMA } from './schema'
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

  // 旧的 (headword, pos, kind) 唯一键会阻止合并不同词性/类型的重复词条
  database.exec('DROP INDEX IF EXISTS ux_items')
  dedupeItems(database)
  // 一个 headword 只允许一个词条；pos/kind 不再参与去重键
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_items_headword_norm ON items(headword_norm)')
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
