import { getDb, localIso } from './connection'

/**
 * 缓存的键带 provider：A 家的答案不能被当成 B 家的。
 * P0 只有 DeepSeek 带货，但读写都已经按 provider 分区。
 * 注意唯一键仍是 (kind, cache_key)，P1 才会换成 (provider, kind, cache_key)。
 */
export function getAiCache(provider: string, kind: string, key: string): string | null {
  const row = getDb()
    .prepare(
      'SELECT response_json FROM ai_cache WHERE provider = ? AND kind = ? AND cache_key = ?'
    )
    .get(provider, kind, key) as { response_json?: string } | undefined
  return row?.response_json ?? null
}

export function setAiCache(
  provider: string,
  kind: string,
  key: string,
  model: string,
  response: string
): void {
  getDb()
    .prepare(
      `INSERT INTO ai_cache (provider, kind, cache_key, model, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, cache_key) DO UPDATE SET
         provider = excluded.provider,
         model = excluded.model,
         response_json = excluded.response_json`
    )
    .run(provider, kind, key, model, response, localIso())
}

export interface UsageRecord {
  provider: string
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
      `INSERT INTO ai_usage (provider, at, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.provider,
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
