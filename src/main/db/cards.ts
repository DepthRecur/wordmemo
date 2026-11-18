import type { Card, CardDirection, DailyPlan, QueueCard, ReviewMode, SubmitReview } from '@shared/types'
import { getDb, localIso, parseJson, toInt, toNum } from './connection'
import { getItem, addAcceptedZh, learnQueue, learnedTodayCount } from './items'
import { getSettings } from '../settings'
import { retrievabilityNow, reviewSnapshot } from '../fsrs'

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

export function mapCard(row: CardRow): Card {
  return {
    id: toInt(row.id),
    itemId: toInt(row.item_id),
    direction: row.direction as CardDirection,
    dueAt: row.due_at,
    stability: row.stability === null ? null : toNum(row.stability),
    difficulty: row.difficulty === null ? null : toNum(row.difficulty),
    reps: toInt(row.reps),
    lapses: toInt(row.lapses),
    state: toInt(row.state),
    suspended: toInt(row.suspended) === 1,
    lastReview: row.last_review,
    learnMark: toInt(row.learn_mark)
  }
}

export function getCardRow(id: number): CardRow | null {
  const row = getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  return row ?? null
}

export function toQueueCard(card: Card, isNew = false, examId?: number): QueueCard | null {
  const item = getItem(card.itemId)
  if (!item) return null
  return { ...card, item, isNew, examId }
}

export function dueQueue(limit = 200): QueueCard[] {
  const d = getDb()
  const settings = getSettings()
  const now = localIso()
  const today = now.slice(0, 10)
  const learnAhead = Math.max(0, Number(settings.learnAheadMinutes ?? 20))
  const learnCutoff = localIso(new Date(Date.now() + learnAhead * 60_000))
  const rows = d
    .prepare(
      `SELECT * FROM cards
       WHERE suspended = 0
         AND IFNULL(buried_until, '') < ?
         AND (
           needs_check = 1
           OR (state = 2 AND due_at <= ?)
           OR (state IN (1, 3) AND due_at <= ?)
         )
       LIMIT ?`
    )
    .all(today, now, learnCutoff, limit) as unknown as CardRow[]

  // 参考 Anki/Word_Memorizer：先出未检测的新卡，再按“预测遗忘概率”从高到低排
  rows.sort((a, b) => {
    const an = toInt(a.needs_check)
    const bn = toInt(b.needs_check)
    if (an !== bn) return bn - an
    if (an && a.learn_mark !== b.learn_mark) return toInt(a.learn_mark) - toInt(b.learn_mark)
    const ar = an ? 0 : retrievabilityNow(a.fsrs_json)
    const br = bn ? 0 : retrievabilityNow(b.fsrs_json)
    if (Math.abs(ar - br) > 0.001) return ar - br
    return a.due_at.localeCompare(b.due_at)
  })

  const out: QueueCard[] = []
  for (const row of rows) {
    const q = toQueueCard(mapCard(row), false)
    if (q) out.push(q)
  }
  return out
}

/**
 * Anki 的「同笔记卡片 bury」思路：同一个词条一次只出一道方向题。
 * 同音的另外两张卡仍然保留在库里，下次会话再随机抽。
 */
export function oneCardPerItem<T extends { itemId: number }>(
  cards: T[],
  random: () => number = Math.random
): T[] {
  const groups = new Map<number, T[]>()
  for (const card of cards) {
    const list = groups.get(card.itemId)
    if (list) list.push(card)
    else groups.set(card.itemId, [card])
  }
  const out: T[] = []
  for (const list of groups.values()) {
    out.push(list[Math.floor(random() * list.length)])
  }
  return out
}

/** 今日任务：先学新词，再复习到期/学习中的卡（每个词只抽一个方向） */
export function dailyPlan(): DailyPlan {
  const settings = getSettings()
  const learnedToday = learnedTodayCount()
  const quota = Math.max(0, settings.newPerDay - learnedToday)
  const learnItems = learnQueue(quota)
  const reviewCards = oneCardPerItem(dueQueue())
  return {
    learnItems,
    reviewCards,
    dueCount: reviewCards.length,
    learnedToday,
    learnQuota: quota
  }
}

/**
 * 用户在学习阶段看过一个词条后调用：
 * 记下 learned_at，并让它的每张卡进入 FSRS 的学习步骤，
 * 之后复习阶段会立刻用这些卡来测。
 */
