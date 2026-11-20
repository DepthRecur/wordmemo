import type { AiProviderId, AiRoleConfig, AiTestResult } from '@shared/types'
import { DEEPSEEK_DEFAULT_MODEL, resolveProviderModel } from '@shared/aiModel'
import { getApiKey, getSettings } from '../settings'
import { getAiCache, logAiUsage, setAiCache } from '../db/ai'
import { noteBudget } from './budget'
import { estimateCostUsd, priceFor } from './pricing'
import {
  PROVIDERS,
  isProviderId,
  type ProviderId,
  type ProviderSpec
} from './providers'
import { AiError, requestChat, sanitizeMessages, type ChatRequest } from './transport'

export { AiError }

/** 角色路由（PLAN-PROVIDERS §3）：只有默认与视觉两种，不做 7 角色矩阵 */
export type AiRole = 'default' | 'vision'

interface ChatOptions {
  messages: unknown[]
  kind: string
  /** 默认 'default'；图片 OCR 用 'vision' */
  role?: AiRole
  /** 只给 scripts/ai-smoke.mjs 用：临时指定某一家，不改设置 */
  provider?: AiProviderId
  json?: boolean
  maxTokens?: number
  thinking?: boolean
  timeoutMs?: number
  cacheKey?: string
  temperature?: number
  /** 调用方要求「结果必须是 JSON」：不是 JSON 的回复不写缓存（P-01） */
  expectJson?: boolean
}

interface Target {
  spec: ProviderSpec
  baseUrl: string
  model: string
}

/** 预算降级成 token 上限时的粗估：$1 ≈ 200 万 token（有未定价调用时才用） */

/**
 * 有些模型（如 GLM 新的 `*-flash`）**始终思考**，会拒绝 `thinking: { type: 'disabled' }`。
 * 一旦某个 provider+model 报过这种错，本次会话就不再发 thinking 字段（对方用默认值），
 * 省掉「每次调用都先 400 一次」的浪费。
 */
const omitThinkingFor = new Set<string>()

function modelKey(spec: ProviderSpec, model: string): string {
  return `${spec.id}:${model}`
}

/** 按学习到的结果，去掉或保留 thinking 能力 */
function specFor(spec: ProviderSpec, model: string): ProviderSpec {
  if (!omitThinkingFor.has(modelKey(spec, model))) return spec
  return { ...spec, compat: { ...spec.compat, reasoning: null } }
}

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
  const s = getSettings()
  return resolveProviderModel(s.ai, id, role, s.model)
}

function roleConfig(role: AiRole): AiRoleConfig {
  const ai = getSettings().ai
  if (role === 'vision' && ai.vision) return ai.vision
  return ai.default
}

function targetFor(id: ProviderId, role?: AiRoleConfig): Target {
  return { spec: PROVIDERS[id], baseUrl: providerBaseUrl(id), model: providerModel(id, role) }
}

function resolveTarget(role: AiRole, override?: AiProviderId): Target {
  if (override) {
    const forced: ProviderId = isProviderId(override) ? override : 'deepseek'
    return targetFor(forced, { provider: forced })
  }
  const cfg = roleConfig(role)
  const id: ProviderId = isProviderId(cfg.provider) ? cfg.provider : 'deepseek'
  return targetFor(id, cfg)
}

/**
 * 400「未知参数」→ 去掉被点名的那个参数再试一次（PLAN-PROVIDERS §3.3）。
 * thinking 改的是 compat（请求体里只有它自己发这个字段），所以返回新的 target；
 * 返回 null 表示已经没东西可以去掉了。
 */
function degradeParam(target: Target, req: ChatRequest, err: AiError): Target | null {
  const msg = err.message
  // 中文也要认：GLM 报的是「该模型始终思考，不支持关闭思考」
  if (/thinking|reasoning|思考|推理/i.test(msg) && target.spec.compat.reasoning) {
    req.thinking = false
    omitThinkingFor.add(modelKey(target.spec, target.model))
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
    req.messages = sanitizeMessages(
      { ...target.spec, compat: { ...target.spec.compat, imageDetail: false } },
      req.messages
    )
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

  let current: Target = { ...target, spec: specFor(target.spec, target.model) }
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
  const target = resolveTarget(role)
  // P-09：只有 Key 没有模型也发不出请求，这里必须一起判断
  return !!getApiKey(target.spec.id) && !!target.model
}

/** 预算判断在 budget.ts；这里 re-export 保持调用方不变 */
export { overBudget } from './budget'

/** 能从文本里找出一个 JSON 值就返回它；纯文本回复返回 undefined */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    /* 继续尝试截取 */
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* 不是 JSON */
    }
  }
  return undefined
}

export async function chat(opts: ChatOptions): Promise<string> {
  const target = resolveTarget(opts.role ?? 'default', opts.provider)
  const key = getApiKey(target.spec.id)
  if (!key) throw new AiError(`未配置 ${target.spec.label} API Key，请先到设置页填写`, { status: 401 })
  if (!target.model) {
    throw new AiError(`还没有给 ${target.spec.label} 填模型名，请先到设置页填写`, { status: 400 })
  }

  // P-02：超预算只提醒，不拦这次调用
  noteBudget()

  if (opts.cacheKey) {
    const cached = getAiCache(target.spec.id, opts.kind, opts.cacheKey)
    if (cached) return cached
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await requestOnce(target, opts, key)
      // P-01：要求 JSON 的调用只要这一轮不是 JSON 就不缓存——否则 chatJson 的
      // 「再要一次 JSON」会命中这条坏缓存，永远修不好
      if (opts.cacheKey && (!opts.expectJson || parseJsonLoose(content) !== undefined)) {
        setAiCache(target.spec.id, opts.kind, opts.cacheKey, target.model, content)
      }
      return content
    } catch (err) {
      lastErr = err
      // 400 是请求本身不对（降级重试已在 requestOnce 做过）
      if (err instanceof AiError && err.status === 400) throw err
      // P-03：其余按 transport 的判定走——403/404/200 里的业务错误重试只会白等
      const retryable = !(err instanceof AiError) || err.retryable
      if (!retryable) throw err
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
      expectJson: true,
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
    const parsed = parseJsonLoose(text)
    if (parsed !== undefined) return parsed as T
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

/** 「保存并测试」用的一条极短请求；撞上「模型始终思考」就记住并去掉 thinking 重试一次 */
async function testMessage(target: Target, key: string): Promise<void> {
  const send = () =>
    requestChat(
      specFor(target.spec, target.model),
      { baseUrl: target.baseUrl, model: target.model, apiKey: key },
      {
        // 强制思考的模型会把 max_tokens 全花在推理上：给足 256，普通模型照样只回两三个 token
        messages: [{ role: 'user', content: '回复 ok' }],
        maxTokens: 256,
        timeoutMs: 20_000
      }
    )
  try {
    await send()
  } catch (err) {
    if (
      err instanceof AiError &&
      err.unknownParam &&
      /thinking|reasoning|思考|推理/i.test(err.message) &&
      target.spec.compat.reasoning
    ) {
      omitThinkingFor.add(modelKey(target.spec, target.model))
      await send()
      return
    }
    throw err
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
    await testMessage(target, key)
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
