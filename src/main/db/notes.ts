import type { NoteDetail, NoteInput, NoteQuery, NoteSummary } from '@shared/types'
import { getDb, localIso, parseJson, toInt, tx } from './connection'
import { defaultDeckId, deckExists } from './decks'
import { itemDirections } from './items'

interface NoteRow {
  id: number
  source_id: number | null
  deck_id: number
  title: string
  note_date: string | null
  tags: string
  raw_markdown: string
  status: string
  created_at: string
  updated_at: string
  source_name?: string | null
  source_kind?: string | null
  deck_name?: string | null
}

interface SummaryRow extends NoteRow {
  item_count: number
  due_count: number
  issue_count: number
}

const SUMMARY_SELECT = `
SELECT n.*,
  d.name AS deck_name,
  (SELECT COUNT(*) FROM note_items ni WHERE ni.note_id = n.id) AS item_count,
  (SELECT COUNT(*) FROM note_items ni JOIN cards c ON c.item_id = ni.item_id
     WHERE ni.note_id = n.id AND c.suspended = 0 AND c.due_at <= ?) AS due_count,
  (SELECT COUNT(*) FROM validation_issues vi WHERE vi.note_id = n.id AND vi.resolved = 0) AS issue_count,
  s.original_name AS source_name,
  s.kind AS source_kind
FROM notes n
LEFT JOIN decks d ON d.id = n.deck_id
LEFT JOIN sources s ON s.id = n.source_id
`

function mapSummary(row: SummaryRow): NoteSummary {
  return {
    id: toInt(row.id),
    deckId: toInt(row.deck_id),
    deckName: row.deck_name ?? '默认库',
    title: row.title,
    noteDate: row.note_date,
    tags: parseJson<string[]>(row.tags, []),
    sourceKind: row.source_kind ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: toInt(row.item_count),
    dueCount: toInt(row.due_count),
    issueCount: toInt(row.issue_count)
  }
}

export function listNotes(query: NoteQuery = {}): NoteSummary[] {
  const d = getDb()
  const now = localIso()
  const params: any[] = [now]
  const clauses: string[] = []

  // 不传 deckId = 全部库（笔记库的「全部」视图）；传了就只列这个库
  if (query.deckId !== null && query.deckId !== undefined) {
    clauses.push('n.deck_id = ?')
    params.push(toInt(query.deckId))
  }
  if (query.search?.trim()) {
    const like = `%${query.search.trim()}%`
    clauses.push(`(
      n.title LIKE ? OR n.raw_markdown LIKE ? OR n.tags LIKE ?
      OR EXISTS (
        SELECT 1 FROM note_items ni JOIN items i ON i.id = ni.item_id
        WHERE ni.note_id = n.id AND (i.headword LIKE ? OR i.meanings LIKE ?)
      )
    )`)
    params.push(like, like, like, like, like)
  }
  if (query.tag?.trim()) {
    clauses.push('n.tags LIKE ?')
    params.push(`%${query.tag.trim()}%`)
  }

  const sortField =
    query.sort === 'title'
      ? 'n.title COLLATE NOCASE'
      : query.sort === 'createdAt'
        ? 'n.created_at'
        : "COALESCE(n.note_date, substr(n.created_at, 1, 10))"
  const order = query.order === 'asc' ? 'ASC' : 'DESC'

  const sql = `${SUMMARY_SELECT}
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY ${sortField} ${order}, n.id DESC`
  const rows = d.prepare(sql).all(...params) as unknown as SummaryRow[]
  return rows.map(mapSummary)
}

export function getNote(id: number): NoteDetail | null {
  const d = getDb()
  const row = d.prepare(`${SUMMARY_SELECT} WHERE n.id = ?`).get(localIso(), id) as SummaryRow | undefined
  if (!row) return null

  const itemRows = d
    .prepare(
      `SELECT i.* FROM note_items ni JOIN items i ON i.id = ni.item_id
       WHERE ni.note_id = ? ORDER BY ni.position ASC, i.id ASC`
    )
    .all(id) as any[]

  const items = itemRows.map((r: any) => ({
    id: toInt(r.id),
    kind: r.kind,
    headword: r.headword,
    pos: r.pos ?? null,
    phonetic: r.phonetic ?? null,
    meanings: parseJson<string[]>(r.meanings, []),
    collocations: parseJson<string[]>(r.collocations, []),
    examples: parseJson<any[]>(r.examples, []),
    extra: r.extra ?? null,
    acceptedZh: parseJson<string[]>(r.accepted_zh, []),
    learnedAt: r.learned_at ?? null,
    createdAt: r.created_at,
    noteIds: [id],
    directions: itemDirections(toInt(r.id))
  }))

  return {
    ...mapSummary(row),
    rawMarkdown: row.raw_markdown,
    sourceName: row.source_name ?? null,
    items
  }
}

/** 库 id 来自主进程内部或 IPC：不认识的 id 一律退回默认库 */
function resolveDeckId(deckId?: number | null): number {
  if (deckId === null || deckId === undefined) return defaultDeckId()
  const id = toInt(deckId)
  return deckExists(id) ? id : defaultDeckId()
}

