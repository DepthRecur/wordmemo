import type { DashboardStats, HeatmapPoint, ForecastPoint } from '@shared/types'
import { addDays, dateKey } from '@shared/normalize'
import { getDb, localIso, parseJson, toInt, toNum } from './connection'
import { countUnlearned, learnedTodayCount } from './items'
import { monthAiCost } from './ai'
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

export function dashboardStats(): DashboardStats {
  const d = getDb()
  const now = localIso()
  const today = dateKey()
  const settings = getSettings()

  const totalItems = count('SELECT COUNT(*) AS c FROM items')
  const totalNotes = count('SELECT COUNT(*) AS c FROM notes')
  const totalReviews = count('SELECT COUNT(*) AS c FROM reviews')
  const learnAhead = Math.max(0, Number(settings.learnAheadMinutes ?? 20))
  const learnCutoff = localIso(new Date(Date.now() + learnAhead * 60_000))
  const dueToday = count(
    `SELECT COUNT(DISTINCT item_id) AS c FROM cards
     WHERE suspended = 0
       AND IFNULL(buried_until, '') < ?
       AND (
         needs_check = 1
         OR (state = 2 AND due_at <= ?)
         OR (state IN (1, 3) AND due_at <= ?)
       )`,
    [today, now, learnCutoff]
  )
  const introduced = learnedTodayCount()
  const unlearned = countUnlearned()
  const newToday = Math.min(Math.max(0, settings.newPerDay - introduced), unlearned)
  const reviewedToday = count('SELECT COUNT(*) AS c FROM reviews WHERE substr(reviewed_at, 1, 10) = ?', [
    today
  ])

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
      `SELECT substr(due_at, 1, 10) AS day, COUNT(*) AS c FROM cards
       WHERE suspended = 0 AND state > 0 AND due_at >= ? AND due_at < ?
       GROUP BY day`
    )
    .all(now, localIso(new Date(Date.now() + 30 * 86400000))) as { day: string; c: number }[]
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
       WHERE c.lapses > 0
       GROUP BY i.id
       ORDER BY lapses DESC
       LIMIT 6`
    )
    .all() as { id: number; headword: string; meanings: string; lapses: number }[]

  const ai = monthAiCost()

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
    aiCallsMonth: ai.calls
  }
}
