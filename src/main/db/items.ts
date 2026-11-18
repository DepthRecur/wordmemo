import type { CardDirection, Example, Item, ItemKind } from '@shared/types'
import { normalizeEn, mergePosText } from '@shared/normalize'
import { getDb, localIso, parseJson, toInt } from './connection'
import { newCardSnapshot } from '../fsrs'

interface ItemRow {
  id: number
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

export function listItems(search?: string): Item[] {
  const d = getDb()
  const where = search?.trim()
    ? 'WHERE headword LIKE ? OR meanings LIKE ? OR collocations LIKE ? OR extra LIKE ?'
    : ''
  const params = search?.trim()
    ? [`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`]
    : []
  const rows = d
    .prepare(`SELECT * FROM items ${where} ORDER BY headword COLLATE NOCASE ASC LIMIT 1000`)
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

  let itemId: number
  if (existing) {
    itemId = toInt(existing.id)
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
  } else {
    const res = d
      .prepare(
        `INSERT INTO items (kind, headword, headword_norm, pos, phonetic, meanings, collocations, examples, extra, accepted_zh, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
      )
      .run(
        kind,
        headword,
        norm,
        pos,
        input.phonetic?.trim() || null,
        JSON.stringify(input.meanings.filter(Boolean)),
        JSON.stringify(input.collocations ?? []),
        JSON.stringify(input.examples ?? []),
        input.extra?.trim() || null,
        localIso()
      )
    itemId = toInt(res.lastInsertRowid)
  }

  ensureCards(itemId, input.listenEnabled)
  d.prepare(
    `INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (?, ?, ?, ?)
     ON CONFLICT(note_id, item_id) DO UPDATE SET raw_line = excluded.raw_line`
  ).run(input.noteId, itemId, input.rawLine ?? null, input.position)

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
  if (row?.id) {
    d.prepare('UPDATE cards SET suspended = ? WHERE id = ?').run(enabled ? 0 : 1, row.id)
    return
  }
  if (!enabled) return
  const snap = newCardSnapshot(new Date())
  d.prepare(
    `INSERT INTO cards (item_id, direction, due_at, stability, difficulty, reps, lapses, state, last_review, suspended, fsrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(itemId, direction, snap.dueAt, snap.stability, snap.difficulty, snap.reps, snap.lapses, snap.state, snap.fsrsJson)
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
  try {
    d.prepare(
      `UPDATE items SET kind = ?, headword = ?, headword_norm = ?, pos = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?, extra = ? WHERE id = ?`
    ).run(
      kind,
      headword,
      normalizeEn(headword),
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
}

export function deleteItem(id: number): void {
  getDb().prepare('DELETE FROM items WHERE id = ?').run(id)
}

export function findExistingItemId(headword: string, _pos: string | null, _kind: ItemKind): number | null {
  const row = getDb()
    .prepare(`SELECT id FROM items WHERE headword_norm = ?`)
    .get(normalizeEn(headword)) as { id?: number } | undefined
  return row?.id ? toInt(row.id) : null
}

export function addAcceptedZh(itemId: number, answer: string): void {
  const d = getDb()
  const row = d.prepare('SELECT accepted_zh FROM items WHERE id = ?').get(itemId) as
    | { accepted_zh?: string }
    | undefined
  if (!row) return
  const list = parseJson<string[]>(row.accepted_zh, [])
  if (!list.includes(answer)) {
    list.push(answer)
    d.prepare('UPDATE items SET accepted_zh = ? WHERE id = ?').run(JSON.stringify(list), itemId)
  }
}

/** 还没学过、且至少有一张卡的词条数 */
export function countUnlearned(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM items i
       WHERE i.learned_at IS NULL
         AND EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.suspended = 0)`
    )
    .get() as { c?: number } | undefined
  return toInt(row?.c)
}

export function learnedTodayCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM items WHERE substr(COALESCE(learned_at, ''), 1, 10) = ?`)
    .get(localIso().slice(0, 10)) as { c?: number } | undefined
  return toInt(row?.c)
}

/** 今日待学习的新词（按词条，不按卡片） */
export function learnQueue(limit: number): Item[] {
  if (limit <= 0) return []
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT i.* FROM items i
       WHERE i.learned_at IS NULL
         AND EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.suspended = 0)
       ORDER BY i.created_at ASC, i.id ASC
       LIMIT ?`
    )
    .all(limit) as unknown as ItemRow[]
  const links = d.prepare('SELECT note_id FROM note_items WHERE item_id = ?')
  return rows.map((row) => {
    const noteIds = (links.all(row.id) as { note_id: number }[]).map((r) => r.note_id)
    const item = mapItem(row, noteIds)
    item.directions = itemDirections(row.id)
    return item
  })
}
