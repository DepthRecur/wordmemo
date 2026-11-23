import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { copyNotes, createNote, deleteNotes, moveNotes, updateNote } from '../src/main/db/notes'
import { deleteItem, updateItem, upsertItem } from '../src/main/db/items'
import { applyReview } from '../src/main/db/cards'
import { createExam, deleteExam } from '../src/main/db/exams'
import { createDeck, defaultDeckId, removeDeck } from '../src/main/db/decks'
import { pendingSyncOps, recordSyncOp, type SyncOpRow } from '../src/main/db/sync'

// PLAN-SYNC §3.4：所有写入口在同一个事务里追加一条 sync_ops。
// 这里检查的是契约本身——op 的形状（字段名、uid、不含本机 id）、只记变更、
// 失败回滚、origin 过滤，而不是某条业务规则。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-sync-'))
const dbFile = path.join(dir, 'sync.db')

/** 本机 id 绝不能出现在 op 里：跨设备这些整数没有意义 */
const LOCAL_ID_KEYS = ['id', 'card_id', 'deck_id', 'exam_id', 'item_id', 'note_id', 'source_id']

let otherDeckId = 0

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  otherDeckId = createDeck({ name: '第二个库' })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function clearOps(): void {
  getDb().exec('DELETE FROM sync_ops')
}

function ops(): SyncOpRow[] {
  return pendingSyncOps()
}

function lastOp(): SyncOpRow {
  const list = ops()
  expect(list.length).toBeGreaterThan(0)
  return list[list.length - 1]
}

function deckUidOf(deckId: number): string {
  const row = getDb().prepare('SELECT uid FROM decks WHERE id = ?').get(deckId) as { uid: string }
  return row.uid
}

function uidOfNote(noteId: number): string {
  const row = getDb().prepare('SELECT uid FROM notes WHERE id = ?').get(noteId) as { uid: string }
  return row.uid
}

function uidOfItem(itemId: number): string {
  const row = getDb().prepare('SELECT uid FROM items WHERE id = ?').get(itemId) as { uid: string }
  return row.uid
}

function firstCard(itemId: number): { id: number; direction: string } {
  return getDb()
    .prepare('SELECT id, direction FROM cards WHERE item_id = ? ORDER BY id ASC LIMIT 1')
    .get(itemId) as { id: number; direction: string }
}

function makeNoteItem(title: string, headword: string): { noteId: number; itemId: number } {
  const noteId = createNote({ title, tags: ['t'], rawMarkdown: `# ${title}` })
  const itemId = upsertItem({
    kind: 'word',
    headword,
    meanings: ['释义'],
    noteId,
    position: 0,
    listenEnabled: false
  })
  return { noteId, itemId }
}

function expectNoLocalIds(fields: Record<string, unknown>): void {
  for (const key of LOCAL_ID_KEYS) expect(fields).not.toHaveProperty(key)
}

