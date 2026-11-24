import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 同步密钥的本机存储（PLAN-SYNC §3.5）：PAT 与口令只进 `safeStorage` 加密的文件，
 * **绝不进 settings.json、不进远端、不进日志、不进快照**。
 *
 * 文件：`<userData>/sync-secrets.bin`（整份加密；`safeStorage` 不可用时退化为 base64，
 * 和现有的 AI Key 存储保持同一策略——仍然只在用户目录里）。
 */

export interface SyncSecrets {
  token: string
  passphrase: string
}

function dataDir(): string {
  return process.env.WORDMEMO_DATA_DIR || app.getPath('userData')
}

function secretsPath(): string {
  return path.join(dataDir(), 'sync-secrets.bin')
}

function encryptText(text: string): string {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text).toString('base64')
  }
  return Buffer.from(text, 'utf8').toString('base64')
}

function decryptText(raw: string): string {
  const buf = Buffer.from(raw, 'base64')
  return safeStorage && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(buf)
    : buf.toString('utf8')
}

export function loadSyncSecrets(): SyncSecrets | null {
  try {
    const file = secretsPath()
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(decryptText(raw)) as Partial<SyncSecrets>
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : ''
    const passphrase = typeof parsed?.passphrase === 'string' ? parsed.passphrase : ''
    if (!token || !passphrase) return null
    return { token, passphrase }
  } catch {
    return null
  }
}

/** 保存（覆盖）；写失败返回 false，调用方要能告诉用户「钥匙没存住」 */
export function saveSyncSecrets(secrets: SyncSecrets): boolean {
  const token = secrets.token.trim()
  if (!token || !secrets.passphrase) return false
  try {
    const file = secretsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({ version: 1, token, passphrase: secrets.passphrase })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, encryptText(payload), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function clearSyncSecrets(): void {
  try {
    fs.unlinkSync(secretsPath())
  } catch {
    /* 文件本来就不存在 */
  }
}
