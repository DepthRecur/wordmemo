import type { Exam, ExamInput, ExamScope } from '@shared/types'
import { getDb, localIso, parseJson, toInt, toNum } from './connection'
import { deckUid, examUid, itemUid, noteUid, withSync } from './sync'
import { newUid } from './uid'

interface ExamRow {
  id: number
  uid: string | null
  title: string
  exam_date: string
  scope: string
  level: string
  target_retention: number
  daily_minutes: number
  status: string
  created_at: string
}

function mapExam(row: ExamRow): Exam {
  return {
    id: toInt(row.id),
    title: row.title,
    examDate: row.exam_date,
    scope: parseJson<ExamScope>(row.scope, {}),
    level: (row.level as Exam['level']) ?? 'dictate',
    targetRetention: toNum(row.target_retention, 0.95),
    dailyMinutes: toInt(row.daily_minutes, 20),
    status: (row.status as Exam['status']) ?? 'active',
    createdAt: row.created_at
  }
}

export function listExams(): Exam[] {
  const rows = getDb()
    .prepare(`SELECT * FROM exams ORDER BY (status = 'active') DESC, exam_date ASC`)
    .all() as unknown as ExamRow[]
  return rows.map(mapExam)
}

export function getExam(id: number): Exam | null {
  const row = getDb().prepare('SELECT * FROM exams WHERE id = ?').get(id) as ExamRow | undefined
  return row ? mapExam(row) : null
}

/**
 * 考试范围的同步形态：`scope.deckId` / `noteIds` / `itemIds` 都是**本机整数 id**，
 * 不能出网（A-06：以前只换了 deckId，另外两个原样发出去，另一台就指向它自己的无关笔记）。
 * 落在本机的字段仍然用本机 id（查询路径不变）。
 */
export function scopeForSync(scope: ExamScope): Record<string, unknown> {
  const { deckId, noteIds, itemIds, ...rest } = scope
  const out: Record<string, unknown> = { ...rest }
  if (deckId !== undefined) out.deck_uid = deckUid(deckId)
  const noteUids = (noteIds ?? []).map((id) => noteUid(id)).filter((uid): uid is string => !!uid)
  if (noteUids.length) out.note_uids = noteUids
  const itemUids = (itemIds ?? []).map((id) => itemUid(id)).filter((uid): uid is string => !!uid)
  if (itemUids.length) out.item_uids = itemUids
  return out
}

export function createExam(input: ExamInput): number {
  const title = input.title.trim() || '英语听写'
  const uid = newUid()
  const createdAt = localIso()
  return withSync(
    {
      entity: 'exam',
      uid,
      fields: {
        title,
        exam_date: input.examDate,
        scope: scopeForSync(input.scope ?? {}),
        level: input.level,
        target_retention: input.targetRetention,
        daily_minutes: input.dailyMinutes,
        status: 'active',
        created_at: createdAt
      }
    },
    () => {
      const res = getDb()
        .prepare(
          `INSERT INTO exams (uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(
          uid,
          title,
          input.examDate,
          JSON.stringify(input.scope ?? {}),
          input.level,
          input.targetRetention,
          input.dailyMinutes,
          createdAt
        )
      return toInt(res.lastInsertRowid)
    }
  )
}

export function updateExam(id: number, patch: Partial<ExamInput> & { status?: string }): void {
  const current = getExam(id)
  if (!current) throw new Error('考试不存在')
  const row = getDb().prepare('SELECT uid FROM exams WHERE id = ?').get(id) as {
    uid?: string | null
  }
  const next = {
    title: patch.title ?? current.title,
    examDate: patch.examDate ?? current.examDate,
    scope: patch.scope ?? current.scope,
    level: patch.level ?? current.level,
    targetRetention: patch.targetRetention ?? current.targetRetention,
    dailyMinutes: patch.dailyMinutes ?? current.dailyMinutes,
    status: patch.status ?? current.status
  }
  // 只记真正变了的字段（同 notes/items）
  const fields: Record<string, unknown> = {}
  if (next.title !== current.title) fields.title = next.title
  if (next.examDate !== current.examDate) fields.exam_date = next.examDate
  const nextScope = scopeForSync(next.scope)
  if (JSON.stringify(nextScope) !== JSON.stringify(scopeForSync(current.scope))) {
    fields.scope = nextScope
  }
  if (next.level !== current.level) fields.level = next.level
  if (next.targetRetention !== current.targetRetention) {
    fields.target_retention = next.targetRetention
  }
  if (next.dailyMinutes !== current.dailyMinutes) fields.daily_minutes = next.dailyMinutes
  if (next.status !== current.status) fields.status = next.status
  withSync({ entity: 'exam', uid: row?.uid ?? '', fields }, () => {
    getDb()
      .prepare(
        `UPDATE exams SET title = ?, exam_date = ?, scope = ?, level = ?, target_retention = ?, daily_minutes = ?, status = ? WHERE id = ?`
      )
      .run(
        next.title,
        next.examDate,
        JSON.stringify(next.scope),
        next.level,
        next.targetRetention,
        next.dailyMinutes,
        next.status,
        id
      )
  })
}

export function deleteExam(id: number): void {
  const uid = examUid(id)
  withSync({ entity: 'exam', uid: uid ?? '', op: 'delete' }, () => {
    getDb().prepare('DELETE FROM exams WHERE id = ?').run(id)
  })
}