describe('sync_ops：写入口契约', () => {
  it('四个写入口各记一条 op，字段用 uid、不含本机 id', () => {
    clearOps()
    const { noteId, itemId } = makeNoteItem('契约笔记', 'contract')
    const noteOp = ops()[0]
    expect(noteOp.entity).toBe('note')
    expect(noteOp.op).toBe('upsert')
    expect(noteOp.uid).toBe(uidOfNote(noteId))
    expect(noteOp.fields.deck_uid).toBe(deckUidOf(defaultDeckId()))
    expect(noteOp.fields.title).toBe('契约笔记')
    expectNoLocalIds(noteOp.fields)

    const itemOp = ops()[1]
    expect(itemOp.entity).toBe('item')
    expect(itemOp.uid).toBe(uidOfItem(itemId))
    expect(itemOp.fields.headword).toBe('contract')
    expectNoLocalIds(itemOp.fields)

    const card = firstCard(itemId)
    const now = new Date('2026-11-23T10:00:00')
    applyReview(
      {
        cardId: card.id,
        rating: 3,
        answer: 'contract',
        correct: true,
        elapsedMs: 1500,
        mode: 'longterm',
        judgeBy: 'self'
      },
      now
    )
    const reviewOp = lastOp()
    expect(reviewOp.entity).toBe('review')
    expect(reviewOp.fields.card_uid).toBe(`${uidOfItem(itemId)}:${card.direction}`)
    expect(reviewOp.fields.rating).toBe(3)
    // 复习 op 的时间就是复习发生的时刻（不是「写队列那一刻」）
    expect(reviewOp.tsUtc).toBe(now.getTime())
    expectNoLocalIds(reviewOp.fields)

    const examId = createExam({
      title: '期末听写',
      examDate: '2026-12-30',
      scope: { deckId: otherDeckId },
      level: 'dictate',
      targetRetention: 0.9,
      dailyMinutes: 30
    })
    const examOp = lastOp()
    expect(examOp.entity).toBe('exam')
    expect(examOp.uid).toBe(
      (getDb().prepare('SELECT uid FROM exams WHERE id = ?').get(examId) as { uid: string }).uid
    )
    expect(examOp.fields.scope).toEqual({ deck_uid: deckUidOf(otherDeckId) })
    expectNoLocalIds(examOp.fields)
  })

  it('更新只记真正变了的字段；原地保存不产生 op', () => {
    const { noteId, itemId } = makeNoteItem('改字段', 'partial')
    clearOps()
    updateNote(noteId, { title: '改过的标题' })
    expect(ops()).toHaveLength(1)
    expect(Object.keys(lastOp().fields).sort()).toEqual(['title'])

    clearOps()
    updateNote(noteId, { title: '改过的标题' })
    expect(ops()).toHaveLength(0)

    clearOps()
    updateItem(itemId, { phonetic: '/ˈpɑːʃl/' })
    expect(Object.keys(lastOp().fields)).toEqual(['phonetic'])
  })

  it('移动笔记记 deck_uid；复制笔记用新 uid', () => {
    const { noteId } = makeNoteItem('移动/复制', 'movable')
    clearOps()
    moveNotes([noteId], otherDeckId)
    expect(lastOp().fields).toEqual({ deck_uid: deckUidOf(otherDeckId) })

    clearOps()
    const { noteIds } = copyNotes([noteId], otherDeckId)
    const copyOp = lastOp()
    expect(copyOp.entity).toBe('note')
    expect(copyOp.uid).not.toBe(uidOfNote(noteId))
    expect(copyOp.uid).toBe(uidOfNote(noteIds[0]))
    expect(copyOp.fields.deck_uid).toBe(deckUidOf(otherDeckId))
  })

  it('删除笔记与孤儿词条各发一条 delete op', () => {
    const { noteId, itemId } = makeNoteItem('要被删掉', 'deletable')
    const noteUid = uidOfNote(noteId)
    const itemUid = uidOfItem(itemId)
    clearOps()
    deleteNotes([noteId])
    const list = ops()
    expect(list.map((op) => op.entity).sort()).toEqual(['item', 'note'])
    const noteOp = list.find((op) => op.entity === 'note')!
    const itemOp = list.find((op) => op.entity === 'item')!
    expect(noteOp.op).toBe('delete')
    expect(noteOp.uid).toBe(noteUid)
    expect(noteOp.fields).toEqual({})
    expect(itemOp.op).toBe('delete')
    expect(itemOp.uid).toBe(itemUid)
  })

  it('删除词条 / 删除考试各自发 delete op', () => {
    const { itemId } = makeNoteItem('删词条', 'dropme')
    clearOps()
    deleteItem(itemId)
    expect(lastOp().entity).toBe('item')
    expect(lastOp().op).toBe('delete')

    const examId = createExam({
      title: '要删的考试',
      examDate: '2026-12-31',
      scope: {},
      level: 'dictate',
      targetRetention: 0.9,
      dailyMinutes: 10
    })
    const examUid = (
      getDb().prepare('SELECT uid FROM exams WHERE id = ?').get(examId) as { uid: string }
    ).uid
    clearOps()
    deleteExam(examId)
    expect(lastOp().entity).toBe('exam')
    expect(lastOp().op).toBe('delete')
    expect(lastOp().uid).toBe(examUid)
  })

  it('写失败整体回滚：不留半条数据，也不留 op', () => {
    clearOps()
    const before = (
      getDb().prepare("SELECT COUNT(*) AS c FROM items WHERE headword = 'rollback'").get() as {
        c: number
      }
    ).c
    expect(() =>
      upsertItem({
        kind: 'word',
        headword: 'rollback',
        meanings: ['回滚'],
        // 不存在的笔记：note_items 的外键会让整条写入失败
        noteId: 999999,
        position: 0,
        listenEnabled: false
      })
    ).toThrow()
    const after = (
      getDb().prepare("SELECT COUNT(*) AS c FROM items WHERE headword = 'rollback'").get() as {
        c: number
      }
    ).c
    expect(after).toBe(before)
    expect(ops()).toHaveLength(0)
  })

  it('origin != local 的 op 只有落库、不进待推送队列', () => {
    clearOps()
    const { noteId } = makeNoteItem('回声', 'echo')
    clearOps()
    recordSyncOp({
      entity: 'note',
      uid: uidOfNote(noteId),
      fields: { title: '远端改的' },
      origin: 'remote:dev1'
    })
    expect(ops()).toHaveLength(0)
    const total = getDb().prepare('SELECT COUNT(*) AS c FROM sync_ops').get() as { c: number }
    expect(total.c).toBe(1)
  })

  it('删库把笔记/考试移走时也发 op（否则别的设备停在旧库）', () => {
    const deckId = createDeck({ name: '要删的库' })
    const noteId = createNote({ title: '库里的笔记', tags: [], rawMarkdown: '', deckId })
    const examId = createExam({
      title: '库里的考试',
      examDate: '2027-01-01',
      scope: { deckId },
      level: 'dictate',
      targetRetention: 0.9,
      dailyMinutes: 10
    })
    clearOps()
    removeDeck(deckId, otherDeckId)

    const noteOp = ops().find((op) => op.entity === 'note')!
    expect(noteOp.uid).toBe(uidOfNote(noteId))
    expect(noteOp.fields).toEqual({ deck_uid: deckUidOf(otherDeckId) })

    const examOp = ops().find((op) => op.entity === 'exam')!
    expect(examOp.uid).toBe(
      (getDb().prepare('SELECT uid FROM exams WHERE id = ?').get(examId) as { uid: string }).uid
    )
    expect(examOp.fields).toEqual({ scope: { deck_uid: deckUidOf(otherDeckId) } })
  })

  it('嵌套写入口不会报「事务里再开事务」：applyReview(ai) 同时写 item 与 review', () => {
    const { itemId } = makeNoteItem('嵌套', 'nested')
    const card = firstCard(itemId)
    clearOps()
    applyReview({
      cardId: card.id,
      rating: 4,
      answer: 'a brand new answer',
      correct: true,
      elapsedMs: 800,
      mode: 'longterm',
      judgeBy: 'ai'
    })
    const list = ops()
    // 这次复习也会 bury 兄弟卡，所以还有 cardFlag；本用例只关心 item + review 两条
    const entities = list.map((op) => op.entity)
    expect(entities).toContain('item')
    expect(entities).toContain('review')
    const itemOp = list.find((op) => op.entity === 'item')!
    expect(itemOp.uid).toBe(uidOfItem(itemId))
    expect(itemOp.fields.accepted_zh).toEqual(['a brand new answer'])
  })
})
