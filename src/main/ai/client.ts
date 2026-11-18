import type { AiProviderId, AiRoleConfig, AiTestResult } from '@shared/types'
import { getApiKey, getSettings } from '../settings'
import { getAiCache, logAiUsage, monthAiCost, setAiCache } from '../db/ai'
import { estimateCostUsd, priceFor } from './pricing'
import {
  PROVIDERS,
  isProviderId,
  type ProviderId,
  type ProviderSpec
} from './providers'
import { AiError, requestChat, type ChatRequest } from './transport'

export { AiError }

/** 角色路由（PLAN-PROVIDERS §3）：只有默认与视觉两种，不做 7 角色矩阵 */
export type AiRole = 'default' | 'vision'

interface ChatOptions {
  messages: unknown[]
  kind: string
  /** 默认 'default'；图片 OCR 用 'vision' */
  role?: AiRole
  json?: boolean
  maxTokens?: number
  thinking?: boolean
  timeoutMs?: number
  cacheKey?: string
  temperature?: number
}

interface Target {
  spec: ProviderSpec
  baseUrl: string
  model: string
}

/** DeepSeek 没有配模型时的兜底名（价格与目录都在 pricing.ts，这里只有名字） */
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'

/** 预算降级成 token 上限时的粗估：$1 ≈ 200 万 token（有未定价调用时才用） */
const TOKENS_PER_USD = 2_000_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 供应商卡片里配的端点/模型（可能为空） */
function providerConfig(id: ProviderId): { baseUrl?: string; model?: string } {
  return getSettings().ai.providers[id] ?? {}
}

/** 某一家实际会用的端点（设置页与目录都要用） */
export function providerBaseUrl(id: ProviderId): string {
  const own = providerConfig(id).baseUrl?.trim()
  if (own) return own.replace(/\/+$/, '')
  // 老配置：DeepSeek 时代只有顶层 baseUrl，不迁移也能照旧
  if (id === 'deepseek') {
    const legacy = getSettings().baseUrl?.trim()
    if (legacy) return legacy.replace(/\/+$/, '')
  }
  return PROVIDERS[id].baseUrl
}

/** 某一家实际会用的模型名（角色覆盖 > 卡片配置 > 旧字段/默认） */
export function providerModel(id: ProviderId, role?: AiRoleConfig): string {
  const fromRole = role && role.provider === id ? role.model?.trim() : ''
  if (fromRole) return fromRole
  const own = providerConfig(id).model?.trim()
  if (own) return own
  if (id === 'deepseek') {
    // 老配置：顶层 model 就是 DeepSeek 的模型
    return getSettings().model?.trim() || DEEPSEEK_DEFAULT_MODEL
  }
  return ''
}

function roleConfig(role: AiRole): AiRoleConfig {
  const ai = getSettings().ai
  if (role === 'vision' && ai.vision) return ai.vision
  return ai.default
}

function targetFor(id: ProviderId, role?: AiRoleConfig): Target {
  return { spec: PROVIDERS[id], baseUrl: providerBaseUrl(id), model: providerModel(id, role) }
}

function resolveTarget(role: AiRole): Target {
  const cfg = roleConfig(role)
  const id: ProviderId = isProviderId(cfg.provider) ? cfg.provider : 'deepseek'
  return targetFor(id, cfg)
}

/** 去掉 messages 里 image_url 的 detail（OpenAI 专有字段，别家兼容层可能 400） */
function stripImageDetail(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown })?.content
    if (!Array.isArray(content)) return message
    return {
      ...(message as Record<string, unknown>),
      content: content.map((part) => {
        const p = part as { type?: string; image_url?: { url?: string; detail?: string } }
        if (p?.type !== 'image_url' || !p.image_url) return part
        const { detail: _drop, ...rest } = p.image_url
        return { ...p, image_url: rest }
      })
    }
  })
}

/**
 * 400「未知参数」→ 去掉被点名的那个参数再试一次（PLAN-PROVIDERS §3.3）。
 * thinking 改的是 compat（请求体里只有它自己发这个字段），所以返回新的 target；
 * 返回 null 表示已经没东西可以去掉了。
 */
function degradeParam(target: Target, req: ChatRequest, err: AiError): Target | null {
  const msg = err.message
  if (/thinking|reasoning/i.test(msg) && target.spec.compat.reasoning) {
    req.thinking = false
    return {
      ...target,
      spec: { ...target.spec, compat: { ...target.spec.compat, reasoning: null } }
    }
  }
  if (/response_format|json/i.test(msg) && req.json) {
    req.json = false
    return target
  }
  if (/temperature/i.test(msg) && req.temperature !== undefined) {
    req.temperature = undefined
    return target
  }
  if (/image_url|detail/i.test(msg)) {
    req.messages = stripImageDetail(req.messages)
    return {
      ...target,
      spec: { ...target.spec, compat: { ...target.spec.compat, imageDetail: false } }
    }
  }
  // 不知道是哪个参数：先按「这家不支持 JSON 模式」再试一次
  if (req.json) {
    req.json = false
    return target
  }
  return null
}

