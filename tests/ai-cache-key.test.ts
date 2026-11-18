import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../src/main/db/sqlite'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { getAiCache, setAiCache } from '../src/main/db/ai'

/**
 * P2 把 ai_cache 的唯一键从 (kind, cache_key) 换成 (provider, kind, cache_key)。
 * SQLite 改不了建表时的约束，只能重建表——用一份 P0/P1 形态的老库验证：
 * 1) 重建后约束对了；2) 老缓存行不丢；3) 同一 (kind, cache_key) 现在能按家共存。
 */

const dirs: string[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-cache-'))
  dirs.push(dir)
  return path.join(dir, 'wordmemo.db')
}

const LEGACY_CACHE = `
CREATE TABLE ai_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  model TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, cache_key)
);
INSERT INTO ai_cache (kind, cache_key, model, response_json, created_at)
  VALUES ('judge', 'k1', 'deepseek-flash', '{"a":1}', '2026-01-01T00:00:00');
`

function cacheSql(): string {
  const row = getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_cache'")
    .get() as unknown as { sql?: string }
  return row?.sql ?? ''
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

describe('ai_cache 唯一键迁移', () => {
  it('老库重建成 (provider, kind, cache_key)，老缓存不丢', () => {
    const file = tmpDb()
    const legacy = new DatabaseSync(file)
    legacy.exec(LEGACY_CACHE)
    legacy.close()

    openDb(file)

    expect(cacheSql()).toContain('UNIQUE(provider, kind, cache_key)')
    expect(getAiCache('deepseek', 'judge', 'k1')).toBe('{"a":1}')

    // 同一个 (kind, cache_key) 现在可以按家并存（旧约束下会被拒）
    setAiCache('openai', 'judge', 'k1', 'gpt-x', '{"b":2}')
    expect(getAiCache('openai', 'judge', 'k1')).toBe('{"b":2}')
    expect(getAiCache('deepseek', 'judge', 'k1')).toBe('{"a":1}')
  })

  it('新库不需要重建，打开两次也不会重复搬', () => {
    const file = tmpDb()
    openDb(file)
    expect(cacheSql()).toContain('UNIQUE(provider, kind, cache_key)')
    closeDb()

    setAiCacheSafe(file)
    expect(cacheSql()).toContain('UNIQUE(provider, kind, cache_key)')
  })
})

/** 写完缓存关掉再用 openDb 打开一次，确认迁移是幂等的 */
function setAiCacheSafe(file: string): void {
  openDb(file)
  setAiCache('deepseek', 'phonetic', 'k2', 'deepseek-flash', '{"c":3}')
  closeDb()
  openDb(file)
  expect(getAiCache('deepseek', 'phonetic', 'k2')).toBe('{"c":3}')
}
