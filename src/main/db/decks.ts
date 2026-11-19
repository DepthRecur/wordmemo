import type { Deck, DeckPatch } from '@shared/types'
import { getDb, localIso, toInt, tx } from './connection'
import { newUid } from './uid'
import { getSettings } from '../settings'

/**
 * 多库作用域（PLAN-DECKS §5）。
 *
 * 卡片、词条、复习记录都是全局一份；库只决定「从哪个范围里抽卡」。
 * 所有按库过滤的查询都必须走这里，漏一处就会出现「在 A 库复习到 B 库的词」。
 *
 * @param column 要比对的列，如 `i.id`（items）或 `c.item_id`（cards）
 * @param deckId null / undefined = 全部库（只有笔记库、统计页这类视图会用）
 */
export function deckInClause(
  column: string,
  deckId?: number | null
): { clause: string; params: number[] } {
  if (deckId === null || deckId === undefined || !Number.isInteger(deckId)) {
    return { clause: '', params: [] }
  }
  return {
    clause: `${column} IN (SELECT ni.item_id FROM note_items ni JOIN notes n ON n.id = ni.note_id WHERE n.deck_id = ?)`,
    params: [deckId]
  }
}

/** 带前导 ` AND ` 的版本，供已有 WHERE 的查询直接拼在后面 */
export function deckScope(
  column: string,
  deckId?: number | null
): { clause: string; params: number[] } {
  const scope = deckInClause(column, deckId)
  return { clause: scope.clause ? ` AND ${scope.clause}` : '', params: scope.params }
}

function isDeck(deckId: unknown): deckId is number {
  return typeof deckId === 'number' && Number.isInteger(deckId) && deckId > 0
}

export function deckExists(deckId: number): boolean {
  if (!isDeck(deckId)) return false
  return Boolean(getDb().prepare('SELECT 1 AS ok FROM decks WHERE id = ?').get(deckId))
}

export function defaultDeckId(): number {
  const row = getDb().prepare('SELECT id FROM decks ORDER BY position ASC, id ASC LIMIT 1').get() as
    | { id?: number }
    | undefined
  return toInt(row?.id)
}

/** 当前库：settings 里记的 id，库被删了就退回第一个库 */
export function currentDeckId(): number {
  const wanted = getSettings().currentDeckId
  if (isDeck(wanted) && deckExists(wanted)) return wanted
  return defaultDeckId()
}

/** 这个库每天出多少新词：库自己的覆盖值优先，NULL 用全局设置 */
export function deckNewPerDay(deckId?: number | null): number {
  const fallback = Math.max(0, Number(getSettings().newPerDay ?? 20))
  if (deckId === null || deckId === undefined) return fallback
  const row = getDb().prepare('SELECT new_per_day FROM decks WHERE id = ?').get(deckId) as
    | { new_per_day?: number | null }
    | undefined
  if (!row) return fallback
  if (row.new_per_day === null || row.new_per_day === undefined) return fallback
  return Math.max(0, toInt(row.new_per_day, fallback))
}

interface DeckCounts {
  noteCount: number
  itemCount: number
  unlearnedCount: number
  learnedToday: number
  dueCount: number
}

function count(sql: string, params: any[] = []): number {
  const row = getDb().prepare(sql).get(...params) as { c?: number } | undefined
  return toInt(row?.c)
}

function deckCounts(deckId: number): DeckCounts {
  const today = localIso().slice(0, 10)
  const now = localIso()
  const learnAhead = Math.max(0, Number(getSettings().learnAheadMinutes ?? 20))
  const learnCutoff = localIso(new Date(Date.now() + learnAhead * 60_000))
  const inDeck = `SELECT ni.item_id FROM note_items ni JOIN notes n ON n.id = ni.note_id WHERE n.deck_id = ?`
  return {
    noteCount: count('SELECT COUNT(*) AS c FROM notes WHERE deck_id = ?', [deckId]),
    itemCount: count(`SELECT COUNT(DISTINCT item_id) AS c FROM (${inDeck})`, [deckId]),
    unlearnedCount: count(
      `SELECT COUNT(*) AS c FROM items i
       WHERE i.learned_at IS NULL
         AND EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.suspended = 0)
         AND i.id IN (${inDeck})`,
      [deckId]
    ),
    learnedToday: count(
      `SELECT COUNT(*) AS c FROM items i
       WHERE substr(COALESCE(i.learned_at, ''), 1, 10) = ? AND i.id IN (${inDeck})`,
      [today, deckId]
    ),
    dueCount: count(
      `SELECT COUNT(DISTINCT c.item_id) AS c FROM cards c
       WHERE c.suspended = 0
         AND IFNULL(c.buried_until, '') < ?
         AND (
           c.needs_check = 1
           OR (c.state = 2 AND c.due_at <= ?)
           OR (c.state IN (1, 3) AND c.due_at <= ?)
         )
         AND c.item_id IN (${inDeck})`,
      [today, now, learnCutoff, deckId]
    )
  }
}

