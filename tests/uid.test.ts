import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { copyNotes, createNote } from '../src/main/db/notes'
import { upsertItem } from '../src/main/db/items'
import { applyReview } from '../src/main/db/cards'
import { createExam } from '../src/main/db/exams'
import { SCHEMA_VERSION } from '../src/main/db/schema'

// PLAN-SYNC §3.2 / HANDOFF-SYNC §3.1：notes / items / reviews / exams 的 uid。
// 重点不是「新行有 uid」，而是**老库迁移后每一行都有 uid 且互不相同**——
// SQLite 的唯一索引允许多个 NULL，只加列不回填等于没有 uid。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-uid-'))
const dbFile = path.join(dir, 'uid.db')
const UID_TABLES = ['notes', 'items', 'reviews', 'exams'] as const
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function count(table: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number }
  return Number(row?.c ?? 0)
}

function firstCardId(itemId: number): number {
  const row = getDb()
    .prepare('SELECT id FROM cards WHERE item_id = ? ORDER BY id ASC LIMIT 1')
    .get(itemId) as { id?: number } | undefined
  return Number(row?.id ?? 0)
}

/** 用真实写入口造一批数据（这样迁移测试面对的是生产形状的行） */
function seed(): void {
  const noteId = createNote({ title: '旧笔记', tags: ['旧'], rawMarkdown: '# 旧' })
  const itemId = upsertItem({
    kind: 'word',
    headword: 'legacy',
    meanings: ['旧的'],
    noteId,
    position: 0,
    listenEnabled: false
  })
  applyReview({
    cardId: firstCardId(itemId),
    rating: 3,
    answer: 'legacy',
    correct: true,
    elapsedMs: 1200,
    mode: 'longterm',
    judgeBy: 'self'
  })
  createExam({
    title: '听写',
    examDate: '2026-12-01',
    scope: {},
    level: 'dictate',
    targetRetention: 0.95,
    dailyMinutes: 20
  })
}

/** 把库退回 v2：去掉 uid 列与索引（SQLite ≥ 3.35 支持 DROP COLUMN） */
function downgradeToV2(): void {
  const d = getDb()
  for (const table of UID_TABLES) {
    d.exec(`DROP INDEX IF EXISTS ux_${table}_uid`)
    d.exec(`ALTER TABLE ${table} DROP COLUMN uid`)
  }
  d.exec('PRAGMA user_version = 2')
}

function userVersion(): number {
  const row = getDb().prepare('PRAGMA user_version').get() as { user_version?: number }
  return Number(row?.user_version ?? 0)
}

describe('uid 迁移（v2 → v3）', () => {
  it('老库回填后每行都有 26 位 uid、互不相同，行数不变', () => {
    seed()
    const before = Object.fromEntries(UID_TABLES.map((t) => [t, count(t)]))
    for (const table of UID_TABLES) expect(before[table]).toBeGreaterThan(0)

    downgradeToV2()
    closeDb()
    openDb(dbFile)

    expect(userVersion()).toBe(SCHEMA_VERSION)
    for (const table of UID_TABLES) {
      // 行数不变：迁移只加不删
      expect(count(table)).toBe(before[table])
      const missing = getDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE uid IS NULL OR uid = ''`)
        .get() as { c?: number }
      expect(Number(missing?.c ?? 0)).toBe(0)

      const rows = getDb().prepare(`SELECT uid FROM ${table}`).all() as unknown as { uid: string }[]
      for (const row of rows) expect(ULID.test(row.uid)).toBe(true)
      expect(new Set(rows.map((row) => row.uid)).size).toBe(rows.length)

      const index = getDb()
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(`ux_${table}_uid`)
      expect(index).toBeTruthy()
    }
  })

  it('uid 唯一索引真的拦重复', () => {
    const row = getDb().prepare('SELECT uid FROM exams LIMIT 1').get() as { uid: string }
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO exams (uid, title, exam_date, created_at) VALUES (?, '重复', '2026-12-01', '2026-12-01T00:00:00')"
        )
        .run(row.uid)
    ).toThrow()
  })

  it('四个写入口新造的行都有 uid', () => {
    const noteId = createNote({ title: '新笔记', tags: [], rawMarkdown: '' })
    const itemId = upsertItem({
      kind: 'word',
      headword: 'fresh',
      meanings: ['新的'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    applyReview({
      cardId: firstCardId(itemId),
      rating: 3,
      answer: 'fresh',
      correct: true,
      elapsedMs: 900,
      mode: 'longterm',
      judgeBy: 'self'
    })
    createExam({
      title: '新考试',
      examDate: '2026-12-20',
      scope: {},
      level: 'dictate',
      targetRetention: 0.9,
      dailyMinutes: 15
    })

    for (const table of UID_TABLES) {
      const rows = getDb().prepare(`SELECT uid FROM ${table}`).all() as unknown as { uid: string }[]
      for (const row of rows) {
        expect(row.uid).toBeTruthy()
        expect(ULID.test(row.uid)).toBe(true)
      }
      expect(new Set(rows.map((row) => row.uid)).size).toBe(rows.length)
    }
  })

  it('复制笔记生成新 uid，不沿用源行', () => {
    const sourceId = createNote({ title: '要被复制的笔记', tags: [], rawMarkdown: '' })
    const deck = getDb().prepare('SELECT id FROM decks ORDER BY id ASC LIMIT 1').get() as {
      id: number
    }
    const { noteIds } = copyNotes([sourceId], deck.id)
    expect(noteIds).toHaveLength(1)

    const uids = getDb()
      .prepare('SELECT id, uid FROM notes WHERE id IN (?, ?)')
      .all(sourceId, noteIds[0]) as unknown as { id: number; uid: string }[]
    expect(uids).toHaveLength(2)
    expect(uids[0].uid).toBeTruthy()
    expect(uids[1].uid).toBeTruthy()
    expect(uids[0].uid).not.toBe(uids[1].uid)
  })
})
