import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type AiSettings, type Settings } from '../src/shared/types'
import { getSettings, initSettings, setApiKey, updateSettings } from '../src/main/settings'
import { aiAvailable } from '../src/main/ai/client'
import { ownedPatch } from '../src/renderer/src/lib/settingsPatch'

/**
 * P-09：界面按钮的可用性跟「Key + 模型」两条一起判断。
 * P-05：设置页改成改完自动保存，落盘范围必须只包含这一页的字段。
 */

const dataDir = app.getPath('userData')
const settingsPath = path.join(dataDir, 'settings.json')

const AI_CLEAN: AiSettings = { default: { provider: 'gemini' }, vision: null, providers: {} }

function configure(ai: Partial<AiSettings>): void {
  updateSettings({ ai: { ...AI_CLEAN, ...ai } })
}

beforeAll(() => {
  initSettings()
  setApiKey('gemini', 'sk-gemini-derived')
})

describe('P-09 可用性看 Key + 模型', () => {
  it('只填 Key 没选模型：modelSet / aiReady 都是 false，aiAvailable 也不放行', () => {
    configure({ default: { provider: 'gemini' }, providers: {} })

    const s = getSettings()
    expect(s.apiKeySet).toBe(true)
    expect(s.modelSet).toBe(false)
    expect(s.aiReady).toBe(false)
    expect(aiAvailable()).toBe(false)
  })

  it('补上模型后三个标记都变成 true', () => {
    configure({ default: { provider: 'gemini' }, providers: { gemini: { model: 'gemini-x' } } })

    const s = getSettings()
    expect(s.modelSet).toBe(true)
    expect(s.aiReady).toBe(true)
    expect(aiAvailable()).toBe(true)
  })

  it('DeepSeek 没填模型也有兜底名，不会被当成缺模型', () => {
    configure({ default: { provider: 'deepseek' }, providers: {} })
    expect(getSettings().modelSet).toBe(true)
  })

  it('派生标记不写进 settings.json', () => {
    configure({ default: { provider: 'gemini' }, providers: { gemini: { model: 'gemini-x' } } })

    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(raw.aiReady).toBeUndefined()
    expect(raw.modelSet).toBeUndefined()
    expect(raw.apiKeySet).toBeUndefined()
  })
})

describe('P-05 自动保存的落盘范围', () => {
  it('ownedPatch 只带本页字段，不覆盖当前库与派生标记', () => {
    const src: Settings = {
      ...DEFAULT_SETTINGS,
      currentDeckId: 7,
      apiKeySet: true,
      modelSet: true,
      aiReady: true,
      newPerDay: 33
    }

    const patch = ownedPatch(src)
    expect(patch.newPerDay).toBe(33)
    expect('currentDeckId' in patch).toBe(false)
    expect('apiKeySet' in patch).toBe(false)
    expect('modelSet' in patch).toBe(false)
    expect('aiReady' in patch).toBe(false)
  })
})
