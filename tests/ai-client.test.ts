import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings, setApiKey } from '../src/main/settings'
import { chat, testApiKey } from '../src/main/ai/client'

/**
 * 不联网地验证 P0 第二块：client.ts 已经接到 transport.ts 上。
 * 只断言"接线正确"（请求体形状、缓存/用量的 provider 维度、重试与不重试的分界），
 * 真正的网络行为在真机验收里跑。
 */

const realFetch = globalThis.fetch

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 }
})

interface StubCall {
  url: string
  init: { headers: Record<string, string>; body: string }
}

function stubFetch(
  handler: (call: { url: string; body: string }) => { status?: number; body: string }
): StubCall[] {
  const calls: StubCall[] = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const call = {
      url: String(url),
      init: init as StubCall['init']
    }
    calls.push(call)
    const result = handler({ url: call.url, body: String(call.init.body) })
    return new Response(result.body, {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
  return calls
}

const messages = [{ role: 'user', content: 'hi' }]

beforeAll(() => {
  const dataDir = app.getPath('userData')
  initSettings()
  setApiKey('sk-test-deepseek')
  openDb(path.join(dataDir, 'ai-client.db'))
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  closeDb()
})

describe('client → transport 接线（DeepSeek）', () => {
  it('请求体是 DeepSeek 形状，地址与 Authorization 正确', async () => {
    const calls = stubFetch(() => ({ body: OK_BODY }))
    const out = await chat({ messages, kind: 'judge', json: true, maxTokens: 300, temperature: 0 })

    expect(out).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test-deepseek')

    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.model).toBe('deepseek-flash')
    expect(body.max_tokens).toBe(300)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.temperature).toBe(0)
    expect(body.stream).toBe(false)
  })

  it('用量按 provider 入库，命中/未命中价格分开算', async () => {
    stubFetch(() => ({ body: OK_BODY }))
    await chat({ messages, kind: 'usage-check' })

    const row = getDb()
      .prepare(
        `SELECT provider, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd
         FROM ai_usage WHERE kind = 'usage-check' ORDER BY id DESC LIMIT 1`
      )
      .get() as unknown as {
      provider: string
      model: string
      prompt_tokens: number
      cached_tokens: number
      completion_tokens: number
      cost_usd: number
    }

    expect(row.provider).toBe('deepseek')
    expect(row.model).toBe('deepseek-flash')
    expect(row.prompt_tokens).toBe(100)
    expect(row.cached_tokens).toBe(40)
    expect(row.completion_tokens).toBe(20)
    // (60 * 0.15 + 40 * 0.003 + 20 * 0.6) / 1e6
    expect(row.cost_usd).toBeCloseTo(0.00002112, 10)
  })

  it('cacheKey 命中时不发第二次请求，缓存行带 provider', async () => {
    const calls = stubFetch(() => ({ body: OK_BODY }))
    await chat({ messages, kind: 'phonetic', cacheKey: 'k-cache' })
    await chat({ messages, kind: 'phonetic', cacheKey: 'k-cache' })

    expect(calls).toHaveLength(1)
    const row = getDb()
      .prepare("SELECT provider, model FROM ai_cache WHERE kind = 'phonetic' AND cache_key = 'k-cache'")
      .get() as unknown as { provider: string; model: string }
    expect(row.provider).toBe('deepseek')
    expect(row.model).toBe('deepseek-flash')
  })

  it('401 / 402 不重试，只请求一次', async () => {
    const calls = stubFetch(() => ({ status: 401, body: '{"error":{"message":"bad key"}}' }))
    await expect(chat({ messages, kind: 'judge' })).rejects.toThrow(/API Key 无效/)
    expect(calls).toHaveLength(1)

    const calls402 = stubFetch(() => ({ status: 402, body: '{}' }))
    await expect(chat({ messages, kind: 'judge' })).rejects.toThrow(/余额不足/)
    expect(calls402).toHaveLength(1)
  })

  it('其余错误仍重试（500 → 第二次成功）', async () => {
    let n = 0
    const calls = stubFetch(() => {
      n++
      return n === 1 ? { status: 500, body: 'boom' } : { body: OK_BODY }
    })
    await expect(chat({ messages, kind: 'judge' })).resolves.toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('testApiKey 走同一条链路：成功回显模型，401 给人话', async () => {
    stubFetch(() => ({ body: OK_BODY }))
    await expect(testApiKey()).resolves.toEqual({
      ok: true,
      message: '连接成功，Key 可用',
      model: 'deepseek-flash'
    })

    stubFetch(() => ({ status: 401, body: '{}' }))
    await expect(testApiKey()).resolves.toEqual({ ok: false, message: 'API Key 无效' })
  })
})
