import type { AiTestResult } from '@shared/types'
import { getApiKey, getSettings } from '../settings'
import { getAiCache, logAiUsage, monthAiCost, setAiCache } from '../db/ai'

export class AiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

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

const PRICES: Record<string, { miss: number; hit: number; out: number }> = {
  'deepseek-flash': { miss: 0.15, hit: 0.003, out: 0.6 }
}

function priceFor(model: string): { miss: number; hit: number; out: number } {
  return PRICES[model] ?? PRICES['deepseek-flash']
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
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: opts.messages,
    stream: false,
    max_tokens: opts.maxTokens ?? 2000,
    thinking: { type: opts.thinking ? 'enabled' : 'disabled' }
  }
  if (opts.json) body.response_format = { type: 'json_object' }
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000)
  let res: Response
  try {
    res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    if (controller.signal.aborted) throw new AiError('请求超时，请检查网络后重试')
    throw new AiError(`网络请求失败：${msg}`)
  }
  clearTimeout(timer)

  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      detail = parsed.error?.message ?? detail
    } catch {
      /* ignore */
    }
    if (res.status === 401) throw new AiError('API Key 无效或已过期', 401)
    if (res.status === 402) throw new AiError('DeepSeek 账户余额不足', 402)
    if (res.status === 429) throw new AiError('请求过于频繁，稍后再试', 429)
    throw new AiError(`DeepSeek 返回 ${res.status}：${detail}`, res.status)
  }

  let payload: {
    choices?: { message?: { content?: string } }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
    }
  }
  try {
    payload = JSON.parse(text)
  } catch {
    throw new AiError('DeepSeek 返回了无法解析的内容')
  }

  const content = payload.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new AiError('DeepSeek 返回了空内容，请重试')

  const usage = payload.usage ?? {}
  const hit = Number(usage.prompt_cache_hit_tokens ?? 0)
  const miss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit))
  const out = Number(usage.completion_tokens ?? 0)
  const p = priceFor(settings.model)
  const cost = (miss * p.miss + hit * p.hit + out * p.out) / 1_000_000
  logAiUsage({
    kind: opts.kind,
    model: settings.model,
    promptTokens: miss + hit,
    cachedTokens: hit,
    completionTokens: out,
    costUsd: cost
  })

  return content
}

export async function chat(opts: ChatOptions): Promise<string> {
  const key = getApiKey()
  if (!key) throw new AiError('未配置 DeepSeek API Key，请先到设置页填写', 401)

  if (opts.cacheKey) {
    const cached = getAiCache(opts.kind, opts.cacheKey)
    if (cached) return cached
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await requestOnce(opts, key)
      if (opts.cacheKey) {
        setAiCache(opts.kind, opts.cacheKey, getSettings().model, content)
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
  try {
    const settings = getSettings()
    const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: '回复 ok' }],
        max_tokens: 8,
        thinking: { type: 'disabled' }
      }),
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status === 401) return { ok: false, message: 'API Key 无效' }
    if (!res.ok) return { ok: false, message: `接口返回 ${res.status}` }
    return { ok: true, message: '连接成功，Key 可用', model: settings.model }
  } catch (err) {
    return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