async function requestOnce(target: Target, opts: ChatOptions, key: string): Promise<string> {
  const req: ChatRequest = {
    messages: opts.messages,
    json: opts.json,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    thinking: opts.thinking,
    timeoutMs: opts.timeoutMs
  }

  let current = target
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await requestChat(
        current.spec,
        { baseUrl: current.baseUrl, model: current.model, apiKey: key },
        req
      )

      // 价格来自 pricing.ts（远程目录 → 随包快照 → 未知）。未知就 priced:false + 只记 token
      const price = priceFor(current.spec.id, current.model)
      const cost = estimateCostUsd(price, result.usage)
      logAiUsage({
        provider: current.spec.id,
        kind: opts.kind,
        model: current.model,
        promptTokens: result.usage.promptTokens,
        cachedTokens: result.usage.cachedTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: cost,
        costSource: price.priced ? price.source : 'none',
        pricedAt: price.asOf
      })
      return result.content
    } catch (err) {
      const degraded =
        attempt === 0 && err instanceof AiError && err.unknownParam
          ? degradeParam(current, req, err)
          : null
      if (!degraded) throw err
      current = degraded
    }
  }
  throw new AiError('AI 调用失败')
}

export function aiAvailable(role: AiRole = 'default'): boolean {
  return !!getApiKey(resolveTarget(role).spec.id)
}

/**
 * 预算：有价按金额；这个月只要出现过「没有价格」的调用，就同时按 token 上限兜底
 * （`TOKENS_PER_USD` 是粗估，宁可早点提示，也不要因为看不到价格就无限花）。
 */
export function overBudget(): boolean {
  const s = getSettings()
  if (!s.monthlyBudgetUsd || s.monthlyBudgetUsd <= 0) return false
  const month = monthAiCost()
  if (month.cost >= s.monthlyBudgetUsd) return true
  if (month.unpricedCalls > 0) {
    return month.tokens >= s.monthlyBudgetUsd * TOKENS_PER_USD
  }
  return false
}

export async function chat(opts: ChatOptions): Promise<string> {
  const target = resolveTarget(opts.role ?? 'default')
  const key = getApiKey(target.spec.id)
  if (!key) throw new AiError(`未配置 ${target.spec.label} API Key，请先到设置页填写`, { status: 401 })
  if (!target.model) {
    throw new AiError(`还没有给 ${target.spec.label} 填模型名，请先到设置页填写`, { status: 400 })
  }

  if (opts.cacheKey) {
    const cached = getAiCache(target.spec.id, opts.kind, opts.cacheKey)
    if (cached) return cached
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await requestOnce(target, opts, key)
      if (opts.cacheKey) {
        setAiCache(target.spec.id, opts.kind, opts.cacheKey, target.model, content)
      }
      return content
    } catch (err) {
      lastErr = err
      const status = err instanceof AiError ? err.status : undefined
      // 401/402 是 Key 或余额问题，400 是请求本身不对（降级重试已在 requestOnce 做过）——重试没用
      if (status === 401 || status === 402 || status === 400) throw err
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

function testMessageFor(err: unknown): string {
  if (!(err instanceof AiError)) {
    return `连接失败：${err instanceof Error ? err.message : String(err)}`
  }
  switch (err.status) {
    case 401:
      return 'API Key 无效'
    case 403:
      return '没有权限（403）：Key 权限不足，或所在地区受限（可能需要代理）'
    case 404:
      return '接口不存在（404）：检查 Base URL 与模型名'
    case 429:
      return '请求过于频繁（429），稍后再试'
    default:
      return err.message
  }
}

/** 设置页「保存并测试」：provider 省略 = deepseek（旧签名兼容） */
export async function testApiKey(
  provider: AiProviderId = 'deepseek',
  overrideKey?: string
): Promise<AiTestResult> {
  const id: ProviderId = isProviderId(provider) ? provider : 'deepseek'
  const target = targetFor(id)
  const key = overrideKey?.trim() || getApiKey(id)
  if (!key) return { ok: false, message: '还没有填写 API Key', provider: id }
  if (!target.model) {
    return {
      ok: false,
      message: `还没有填 ${target.spec.label} 的模型名，先在上面填一个再测试`,
      provider: id
    }
  }

  const started = Date.now()
  try {
    await requestChat(
      target.spec,
      { baseUrl: target.baseUrl, model: target.model, apiKey: key },
      { messages: [{ role: 'user', content: '回复 ok' }], maxTokens: 8, timeoutMs: 20_000 }
    )
    return {
      ok: true,
      message: '连接成功，Key 可用',
      model: target.model,
      provider: id,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    return {
      ok: false,
      message: testMessageFor(err),
      model: target.model,
      provider: id,
      latencyMs: Date.now() - started
    }
  }
}

/* 设置页的供应商卡片视图在 info.ts（依赖 catalog.ts，不能让 client 反向依赖） */
