import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AiProviderId, AiSettings, Settings, SettingsPatch } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { resolveProviderModel } from '@shared/aiModel'

let cache: Settings | null = null
/** provider → Key；明文只存在内存里，落盘是整份加密的 secrets.v2.json */
let keyCache: Map<string, string> | null = null

function baseDir(): string {
  return process.env.WORDMEMO_DATA_DIR || app.getPath('userData')
}

function settingsPath(): string {
  return path.join(baseDir(), 'settings.json')
}

function secretsPath(): string {
  return path.join(baseDir(), 'secrets.v2.json')
}

/** P0 及以前的单 Key 文件：只在迁移时读，用户点「清除全部」才删 */
function legacySecretPath(): string {
  return path.join(baseDir(), 'secrets.bin')
}

function encryptText(text: string): string {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text).toString('base64')
  }
  // 系统安全存储不可用时退化为 base64；仍只保存在本机用户目录
  return Buffer.from(text, 'utf8').toString('base64')
}

function decryptText(raw: string): string {
  const buf = Buffer.from(raw, 'base64')
  return safeStorage && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(buf)
    : buf.toString('utf8')
}

/** 读 secrets.v2.json；文件不存在或解不开都返回 null */
function readKeysFile(): Map<string, string> | null {
  try {
    if (!fs.existsSync(secretsPath())) return null
    const raw = fs.readFileSync(secretsPath(), 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(decryptText(raw)) as { providers?: Record<string, string> }
    const keys = new Map<string, string>()
    for (const [id, key] of Object.entries(parsed?.providers ?? {})) {
      if (typeof key === 'string' && key.trim()) keys.set(id, key.trim())
    }
    return keys
  } catch {
    return null
  }
}

function readLegacyKey(): string | null {
  try {
    if (!fs.existsSync(legacySecretPath())) return null
    const raw = fs.readFileSync(legacySecretPath(), 'utf8').trim()
    if (!raw) return null
    return decryptText(raw).trim() || null
  } catch {
    return null
  }
}

/** 临时文件 + rename：并发保存不会写坏；Windows 上 rename 是替换式原子操作 */
function writeKeys(keys: Map<string, string>): void {
  const file = secretsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({ version: 2, providers: Object.fromEntries(keys) })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, encryptText(payload), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 读 Key：优先 secrets.v2.json；只有旧 secrets.bin 时顺手迁移一份
 * （旧文件保留，直到用户点「清除全部」——迁移失败也不至于丢 Key）。
 */
function loadKeys(): Map<string, string> {
  if (keyCache) return keyCache
  const current = readKeysFile()
  if (current) {
    keyCache = current
    return current
  }
  const keys = new Map<string, string>()
  const legacy = readLegacyKey()
  if (legacy) {
    keys.set('deepseek', legacy)
    try {
      writeKeys(keys)
    } catch {
      /* 迁移失败就先用内存里的，至少本次会话可用 */
    }
  }
  keyCache = keys
  return keys
}

function mergeAi(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const base = DEFAULT_SETTINGS.ai
  const providers: AiSettings['providers'] = {}
  for (const [id, cfg] of Object.entries(raw?.providers ?? {})) {
    if (!cfg) continue
    providers[id as AiProviderId] = { ...(base.providers[id as AiProviderId] ?? {}), ...cfg }
  }
  // vision 显式写成 null 表示"跟随默认"，不能当成缺省值合并掉
  const vision =
    raw && Object.prototype.hasOwnProperty.call(raw, 'vision')
      ? raw.vision
        ? { ...base.default, ...raw.vision }
        : null
      : base.vision
  return {
    default: { ...base.default, ...(raw?.default ?? {}) },
    vision,
    providers
  }
}

function merge(raw: Partial<Settings> | null): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  merged.quietHours = { ...DEFAULT_SETTINGS.quietHours, ...(raw?.quietHours ?? {}) }
  merged.reminders = Array.isArray(raw?.reminders) ? raw!.reminders! : [...DEFAULT_SETTINGS.reminders]
  merged.ttsSources = Array.isArray(raw?.ttsSources) && raw!.ttsSources!.length
    ? raw!.ttsSources!
    : [...DEFAULT_SETTINGS.ttsSources]
  // `ai` 是浅合并的例外：必须深合并，否则老配置一升级就丢字段（PLAN-PROVIDERS §5）
  merged.ai = mergeAi(raw?.ai)
  // 当前库：文件被手改/删库后可能留下不存在的 id，先归一化成合法数字
  const deckId = Number((raw as { currentDeckId?: unknown } | null)?.currentDeckId)
  merged.currentDeckId = Number.isInteger(deckId) && deckId > 0 ? deckId : DEFAULT_SETTINGS.currentDeckId
  // 界面上「是否已配置 Key」跟随默认角色用的那家
  merged.apiKeySet = hasApiKey(merged.ai.default.provider)
  return refreshDerived(merged)
}

/** 派生字段（不落盘）：改了 Key/模型/角色之后要跟着重算 */
function refreshDerived(s: Settings): Settings {
  const provider = s.ai.default.provider
  s.apiKeySet = hasApiKey(provider)
  s.modelSet = !!resolveProviderModel(s.ai, provider, s.ai.default, s.model)
  s.aiReady = s.apiKeySet && s.modelSet
  return s
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
  return refreshDerived(cache)
}

export function updateSettings(patch: SettingsPatch): Settings {
  const next = merge({ ...getSettings(), ...patch })
  // 派生字段只给界面看，不写进 settings.json
  const { apiKeySet: _apiKeySet, modelSet: _modelSet, aiReady: _aiReady, ...persisted } = next
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(persisted, null, 2), 'utf8')
  cache = next
  return next
}

export function hasApiKey(provider: AiProviderId = 'deepseek'): boolean {
  return !!loadKeys().get(provider)
}

export function setApiKey(provider: AiProviderId, key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) return false
  const keys = new Map(loadKeys())
  keys.set(provider, trimmed)
  try {
    writeKeys(keys)
  } catch {
    return false
  }
  keyCache = keys
  if (cache) refreshDerived(cache)
  return true
}

export function getApiKey(provider: AiProviderId = 'deepseek'): string | null {
  return loadKeys().get(provider) ?? null
}

export function clearApiKey(provider: AiProviderId = 'deepseek'): void {
  const keys = new Map(loadKeys())
  if (!keys.delete(provider)) return
  try {
    writeKeys(keys)
  } catch {
    /* ignore */
  }
  keyCache = keys
  if (cache) refreshDerived(cache)
}

/** 「清除全部」：secrets.v2.json 与旧的 secrets.bin 一起删 */
export function clearAllApiKeys(): void {
  keyCache = new Map()
  for (const file of [secretsPath(), legacySecretPath()]) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
  if (cache) refreshDerived(cache)
}
