/**
 * 模型目录（P2）：GET {baseUrl}/models，缓存进 `ai_catalog`。
 *
 * 语义（照 PLAN-PROVIDERS §4.1）：TTL 24 小时、启动后后台刷新、失败保留上次成功的列表、
 * 并发请求合并成一次（单飞）、**永远允许手填**（UI 那边是 datalist，不是只读下拉）。
 */
import type { AiProviderId } from '@shared/types'
import { getApiKey } from '../settings'
import { localIso } from '../db/connection'
import { readCatalog, replaceCatalog } from '../db/ai'
import { PROVIDERS, modelsEndpoint, type ProviderSpec } from './providers'
import { providerBaseUrl } from './client'

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

export interface CatalogModel {
  id: string
  name: string
}

export interface CatalogSnapshot {
  provider: AiProviderId
  models: CatalogModel[]
  fetchedAt: string | null
  /** 超过 TTL（或拉取失败后沿用旧列表） */
  stale: boolean
  /** 拉取失败时的原因；成功为 null */
  error: string | null
}

const inflight = new Map<AiProviderId, Promise<CatalogSnapshot>>()

function shapeOf(spec: ProviderSpec): 'openai' | 'google' {
  return spec.modelsConfig?.shape ?? 'openai'
}

/** 解析 /models 响应：OpenAI 形状 `{data:[{id}]}`，Gemini 形状 `{models:[{name}]}` */
export function parseModels(shape: 'openai' | 'google', text: string): CatalogModel[] {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return []
  }
  const p = payload as {
    data?: { id?: string; name?: string }[]
    models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]
  }

  if (shape === 'google') {
    const list = Array.isArray(p.models) ? p.models : []
    return list
      .filter(
        (m) =>
          !Array.isArray(m.supportedGenerationMethods) ||
          m.supportedGenerationMethods.includes('generateContent')
      )
      .map((m) => {
        const id = String(m.name ?? '').replace(/^models\//, '')
        return { id, name: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName : id }
      })
      .filter((m) => !!m.id)
  }

  const list = Array.isArray(p.data) ? p.data : Array.isArray(p.models) ? (p.models as { id?: string }[]) : []
  return list
    .map((m) => {
      const id = String(m.id ?? (m as { name?: string }).name ?? '')
      const name = String((m as { name?: string }).name ?? id)
      return { id, name }
    })
    .filter((m) => !!m.id)
}

function isFresh(fetchedAt: string | null): boolean {
  if (!fetchedAt) return false
  const at = Date.parse(fetchedAt)
  if (Number.isNaN(at)) return false
  return Date.now() - at < CATALOG_TTL_MS
}

function readCachedSafe(provider: AiProviderId): { models: CatalogModel[]; fetchedAt: string | null } {
  try {
    const cached = readCatalog(provider)
    return {
      models: cached.models.map((row) => {
        let name = row.id
        try {
          const parsed = JSON.parse(row.payload) as { name?: string }
          if (typeof parsed?.name === 'string' && parsed.name) name = parsed.name
        } catch {
          /* payload 坏掉就用 id */
        }
        return { id: row.id, name }
      }),
      fetchedAt: cached.fetchedAt
    }
  } catch {
    // 数据库还没打开（纯单测）时不要炸
    return { models: [], fetchedAt: null }
  }
}

/** 只读缓存，不发请求（设置页首屏用这个） */
export function cachedCatalog(provider: AiProviderId): CatalogSnapshot {
  const cached = readCachedSafe(provider)
  return {
    provider,
    models: cached.models,
    fetchedAt: cached.fetchedAt,
    stale: !cached.models.length || !isFresh(cached.fetchedAt),
    error: null
  }
}

async function doRefresh(spec: ProviderSpec, key: string): Promise<CatalogSnapshot> {
  const url = spec.modelsConfig?.url ?? modelsEndpoint(spec, providerBaseUrl(spec.id))
  const headers: Record<string, string> = { accept: 'application/json' }
  if (spec.modelsConfig?.auth === 'google') headers['x-goog-api-key'] = key
  else headers.Authorization = `Bearer ${key}`

  const fallback = readCachedSafe(spec.id)

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    const text = await res.text()
    if (!res.ok) {
      return {
        provider: spec.id,
        models: fallback.models,
        fetchedAt: fallback.fetchedAt,
        stale: true,
        error: `目录拉取失败（HTTP ${res.status}），继续用上次的列表`
      }
    }
    const models = parseModels(shapeOf(spec), text)
    if (!models.length) {
      return {
        provider: spec.id,
        models: fallback.models,
        fetchedAt: fallback.fetchedAt,
        stale: true,
        error: '目录返回空列表，继续用上次的列表'
      }
    }
    const fetchedAt = localIso()
    replaceCatalog(
      spec.id,
      models.map((m) => ({ id: m.id, payload: { name: m.name } })),
      fetchedAt
    )
    return { provider: spec.id, models, fetchedAt, stale: false, error: null }
  } catch (err) {
    return {
      provider: spec.id,
      models: fallback.models,
      fetchedAt: fallback.fetchedAt,
      stale: true,
      error: `目录拉取失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 拉某一家的目录；并发调用会合并成一次请求 */
export async function refreshCatalog(
  provider: AiProviderId,
  force = false
): Promise<CatalogSnapshot> {
  if (!force) {
    const cached = cachedCatalog(provider)
    if (cached.models.length && !cached.stale) return cached
  }
  const spec = PROVIDERS[provider]
  if (!spec) return cachedCatalog(provider)

  const key = getApiKey(provider)
  if (!key) {
    const cached = cachedCatalog(provider)
    return { ...cached, error: `还没有配置 ${spec.label} 的 API Key` }
  }

  const existing = inflight.get(provider)
  if (existing) return existing

  const task = doRefresh(spec, key).finally(() => inflight.delete(provider))
  inflight.set(provider, task)
  return task
}

/** 后台刷新所有已配置 Key 的家（没 Key 的跳过，不报错） */
export async function refreshAllCatalogs(force = false): Promise<void> {
  const targets = Object.keys(PROVIDERS).filter((id) => !!getApiKey(id as AiProviderId))
  await Promise.allSettled(targets.map((id) => refreshCatalog(id as AiProviderId, force)))
}

/** 启动 30 秒后刷新一次（PLAN-PROVIDERS §4.1） */
export function scheduleCatalogRefresh(delayMs = 30_000): void {
  const timer = setTimeout(() => {
    void refreshAllCatalogs(false).catch(() => undefined)
  }, delayMs)
  if (typeof timer.unref === 'function') timer.unref()
}
