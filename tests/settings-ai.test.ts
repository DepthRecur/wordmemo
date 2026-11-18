import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { getSettings, initSettings, setApiKey, updateSettings } from '../src/main/settings'

/**
 * settings.ai 的深合并（PLAN-PROVIDERS §5）：
 * 老配置里没有 ai（或者只有一半），升级后不能丢字段，也不能把用户在用的顶层
 * model / baseUrl 弄坏——DeepSeek 的模型解析仍然回落到它们。
 */

const settingsPath = path.join(app.getPath('userData'), 'settings.json')

beforeAll(() => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      monthlyBudgetUsd: 2,
      ai: { default: { provider: 'glm' }, providers: { glm: { model: 'glm-4-flash' } } }
    }),
    'utf8'
  )
  initSettings()
})

describe('settings.ai 深合并', () => {
  it('缺的字段按默认补全，已有的字段不被覆盖', () => {
    const s = getSettings()
    expect(s.ai.default.provider).toBe('glm')
    expect(s.ai.vision).toBeNull()
    expect(s.ai.providers.glm?.model).toBe('glm-4-flash')
    // 旧顶层字段仍保留：DeepSeek 的模型解析要回落到它
    expect(s.model).toBe('deepseek-chat')
    expect(s.monthlyBudgetUsd).toBe(2)
  })

  it('apiKeySet 跟随默认角色那家', () => {
    setApiKey('deepseek', 'sk-deepseek')
    updateSettings({})
    // 默认是 glm，而 glm 还没 Key
    expect(getSettings().apiKeySet).toBe(false)

    setApiKey('glm', 'sk-glm')
    updateSettings({})
    expect(getSettings().apiKeySet).toBe(true)
  })

  it('vision 显式 null 与缺省不是一回事', () => {
    updateSettings({ ai: { ...getSettings().ai, vision: null } })
    expect(getSettings().ai.vision).toBeNull()

    updateSettings({ ai: { ...getSettings().ai, vision: { provider: 'openai' } } })
    expect(getSettings().ai.vision).toMatchObject({ provider: 'openai' })
  })

  it('改一家的配置不会冲掉别家', () => {
    updateSettings({
      ai: {
        ...getSettings().ai,
        providers: { ...getSettings().ai.providers, gemini: { model: 'gemini-2.0-flash' } }
      }
    })
    const s = getSettings()
    expect(s.ai.providers.glm?.model).toBe('glm-4-flash')
    expect(s.ai.providers.gemini?.model).toBe('gemini-2.0-flash')
  })
})