export function markItemLearned(itemId: number, known: boolean): void {
  const d = getDb()
  const row = d.prepare('SELECT learned_at FROM items WHERE id = ?').get(itemId) as
    | { learned_at?: string | null }
    | undefined
  if (!row || row.learned_at) return

  d.prepare('UPDATE items SET learned_at = ? WHERE id = ?').run(localIso(), itemId)
  d.prepare('UPDATE cards SET needs_check = 1, learn_mark = ? WHERE item_id = ? AND suspended = 0').run(
    known ? 1 : 0,
    itemId
  )
}

export function cardsInScope(scope: {
  noteIds?: number[]
  tags?: string[]
  itemIds?: number[]
}): Card[] {
  const d = getDb()
  const clauses: string[] = ['c.suspended = 0', "IFNULL(c.buried_until, '') < ?"]
  const params: any[] = [localIso().slice(0, 10)]

  if (scope.itemIds?.length) {
    clauses.push(`c.item_id IN (${scope.itemIds.map(() => '?').join(',')})`)
    params.push(...scope.itemIds)
  }
  if (scope.noteIds?.length) {
    clauses.push(
      `c.item_id IN (SELECT item_id FROM note_items WHERE note_id IN (${scope.noteIds
        .map(() => '?')
        .join(',')}))`
    )
    params.push(...scope.noteIds)
  }
  if (scope.tags?.length) {
    const tagClauses = scope.tags.map(() => `n.tags LIKE ?`)
    clauses.push(
      `c.item_id IN (SELECT ni.item_id FROM note_items ni JOIN notes n ON n.id = ni.note_id WHERE ${tagClauses.join(
        ' OR '
      )})`
    )
    params.push(...scope.tags.map((t) => `%${t}%`))
  }

  const rows = d
    .prepare(`SELECT c.* FROM cards c WHERE ${clauses.join(' AND ')}`)
    .all(...params) as unknown as CardRow[]
  return rows.map(mapCard)
}

export interface ReviewOutcome {
  dueAt: string
  state: number
}

export function applyReview(input: SubmitReview): ReviewOutcome {
  const row = getCardRow(input.cardId)
  if (!row) throw new Error('卡片不存在')
  const updated = reviewSnapshot(row.fsrs_json, input.rating, new Date())
  const d = getDb()
  d.prepare(
    `UPDATE cards SET due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ?, needs_check = 0, fsrs_json = ?
     WHERE id = ?`
  ).run(
    updated.dueAt,
    updated.stability,
    updated.difficulty,
    updated.reps,
    updated.lapses,
    updated.state,
    localIso(),
    updated.fsrsJson,
    input.cardId
  )
  // Anki 的 sibling bury：一个词条的一张卡复习后，其他方向今天不再出现
  const today = localIso().slice(0, 10)
  d.prepare(
    `UPDATE cards SET buried_until = ? WHERE item_id = ? AND id <> ? AND suspended = 0`
  ).run(today, toInt(row.item_id), input.cardId)
  d.prepare(
    `INSERT INTO reviews (card_id, reviewed_at, rating, answer, correct, elapsed_ms, mode, judge_by, exam_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.cardId,
    localIso(),
    input.rating,
    input.answer ?? '',
    input.correct ? 1 : 0,
    Math.round(input.elapsedMs ?? 0),
    input.mode,
    input.judgeBy,
    input.examId ?? null
  )

  if (input.correct && input.judgeBy === 'ai' && input.answer.trim()) {
    addAcceptedZh(toInt(row.item_id), input.answer.trim())
  }

  return { dueAt: updated.dueAt, state: updated.state }
}

export function countDue(): number {
  const settings = getSettings()
  const now = localIso()
  const today = now.slice(0, 10)
  const learnAhead = Math.max(0, Number(settings.learnAheadMinutes ?? 20))
  const learnCutoff = localIso(new Date(Date.now() + learnAhead * 60_000))
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT item_id) AS c FROM cards
       WHERE suspended = 0
         AND IFNULL(buried_until, '') < ?
         AND (
           needs_check = 1
           OR (state = 2 AND due_at <= ?)
           OR (state IN (1, 3) AND due_at <= ?)
         )`
    )
    .get(today, now, learnCutoff) as { c?: number } | undefined
  return toInt(row?.c)
}
