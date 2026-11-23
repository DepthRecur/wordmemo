import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote, copyNotes } from '../src/main/db/notes'
import { deleteItem, upsertItem } from '../src/main/db/items'
import { createExam } from '../src/main/db/exams'
import { createDeck, removeDeck, updateDeck } from '../src/main/db/decks'
import { SCHEMA_VERSION } from '../src/main/db/schema'
import {
  getSyncState,
  listTombstones,
  pendingSyncOps,
  recordSyncOp,
  updateSyncState
} from '../src/main/db/sync'

// S1 新增的两类实体（2026-11-23 确认）：
// - `deck` 也进同步，否则 notes.deck_uid / exams.scope.deck_uid 在另一台设备上指不到库；
// - `noteItem`（笔记↔词条关联）用独立事件，并集合并，和 reviews 一样是「事实」。
// 另外这里验证删除影子表、单行同步状态，以及 v3→v4 的 decks.uid 补列/索引。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-rel-'))
const dbFile = path.join(dir, 'rel.db')

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function clearOps(): void {
  getDb().exec('DELETE FROM sync_ops')
}

function ops() {
  return pendingSyncOps()
}

function uidOfNote(noteId: number): string {
  return (getDb().prepare('SELECT uid FROM notes WHERE id = ?').get(noteId) as { uid: string }).uid
}

function uidOfItem(itemId: number): string {
  return (getDb().prepare('SELECT uid FROM items WHERE id = ?').get(itemId) as { uid: string }).uid
}

function makeNoteItem(title: string, headword: string, rawLine?: string): {
  noteId: number
  itemId: number
} {
  const noteId = createNote({ title, tags: [], rawMarkdown: '' })
  const itemId = upsertItem({
    kind: 'word',
    headword,
    meanings: ['释义'],
    noteId,
    position: 0,
    listenEnabled: false,
    rawLine
  })
  return { noteId, itemId }
}

describe('deck 事件', () => {
  it('建库/改名/删库各发一条，删除同时落影子', () => {
    clearOps()
    const deckId = createDeck({ name: '同步库', color: '#abc', newPerDay: 7 })
    const deck = getDb().prepare('SELECT uid FROM decks WHERE id = ?').get(deckId) as { uid: string }
    const createOp = ops()[0]
    expect(createOp.entity).toBe('deck')
    expect(createOp.uid).toBe(deck.uid)
    expect(createOp.fields).toEqual({
      name: '同步库',
      color: '#abc',
      position: expect.any(Number),
      new_per_day: 7,
      created_at: expect.any(String)
    })

    clearOps()
    updateDeck(deckId, { name: '改名后的库' })
    const renameOp = ops()[0]
    expect(renameOp.entity).toBe('deck')
    expect(Object.keys(renameOp.fields)).toEqual(['name'])

    clearOps()
    const target = getDb()
      .prepare('SELECT id FROM decks WHERE id <> ? ORDER BY id ASC LIMIT 1')
      .get(deckId) as { id: number }
    removeDeck(deckId, target.id)
    const deleteOp = ops().find((op) => op.entity === 'deck')!
    expect(deleteOp.op).toBe('delete')
    expect(deleteOp.uid).toBe(deck.uid)
    const tombstone = listTombstones().find((row) => row.uid === deck.uid)
    expect(tombstone?.entity).toBe('deck')
  })
})

