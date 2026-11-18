import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db/connection'
import { replaceCatalog, writeRemotePricing } from '../src/main/db/ai'
import { initSettings } from '../src/main/settings'
import { aiSettingsInfo } from '../src/main/ai/info'
import { knownModels, refreshPricing } from '../src/main/ai/pricing'

/**
 * 模型下拉框的候选：只来自 /models 目录；公开名按 API → models.dev → id 合并。
 * 这里不测 UI，只测喂给 UI 的那份数据对不对。
 */

const dirs: string[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-models-'))
  dirs.push(dir)
  return path.join(dir, 'wordmemo.db')
}

afterEach(() => {
  closeDb()
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function provider(id: 'deepseek' | 'openai' | 'gemini' | 'glm') {
  const info = aiSettingsInfo().providers.find((p) => p.id === id)
  if (!info) throw new Error(`没有 ${id}`)
  return info
}

describe('模型列表：只来自 /models，名字三级合并', () => {
  it('API 自报的名字优先（deepseek-flash → DeepSeek-V4.1-Flash）', () => {
    openDb(tmpDb())
    initSettings()
    replaceCatalog(
      'deepseek',
      [{ id: 'deepseek-flash', payload: { name: 'DeepSeek-V4.1-Flash' } }],
      '2026-11-19T08:00:00'
    )
    const p = provider('deepseek')
    expect(p.models).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', priced: true, input: 0.15, output: 0.6 }
    ])
  })

  it('目录只给 id 时用 models.dev 的公开名（OpenAI）', () => {
    openDb(tmpDb())
    initSettings()
    replaceCatalog('openai', [{ id: 'gpt-5', payload: { name: 'gpt-5' } }], '2026-11-19T08:00:00')
    const model = provider('openai').models[0]
    expect(model.id).toBe('gpt-5')
    expect(model.name).toBe('GPT-5')
    expect(model.priced).toBe(true)
  })

  it('目录里有、价格目录里没有 → 费用未知（不是 0 价）', () => {
    openDb(tmpDb())
    initSettings()
    replaceCatalog(
      'glm',
      [{ id: 'glm-unknown-preview', payload: { name: 'GLM 神秘预览版' } }],
      '2026-11-19T08:00:00'
    )
    expect(provider('glm').models[0]).toMatchObject({
      id: 'glm-unknown-preview',
      name: 'GLM 神秘预览版',
      priced: false,
      input: null,
      output: null
    })
  })

  it('目录没拉过就是空列表（不拿内置快照冒充）', () => {
    openDb(tmpDb())
    initSettings()
    expect(provider('gemini').models).toEqual([])
    expect(provider('openai').models).toEqual([])
  })

  it('远程价格目录里的名字会覆盖快照名', () => {
    openDb(tmpDb())
    initSettings()
    writeRemotePricing(
      'openai',
      { models: { 'gpt-5': { name: 'GPT-5 (2026-11)', input: 1, output: 2 } } },
      '2026-11-19T08:00:00'
    )
    replaceCatalog('openai', [{ id: 'gpt-5', payload: { name: 'gpt-5' } }], '2026-11-19T08:00:00')
    expect(provider('openai').models[0]).toMatchObject({
      name: 'GPT-5 (2026-11)',
      input: 1,
      output: 2
    })
  })
})

describe('价格刷新的名字保留', () => {
  it('从 models.dev 刷新时把 name 一起存下来', async () => {
    openDb(tmpDb())
    initSettings()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          deepseek: {
            models: { 'deepseek-flash': { name: 'DeepSeek V4.1 Flash', cost: { input: 0.1, output: 0.5 } } }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
    try {
      const result = await refreshPricing(true)
      expect(result.ok).toBe(true)
      expect(result.updated).toBe(true)
      expect(knownModels('deepseek')['deepseek-flash']).toMatchObject({
        name: 'DeepSeek V4.1 Flash',
        price: { priced: true, input: 0.1, output: 0.5, source: 'catalog' }
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
