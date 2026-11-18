import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import {
  clearAllApiKeys,
  clearApiKey,
  getApiKey,
  hasApiKey,
  initSettings,
  setApiKey
} from '../src/main/settings'

/**
 * secrets.bin（P0 的单 Key）→ secrets.v2.json（多 Key）。
 * 测试里的 safeStorage 不可用，所以文件走 base64 退化路径，和没有 DPAPI 的机器一致。
 */

const dataDir = app.getPath('userData')
const legacyPath = path.join(dataDir, 'secrets.bin')
const v2Path = path.join(dataDir, 'secrets.v2.json')

function readV2(): { version: number; providers: Record<string, string> } {
  const raw = fs.readFileSync(v2Path, 'utf8').trim()
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
    version: number
    providers: Record<string, string>
  }
}

beforeAll(() => {
  fs.writeFileSync(legacyPath, Buffer.from('sk-legacy-key', 'utf8').toString('base64'), 'utf8')
  initSettings()
})

describe('旧 secrets.bin → secrets.v2.json', () => {
  it('第一次读 Key 时自动迁移，旧文件保留到「清除全部」', () => {
    expect(getApiKey('deepseek')).toBe('sk-legacy-key')
    expect(fs.existsSync(legacyPath)).toBe(true)

    const v2 = readV2()
    expect(v2.version).toBe(2)
    expect(v2.providers.deepseek).toBe('sk-legacy-key')
  })

  it('迁移只影响 deepseek，别家仍然是空的', () => {
    expect(getApiKey('openai')).toBeNull()
    expect(hasApiKey('openai')).toBe(false)
    expect(hasApiKey('deepseek')).toBe(true)
  })

  it('多家 Key 并存，写一家不会冲掉别家', () => {
    setApiKey('openai', 'sk-openai')
    setApiKey('glm', '  sk-glm  ')
    const v2 = readV2()
    expect(v2.providers).toMatchObject({
      deepseek: 'sk-legacy-key',
      openai: 'sk-openai',
      glm: 'sk-glm'
    })
  })

  it('清除一家只删这一家', () => {
    clearApiKey('openai')
    expect(getApiKey('openai')).toBeNull()
    expect(getApiKey('deepseek')).toBe('sk-legacy-key')
    expect(getApiKey('glm')).toBe('sk-glm')
  })

  it('清除全部：v2 与旧 secrets.bin 一起删掉', () => {
    clearAllApiKeys()
    expect(fs.existsSync(v2Path)).toBe(false)
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(getApiKey('deepseek')).toBeNull()
  })
})
