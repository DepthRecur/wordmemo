import type { NoteDetail, NoteInput, NoteQuery, NoteSummary } from '@shared/types'
import { getDb, localIso, parseJson, toInt } from './connection'
import { itemDirections } from './items'

interface NoteRow {
  id: number
  source_id: number | null
  title: string
  note_date: string | null
  tags: string
  raw_markdown: string
  status: string
  created_at: string
  updated_at: string
  source_name?: string | null
  source_kind?: string | null
}

interface SummaryRow extends NoteRow {
  item_count: number
  due_count: number
  issue_count: number
}

const SUMMARY_SELECT = `
SELECT n.*,
  (SELECT COUNT(*) FROM note_items ni WHERE ni.note_id = n.id) AS item_count,
  (SELECT COUNT(*) FROM note_items ni JOIN cards c ON c.item_id = ni.item_id
     WHERE ni.note_id = n.id AND c.suspended = 0 AND c.due_at <= ?) AS due_count,
  (SELECT COUNT(*) FROM validation_issues vi WHERE vi.note_id = n.id AND vi.resolved = 0) AS issue_count,
  s.original_name AS source_name,
  s.kind AS source_kind
FROM notes n
LEFT JOIN sources s ON s.id = n.source_id
`

function mapSummary(row: SummaryRow): NoteSummary {
  return {
    id: toInt(row.id),
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

export function createNote(
  input: NoteInput & { sourceId?: number | null; status?: string }
): number {
  const d = getDb()
  const now = localIso()
  const res = d
    .prepare(
      `INSERT INTO notes (source_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sourceId ?? null,
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
  d.prepare(
    `UPDATE notes SET title = ?, note_date = ?, tags = ?, raw_markdown = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.title?.trim() || current.title,
    patch.noteDate === undefined ? current.note_date : patch.noteDate,
    JSON.stringify(patch.tags ?? parseJson<string[]>(current.tags, [])),
    patch.rawMarkdown ?? current.raw_markdown,
    patch.status ?? current.status,
    localIso(),
    id
  )
}

export function deleteNote(id: number): void {
  const d = getDb()
  d.prepare('DELETE FROM notes WHERE id = ?').run(id)
  // 清掉不再被任何笔记引用的词条，卡片会级联删除，避免词库留下孤儿
  d.prepare('DELETE FROM items WHERE id NOT IN (SELECT item_id FROM note_items)').run()
}

export function countNotes(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM notes').get() as { c?: number }
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
