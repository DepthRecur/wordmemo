import { getDb, localIso, parseJson } from './connection'

/** 价格来源（PLAN-PROVIDERS §4.2）：厂商自报 / 远程目录 / 随包快照 / 没有 */
export type CostSource = 'provider' | 'catalog' | 'snapshot' | 'none'

/**
 * 缓存的键带 provider：A 家的答案不能被当成 B 家的。
 * 唯一键是 (provider, kind, cache_key)（P2 起；老库在 migrate 里重建过表）。
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
       ON CONFLICT(provider, kind, cache_key) DO UPDATE SET
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
  costSource?: CostSource
  /** 价格数据的日期（YYYY-MM-DD）；没有价格时为空 */
  pricedAt?: string | null
}

export function logAiUsage(u: UsageRecord): void {
  getDb()
    .prepare(
      `INSERT INTO ai_usage (provider, at, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd, cost_source, priced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.provider,
      localIso(),
      u.kind,
      u.model,
      Math.round(u.promptTokens),
      Math.round(u.cachedTokens),
      Math.round(u.completionTokens),
      u.costUsd,
      u.costSource ?? null,
      u.pricedAt ?? null
    )
}

export interface MonthAiCost {
  /** 本月有价格的调用估算金额（美元） */
  cost: number
  calls: number
  /** 本月模型没有价格的调用次数——预算降级成 token 上限时用 */
  unpricedCalls: number
  tokens: number
}

export function monthAiCost(): MonthAiCost {
  const month = localIso().slice(0, 7)
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN cost_source = 'none' THEN 1 ELSE 0 END), 0) AS unpriced,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
       FROM ai_usage WHERE substr(at, 1, 7) = ?`
    )
    .get(month) as
    | { cost?: number; calls?: number; unpriced?: number; tokens?: number }
    | undefined
  return {
    cost: Number(row?.cost ?? 0),
    calls: Number(row?.calls ?? 0),
    unpricedCalls: Number(row?.unpriced ?? 0),
    tokens: Number(row?.tokens ?? 0)
  }
}

/** 按供应商拆用量（统计页用） */
export function monthAiUsageByProvider(): { provider: string; calls: number; cost: number }[] {
  const month = localIso().slice(0, 7)
  const rows = getDb()
    .prepare(
      `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost
       FROM ai_usage WHERE substr(at, 1, 7) = ?
       GROUP BY provider ORDER BY cost DESC, calls DESC`
    )
    .all(month) as unknown as { provider?: string; calls?: number; cost?: number }[]
  return rows.map((r) => ({
    provider: r.provider ?? 'deepseek',
    calls: Number(r.calls ?? 0),
    cost: Number(r.cost ?? 0)
  }))
}

/* ---------------- 模型目录（P2） ---------------- */

export interface CatalogEntry {
  id: string
  /** 目录里的原始 JSON（展示名、上下文长度等） */
  payload: string
}

export function readCatalog(provider: string): { models: CatalogEntry[]; fetchedAt: string | null } {
  const rows = getDb()
    .prepare(
      'SELECT model_id, payload, fetched_at FROM ai_catalog WHERE provider = ? ORDER BY model_id'
    )
    .all(provider) as unknown as { model_id: string; payload: string; fetched_at: string }[]
  let fetchedAt: string | null = null
  for (const row of rows) {
    if (!fetchedAt || row.fetched_at > fetchedAt) fetchedAt = row.fetched_at
  }
  return {
    models: rows.map((r) => ({ id: r.model_id, payload: r.payload })),
    fetchedAt
  }
}

/** 整家替换（一个事务，读到的要么是旧列表要么是新列表） */
export function replaceCatalog(
  provider: string,
  models: { id: string; payload?: unknown }[],
  fetchedAt: string
): void {
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM ai_catalog WHERE provider = ?').run(provider)
    const insert = db.prepare(
      'INSERT OR REPLACE INTO ai_catalog (provider, model_id, payload, fetched_at) VALUES (?, ?, ?, ?)'
    )
    for (const model of models) {
      insert.run(provider, model.id, JSON.stringify(model.payload ?? {}), fetchedAt)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

/* ---------------- 价格（P2） ---------------- */

export interface RemotePricing {
  models: Record<string, { name?: string; input: number; output: number; cacheRead?: number }>
  fetchedAt: string
}

export function readRemotePricing(provider: string): RemotePricing | null {
  const row = getDb()
    .prepare('SELECT payload, fetched_at FROM ai_pricing WHERE provider = ?')
    .get(provider) as { payload?: string; fetched_at?: string } | undefined
  if (!row?.payload) return null
  const parsed = parseJson<{ models?: RemotePricing['models'] }>(row.payload, {})
  if (!parsed.models) return null
  return { models: parsed.models, fetchedAt: row.fetched_at ?? '' }
}

export function writeRemotePricing(provider: string, payload: unknown, fetchedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO ai_pricing (provider, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
    )
    .run(provider, JSON.stringify(payload), fetchedAt)
}
