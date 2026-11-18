import type { AiTestResult } from '@shared/types'
import { getApiKey, getSettings } from '../settings'
import { getAiCache, logAiUsage, monthAiCost, setAiCache } from '../db/ai'
import { PROVIDERS } from './providers'
import { AiError, requestChat } from './transport'

export { AiError }

interface ChatOptions {
  messages: unknown[]
  kind: string
  json?: boolean
  maxTokens?: number
  thinking?: boolean
  timeoutMs?: number
  cacheKey?: string
  temperature?: number
}

/** P0 仍然只走 DeepSeek（settings.model / baseUrl 照旧）；P1 才由 settings.ai 选 provider */
const ACTIVE_PROVIDER = PROVIDERS.deepseek

type Price = { miss: number; hit: number; out: number }

/** 美元 / 百万 token。键是 provider → 模型名。 */
const PRICES: Record<string, Record<string, Price>> = {
  deepseek: { 'deepseek-flash': { miss: 0.15, hit: 0.003, out: 0.6 } }
}

/** 每个 provider 认不出模型时的旧兜底（P0 保持行为不变，P2 改成「费用未知」） */
const DEFAULT_MODEL: Record<string, string> = { deepseek: 'deepseek-flash' }

const ZERO_PRICE: Price = { miss: 0, hit: 0, out: 0 }

function priceFor(provider: string, model: string): Price {
  const table = PRICES[provider] ?? {}
  return table[model] ?? table[DEFAULT_MODEL[provider]] ?? ZERO_PRICE
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function aiAvailable(): boolean {
  return !!getApiKey()
}

export function overBudget(): boolean {
  const s = getSettings()
  if (!s.monthlyBudgetUsd || s.monthlyBudgetUsd <= 0) return false
  return monthAiCost().cost >= s.monthlyBudgetUsd
}

async function requestOnce(opts: ChatOptions, key: string): Promise<string> {
  const settings = getSettings()
  const spec = ACTIVE_PROVIDER
  const result = await requestChat(
    spec,
    { baseUrl: settings.baseUrl, model: settings.model, apiKey: key },
    {
      messages: opts.messages,
      json: opts.json,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      thinking: opts.thinking,
      timeoutMs: opts.timeoutMs
    }
  )

  const price = priceFor(spec.id, settings.model)
  const cached = result.usage.cachedTokens
  const miss = Math.max(0, result.usage.promptTokens - cached)
  const cost =
    (miss * price.miss + cached * price.hit + result.usage.completionTokens * price.out) / 1_000_000
  logAiUsage({
    provider: spec.id,
    kind: opts.kind,
    model: settings.model,
    promptTokens: result.usage.promptTokens,
    cachedTokens: cached,
    completionTokens: result.usage.completionTokens,
    costUsd: cost
  })

  return result.content
}

export async function chat(opts: ChatOptions): Promise<string> {
  const spec = ACTIVE_PROVIDER
  const key = getApiKey()
  if (!key) throw new AiError(`未配置 ${spec.label} API Key，请先到设置页填写`, { status: 401 })

  if (opts.cacheKey) {
    const cached = getAiCache(spec.id, opts.kind, opts.cacheKey)
    if (cached) return cached
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await requestOnce(opts, key)
      if (opts.cacheKey) {
        setAiCache(spec.id, opts.kind, opts.cacheKey, getSettings().model, content)
      }
      return content
    } catch (err) {
      lastErr = err
      const status = err instanceof AiError ? err.status : undefined
      if (status === 401 || status === 402) throw err
      if (attempt < 2) {
        await sleep(attempt === 0 ? 1200 : 4000)
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiError('AI 调用失败')
}

export async function chatJson<T>(opts: ChatOptions): Promise<T> {
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await chat({
      ...opts,
      json: true,
      messages:
        attempt === 0
          ? opts.messages
          : [
              ...opts.messages,
              {
                role: 'user',
                content: `上一次输出不是合法 JSON。请只输出合法 JSON，不要任何解释。上一次输出：${lastText.slice(0, 1500)}`
              }
            ]
    })
    lastText = text
    try {
      return JSON.parse(text) as T
    } catch {
      // 尝试从文本中截取 JSON
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1)) as T
        } catch {
          /* fallthrough */
        }
      }
    }
  }
  throw new AiError('AI 返回的内容不是合法 JSON')
}

export async function testApiKey(overrideKey?: string): Promise<AiTestResult> {
  const key = overrideKey?.trim() || getApiKey()
  if (!key) return { ok: false, message: '还没有填写 API Key' }
  const settings = getSettings()
  const spec = ACTIVE_PROVIDER
  try {
    await requestChat(
      spec,
      { baseUrl: settings.baseUrl, model: settings.model, apiKey: key },
      {
        messages: [{ role: 'user', content: '回复 ok' }],
        maxTokens: 8,
        timeoutMs: 20_000
      }
    )
    return { ok: true, message: '连接成功，Key 可用', model: settings.model }
  } catch (err) {
    if (err instanceof AiError) {
      if (err.status === 401) return { ok: false, message: 'API Key 无效' }
      if (err.status) return { ok: false, message: `接口返回 ${err.status}` }
      return { ok: false, message: `连接失败：${err.message}` }
    }
    return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
