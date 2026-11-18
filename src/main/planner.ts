import type { Exam, ExamPlan, QueueCard } from '@shared/types'
import { addDays, dateKey, daysBetween } from '@shared/normalize'
import { getExam } from './db/exams'
import { cardsInScope, mapCard, oneCardPerItem, toQueueCard } from './db/cards'
import { projectedRetentionAfterGood, retrievabilityAt } from './fsrs'
import { getDb, toInt } from './db/connection'

const SECONDS_PER_CARD = 14

interface Scored {
  card: ReturnType<typeof mapCard>
  r: number
  after: number
  urgency: number
  weight: number
}

function directionWeight(direction: string): number {
  if (direction === 'zh2en') return 1.15
  if (direction === 'listen2en') return 1.1
  return 1
}

function levelFilter(level: Exam['level'], direction: string): boolean {
  if (level === 'recognize') return direction === 'en2zh'
  if (level === 'dictate') return direction === 'zh2en' || direction === 'listen2en'
  return true
}

function reviewedTodayCount(examId: number, today: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT card_id) AS c FROM reviews
       WHERE exam_id = ? AND substr(reviewed_at, 1, 10) = ?`
    )
    .get(examId, today) as { c?: number } | undefined
  return toInt(row?.c)
}

export function buildExamPlan(examId: number): ExamPlan {
  const exam = getExam(examId)
  if (!exam) throw new Error('考试不存在')

  const today = dateKey()
  const daysLeft = Math.max(0, daysBetween(today, exam.examDate))
  const examEnd = new Date(`${exam.examDate}T23:59:59`)
  const now = new Date()

  const allCards = cardsInScope(exam.scope).filter((c) => levelFilter(exam.level, c.direction))
  const stateRows = getDb().prepare('SELECT id, fsrs_json FROM cards').all() as {
    id: number
    fsrs_json: string
  }[]
  const stateMap = new Map(stateRows.map((r) => [toInt(r.id), r.fsrs_json]))

  const scored: Scored[] = allCards.map((card) => {
    const state = stateMap.get(card.id) ?? ''
    const r = state ? retrievabilityAt(state, examEnd) : 0
    const after = r < exam.targetRetention && state
      ? projectedRetentionAfterGood(state, examEnd, now, 'exam')
      : r
    return {
      card,
      r,
      after,
      urgency: Math.max(0, exam.targetRetention - r),
      weight: directionWeight(card.direction)
    }
  })

  scored.sort((a, b) => {
    const ua = a.urgency * a.weight
    const ub = b.urgency * b.weight
    if (Math.abs(ua - ub) > 1e-6) return ub - ua
    if (a.card.lapses !== b.card.lapses) return b.card.lapses - a.card.lapses
    return a.card.dueAt.localeCompare(b.card.dueAt)
  })

  const needed = scored.filter((s) => s.r < exam.targetRetention)
  const covered = scored.length - needed.length

  const capacityPerDay = Math.max(4, Math.floor((exam.dailyMinutes * 60) / SECONDS_PER_CARD))
  const daysToUse = Math.max(1, daysLeft)
  const quota = Math.min(capacityPerDay, Math.max(1, Math.ceil(needed.length / daysToUse)))

  const doneToday = reviewedTodayCount(examId, today)
  const picked: QueueCard[] = []
  for (const s of needed) {
    if (picked.length >= quota) break
    if (s.card.lastReview && s.card.lastReview.slice(0, 10) === today) continue
    const q = toQueueCard(s.card, s.card.reps === 0, examId)
    if (q) picked.push(q)
  }
  // 同一个词条一次只出一道方向题
  const queue = oneCardPerItem(picked)

  const daily = []
  let remaining = Math.max(0, needed.length - doneToday)
  const horizon = Math.max(1, daysLeft)
  for (let i = 0; i < horizon; i++) {
    const date = addDays(today, i)
    const count = Math.min(capacityPerDay, Math.ceil(remaining / Math.max(1, horizon - i)))
    remaining = Math.max(0, remaining - count)
    daily.push({
      date,
      count: i === 0 ? Math.max(count, doneToday) : count,
      done: i === 0 ? doneToday : 0,
      isToday: i === 0
    })
  }

  const queueSet = new Set(queue.map((q) => q.id))
  const projected =
    scored.length === 0
      ? 1
      : scored.reduce((sum, s) => sum + (queueSet.has(s.card.id) ? s.after : s.r), 0) / scored.length

  const requiredTime = needed.length * SECONDS_PER_CARD
  const availableTime = daysToUse * exam.dailyMinutes * 60
  let warning: string | null = null
  if (daysLeft === 0) {
    warning = '今天就是听写日：只做高频错词和整体速览，不再安排新内容。'
  } else if (requiredTime > availableTime * 1.15) {
    const suggestMinutes = Math.ceil(requiredTime / 60 / daysToUse)
    warning = `按当前预算，预计只有 ${Math.round(projected * 100)}% 的词能在听写日达到目标。建议每天增加到 ${suggestMinutes} 分钟，或缩小考试范围。`
  }

  return {
    exam,
    daysLeft,
    totalCards: scored.length,
    coveredCards: covered,
    todayCount: queue.length,
    todayMinutes: Math.round((queue.length * SECONDS_PER_CARD) / 60),
    projectedRetention: projected,
    daily,
    warning,
    queue
  }
}

/** 统计某次考试范围内的复习量，供统计页使用 */
export function examProgress(examId: number): { done: number; total: number } {
  const exam = getExam(examId)
  if (!exam) return { done: 0, total: 0 }
  const cards = cardsInScope(exam.scope).filter((c) => levelFilter(exam.level, c.direction))
  const row = getDb()
    .prepare('SELECT COUNT(DISTINCT card_id) AS c FROM reviews WHERE exam_id = ?')
    .get(examId) as { c?: number } | undefined
  return { done: toInt(row?.c), total: cards.length }
}
