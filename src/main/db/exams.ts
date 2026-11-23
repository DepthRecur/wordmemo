import type { Exam, ExamInput, ExamScope } from '@shared/types'
import { getDb, localIso, parseJson, toInt, toNum } from './connection'
import { newUid } from './uid'

interface ExamRow {
  id: number
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

export function createExam(input: ExamInput): number {
  const res = getDb()
    .prepare(
      `INSERT INTO exams (uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      newUid(),
      input.title.trim() || '英语听写',
      input.examDate,
      JSON.stringify(input.scope ?? {}),
      input.level,
      input.targetRetention,
      input.dailyMinutes,
      localIso()
    )
  return toInt(res.lastInsertRowid)
}

export function updateExam(id: number, patch: Partial<ExamInput> & { status?: string }): void {
  const current = getExam(id)
  if (!current) throw new Error('考试不存在')
  getDb()
    .prepare(
      `UPDATE exams SET title = ?, exam_date = ?, scope = ?, level = ?, target_retention = ?, daily_minutes = ?, status = ? WHERE id = ?`
    )
    .run(
      patch.title ?? current.title,
      patch.examDate ?? current.examDate,
      JSON.stringify(patch.scope ?? current.scope),
      patch.level ?? current.level,
      patch.targetRetention ?? current.targetRetention,
      patch.dailyMinutes ?? current.dailyMinutes,
      patch.status ?? current.status,
      id
    )
}

export function deleteExam(id: number): void {
  getDb().prepare('DELETE FROM exams WHERE id = ?').run(id)
}
