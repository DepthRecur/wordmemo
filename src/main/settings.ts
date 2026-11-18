import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings, SettingsPatch } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

let cache: Settings | null = null
let apiKeyCache: string | null = null

function baseDir(): string {
  return process.env.WORDMEMO_DATA_DIR || app.getPath('userData')
}

function settingsPath(): string {
  return path.join(baseDir(), 'settings.json')
}

function secretPath(): string {
  return path.join(baseDir(), 'secrets.bin')
}

function merge(raw: Partial<Settings> | null): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  merged.quietHours = { ...DEFAULT_SETTINGS.quietHours, ...(raw?.quietHours ?? {}) }
  merged.reminders = Array.isArray(raw?.reminders) ? raw!.reminders! : [...DEFAULT_SETTINGS.reminders]
  merged.ttsSources = Array.isArray(raw?.ttsSources) && raw!.ttsSources!.length
    ? raw!.ttsSources!
    : [...DEFAULT_SETTINGS.ttsSources]
  merged.apiKeySet = hasApiKey()
  return merged
}

export function initSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    cache = merge(raw)
  } catch {
    cache = merge(null)
  }
  return cache
}

export function getSettings(): Settings {
  if (!cache) cache = initSettings()
  cache.apiKeySet = hasApiKey()
  return cache
}

export function updateSettings(patch: SettingsPatch): Settings {
  const next = merge({ ...getSettings(), ...patch })
  const { apiKeySet: _ignored, ...persisted } = next
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(persisted, null, 2), 'utf8')
  cache = next
  return next
}

export function hasApiKey(): boolean {
  try {
    return fs.existsSync(secretPath()) && fs.statSync(secretPath()).size > 0
  } catch {
    return false
  }
}

export function setApiKey(key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) return false
  fs.mkdirSync(path.dirname(secretPath()), { recursive: true })
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(trimmed)
    fs.writeFileSync(secretPath(), encrypted.toString('base64'), 'utf8')
  } else {
    // 系统安全存储不可用时退化为 base64；仍只保存在本机用户目录
    fs.writeFileSync(secretPath(), Buffer.from(trimmed, 'utf8').toString('base64'), 'utf8')
  }
  apiKeyCache = trimmed
  if (cache) cache.apiKeySet = true
  return true
}

export function getApiKey(): string | null {
  if (apiKeyCache) return apiKeyCache
  try {
    if (!fs.existsSync(secretPath())) return null
    const raw = fs.readFileSync(secretPath(), 'utf8').trim()
    if (!raw) return null
    const buf = Buffer.from(raw, 'base64')
    apiKeyCache = safeStorage && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    return apiKeyCache
  } catch {
    return null
  }
}

export function clearApiKey(): void {
  apiKeyCache = null
  try {
    fs.unlinkSync(secretPath())
  } catch {
    /* ignore */
  }
  if (cache) cache.apiKeySet = false
}
