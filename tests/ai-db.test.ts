import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../src/main/db/sqlite'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { getAiCache, logAiUsage, monthAiCost, setAiCache } from '../src/main/db/ai'

const dirs: string[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-ai-'))
  dirs.push(dir)
  return path.join(dir, 'wordmemo.db')
}

function columns(table: string): string[] {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return rows.map((c) => c.name)
}

/** P0 第一版（多供应商之前）的 ai_cache / ai_usage */
const LEGACY_AI_TABLES = `
CREATE TABLE ai_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  model TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, cache_key)
);
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);
INSERT INTO ai_cache (kind, cache_key, model, response_json, created_at)
  VALUES ('judge', 'k1', 'deepseek-flash', '{"ok":1}', '2026-01-01T00:00:00');
INSERT INTO ai_usage (at, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd)
  VALUES ('2026-01-01T00:00:00', 'judge', 'deepseek-flash', 100, 40, 20, 0.001);
`

afterEach(() => {
  closeDb()
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉，留给系统临时目录 */
    }
  }
})

describe('ai_cache / ai_usage 的 provider 维度', () => {
  it('新建的库直接带 provider 列', () => {
    openDb(tmpDb())
    expect(columns('ai_cache')).toContain('provider')
    expect(columns('ai_usage')).toContain('provider')
  })

  it('缓存按 provider 分区：A 家的答案不会被当成 B 家的', () => {
    openDb(tmpDb())
    setAiCache('deepseek', 'judge', 'k1', 'deepseek-flash', '{"ok":1}')
    expect(getAiCache('deepseek', 'judge', 'k1')).toBe('{"ok":1}')
    expect(getAiCache('openai', 'judge', 'k1')).toBeNull()
  })

  it('用量记下 provider，月度汇总仍然把各家加在一起', () => {
    openDb(tmpDb())
    const base = {
      kind: 'judge',
      model: 'm',
      promptTokens: 100,
      cachedTokens: 10,
      completionTokens: 20
    }
    logAiUsage({ provider: 'deepseek', ...base, costUsd: 0.25 })
    logAiUsage({ provider: 'openai', ...base, costUsd: 0.5 })

    const rows = getDb()
      .prepare('SELECT provider FROM ai_usage ORDER BY id')
      .all() as unknown as { provider: string }[]
    expect(rows.map((r) => r.provider)).toEqual(['deepseek', 'openai'])

    const month = monthAiCost()
    expect(month.calls).toBe(2)
    expect(month.cost).toBeCloseTo(0.75, 10)
  })

  it('老库迁移：补上 provider 列，并把已有行回填 deepseek', () => {
    const file = tmpDb()
    const legacy = new DatabaseSync(file)
    legacy.exec(LEGACY_AI_TABLES)
    legacy.close()

    openDb(file)

    expect(columns('ai_cache')).toContain('provider')
    expect(columns('ai_usage')).toContain('provider')
    const cacheRow = getDb().prepare('SELECT provider FROM ai_cache').get() as unknown as {
      provider: string
    }
    expect(cacheRow.provider).toBe('deepseek')
    const usageRow = getDb().prepare('SELECT provider FROM ai_usage').get() as unknown as {
      provider: string
    }
    expect(usageRow.provider).toBe('deepseek')

    // 回填之后老缓存还能按 deepseek 命中
    expect(getAiCache('deepseek', 'judge', 'k1')).toBe('{"ok":1}')
  })

  it('重复打开同一个库不会重复加列', () => {
    const file = tmpDb()
    openDb(file)
    closeDb()
    openDb(file)
    expect(columns('ai_cache').filter((c) => c === 'provider')).toHaveLength(1)
    expect(columns('ai_usage').filter((c) => c === 'provider')).toHaveLength(1)
  })
})
