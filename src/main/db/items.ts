import type { CardDirection, Example, Item, ItemKind } from '@shared/types'
import { normalizeEn, mergePosText } from '@shared/normalize'
import { getDb, localIso, parseJson, toInt } from './connection'
import { deckScope } from './decks'
import { cardFlagUid, itemUid, noteItemUid, noteUid, recordSyncOp, withSync } from './sync'
import { newUid } from './uid'
import { newCardSnapshot } from '../fsrs'

interface ItemRow {
  id: number
  uid: string | null
  kind: string
  headword: string
  headword_norm: string
  pos: string | null
  phonetic: string | null
  meanings: string
  collocations: string
  examples: string
  extra: string | null
  accepted_zh: string
  learned_at: string | null
  created_at: string
}

function mapItem(row: ItemRow, noteIds: number[] = []): Item {
  return {
    id: toInt(row.id),
    kind: (row.kind as ItemKind) ?? 'word',
    headword: row.headword,
    pos: row.pos,
    phonetic: row.phonetic,
    meanings: parseJson<string[]>(row.meanings, []),
    collocations: parseJson<string[]>(row.collocations, []),
    examples: parseJson<Example[]>(row.examples, []),
    extra: row.extra,
    acceptedZh: parseJson<string[]>(row.accepted_zh, []),
    learnedAt: row.learned_at ?? null,
    createdAt: row.created_at,
    noteIds,
    directions: []
  }
}

const BASE_DIRECTIONS: CardDirection[] = ['en2zh', 'zh2en']
const ITEM_KINDS: ItemKind[] = ['word', 'phrase', 'sentence', 'grammar']

export function itemDirections(itemId: number): CardDirection[] {
  const rows = getDb()
    .prepare('SELECT direction FROM cards WHERE item_id = ? AND suspended = 0')
    .all(itemId) as { direction: string }[]
  return rows.map((r) => r.direction as CardDirection)
}

export function getItem(id: number): Item | null {
  const row = getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined
  if (!row) return null
  const noteIds = (
    getDb().prepare('SELECT note_id FROM note_items WHERE item_id = ?').all(id) as { note_id: number }[]
  ).map((r) => r.note_id)
  const item = mapItem(row, noteIds)
  item.directions = itemDirections(id)
  return item
}

/** 词条列表（笔记库搜索用）；deckId = 只看这个库里的词条 */
export function listItems(search?: string, deckId?: number | null): Item[] {
  const d = getDb()
  const scope = deckScope('i.id', deckId)
  const keyword = search?.trim()
  const where = keyword
    ? `WHERE (i.headword LIKE ? OR i.meanings LIKE ? OR i.collocations LIKE ? OR i.extra LIKE ?)${scope.clause}`
    : `WHERE 1 = 1${scope.clause}`
  const params = keyword
    ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, ...scope.params]
    : scope.params
  const rows = d
    .prepare(`SELECT i.* FROM items i ${where} ORDER BY i.headword COLLATE NOCASE ASC LIMIT 1000`)
    .all(...params) as unknown as ItemRow[]
  const links = d.prepare('SELECT note_id FROM note_items WHERE item_id = ?')
  return rows.map((row) => {
    const noteIds = (links.all(row.id) as { note_id: number }[]).map((r) => r.note_id)
    const item = mapItem(row, noteIds)
    item.directions = itemDirections(row.id)
    return item
  })
}

export interface UpsertItemInput {
  kind: ItemKind
  headword: string
  pos?: string | null
  phonetic?: string | null
  meanings: string[]
  collocations?: string[]
  examples?: Example[]
  extra?: string | null
  rawLine?: string | null
  noteId: number
  position: number
  listenEnabled: boolean
}

