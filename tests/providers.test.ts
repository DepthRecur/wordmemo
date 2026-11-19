import { describe, expect, it } from 'vitest'
import { chatEndpoint, PROVIDERS, modelsEndpoint } from '../src/main/ai/providers'
import {
  buildChatBody,
  normalizeHttpError,
  parseChatResponse
} from '../src/main/ai/transport'

const ds = PROVIDERS.deepseek
const oa = PROVIDERS.openai
const gm = PROVIDERS.gemini
const glm = PROVIDERS.glm

const messages = [{ role: 'user', content: 'hi' }]

describe('供应商表', () => {
  it('四家的端点拼接正确（容忍尾部斜杠）', () => {
    expect(chatEndpoint(ds)).toBe('https://api.deepseek.com/chat/completions')
    expect(chatEndpoint(oa)).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatEndpoint(gm)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    )
    expect(chatEndpoint(glm)).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(modelsEndpoint(ds, 'https://api.deepseek.com/')).toBe('https://api.deepseek.com/models')
  })
})

describe('请求体装配', () => {
  it('DeepSeek：默认关闭 thinking，用 max_tokens，json 时带 response_format', () => {
    const body = buildChatBody(ds, { model: 'deepseek-flash' }, { messages, json: true, maxTokens: 300 })
    expect(body.model).toBe('deepseek-flash')
    expect(body.max_tokens).toBe(300)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.stream).toBe(false)
  })

  it('DeepSeek：thinking 打开时是 enabled', () => {
    const body = buildChatBody(ds, { model: 'm' }, { messages, thinking: true })
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('GLM：不需要思考时不发 thinking（强制思考模型会拒绝 disabled）', () => {
    expect(buildChatBody(glm, { model: 'glm-5.3-flash' }, { messages }).thinking).toBeUndefined()
    expect(
      buildChatBody(glm, { model: 'glm-5.3-flash' }, { messages, thinking: true }).thinking
    ).toEqual({ type: 'enabled' })
  })

  it('OpenAI：用 max_completion_tokens，不发 thinking；thinking 才发 reasoning_effort', () => {
    const plain = buildChatBody(oa, { model: 'gpt-x' }, { messages, maxTokens: 500 })
    expect(plain.max_completion_tokens).toBe(500)
    expect(plain.max_tokens).toBeUndefined()
    expect(plain.thinking).toBeUndefined()
    expect(plain.reasoning_effort).toBeUndefined()

    const reasoning = buildChatBody(oa, { model: 'gpt-x' }, { messages, thinking: true })
    expect(reasoning.reasoning_effort).toBe('low')
  })

  it('Gemini：兼容层未验证 JSON 模式，不发 response_format', () => {
    const body = buildChatBody(gm, { model: 'gemini-x' }, { messages, json: true })
    expect(body.response_format).toBeUndefined()
    expect(body.max_tokens).toBe(2000)
  })

  it('temperature 只在给了数值时发送', () => {
    expect(buildChatBody(ds, { model: 'm' }, { messages }).temperature).toBeUndefined()
    expect(buildChatBody(ds, { model: 'm' }, { messages, temperature: 0 }).temperature).toBe(0)
  })
})

describe('响应解析', () => {
  const ok = (usage: string) =>
    `{"choices":[{"message":{"content":"ok"}}],${usage}}`

  it('DeepSeek 的缓存命中字段', () => {
    const r = parseChatResponse(
      ds,
      ok('"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":40}')
    )
    expect(r.content).toBe('ok')
    expect(r.usage).toEqual({ promptTokens: 100, cachedTokens: 40, completionTokens: 20 })
  })

  it('OpenAI 的 cached_tokens 在 prompt_tokens_details 里', () => {
    const r = parseChatResponse(
      oa,
      ok('"usage":{"prompt_tokens":80,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":30}}')
    )
    expect(r.usage.cachedTokens).toBe(30)
  })

  it('没有 usage 字段也不崩', () => {
    const r = parseChatResponse(gm, '{"choices":[{"message":{"content":"hi"}}]}')
    expect(r.usage).toEqual({ promptTokens: 0, cachedTokens: 0, completionTokens: 0 })
  })

  it('HTTP 200 里的业务错误要拦下来', () => {
    expect(() => parseChatResponse(glm, '{"error_code":336006,"error_message":"bad"}')).toThrow(
      /返回错误/
    )
  })

  it('空内容报错而不是返回空串', () => {
    expect(() => parseChatResponse(ds, '{"choices":[{"message":{"content":"   "}}]}')).toThrow(
      /空内容/
    )
  })
})

describe('错误归一化', () => {
  it('401/403 不可重试，文案带 provider 名', () => {
    const e = normalizeHttpError(oa, 401, '{"error":{"message":"bad key"}}')
    expect(e.message).toContain('OpenAI')
    expect(e.retryable).toBe(false)
  })

  it('402 或余额文案 → 余额不足', () => {
    expect(normalizeHttpError(ds, 402, '').message).toContain('余额不足')
    expect(normalizeHttpError(glm, 400, '{"error":{"message":"Insufficient Balance"}}').message).toContain(
      '余额不足'
    )
  })

  it('429/5xx 可重试', () => {
    expect(normalizeHttpError(ds, 429, '').retryable).toBe(true)
    expect(normalizeHttpError(ds, 503, '').retryable).toBe(true)
  })

  it('400 未知参数标记 unknownParam，供上层降级重试', () => {
    const e = normalizeHttpError(oa, 400, '{"error":{"message":"Unknown parameter: thinking"}}')
    expect(e.unknownParam).toBe(true)
    expect(e.retryable).toBe(false)
  })

  it('中文的「不支持…」也算 unknownParam（GLM 的「不支持关闭思考」）', () => {
    const e = normalizeHttpError(
      glm,
      400,
      '{"error":{"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}}'
    )
    expect(e.unknownParam).toBe(true)
  })
})
