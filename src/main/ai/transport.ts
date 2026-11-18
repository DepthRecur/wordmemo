/**
 * 唯一的 OpenAI 兼容传输层。
 *
 * 供应商之间的差异全部来自 providers.ts 的 compat 声明，这里不出现任何
 * `if (provider === 'xxx')`。P0 阶段只有 DeepSeek 走这条链路，其余三家
 * 在 P1 接入。
 */
import type { ProviderSpec } from './providers'
import { chatEndpoint } from './providers'

export class AiError extends Error {
  status?: number
  /** 值得自动重试（限流、5xx、网络） */
  retryable: boolean
  /** 400 且像"参数不支持"——调用方可去掉该参数重试一次 */
  unknownParam: boolean

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; unknownParam?: boolean } = {}
  ) {
    super(message)
    this.name = 'AiError'
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.unknownParam = opts.unknownParam ?? false
  }
}

export interface ChatRequest {
  messages: unknown[]
  json?: boolean
  maxTokens?: number
  temperature?: number
  thinking?: boolean
  timeoutMs?: number
}

export interface NormalizedUsage {
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

export interface ChatResult {
  content: string
  usage: NormalizedUsage
}

export interface ProviderConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 只做"装配请求体"，不发网络请求——方便单测 */
export function buildChatBody(
  spec: ProviderSpec,
  cfg: Pick<ProviderConfig, 'model'>,
  req: ChatRequest
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    stream: false,
    [spec.compat.maxTokensField]: req.maxTokens ?? 2000
  }

  if (spec.compat.reasoning) {
    if (spec.compat.reasoning.style === 'thinking') {
      body.thinking = { type: req.thinking ? 'enabled' : 'disabled' }
    } else if (req.thinking) {
      body.reasoning_effort = 'low'
    }
  }

  if (req.json && spec.compat.jsonMode === 'force') {
    body.response_format = { type: 'json_object' }
  }
  if (spec.compat.temperature && typeof req.temperature === 'number') {
    body.temperature = req.temperature
  }
  return body
}

/** 解析成功响应；HTTP 200 里的业务错误也在这里拦下 */
export function parseChatResponse(spec: ProviderSpec, text: string): ChatResult {
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new AiError(`${spec.label} 返回了无法解析的内容`)
  }

  if (payload?.error || payload?.error_code) {
    const detail =
      payload?.error?.message ?? payload?.error_message ?? payload?.error_msg ?? JSON.stringify(payload).slice(0, 300)
    throw new AiError(`${spec.label} 返回错误：${detail}`)
  }

  const content = payload?.choices?.[0]?.message?.content ?? ''
  if (typeof content !== 'string' || !content.trim()) {
    throw new AiError(`${spec.label} 返回了空内容，请重试`)
  }

  const usage = payload?.usage ?? {}
  const promptTokens = Number(usage.prompt_tokens ?? 0)
  const completionTokens = Number(usage.completion_tokens ?? 0)
  let cachedTokens = 0
  if (spec.compat.usageCache === 'deepseek') {
    cachedTokens = Number(usage.prompt_cache_hit_tokens ?? 0)
  } else if (spec.compat.usageCache === 'openai') {
    cachedTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? 0)
  }

  return {
    content,
    usage: {
      promptTokens: Math.max(0, promptTokens),
      cachedTokens: Math.max(0, Math.min(cachedTokens, promptTokens)),
      completionTokens: Math.max(0, completionTokens)
    }
  }
}

/** HTTP 错误 → 归一化错误（文案里用 provider 的 label，不写死 DeepSeek） */
export function normalizeHttpError(spec: ProviderSpec, status: number, text: string): AiError {
  let detail = text.slice(0, 300)
  try {
    const parsed = JSON.parse(text)
    detail = parsed?.error?.message ?? parsed?.error_message ?? parsed?.message ?? detail
  } catch {
    /* 原样使用 */
  }

  if (status === 401 || status === 403) {
    return new AiError(`${spec.label} 的 API Key 无效或没有权限`, { status })
  }
  if (status === 402 || /insufficient|balance|余额|quota/i.test(detail)) {
    return new AiError(`${spec.label} 账户余额不足`, { status })
  }
  if (status === 429) {
    return new AiError('请求过于频繁，稍后再试', { status, retryable: true })
  }
  if (status >= 500) {
    return new AiError(`${spec.label} 服务暂时不可用（${status}），稍后再试`, {
      status,
      retryable: true
    })
  }
  if (status === 400) {
    const unknownParam = /unknown|unsupported|not support|invalid.*(param|parameter|field)|unrecognized/i.test(
      detail
    )
    return new AiError(`${spec.label} 拒绝了这次请求：${detail}`, { status, unknownParam })
  }
  return new AiError(`${spec.label} 返回 ${status}：${detail}`, { status })
}

/** 真正发请求；超时/网络错误也归一化成 AiError */
export async function requestChat(
  spec: ProviderSpec,
  cfg: ProviderConfig,
  req: ChatRequest
): Promise<ChatResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 90_000)
  let res: Response
  let text: string
  try {
    res = await fetch(chatEndpoint(spec, cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(buildChatBody(spec, cfg, req)),
      signal: controller.signal
    })
    text = await res.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (controller.signal.aborted) throw new AiError('请求超时，请检查网络后重试', { retryable: true })
    throw new AiError(`网络请求失败：${msg}`, { retryable: true })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw normalizeHttpError(spec, res.status, text)
  return parseChatResponse(spec, text)
}
