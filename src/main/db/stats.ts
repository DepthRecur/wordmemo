import type { DashboardStats, HeatmapPoint, ForecastPoint } from '@shared/types'
import { addDays, dateKey } from '@shared/normalize'
import { getDb, localIso, parseJson, toInt, toNum } from './connection'
import { countUnlearned, learnedTodayCount } from './items'
import { deckNewPerDay, deckScope } from './decks'
import { monthAiCost, monthAiUsageByProvider } from './ai'
import { PROVIDERS, isProviderId } from '../ai/providers'
import { getSettings } from '../settings'

function count(sql: string, params: any[] = []): number {
  const row = getDb().prepare(sql).get(...params) as { c?: number } | undefined
  return toInt(row?.c)
}

function streakDays(): number {
  const rows = getDb()
    .prepare(`SELECT DISTINCT substr(reviewed_at, 1, 10) AS d FROM reviews ORDER BY d DESC LIMIT 400`)
    .all() as { d: string }[]
  if (!rows.length) return 0
  const set = new Set(rows.map((r) => r.d))
  let cursor = dateKey()
  if (!set.has(cursor)) {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    cursor = dateKey(yesterday)
    if (!set.has(cursor)) return 0
  }
  let streak = 0
  while (set.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

/**
 * 统计：deckId 只影响「数量类」指标（词条数、笔记数、今天到期、新词、难词、到期预测）。
 * 热力图、连续天数、正确率、AI 花费始终跨库——它们记在 reviews / ai_usage 上，没有库维度。
 */
export function dashboardStats(deckId?: number | null): DashboardStats {
  const d = getDb()
  const now = localIso()
  const today = dateKey()
  const settings = getSettings()
  const allDecks = deckId === null || deckId === undefined

  const itemScope = deckScope('i.id', deckId)
  const cardScope = deckScope('c.item_id', deckId)

  const totalItems = count(`SELECT COUNT(*) AS c FROM items i WHERE 1 = 1${itemScope.clause}`, itemScope.params)
  const totalNotes = count(
    allDecks ? 'SELECT COUNT(*) AS c FROM notes' : 'SELECT COUNT(*) AS c FROM notes WHERE deck_id = ?',
    allDecks ? [] : [toInt(deckId)]
  )
  const totalReviews = count(
    `SELECT COUNT(*) AS c FROM reviews r JOIN cards c ON c.id = r.card_id WHERE 1 = 1${cardScope.clause}`,
    cardScope.params
  )
  const learnAhead = Math.max(0, Number(settings.learnAheadMinutes ?? 20))
  const learnCutoff = localIso(new Date(Date.now() + learnAhead * 60_000))
  const dueToday = count(
    `SELECT COUNT(DISTINCT c.item_id) AS c FROM cards c
     WHERE c.suspended = 0
       AND IFNULL(c.buried_until, '') < ?
       AND (
         c.needs_check = 1
         OR (c.state = 2 AND c.due_at <= ?)
         OR (c.state IN (1, 3) AND c.due_at <= ?)
       )${cardScope.clause}`,
    [today, now, learnCutoff, ...cardScope.params]
  )
  const introduced = learnedTodayCount(deckId)
  const unlearned = countUnlearned(deckId)
  const newToday = Math.min(Math.max(0, deckNewPerDay(deckId) - introduced), unlearned)
  const reviewedToday = count(
    `SELECT COUNT(*) AS c FROM reviews r JOIN cards c ON c.id = r.card_id
     WHERE substr(r.reviewed_at, 1, 10) = ?${cardScope.clause}`,
    [today, ...cardScope.params]
  )

  const retentionRow = d
    .prepare(
      `SELECT AVG(correct) AS r, COUNT(*) AS c FROM reviews
       WHERE correct IS NOT NULL AND reviewed_at >= ?`
    )
    .get(localIso(new Date(Date.now() - 30 * 86400000))) as { r?: number; c?: number } | undefined
  const retention30d = retentionRow && toInt(retentionRow.c) > 0 ? toNum(retentionRow.r) : null

  const forecast: ForecastPoint[] = []
  const forecastRows = d
    .prepare(
      `SELECT substr(c.due_at, 1, 10) AS day, COUNT(*) AS c FROM cards c
       WHERE c.suspended = 0 AND c.state > 0 AND c.due_at >= ? AND c.due_at < ?${cardScope.clause}
       GROUP BY day`
    )
    .all(now, localIso(new Date(Date.now() + 30 * 86400000)), ...cardScope.params) as {
    day: string
    c: number
  }[]
  const forecastMap = new Map(forecastRows.map((r) => [r.day, toInt(r.c)]))
  for (let i = 0; i < 30; i++) {
    const day = addDays(today, i)
    forecast.push({ date: day, count: forecastMap.get(day) ?? 0 })
  }

  const heatmap: HeatmapPoint[] = []
  // 从 11 周前的周一开始，保证每一列固定是周一到周日，和左侧星期标签对齐
  const todayWeekday = (new Date(`${today}T00:00:00`).getDay() + 6) % 7 // 周一 = 0
  const heatStart = addDays(today, -(11 * 7 + todayWeekday))
  const heatRows = d
    .prepare(
      `SELECT substr(reviewed_at, 1, 10) AS day, COUNT(*) AS c FROM reviews
       WHERE reviewed_at >= ? GROUP BY day`
    )
    .all(heatStart) as { day: string; c: number }[]
  const heatMap = new Map(heatRows.map((r) => [r.day, toInt(r.c)]))
  for (let i = 0; i < 84; i++) {
    const day = addDays(heatStart, i)
    heatmap.push({ date: day, count: heatMap.get(day) ?? 0 })
  }

  const difficultRows = d
    .prepare(
      `SELECT i.id, i.headword, i.meanings, MAX(c.lapses) AS lapses
       FROM cards c JOIN items i ON i.id = c.item_id
       WHERE c.lapses > 0${cardScope.clause}
       GROUP BY i.id
       ORDER BY lapses DESC
       LIMIT 6`
    )
    .all(...cardScope.params) as { id: number; headword: string; meanings: string; lapses: number }[]

  const ai = monthAiCost()
  const byProvider = monthAiUsageByProvider().map((row) => ({
    ...row,
    label: isProviderId(row.provider) ? PROVIDERS[row.provider].label : row.provider
  }))

  return {
    dueToday,
    newToday,
    reviewedToday,
    streak: streakDays(),
    totalItems,
    totalNotes,
    totalReviews,
    retention30d,
    forecast,
    heatmap,
    difficult: difficultRows.map((r) => ({
      id: toInt(r.id),
      headword: r.headword,
      meanings: parseJson<string[]>(r.meanings, []),
      lapses: toInt(r.lapses)
    })),
    aiCostMonth: ai.cost,
    aiCallsMonth: ai.calls,
    aiByProvider: byProvider,
    aiUnpricedCalls: ai.unpricedCalls
  }
}