function mapDeck(row: { [key: string]: unknown }): Deck {
  const id = toInt(row.id)
  const counts = deckCounts(id)
  const quota = deckNewPerDay(id)
  const remaining = Math.max(0, quota - counts.learnedToday)
  return {
    id,
    uid: String(row.uid ?? ''),
    name: String(row.name ?? ''),
    color: row.color ? String(row.color) : null,
    position: toInt(row.position),
    newPerDay: row.new_per_day === null || row.new_per_day === undefined ? null : toInt(row.new_per_day),
    noteCount: counts.noteCount,
    itemCount: counts.itemCount,
    unlearnedCount: counts.unlearnedCount,
    learnedToday: counts.learnedToday,
    todayNew: Math.min(remaining, counts.unlearnedCount),
    dueCount: counts.dueCount
  }
}

export function listDecks(): Deck[] {
  const rows = getDb()
    .prepare('SELECT * FROM decks ORDER BY position ASC, id ASC')
    .all() as unknown as { [key: string]: unknown }[]
  return rows.map(mapDeck)
}

export function getDeck(id: number): Deck | null {
  const row = getDb().prepare('SELECT * FROM decks WHERE id = ?').get(id) as
    | { [key: string]: unknown }
    | undefined
  return row ? mapDeck(row) : null
}

function normalizedName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new Error('库名不能为空')
  if (name.length > 40) throw new Error('库名最多 40 个字')
  return name
}

function nameTaken(name: string, excludeId?: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM decks WHERE name = ? COLLATE NOCASE')
    .get(name) as { id?: number } | undefined
  if (!row?.id) return false
  return excludeId === undefined || toInt(row.id) !== excludeId
}

export function createDeck(input: {
  name: string
  color?: string | null
  newPerDay?: number | null
}): number {
  const name = normalizedName(input.name)
  if (nameTaken(name)) throw new Error(`已经有叫「${name}」的库了`)
  const row = getDb().prepare('SELECT IFNULL(MAX(position), -1) AS p FROM decks').get() as
    | { p?: number }
    | undefined
  const position = toInt(row?.p, -1) + 1
  const res = getDb()
    .prepare(
      'INSERT INTO decks (uid, name, color, position, new_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      newUid(),
      name,
      input.color?.trim() || null,
      position,
      input.newPerDay === null || input.newPerDay === undefined
        ? null
        : Math.max(0, toInt(input.newPerDay)),
      localIso()
    )
  return toInt(res.lastInsertRowid)
}

export function updateDeck(id: number, patch: DeckPatch): void {
  const current = getDb().prepare('SELECT * FROM decks WHERE id = ?').get(id) as
    | { [key: string]: unknown }
    | undefined
  if (!current) throw new Error('这个库不存在（可能已经被删除）')

  const name = patch.name === undefined ? String(current.name) : normalizedName(patch.name)
  if (nameTaken(name, id)) throw new Error(`已经有叫「${name}」的库了`)
  const color =
    patch.color === undefined ? (current.color ? String(current.color) : null) : patch.color?.trim() || null
  const newPerDay =
    patch.newPerDay === undefined
      ? (current.new_per_day as number | null)
      : patch.newPerDay === null
        ? null
        : Math.max(0, toInt(patch.newPerDay))
  const position = patch.position === undefined ? toInt(current.position) : toInt(patch.position)

  getDb()
    .prepare('UPDATE decks SET name = ?, color = ?, position = ?, new_per_day = ? WHERE id = ?')
    .run(name, color, position, newPerDay, id)
}

/**
 * 删库：先把这个库的笔记全部移到 moveTo，再删（PLAN-DECKS §7.4）。
 * 不允许删最后一个库，也不允许「连笔记一起删」。
 */
export function removeDeck(id: number, moveTo: number): { moved: number } {
  if (!isDeck(id)) throw new Error('库不存在')
  if (id === moveTo) throw new Error('不能把笔记移到正在删除的库')
  const total = count('SELECT COUNT(*) AS c FROM decks')
  if (total <= 1) throw new Error('至少要保留一个库')
  if (!deckExists(moveTo)) throw new Error('目标库不存在')
  if (!deckExists(id)) throw new Error('要删除的库不存在')

  return tx(() => {
    const before = count('SELECT COUNT(*) AS c FROM notes WHERE deck_id = ?', [id])
    getDb()
      .prepare('UPDATE notes SET deck_id = ?, updated_at = ? WHERE deck_id = ?')
      .run(moveTo, localIso(), id)
    getDb().prepare('DELETE FROM decks WHERE id = ?').run(id)
    return { moved: before }
  })
}

