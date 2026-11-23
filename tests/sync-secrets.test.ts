import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearSyncSecrets,
  loadSyncSecrets,
  saveSyncSecrets
} from '../src/main/sync/secretStore'

// S2：PAT 与同步口令只进 safeStorage 加密的文件，不进 settings.json。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-syncsecret-'))
const previous = process.env.WORDMEMO_DATA_DIR

beforeAll(() => {
  process.env.WORDMEMO_DATA_DIR = dir
})

afterAll(() => {
  if (previous === undefined) delete process.env.WORDMEMO_DATA_DIR
  else process.env.WORDMEMO_DATA_DIR = previous
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('sync-secrets.bin', () => {
  it('保存后能读回；文件里不是明文 token', () => {
    expect(saveSyncSecrets({ token: 'ghp_secret_token_123', passphrase: 'correct horse battery' })).toBe(true)
    expect(loadSyncSecrets()).toEqual({
      token: 'ghp_secret_token_123',
      passphrase: 'correct horse battery'
    })
    const raw = fs.readFileSync(path.join(dir, 'sync-secrets.bin'), 'utf8')
    expect(raw).not.toContain('ghp_secret_token_123')
    expect(raw).not.toContain('correct horse battery')
  })

  it('空 token 不保存；清掉后读不到', () => {
    expect(saveSyncSecrets({ token: '   ', passphrase: 'correct horse battery' })).toBe(false)
    clearSyncSecrets()
    expect(loadSyncSecrets()).toBeNull()
  })

  it('文件被改坏：返回 null，不抛错', () => {
    fs.writeFileSync(path.join(dir, 'sync-secrets.bin'), 'not-json-at-all', 'utf8')
    expect(loadSyncSecrets()).toBeNull()
  })
})