describe('noteItem 事件', () => {
  it('入库时发一条关联 op（带两端 uid 与 position）', () => {
    clearOps()
    const { noteId, itemId } = makeNoteItem('关联笔记', 'relation', 'relation /rɪˈleɪʃn/ 关系')
    const linkOp = ops().find((op) => op.entity === 'noteItem')!
    const noteUid = uidOfNote(noteId)
    const itemUid = uidOfItem(itemId)
    expect(linkOp.uid).toBe(`${noteUid}:${itemUid}`)
    expect(linkOp.fields).toEqual({
      note_uid: noteUid,
      item_uid: itemUid,
      raw_line: 'relation /rɪˈleɪʃn/ 关系',
      position: 0
    })
  })

  it('raw_line 变了才发；原样再入库不发任何 op', () => {
    const noteId = createNote({ title: 'rawline', tags: [], rawMarkdown: '' })
    const input = {
      kind: 'word' as const,
      headword: 'rawline',
      meanings: ['释义'],
      noteId,
      position: 0,
      listenEnabled: false,
      rawLine: '第一版原文'
    }
    const itemId = upsertItem(input)

    clearOps()
    upsertItem({ ...input, rawLine: '第二版原文' })
    const changed = ops().find((op) => op.entity === 'noteItem')!
    expect(changed.uid).toBe(`${uidOfNote(noteId)}:${uidOfItem(itemId)}`)
    expect(changed.fields.raw_line).toBe('第二版原文')
    // 词条本身没变：只有关联一条 op
    expect(ops()).toHaveLength(1)

    clearOps()
    upsertItem({ ...input, rawLine: '第二版原文' })
    expect(ops()).toHaveLength(0)
  })

  it('复制笔记时关联用新笔记的 uid，旧关联不受影响', () => {
    const { noteId, itemId } = makeNoteItem('复制关联', 'copyrel', '原始行')
    const deck = getDb().prepare('SELECT id FROM decks ORDER BY id ASC LIMIT 1').get() as {
      id: number
    }
    clearOps()
    const { noteIds } = copyNotes([noteId], deck.id)
    const newNoteUid = uidOfNote(noteIds[0])
    const itemUid = uidOfItem(itemId)
    const copied = ops().filter((op) => op.entity === 'noteItem')
    expect(copied).toHaveLength(1)
    expect(copied[0].uid).toBe(`${newNoteUid}:${itemUid}`)
    expect(copied[0].uid).not.toBe(`${uidOfNote(noteId)}:${itemUid}`)
    expect(copied[0].fields.raw_line).toBe('原始行')
  })
})

describe('删除影子', () => {
  it('delete op 落影子，同一 uid 只保留最新的 ts', () => {
    const { itemId } = makeNoteItem('影子', 'tombstone')
    const itemUid = uidOfItem(itemId)
    clearOps()
    deleteItem(itemId)
    const first = listTombstones().find((row) => row.uid === itemUid)!
    expect(first.entity).toBe('item')

    recordSyncOp({ entity: 'item', uid: itemUid, op: 'delete' })
    const second = listTombstones().find((row) => row.uid === itemUid)!
    expect(second.tsUtc).toBeGreaterThanOrEqual(first.tsUtc)
    // 影子表按 (entity, uid) 唯一，不会越积越多个同 uid
    expect(listTombstones().filter((row) => row.uid === itemUid)).toHaveLength(1)

    // 删除考试也落影子
    const examId = createExam({
      title: '影子考试',
      examDate: '2027-02-01',
      scope: {},
      level: 'dictate',
      targetRetention: 0.9,
      dailyMinutes: 10
    })
    const examUid = (
      getDb().prepare('SELECT uid FROM exams WHERE id = ?').get(examId) as { uid: string }
    ).uid
    recordSyncOp({ entity: 'exam', uid: examUid, op: 'delete' })
    expect(listTombstones().some((row) => row.uid === examUid)).toBe(true)
  })
})

describe('sync_state', () => {
  it('第一次创建、之后稳定；能更新上次同步时间', () => {
    const first = getSyncState()
    expect(first.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(first.formatVersion).toBe(1)
    const second = getSyncState()
    expect(second.deviceId).toBe(first.deviceId)

    updateSyncState({ lastPushAt: '2026-11-23T18:00:00', lastPullAt: '2026-11-23T18:01:00' })
    const third = getSyncState()
    expect(third.lastPushAt).toBe('2026-11-23T18:00:00')
    expect(third.lastPullAt).toBe('2026-11-23T18:01:00')
    expect(third.deviceId).toBe(first.deviceId)
  })
})

describe('decks.uid 迁移（v3 → v4）', () => {
  it('老 deck 行补 uid、建唯一索引', () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM decks').get() as { c: number }).c
    expect(before).toBeGreaterThan(0)
    getDb().exec('DROP INDEX IF EXISTS ux_decks_uid')
    getDb().exec('UPDATE decks SET uid = NULL')
    getDb().exec('PRAGMA user_version = 3')
    closeDb()
    openDb(dbFile)

    const version = (
      getDb().prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version
    expect(version).toBe(SCHEMA_VERSION)
    const missing = getDb()
      .prepare("SELECT COUNT(*) AS c FROM decks WHERE uid IS NULL OR uid = ''")
      .get() as { c: number }
    expect(missing.c).toBe(0)
    const distinct = getDb().prepare('SELECT COUNT(DISTINCT uid) AS c FROM decks').get() as {
      c: number
    }
    expect(distinct.c).toBe(before)
    const index = getDb()
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'ux_decks_uid'")
      .get()
    expect(index).toBeTruthy()
  })
})
