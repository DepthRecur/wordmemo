import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { logAiUsage, monthAiCost, monthAiUsageByProvider, writeRemotePricing } from '../src/main/db/ai'
import { estimateCostUsd, priceFor, snapshotInfo } from '../src/main/ai/pricing'
import { parseModels } from '../src/main/ai/catalog'
import { overBudget } from '../src/main/ai/client'
import { initSettings, updateSettings } from '../src/main/settings'

const dirs: string[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-price-'))
  dirs.push(dir)
  return path.join(dir, 'wordmemo.db')
}

afterEach(() => {
  closeDb()
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
})

describe('价格：远程目录 → 随包快照 → 未知', () => {
  it('快照里有 deepseek-flash，且和旧硬编码一致', () => {
    openDb(tmpDb())
    const price = priceFor('deepseek', 'deepseek-flash')
    expect(price).toMatchObject({
      priced: true,
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      source: 'snapshot'
    })
    expect(price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('目录里的模型是 4 家都有的（不是只裁了 DeepSeek）', () => {
    openDb(tmpDb())
    expect(priceFor('openai', 'gpt-4o-2024-08-06').priced).toBe(true)
    expect(priceFor('gemini', 'gemini-2.5-flash').priced).toBe(true)
    expect(priceFor('glm', 'glm-4.7').priced).toBe(true)
  })

  it('未知模型不猜价：priced:false，金额 0', () => {
    openDb(tmpDb())
    const price = priceFor('openai', 'no-such-model-xyz')
    expect(price).toMatchObject({ priced: false, source: 'none', asOf: null, input: 0, output: 0 })
    expect(
      estimateCostUsd(price, { promptTokens: 1000, cachedTokens: 0, completionTokens: 500 })
    ).toBe(0)
  })

  it('远程目录比随包快照优先，并带上数据日期', () => {
    openDb(tmpDb())
    writeRemotePricing(
      'deepseek',
      { models: { 'deepseek-flash': { input: 9, output: 9, cacheRead: 1 } } },
      '2026-11-20T08:00:00'
    )
    const price = priceFor('deepseek', 'deepseek-flash')
    expect(price).toMatchObject({ priced: true, input: 9, output: 9, cacheRead: 1, source: 'catalog' })
    expect(price.asOf).toBe('2026-11-20')
  })

  it('费用估算：命中/未命中分开算', () => {
    openDb(tmpDb())
    const price = priceFor('deepseek', 'deepseek-flash')
    // 60 * 0.15 + 40 * 0.003 + 20 * 0.6 = 21.12 → /1e6
    expect(
      estimateCostUsd(price, { promptTokens: 100, cachedTokens: 40, completionTokens: 20 })
    ).toBeCloseTo(0.00002112, 12)
  })

  it('快照信息带来源与日期（设置页要显示）', () => {
    const info = snapshotInfo()
    expect(info.source).toBe('models.dev')
    expect(info.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('模型目录解析', () => {
  it('OpenAI 形状 { data: [{id}] }', () => {
    expect(parseModels('openai', '{"data":[{"id":"gpt-x"},{"id":"gpt-y"}]}')).toEqual([
      { id: 'gpt-x', name: 'gpt-x' },
      { id: 'gpt-y', name: 'gpt-y' }
    ])
  })

  it('Gemini 形状：去掉 models/ 前缀，只留能 generateContent 的', () => {
    const text = JSON.stringify({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/embedding-001',
          supportedGenerationMethods: ['embedContent']
        },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }
      ]
    })
    const models = parseModels('google', text)
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(models[0].name).toBe('Gemini 2.5 Flash')
  })

  it('坏 JSON 返回空数组，不抛', () => {
    expect(parseModels('openai', 'not json')).toEqual([])
    expect(parseModels('google', '{}')).toEqual([])
  })
})

describe('用量：未定价调用与预算', () => {
  it('未定价调用只记 token，不混进金额', () => {
    openDb(tmpDb())
    logAiUsage({
      provider: 'openai',
      kind: 'judge',
      model: 'mystery-model',
      promptTokens: 100,
      cachedTokens: 0,
      completionTokens: 50,
      costUsd: 0,
      costSource: 'none'
    })
    logAiUsage({
      provider: 'deepseek',
      kind: 'judge',
      model: 'deepseek-flash',
      promptTokens: 100,
      cachedTokens: 0,
      completionTokens: 50,
      costUsd: 0.001,
      costSource: 'snapshot',
      pricedAt: '2026-11-18'
    })

    const month = monthAiCost()
    expect(month.cost).toBeCloseTo(0.001, 10)
    expect(month.unpricedCalls).toBe(1)
    expect(month.calls).toBe(2)
    expect(month.tokens).toBe(300)

    const rows = getDb()
      .prepare('SELECT cost_source, priced_at FROM ai_usage ORDER BY id')
      .all() as unknown as { cost_source: string | null; priced_at: string | null }[]
    expect(rows.map((r) => r.cost_source)).toEqual(['none', 'snapshot'])
    expect(rows[1].priced_at).toBe('2026-11-18')
  })

  it('这个月有未定价调用时，预算按 token 上限兜底', () => {
    openDb(tmpDb())
    initSettings()
    updateSettings({ monthlyBudgetUsd: 1 })
    // $1 ≈ 200 万 token 的粗估上限
    logAiUsage({
      provider: 'openai',
      kind: 'judge',
      model: 'mystery-model',
      promptTokens: 1_000_000,
      cachedTokens: 0,
      completionTokens: 1_200_000,
      costUsd: 0,
      costSource: 'none'
    })
    expect(overBudget()).toBe(true)
  })

  it('没有未定价调用时，只看金额', () => {
    openDb(tmpDb())
    initSettings()
    updateSettings({ monthlyBudgetUsd: 1 })
    logAiUsage({
      provider: 'deepseek',
      kind: 'judge',
      model: 'deepseek-flash',
      promptTokens: 1_000_000,
      cachedTokens: 0,
      completionTokens: 1_000_000,
      costUsd: 0.5,
      costSource: 'snapshot'
    })
    expect(overBudget()).toBe(false)
  })

  it('按供应商拆用量（统计页「钱花在哪家」）', () => {
    openDb(tmpDb())
    logAiUsage({
      provider: 'deepseek',
      kind: 'judge',
      model: 'deepseek-flash',
      promptTokens: 100,
      cachedTokens: 0,
      completionTokens: 50,
      costUsd: 0.02,
      costSource: 'catalog'
    })
    logAiUsage({
      provider: 'glm',
      kind: 'struct',
      model: 'glm-4.7',
      promptTokens: 100,
      cachedTokens: 0,
      completionTokens: 50,
      costUsd: 0.05,
      costSource: 'snapshot'
    })
    logAiUsage({
      provider: 'deepseek',
      kind: 'judge',
      model: 'deepseek-flash',
      promptTokens: 100,
      cachedTokens: 0,
      completionTokens: 50,
      costUsd: 0.01,
      costSource: 'catalog'
    })

    const byProvider = monthAiUsageByProvider()
    expect(byProvider.map((r) => r.provider)).toEqual(['glm', 'deepseek'])
    expect(byProvider[0]).toMatchObject({ provider: 'glm', calls: 1 })
    expect(byProvider[0].cost).toBeCloseTo(0.05, 10)
    expect(byProvider[1]).toMatchObject({ provider: 'deepseek', calls: 2 })
    expect(byProvider[1].cost).toBeCloseTo(0.03, 10)
  })
})
