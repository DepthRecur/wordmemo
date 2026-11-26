import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { deleteNotes } from '../src/main/db/notes'
import { deleteItem } from '../src/main/db/items'
import { deleteExam } from '../src/main/db/exams'
import { listDeleted, restoreDeleted } from '../src/main/db/trash'
import { listTombstones, recordTombstone } from '../src/main/db/sync'

// D-05 回收站（4b）：按原 uid 恢复本机删除的笔记/词条/考试，并记一条 upsert op
// 让对端跟着复活。复习记录已经级联删掉，恢复不回来——这是设计，不是 bug。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-trash-'))
const dbFile = path.join(dir, 'trash.db')
const NOW = '2026-11-26T12:00:00.000Z'

beforeAll(async () => {
  initSettings()
  // 恢复词条会 ensureCards()，没有 FSRS 配置会直接抛
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
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
    DELETE FROM cards;
    DELETE FROM notes;
    DELETE FROM items;
    DELETE FROM exams;
    DELETE FROM decks;
  `)
})

function count(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...params) as { c?: number } | undefined
  return Number(row?.c ?? 0)
}

describe('回收站：列表', () => {
  it('没有快照的影子标成「不能恢复」，并给出原因', () => {
    // 远端 delete op 不带字段：只有 uid 和 ts
    recordTombstone('note', 'REMOTE1', Date.now())

    const entry = listDeleted().find((row) => row.uid === 'REMOTE1')
    expect(entry?.restorable).toBe(false)
    expect(entry?.reason).toContain('没有内容快照')
    expect(restoreDeleted('note', 'REMOTE1').ok).toBe(false)
  })

  it('新的删除排在前面，且不超过上限', () => {
    recordTombstone('note', 'OLD', 1000, { title: '旧' })
    recordTombstone('note', 'NEW', 2000, { title: '新' })

    expect(listDeleted().map((row) => row.uid)).toEqual(['NEW', 'OLD'])
    expect(listDeleted(1)).toHaveLength(1)
  })
})

describe('回收站：恢复', () => {
  it('笔记恢复后回到原库、关联重建、影子消失，并留下 upsert op', () => {
    const d = getDb()
    d.prepare('INSERT INTO decks (id, uid, name, created_at) VALUES (1, ?, ?, ?)').run(
      'DECK1',
      '默认库',
      NOW
    )
    d.prepare(
      `INSERT INTO notes (id, uid, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       VALUES (1, ?, 1, ?, NULL, ?, ?, 'validated', ?, ?)`
    ).run('NOTE1', '第一课', '["课文"]', '# 第一课 apple 苹果', NOW, NOW)
    d.prepare(
      `INSERT INTO items (id, uid, kind, headword, headword_norm, meanings, created_at)
       VALUES (1, ?, 'word', 'apple', 'apple', '[]', ?)`
    ).run('ITEM1', NOW)
    d.prepare('INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (1, 1, ?, 0)').run(
      'apple 苹果'
    )
    deleteNotes([1])
    expect(count('SELECT COUNT(*) AS c FROM notes')).toBe(0)

    const result = restoreDeleted('note', 'NOTE1')
    expect(result.ok).toBe(true)

    const note = d.prepare('SELECT * FROM notes WHERE uid = ?').get('NOTE1') as {
      title: string
      deck_id: number
      raw_markdown: string
    }
    expect(note.title).toBe('第一课')
    expect(Number(note.deck_id)).toBe(1)
    expect(note.raw_markdown).toContain('apple 苹果')
    // 孤儿词条跟着笔记一起被删了：恢复笔记时用它的快照一起恢复，关联才补得回来
    expect(count('SELECT COUNT(*) AS c FROM items')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM note_items')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM cards')).toBeGreaterThanOrEqual(2)
    // 影子没了 → 回收站里不再显示
    expect(listTombstones().some((row) => row.uid === 'NOTE1')).toBe(false)

    // 对端要靠这条 op 才知道内容回来了，而且 ts 必须比删除那次新
    const op = d
      .prepare("SELECT fields, ts_utc FROM sync_ops WHERE entity = 'note' AND op = 'upsert' AND uid = ?")
      .get('NOTE1') as { fields: string; ts_utc: number } | undefined
    expect(op).toBeTruthy()
    expect(JSON.parse(op!.fields).title).toBe('第一课')
  })

  it('笔记恢复时跳过已经不存在的词条关联', () => {
    // 只留影子、不留行：模拟「笔记和它的词条都已经被删掉」
    recordTombstone('note', 'NOTE2', 1000, {
      title: '孤儿关联',
      deck_uid: null,
      tags: [],
      raw_markdown: '',
      status: 'validated',
      item_uids: ['GONE1', 'GONE2']
    })

    expect(restoreDeleted('note', 'NOTE2').ok).toBe(true)
    expect(count('SELECT COUNT(*) AS c FROM note_items')).toBe(0)
  })

  it('词条恢复后重建卡片，但同名词条还在时拒绝', () => {
    getDb()
      .prepare(
        `INSERT INTO items (id, uid, kind, headword, headword_norm, pos, meanings, created_at)
         VALUES (1, ?, 'word', 'permit', 'permit', 'v.', ?, ?)`
      )
      .run('ITEM2', '[{"pos":"v.","zh":["允许"]}]', NOW)
    deleteItem(1)
    expect(count('SELECT COUNT(*) AS c FROM items')).toBe(0)

    const restored = restoreDeleted('item', 'ITEM2')
    expect(restored.ok).toBe(true)
    expect(count('SELECT COUNT(*) AS c FROM items')).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM cards')).toBeGreaterThanOrEqual(2)
    expect(restored.message).toContain('复习进度')

    // 再恢复一次：影子已经没了
    expect(restoreDeleted('item', 'ITEM2').ok).toBe(false)

    // 同名冲突：库里已经有「permit」了（就是刚恢复的那条），再恢复一条同名词条要拒绝
    recordTombstone('item', 'ITEM4', 3000, { headword: 'permit', kind: 'word', meanings: [] })
    const clash = restoreDeleted('item', 'ITEM4')
    expect(clash.ok).toBe(false)
    expect(clash.message).toContain('已经有')
  })

  it('考试恢复后回到列表，影子消失', () => {
    getDb()
      .prepare(
        `INSERT INTO exams (id, uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
         VALUES (1, ?, ?, '2026-12-01', ?, 'dictate', 0.95, 20, 'active', ?)`
      )
      .run('EXAM1', '期中听写', JSON.stringify({ deckId: 1 }), NOW)
    deleteExam(1)

    const result = restoreDeleted('exam', 'EXAM1')
    expect(result.ok).toBe(true)
    const row = getDb().prepare('SELECT title, exam_date FROM exams WHERE uid = ?').get('EXAM1') as {
      title: string
      exam_date: string
    }
    expect(row.title).toBe('期中听写')
    expect(row.exam_date).toBe('2026-12-01')
    expect(listTombstones().some((item) => item.uid === 'EXAM1')).toBe(false)
  })
})


