import type { Deck, DeckPatch, ExamScope } from '@shared/types'
import { getDb, localIso, parseJson, toInt, tx } from './connection'
import { scopeForSync } from './exams'
import { deckUid, recordSyncOp } from './sync'
import { newUid } from './uid'
import { getSettings, updateSettings } from '../settings'

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
 * 删库（PLAN-DECKS §7.4；2026-11-20 放宽为「允许一个库都没有」）。
 *
 * - `moveTo` = 目标库：笔记全部移过去（原来唯一的做法）；
 * - `moveTo` = null：只用于删**最后一个**库。笔记不删，`deck_id` 置 0 = 未归类，
 *   只在笔记库的「全部」里出现，以后可以批量移动到新库。绝不静默丢笔记。
 */
export function removeDeck(
  id: number,
  moveTo: number | null
): { moved: number; unassigned: number } {
  if (!isDeck(id)) throw new Error('库不存在')
  if (!deckExists(id)) throw new Error('要删除的库不存在')
  if (moveTo === null) {
    if (count('SELECT COUNT(*) AS c FROM decks') > 1) {
      throw new Error('还有别的库，请先选择这些笔记要移到哪个库')
    }
  } else {
    if (!isDeck(moveTo)) throw new Error('目标库不存在')
    if (id === moveTo) throw new Error('不能把笔记移到正在删除的库')
    if (!deckExists(moveTo)) throw new Error('目标库不存在')
  }

  const wasCurrent = getSettings().currentDeckId === id
  const result = tx(() => {
    const before = count('SELECT COUNT(*) AS c FROM notes WHERE deck_id = ?', [id])
    // 先取 uid：改完归属要发 note / exam 的 op，别的设备才知道这些行变了
    const noteRows = getDb()
      .prepare('SELECT id, uid FROM notes WHERE deck_id = ?')
      .all(id) as unknown as { id: number; uid: string | null }[]
    const targetUid = moveTo === null ? null : deckUid(moveTo)
    if (moveTo === null) {
      getDb()
        .prepare('UPDATE notes SET deck_id = 0, updated_at = ? WHERE deck_id = ?')
        .run(localIso(), id)
      // 这些草稿原本要入这个库：入库时按「未归类」处理，不要指向已删的库
      getDb().prepare('UPDATE import_drafts SET deck_id = 0 WHERE deck_id = ?').run(id)
    } else {
      getDb()
        .prepare('UPDATE notes SET deck_id = ?, updated_at = ? WHERE deck_id = ?')
        .run(moveTo, localIso(), id)
      getDb().prepare('UPDATE import_drafts SET deck_id = ? WHERE deck_id = ?').run(moveTo, id)
    }
    for (const note of noteRows) {
      recordSyncOp({ entity: 'note', uid: note.uid ?? '', fields: { deck_uid: targetUid } })
    }
    // 考试范围是 JSON，没有外键：不同步就会留下永远查不到卡的悬空 deckId（D-01）。
    // 用 JS 解析/写回，避免依赖 SQLite JSON1；moveTo = null（删最后一个库）时
    // 删掉 deckId = 退回「全部库」，不要写 0（0 在 deckInClause 里是「未归类」）。
    const examRows = getDb().prepare('SELECT id, uid, scope FROM exams').all() as {
      id: number
      uid: string | null
      scope: string
    }[]
    if (examRows.length) {
      const updateScope = getDb().prepare('UPDATE exams SET scope = ? WHERE id = ?')
      for (const exam of examRows) {
        const scope = parseJson<ExamScope>(exam.scope, {})
        if (toInt(scope.deckId) !== id) continue
        if (moveTo === null) delete scope.deckId
        else scope.deckId = moveTo
        updateScope.run(JSON.stringify(scope), toInt(exam.id))
        recordSyncOp({
          entity: 'exam',
          uid: exam.uid ?? '',
          fields: { scope: scopeForSync(scope) }
        })
      }
    }
    getDb().prepare('DELETE FROM decks WHERE id = ?').run(id)
    return { moved: before, unassigned: moveTo === null ? before : 0 }
  })
  // 当前库就是被删的这个：别把悬空 id 留给托盘/提醒（D-05）。
  // 放在事务外：事务回滚时不该已经改了磁盘上的 settings.json。
  if (wasCurrent) {
    try {
      updateSettings({ currentDeckId: moveTo ?? 0 })
    } catch {
      /* 设置写失败不影响库已删除的结果；下次启动 currentDeckId 会兜底到第一个库 */
    }
  }
  return result
}

