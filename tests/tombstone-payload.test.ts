import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from '../src/main/db/sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { SCHEMA_VERSION } from '../src/main/db/schema'
import { deleteNotes } from '../src/main/db/notes'
import { deleteItem } from '../src/main/db/items'
import { deleteExam } from '../src/main/db/exams'
import { listTombstones, recordTombstone } from '../src/main/db/sync'

// D-05 方案 A 第一步（schema v5）：删除时把整行快照写进 sync_tombstones.payload，
// 回收站才有东西可恢复。远端来的 delete op 不带字段，所以那种影子仍然没有 payload。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-tombstone-payload-'))
const dbFile = path.join(dir, 'payload.db')
const NOW = '2026-11-26T12:00:00.000Z'

beforeAll(() => {
  openDb(dbFile)
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(`
    DELETE FROM sync_tombstones;
    DELETE FROM sync_ops;
    DELETE FROM note_items;
    DELETE FROM notes;
    DELETE FROM items;
    DELETE FROM exams;
    DELETE FROM decks;
  `)
})

function lastTombstone(entity: string, uid: string) {
  const row = listTombstones().find((t) => t.entity === entity && t.uid === uid)
  if (!row) throw new Error(`没有找到 ${entity}/${uid} 的删除影子`)
  return row
}

describe('删除快照（D-05 / schema v5）', () => {
  it('删笔记：快照带标题、库 uid、正文和关联词条 uid', () => {
    const d = getDb()
    d.prepare('INSERT INTO decks (id, uid, name, created_at) VALUES (1, ?, ?, ?)').run(
      'DECK1',
      '默认库',
      NOW
    )
    d.prepare(
      `INSERT INTO notes (id, uid, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       VALUES (1, ?, 1, ?, '2026-11-20', ?, ?, 'validated', ?, ?)`
    ).run('NOTE1', '第一课', '["课文","Unit 1"]', '# 第一课\n\napple 苹果', NOW, NOW)
    d.prepare(
      `INSERT INTO items (id, uid, kind, headword, headword_norm, meanings, created_at)
       VALUES (1, ?, 'word', 'apple', 'apple', ?, ?)`
    ).run('ITEM1', '[{"pos":"n.","zh":["苹果"]}]', NOW)
    d.prepare('INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (1, 1, ?, 0)').run(
      'apple 苹果'
    )

    expect(deleteNotes([1])).toEqual({ removed: 1 })

    const note = lastTombstone('note', 'NOTE1')
    expect(note.payload).toMatchObject({
      title: '第一课',
      deck_uid: 'DECK1',
      note_date: '2026-11-20',
      tags: ['课文', 'Unit 1'],
      item_uids: ['ITEM1']
    })
    expect(String(note.payload?.raw_markdown)).toContain('apple 苹果')

    // 词条变成孤儿被一起删掉：它也要有快照，否则恢复笔记时重建不出词条
    expect(lastTombstone('item', 'ITEM1').payload).toMatchObject({
      headword: 'apple',
      meanings: [{ pos: 'n.', zh: ['苹果'] }]
    })
  })

  it('删词条：快照带词性与释义，恢复时能重建卡片', () => {
    getDb()
      .prepare(
        `INSERT INTO items (id, uid, kind, headword, headword_norm, pos, phonetic, meanings, created_at)
         VALUES (2, ?, 'word', 'permit', 'permit', 'v.', '/pəˈmɪt/', ?, ?)`
      )
      .run('ITEM2', '[{"pos":"v.","zh":["允许"]}]', NOW)

    deleteItem(2)

    expect(lastTombstone('item', 'ITEM2').payload).toMatchObject({
      headword: 'permit',
      pos: 'v.',
      phonetic: '/pəˈmɪt/',
      meanings: [{ pos: 'v.', zh: ['允许'] }]
    })
  })

  it('删考试：快照带标题、日期与范围', () => {
    getDb()
      .prepare(
        `INSERT INTO exams (id, uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
         VALUES (1, ?, '期中听写', '2026-12-01', ?, 'dictate', 0.95, 20, 'active', ?)`
      )
      .run('EXAM1', JSON.stringify({ deckId: 1, tags: ['Unit 1'] }), NOW)

    deleteExam(1)

    expect(lastTombstone('exam', 'EXAM1').payload).toMatchObject({
      title: '期中听写',
      exam_date: '2026-12-01',
      scope: { deckId: 1, tags: ['Unit 1'] },
      level: 'dictate'
    })
  })

  it('没有快照的新删除不会冲掉旧快照', () => {
    recordTombstone('note', 'NOTE9', 1000, { title: '旧快照' })
    // 远端 delete op 不带字段：只更新 ts，payload 保持
    recordTombstone('note', 'NOTE9', 2000)

    const row = lastTombstone('note', 'NOTE9')
    expect(row.tsUtc).toBe(2000)
    expect(row.payload).toEqual({ title: '旧快照' })
  })
})

describe('v4 → v5 迁移', () => {
  it('老库补上 payload 列，旧影子变成「没有快照」而不是坏数据', () => {
    // 先把主库关掉：Windows 上两个句柄同时开同一个文件会影响后面的清理
    closeDb()
    const file = path.join(dir, 'v4.db')
    const raw = new DatabaseSync(file)
    raw.exec(`CREATE TABLE sync_tombstones (entity TEXT NOT NULL, uid TEXT NOT NULL, ts_utc INTEGER NOT NULL, PRIMARY KEY (entity, uid))`)
    raw.prepare('INSERT INTO sync_tombstones (entity, uid, ts_utc) VALUES (?, ?, ?)').run(
      'note',
      'OLD1',
      1700000000000
    )
    raw.exec('PRAGMA user_version = 4')
    raw.close()

    openDb(file)
    const columns = getDb().prepare('PRAGMA table_info(sync_tombstones)').all() as unknown as {
      name: string
    }[]
    expect(columns.map((c) => c.name)).toContain('payload')
    const version = getDb().prepare('PRAGMA user_version').get() as { user_version?: number }
    expect(Number(version.user_version)).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(5)

    const old = listTombstones().find((t) => t.uid === 'OLD1')
    expect(old?.payload).toBeNull()

    closeDb()
    // 后面还有用例：把主库重新打开
    openDb(dbFile)
  })
})
