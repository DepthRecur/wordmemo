import type { SqliteDatabase } from './sqlite'
import { mergePosText, normalizeEn } from '@shared/normalize'

interface ItemRow {
  id: number
  headword: string
  headword_norm: string
  kind: string
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

interface CardRow {
  id: number
  item_id: number
  direction: string
  due_at: string
  stability: number | null
  difficulty: number | null
  reps: number
  lapses: number
  state: number
  last_review: string | null
  suspended: number
  needs_check: number
  learn_mark: number
  buried_until: string | null
  fsrs_json: string
}

function parseArray<T>(raw: string): T[] {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = String(raw ?? '').trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

function mergeExamples(rows: ItemRow[]): { en: string; zh?: string }[] {
  const seen = new Set<string>()
  const out: { en: string; zh?: string }[] = []
  for (const row of rows) {
    for (const example of parseArray<{ en?: string; zh?: string }>(row.examples)) {
      const en = String(example.en ?? '').trim()
      if (!en || seen.has(normalizeEn(en))) continue
      seen.add(normalizeEn(en))
      out.push({ en, zh: example.zh ? String(example.zh).trim() : undefined })
    }
  }
  return out
}

function cardRank(card: CardRow): number {
  return card.reps * 1000 + card.state * 100 + card.needs_check * 10 + (card.last_review ? 1 : 0)
}

function mergeGroup(db: SqliteDatabase, rows: ItemRow[]): void {
  const survivor = [...rows].sort((a, b) => {
    const learned = Number(Boolean(b.learned_at)) - Number(Boolean(a.learned_at))
    if (learned !== 0) return learned
    return a.created_at.localeCompare(b.created_at)
  })[0]
  const duplicates = rows.filter((row) => row.id !== survivor.id)

  const meanings = uniqueStrings(rows.flatMap((row) => parseArray<string>(row.meanings)))
  const collocations = uniqueStrings(rows.flatMap((row) => parseArray<string>(row.collocations)))
  const accepted = uniqueStrings(rows.flatMap((row) => parseArray<string>(row.accepted_zh)))
  const examples = mergeExamples(rows)
  const pos = rows.reduce<string | null>(
    (current, row) => mergePosText(current, row.pos),
    null
  )
  const kind = rows.some((row) => row.kind === 'word') ? 'word' : survivor.kind
  const phonetic = rows.map((row) => row.phonetic?.trim()).find(Boolean) ?? null
  const extra = uniqueStrings(rows.flatMap((row) => (row.extra ?? '').split(/\r?\n/))).join('\n') || null
  const learnedAt = rows.find((row) => row.learned_at)?.learned_at ?? null
  const createdAt = rows.map((row) => row.created_at).sort()[0]

  db.prepare(
    `UPDATE items
     SET pos = ?, kind = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?,
         extra = ?, accepted_zh = ?, learned_at = ?, created_at = ?
     WHERE id = ?`
  ).run(
    pos,
    kind,
    phonetic,
    JSON.stringify(meanings),
    JSON.stringify(collocations),
    JSON.stringify(examples),
    extra,
    JSON.stringify(accepted),
    learnedAt,
    createdAt,
    survivor.id
  )

  for (const duplicate of duplicates) {
    // 笔记关联：能迁移的迁移，主键冲突的旧关联直接丢弃
    db.prepare('UPDATE OR IGNORE note_items SET item_id = ? WHERE item_id = ?').run(
      survivor.id,
      duplicate.id
    )
    db.prepare('DELETE FROM note_items WHERE item_id = ?').run(duplicate.id)

    const cards = db.prepare('SELECT * FROM cards WHERE item_id = ?').all(duplicate.id) as unknown as CardRow[]
    for (const card of cards) {
      const existing = db
        .prepare('SELECT * FROM cards WHERE item_id = ? AND direction = ?')
        .get(survivor.id, card.direction) as CardRow | undefined
      if (!existing) {
        db.prepare('UPDATE cards SET item_id = ? WHERE id = ?').run(survivor.id, card.id)
        continue
      }

      // 同一方向的两张卡：保留进度更多的那张，复习日志也迁到保留卡
      db.prepare('UPDATE reviews SET card_id = ? WHERE card_id = ?').run(existing.id, card.id)
      if (cardRank(card) > cardRank(existing)) {
        db.prepare(
          `UPDATE cards
           SET due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?,
               last_review = ?, suspended = ?, needs_check = ?, learn_mark = ?, buried_until = ?, fsrs_json = ?
           WHERE id = ?`
        ).run(
          card.due_at,
          card.stability,
          card.difficulty,
          card.reps,
          card.lapses,
          card.state,
          card.last_review,
          card.suspended,
          card.needs_check,
          card.learn_mark,
          card.buried_until,
          card.fsrs_json,
          existing.id
        )
      }
      db.prepare('DELETE FROM cards WHERE id = ?').run(card.id)
    }

    db.prepare('DELETE FROM items WHERE id = ?').run(duplicate.id)
  }
}

/**
 * 把 headword_norm 相同的词条合并成一个。
 * 之前唯一键包含 pos/kind，resemble 这种“word/phrase 被识别成不同类型”的词会重复建条。
 */
export function dedupeItems(db: SqliteDatabase): void {
  const groups = db
    .prepare(
      `SELECT headword_norm FROM items
       GROUP BY headword_norm HAVING COUNT(*) > 1`
    )
    .all() as unknown as { headword_norm: string }[]
  if (!groups.length) return

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const group of groups) {
      const rows = db
        .prepare('SELECT * FROM items WHERE headword_norm = ?')
        .all(group.headword_norm) as unknown as ItemRow[]
      if (rows.length > 1) mergeGroup(db, rows)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw error
  }
}