export function createNote(
  input: NoteInput & { sourceId?: number | null; status?: string }
): number {
  const d = getDb()
  const now = localIso()
  const res = d
    .prepare(
      `INSERT INTO notes (source_id, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sourceId ?? null,
      resolveDeckId(input.deckId),
      input.title.trim() || '未命名笔记',
      input.noteDate ?? null,
      JSON.stringify(input.tags ?? []),
      input.rawMarkdown ?? '',
      input.status ?? 'validated',
      now,
      now
    )
  return toInt(res.lastInsertRowid)
}

export function updateNote(
  id: number,
  patch: Partial<NoteInput> & { status?: string; sourceId?: number | null }
): void {
  const d = getDb()
  const current = d.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
  if (!current) throw new Error('笔记不存在')
  // 单选移动：词条与卡片不动，只改归属
  const deckId =
    patch.deckId === undefined ? toInt(current.deck_id) : resolveDeckId(patch.deckId)
  d.prepare(
    `UPDATE notes SET title = ?, note_date = ?, tags = ?, raw_markdown = ?, status = ?, deck_id = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.title?.trim() || current.title,
    patch.noteDate === undefined ? current.note_date : patch.noteDate,
    JSON.stringify(patch.tags ?? parseJson<string[]>(current.tags, [])),
    patch.rawMarkdown ?? current.raw_markdown,
    patch.status ?? current.status,
    deckId,
    localIso(),
    id
  )
}

/** 批量操作一次最多处理这么多份：防止 3500 份全选把界面和主进程拖死 */
export const MAX_BATCH = 500

function normalizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const raw of ids) {
    const id = toInt(raw)
    if (id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_BATCH) break
  }
  return out
}

function existingNoteIds(ids: number[]): number[] {
  if (!ids.length) return []
  const rows = getDb()
    .prepare(`SELECT id FROM notes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as { id: number }[]
  const set = new Set(rows.map((r) => toInt(r.id)))
  return ids.filter((id) => set.has(id))
}

/**
 * 批量移动：只改 deck_id；目标库的待学数会立刻变化（PLAN-DECKS §6.1）。
 * 不做撤销：操作本身可重复（再移回去即可），单步撤销只会多一套要维护的状态。
 */
export function moveNotes(ids: unknown, deckId: number): { moved: number } {
  const list = normalizeIds(ids)
  if (!list.length) return { moved: 0 }
  const target = toInt(deckId)
  if (!deckExists(target)) throw new Error('目标库不存在')
  return tx(() => {
    const d = getDb()
    const existing = existingNoteIds(list)
    // 已在目标库的笔记不算移动：UI 会禁用，这里也返回 0
    const rows = existing.length
      ? (d
          .prepare(
            `SELECT id FROM notes WHERE deck_id <> ? AND id IN (${existing.map(() => '?').join(',')})`
          )
          .all(target, ...existing) as unknown as { id: number }[])
      : []
    const now = localIso()
    const stmt = d.prepare('UPDATE notes SET deck_id = ?, updated_at = ? WHERE id = ?')
    let moved = 0
    for (const row of rows) {
      moved += Number(stmt.run(target, now, toInt(row.id)).changes ?? 0)
    }
    return { moved }
  })
}

/** 批量复制：复制笔记行 + 词条关联，不复制词条本身（进度只有一份，§6.2） */
export function copyNotes(ids: unknown, deckId: number): { copied: number; noteIds: number[] } {
  const list = normalizeIds(ids)
  if (!list.length) return { copied: 0, noteIds: [] }
  const target = toInt(deckId)
  if (!deckExists(target)) throw new Error('目标库不存在')
  return tx(() => {
    const d = getDb()
    const now = localIso()
    const insert = d.prepare(
      `INSERT INTO notes (source_id, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       SELECT source_id, ?, title, note_date, tags, raw_markdown, status, ?, ? FROM notes WHERE id = ?`
    )
    const link = d.prepare(
      `INSERT INTO note_items (note_id, item_id, raw_line, position)
       SELECT ?, item_id, raw_line, position FROM note_items WHERE note_id = ?`
    )
    const noteIds: number[] = []
    for (const id of existingNoteIds(list)) {
      const res = insert.run(target, now, now, id)
      const noteId = toInt(res.lastInsertRowid)
      link.run(noteId, id)
      noteIds.push(noteId)
    }
    return { copied: noteIds.length, noteIds }
  })
}

/** 批量删除：与 deleteNote 同语义，一次事务；只在词不再被引用时删词条（§6.3） */
export function deleteNotes(ids: unknown): { removed: number } {
  const list = normalizeIds(ids)
  if (!list.length) return { removed: 0 }
  return tx(() => {
    const d = getDb()
    const stmt = d.prepare('DELETE FROM notes WHERE id = ?')
    let removed = 0
    for (const id of list) removed += Number(stmt.run(id).changes ?? 0)
    // 清掉不再被任何笔记引用的词条，卡片会级联删除，避免词库留下孤儿
    d.prepare('DELETE FROM items WHERE id NOT IN (SELECT item_id FROM note_items)').run()
    return { removed }
  })
}

export function deleteNote(id: number): void {
  deleteNotes([id])
}

export function countNotes(deckId?: number | null): number {
  const row =
    deckId === null || deckId === undefined
      ? (getDb().prepare('SELECT COUNT(*) AS c FROM notes').get() as { c?: number })
      : (getDb().prepare('SELECT COUNT(*) AS c FROM notes WHERE deck_id = ?').get(toInt(deckId)) as {
          c?: number
        })
  return toInt(row?.c)
}

export function createSource(input: {
  kind: string
  originalName: string
  storedPath?: string | null
  sha256?: string | null
  rawText?: string | null
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO sources (kind, original_name, stored_path, sha256, raw_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.kind,
      input.originalName,
      input.storedPath ?? null,
      input.sha256 ?? null,
      input.rawText ?? null,
      localIso()
    )
  return toInt(res.lastInsertRowid)
}
