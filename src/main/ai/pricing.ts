/**
 * 价格：三级来源，绝不猜（PLAN-PROVIDERS §4.2）
 *
 * 1. 厂商响应自报 —— 目前 4 家的兼容层都没给，留了 `provider` 这个枚举位；
 * 2. 远程目录 —— models.dev 的 4 家子集，落在 `ai_pricing`，TTL 7 天；
 * 3. 随包快照 —— `pricing-snapshot.json`，构建时由 `scripts/gen-pricing.mjs` 生成；
 * 都没有 → `priced:false`，只统计 token，金额按 0 记（绝不复用别家价格）。
 */
import type { AiPriceInfo, AiPriceSource, AiProviderId } from '@shared/types'
import { readRemotePricing, writeRemotePricing, type RemotePricing } from '../db/ai'
import snapshot from './pricing-snapshot.json'

export type PriceSource = AiPriceSource

/** 与 shared 里的 AiPriceInfo 是同一个类型（设置页直接用它显示） */
export type ModelPrice = AiPriceInfo

interface SnapshotModel {
  name?: string
  input: number
  output: number
  cacheRead?: number
}

interface Snapshot {
  source: string
  fetchedAt: string
  providers: Record<string, { models: Record<string, SnapshotModel> }>
}

const SNAPSHOT = snapshot as Snapshot

/** 远程价格目录的 TTL */
export const PRICING_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const PRICING_SOURCE_URL = 'https://models.dev/api.json'

/** models.dev 的 provider key → 我们的 id */
const REMOTE_PROVIDERS: Record<AiProviderId, string> = {
  deepseek: 'deepseek',
  openai: 'openai',
  gemini: 'google',
  glm: 'zhipuai'
}

const NONE: ModelPrice = {
  priced: false,
  input: 0,
  output: 0,
  cacheRead: 0,
  source: 'none',
  asOf: null
}

function toPrice(entry: SnapshotModel | undefined, source: PriceSource, asOf: string): ModelPrice {
  if (!entry) return NONE
  return {
    priced: true,
    input: entry.input,
    output: entry.output,
    cacheRead: typeof entry.cacheRead === 'number' && entry.cacheRead > 0 ? entry.cacheRead : entry.input,
    source,
    asOf
  }
}

/** 快照信息（设置页显示「价格：models.dev · 日期」） */
export function snapshotInfo(): { source: string; asOf: string } {
  return { source: SNAPSHOT.source, asOf: SNAPSHOT.fetchedAt }
}

function readRemoteSafe(provider: AiProviderId): RemotePricing | null {
  try {
    return readRemotePricing(provider)
  } catch {
    // 数据库还没打开（比如纯单测）时不要炸
    return null
  }
}

export function priceFor(provider: AiProviderId, model: string): ModelPrice {
  if (!model) return NONE
  const remote = readRemoteSafe(provider)
  const remotePrice = remote?.models?.[model]
  if (remotePrice) {
    return toPrice(remotePrice, 'catalog', remote!.fetchedAt.slice(0, 10))
  }
  const snap = SNAPSHOT.providers[provider]?.models?.[model]
  return toPrice(snap, 'snapshot', SNAPSHOT.fetchedAt)
}

export interface KnownModelEntry {
  /** models.dev 的公开名（可能为空） */
  name: string | null
  price: ModelPrice
}

/**
 * 一家所有「我们认识」的模型（快照 ∪ 远程目录），带公开名与价格。
 * 给模型下拉框用：/models 只回 id 的家（OpenAI / GLM）靠这里的 name 显示人话。
 * 注意：这只用于**补名字/补价格**，下拉框的候选列表仍只来自 /models 目录。
 */
export function knownModels(provider: AiProviderId): Record<string, KnownModelEntry> {
  const out: Record<string, KnownModelEntry> = {}
  const snap = SNAPSHOT.providers[provider]?.models ?? {}
  for (const [id, entry] of Object.entries(snap)) {
    out[id] = {
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
      price: toPrice(entry, 'snapshot', SNAPSHOT.fetchedAt)
    }
  }
  const remote = readRemoteSafe(provider)
  if (remote) {
    const asOf = remote.fetchedAt.slice(0, 10)
    for (const [id, entry] of Object.entries(remote.models)) {
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null
      out[id] = { name: name ?? out[id]?.name ?? null, price: toPrice(entry, 'catalog', asOf) }
    }
  }
  return out
}

