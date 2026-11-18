import { getDb, localIso } from './connection'

export function getAiCache(kind: string, key: string): string | null {
  const row = getDb()
    .prepare('SELECT response_json FROM ai_cache WHERE kind = ? AND cache_key = ?')
    .get(kind, key) as { response_json?: string } | undefined
  return row?.response_json ?? null
}

export function setAiCache(kind: string, key: string, model: string, response: string): void {
  getDb()
    .prepare(
      `INSERT INTO ai_cache (kind, cache_key, model, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, cache_key) DO UPDATE SET response_json = excluded.response_json`
    )
    .run(kind, key, model, response, localIso())
}

export interface UsageRecord {
  kind: string
  model: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  costUsd: number
}

export function logAiUsage(u: UsageRecord): void {
  getDb()
    .prepare(
      `INSERT INTO ai_usage (at, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      localIso(),
      u.kind,
      u.model,
      Math.round(u.promptTokens),
      Math.round(u.cachedTokens),
      Math.round(u.completionTokens),
      u.costUsd
    )
}

export function monthAiCost(): { cost: number; calls: number } {
  const month = localIso().slice(0, 7)
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls
       FROM ai_usage WHERE substr(at, 1, 7) = ?`
    )
    .get(month) as { cost?: number; calls?: number } | undefined
  return { cost: Number(row?.cost ?? 0), calls: Number(row?.calls ?? 0) }
}