function mergeUnique(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((s) => s.trim()))
  const out = [...a]
  for (const v of b) {
    const t = v.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function mergeExamples(a: Example[], b: Example[]): Example[] {
  const seen = new Set(a.map((e) => normalizeEn(e.en)))
  const out = [...a]
  for (const e of b) {
    const k = normalizeEn(e.en)
    if (e.en.trim() && !seen.has(k)) {
      seen.add(k)
      out.push(e)
    }
  }
  return out
}

export function upsertItem(input: UpsertItemInput): number {
  const d = getDb()
  const kind = input.kind
  const headword = input.headword.trim()
  const pos = input.pos?.trim() || null
  const norm = normalizeEn(headword)
  const existing = d
    .prepare(`SELECT * FROM items WHERE headword_norm = ?`)
    .get(norm) as ItemRow | undefined

  if (existing) {
    const itemId = toInt(existing.id)
    const meanings = mergeUnique(parseJson<string[]>(existing.meanings, []), input.meanings)
    const collocations = mergeUnique(
      parseJson<string[]>(existing.collocations, []),
      input.collocations ?? []
    )
    const examples = mergeExamples(parseJson<Example[]>(existing.examples, []), input.examples ?? [])
    const extra = input.extra?.trim()
      ? mergeUnique([existing.extra ?? ''], [input.extra])
          .filter(Boolean)
          .join('\n')
      : existing.extra
    const mergedPos = mergePosText(existing.pos, pos)
    const mergedKind =
      existing.kind === 'word' || kind === 'word' ? 'word' : existing.kind || kind
    const phonetic = existing.phonetic?.trim() || input.phonetic?.trim() || null
    // 只记真正变了的字段（字段级 LWW：全量重写会盖掉别的设备改的字段）
    const fields: Record<string, unknown> = {}
    if (mergedPos !== existing.pos) fields.pos = mergedPos
    if (mergedKind !== existing.kind) fields.kind = mergedKind
    if (phonetic !== existing.phonetic) fields.phonetic = phonetic
    if (JSON.stringify(meanings) !== existing.meanings) fields.meanings = meanings
    if (JSON.stringify(collocations) !== existing.collocations) fields.collocations = collocations
    if (JSON.stringify(examples) !== existing.examples) fields.examples = examples
    if (extra !== existing.extra) fields.extra = extra
    return withSync({ entity: 'item', uid: existing.uid ?? '', fields }, () => {
      d.prepare(
        `UPDATE items SET pos = ?, kind = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?, extra = ?
         WHERE id = ?`
      ).run(
        mergedPos,
        mergedKind,
        phonetic,
        JSON.stringify(meanings),
        JSON.stringify(collocations),
        JSON.stringify(examples),
        extra,
        itemId
      )
      return finishItemWrite(itemId, input)
    })
  }

  const uid = newUid()
  const createdAt = localIso()
  const newMeanings = input.meanings.filter(Boolean)
  const newCollocations = input.collocations ?? []
  const newExamples = input.examples ?? []
  const extra = input.extra?.trim() || null
  const newPhonetic = input.phonetic?.trim() || null
  return withSync(
    {
      entity: 'item',
      uid,
      fields: {
        kind,
        headword,
        pos,
        phonetic: newPhonetic,
        meanings: newMeanings,
        collocations: newCollocations,
        examples: newExamples,
        extra,
        accepted_zh: [],
        learned_at: null,
        created_at: createdAt
      }
    },
    () => {
      const res = d
        .prepare(
          `INSERT INTO items (uid, kind, headword, headword_norm, pos, phonetic, meanings, collocations, examples, extra, accepted_zh, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
        )
        .run(
          uid,
          kind,
          headword,
          norm,
          pos,
          newPhonetic,
          JSON.stringify(newMeanings),
          JSON.stringify(newCollocations),
          JSON.stringify(newExamples),
          extra,
          createdAt
        )
      return finishItemWrite(toInt(res.lastInsertRowid), input)
    }
  )
}

/** 词条写完之后的两件事：补卡片、挂到笔记上（关联本身也是一个同步实体） */
function finishItemWrite(itemId: number, input: UpsertItemInput): number {
  ensureCards(itemId, input.listenEnabled)
  const d = getDb()
  const previous = d
    .prepare('SELECT raw_line FROM note_items WHERE note_id = ? AND item_id = ?')
    .get(input.noteId, itemId) as { raw_line: string | null } | undefined
  const rawLine = input.rawLine ?? null
  d.prepare(
    `INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (?, ?, ?, ?)
     ON CONFLICT(note_id, item_id) DO UPDATE SET raw_line = excluded.raw_line`
  ).run(input.noteId, itemId, rawLine, input.position)

  // 关联是独立实体（PLAN-SYNC S1）：新建或 raw_line 变了才发；position 只在新建时定
  const noteUidValue = noteUid(input.noteId)
  const itemUidValue = itemUid(itemId)
  if (noteUidValue && itemUidValue && (!previous || previous.raw_line !== rawLine)) {
    recordSyncOp({
      entity: 'noteItem',
      uid: noteItemUid(noteUidValue, itemUidValue),
      fields: previous
        ? { note_uid: noteUidValue, item_uid: itemUidValue, raw_line: rawLine }
        : {
            note_uid: noteUidValue,
            item_uid: itemUidValue,
            raw_line: rawLine,
            position: input.position
          }
    })
  }
  return itemId
}

export function ensureCards(itemId: number, listenEnabled: boolean): void {
  const d = getDb()
  const dirs: CardDirection[] = [...BASE_DIRECTIONS]
  if (listenEnabled) dirs.push('listen2en')
  const now = new Date()
  for (const dir of dirs) {
    const exists = d
      .prepare('SELECT id FROM cards WHERE item_id = ? AND direction = ?')
      .get(itemId, dir) as { id?: number } | undefined
    if (exists?.id) continue
    const snap = newCardSnapshot(now)
    d.prepare(
      `INSERT INTO cards (item_id, direction, due_at, stability, difficulty, reps, lapses, state, last_review, suspended, fsrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
    ).run(
      itemId,
      dir,
      snap.dueAt,
      snap.stability,
      snap.difficulty,
      snap.reps,
      snap.lapses,
      snap.state,
      snap.fsrsJson
    )
  }
}

export function setDirection(itemId: number, direction: CardDirection, enabled: boolean): void {
  if (direction !== 'listen2en') throw new Error('英→中、中→英为必选方向，不能关闭')
  const d = getDb()
  const row = d
    .prepare('SELECT id FROM cards WHERE item_id = ? AND direction = ?')
    .get(itemId, direction) as { id?: number } | undefined
  const itemUidValue = itemUid(itemId)
  // 卡片标志单独走 cardFlag 事件（PLAN-SYNC §3.3）：卡片本身不传，本地重放
  const flagUid = itemUidValue ? cardFlagUid(itemUidValue, direction) : ''
  if (row?.id) {
    const cardId = row.id
    withSync({ entity: 'cardFlag', uid: flagUid, fields: { suspended: enabled ? 0 : 1 } }, () => {
      d.prepare('UPDATE cards SET suspended = ? WHERE id = ?').run(enabled ? 0 : 1, cardId)
    })
    return
  }
  if (!enabled) return
  const snap = newCardSnapshot(new Date())
  withSync({ entity: 'cardFlag', uid: flagUid, fields: { suspended: 0 } }, () => {
    d.prepare(
      `INSERT INTO cards (item_id, direction, due_at, stability, difficulty, reps, lapses, state, last_review, suspended, fsrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
    ).run(itemId, direction, snap.dueAt, snap.stability, snap.difficulty, snap.reps, snap.lapses, snap.state, snap.fsrsJson)
  })
}

export function updateItem(
  id: number,
  patch: Partial<
    Pick<
      Item,
      'kind' | 'headword' | 'pos' | 'meanings' | 'collocations' | 'examples' | 'extra' | 'phonetic'
    >
  >
): void {
  const d = getDb()
  const current = d.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined
  if (!current) throw new Error('词条不存在')
  const kind =
    patch.kind && ITEM_KINDS.includes(patch.kind) ? patch.kind : (current.kind as ItemKind)
  const headword = patch.headword?.trim() || current.headword
  const pos = patch.pos === undefined ? current.pos : patch.pos?.trim() || null
  const meanings = patch.meanings ?? parseJson<string[]>(current.meanings, [])
  const collocations = patch.collocations ?? parseJson<string[]>(current.collocations, [])
  const examples = patch.examples ?? parseJson<Example[]>(current.examples, [])
  const extra = patch.extra === undefined ? current.extra : patch.extra
  const phonetic = patch.phonetic === undefined ? current.phonetic : patch.phonetic
  const norm = normalizeEn(headword)
  // 只记真正变了的字段（同 upsertItem）
  const fields: Record<string, unknown> = {}
  if (kind !== current.kind) fields.kind = kind
  if (headword !== current.headword) fields.headword = headword
  if (pos !== current.pos) fields.pos = pos
  if (phonetic !== current.phonetic) fields.phonetic = phonetic
  if (JSON.stringify(meanings) !== current.meanings) fields.meanings = meanings
  if (JSON.stringify(collocations) !== current.collocations) fields.collocations = collocations
  if (JSON.stringify(examples) !== current.examples) fields.examples = examples
  if (extra !== current.extra) fields.extra = extra
  withSync({ entity: 'item', uid: current.uid ?? '', fields }, () => {
    try {
      d.prepare(
        `UPDATE items SET kind = ?, headword = ?, headword_norm = ?, pos = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?, extra = ? WHERE id = ?`
      ).run(
        kind,
        headword,
        norm,
        pos,
        phonetic,
        JSON.stringify(meanings),
        JSON.stringify(collocations),
        JSON.stringify(examples),
        extra,
        id
      )
    } catch (err) {
      throw new Error('修改失败：已存在同名词条（同词性）')
    }
  })
}

export function deleteItem(id: number): void {
  const uid = itemUid(id)
  withSync({ entity: 'item', uid: uid ?? '', op: 'delete' }, () => {
    getDb().prepare('DELETE FROM items WHERE id = ?').run(id)
  })
}

export function findExistingItemId(headword: string, _pos: string | null, _kind: ItemKind): number | null {
  const row = getDb()
    .prepare(`SELECT id FROM items WHERE headword_norm = ?`)
    .get(normalizeEn(headword)) as { id?: number } | undefined
  return row?.id ? toInt(row.id) : null
}

export function addAcceptedZh(itemId: number, answer: string): void {
  const d = getDb()
  const row = d.prepare('SELECT uid, accepted_zh FROM items WHERE id = ?').get(itemId) as
    | { uid?: string | null; accepted_zh?: string }
    | undefined
  if (!row) return
  const list = parseJson<string[]>(row.accepted_zh, [])
  if (!list.includes(answer)) {
    list.push(answer)
    withSync({ entity: 'item', uid: row.uid ?? '', fields: { accepted_zh: list } }, () => {
      d.prepare('UPDATE items SET accepted_zh = ? WHERE id = ?').run(JSON.stringify(list), itemId)
    })
  }
}

/** 还没学过、且至少有一张卡的词条数；deckId = 只数这个库 */
export function countUnlearned(deckId?: number | null): number {
  const scope = deckScope('i.id', deckId)
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM items i
       WHERE i.learned_at IS NULL
         AND EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.suspended = 0)${scope.clause}`
    )
    .get(...scope.params) as { c?: number } | undefined
  return toInt(row?.c)
}

/** 今天学过的新词数；按库算时只数这个库范围内的词条 */
export function learnedTodayCount(deckId?: number | null): number {
  const scope = deckScope('i.id', deckId)
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM items i
       WHERE substr(COALESCE(i.learned_at, ''), 1, 10) = ?${scope.clause}`
    )
    .get(localIso().slice(0, 10), ...scope.params) as { c?: number } | undefined
  return toInt(row?.c)
}

/** 今日待学习的新词（按词条，不按卡片）；deckId = 只抽这个库 */
export function learnQueue(limit: number, deckId?: number | null): Item[] {
  if (limit <= 0) return []
  const d = getDb()
  const scope = deckScope('i.id', deckId)
  const rows = d
    .prepare(
      `SELECT i.* FROM items i
       WHERE i.learned_at IS NULL
         AND EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.suspended = 0)${scope.clause}
       ORDER BY i.created_at ASC, i.id ASC
       LIMIT ?`
    )
    .all(...scope.params, limit) as unknown as ItemRow[]
  const links = d.prepare('SELECT note_id FROM note_items WHERE item_id = ?')
  return rows.map((row) => {
    const noteIds = (links.all(row.id) as { note_id: number }[]).map((r) => r.note_id)
    const item = mapItem(row, noteIds)
    item.directions = itemDirections(row.id)
    return item
  })
}