/** 估算一次调用的金额（美元）；没价就是 0 */
export function estimateCostUsd(
  price: ModelPrice,
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number }
): number {
  if (!price.priced) return 0
  const cached = Math.max(0, Math.min(usage.cachedTokens, usage.promptTokens))
  const miss = Math.max(0, usage.promptTokens - cached)
  return (
    (miss * price.input + cached * price.cacheRead + usage.completionTokens * price.output) / 1_000_000
  )
}

export interface PricingRefreshResult {
  ok: boolean
  updated: boolean
  message: string
  asOf: string | null
}

/** 最近一次远程价格的时间（四家里最新的） */
export function lastRemotePricingAt(): string | null {
  let latest: string | null = null
  for (const id of Object.keys(REMOTE_PROVIDERS) as AiProviderId[]) {
    const remote = readRemoteSafe(id)
    if (remote?.fetchedAt && (!latest || remote.fetchedAt > latest)) latest = remote.fetchedAt
  }
  return latest
}

function isFresh(fetchedAt: string | null, ttl: number): boolean {
  if (!fetchedAt) return false
  const at = Date.parse(fetchedAt)
  if (Number.isNaN(at)) return false
  return Date.now() - at < ttl
}

/** 拉 models.dev 整包，只留 4 家写进 ai_pricing；原始包不落盘 */
export async function refreshPricing(force = false): Promise<PricingRefreshResult> {
  const last = lastRemotePricingAt()
  if (!force && isFresh(last, PRICING_TTL_MS)) {
    return {
      ok: true,
      updated: false,
      message: '价格目录还是新的，7 天内不用刷新',
      asOf: last ? last.slice(0, 10) : SNAPSHOT.fetchedAt
    }
  }

  try {
    const res = await fetch(PRICING_SOURCE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) {
      return {
        ok: false,
        updated: false,
        message: `价格目录拉取失败（HTTP ${res.status}），继续用${last ? '上次的' : '随包'}数据`,
        asOf: (last ?? SNAPSHOT.fetchedAt).slice(0, 10)
      }
    }
    const all = (await res.json()) as Record<
      string,
      { models?: Record<string, { name?: string; cost?: Record<string, number> }> }
    >
    const fetchedAt = new Date().toISOString()
    let count = 0
    for (const id of Object.keys(REMOTE_PROVIDERS) as AiProviderId[]) {
      const remoteId = REMOTE_PROVIDERS[id]
      const source = all?.[remoteId]
      if (!source?.models) continue
      const models: RemotePricing['models'] = {}
      for (const [modelId, model] of Object.entries(source.models)) {
        const cost = model?.cost
        if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') continue
        const entry: { name?: string; input: number; output: number; cacheRead?: number } = {
          input: cost.input,
          output: cost.output
        }
        // 名字留着给「模型下拉框」用：API 只回 id 的家（OpenAI / GLM）靠它显示公开名
        if (typeof model.name === 'string' && model.name.trim()) entry.name = model.name.trim()
        if (typeof cost.cache_read === 'number' && cost.cache_read > 0) entry.cacheRead = cost.cache_read
        models[modelId] = entry
        count++
      }
      writeRemotePricing(id, { models }, fetchedAt)
    }
    return {
      ok: true,
      updated: true,
      message: `价格目录已更新：${count} 个模型`,
      asOf: fetchedAt.slice(0, 10)
    }
  } catch (err) {
    return {
      ok: false,
      updated: false,
      message: `价格目录刷新失败：${err instanceof Error ? err.message : String(err)}`,
      asOf: (last ?? SNAPSHOT.fetchedAt).slice(0, 10)
    }
  }
}

/** 启动后后台刷新一次（过期才真的下载）；失败保持现状 */
export function schedulePricingRefresh(delayMs = 30_000): void {
  const timer = setTimeout(() => {
    void refreshPricing(false).catch(() => undefined)
  }, delayMs)
  // 不要因为一个后台任务把进程吊住
  if (typeof timer.unref === 'function') timer.unref()
}
