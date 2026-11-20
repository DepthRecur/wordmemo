import path from 'node:path'
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { DatabaseSync } from '../src/main/db/sqlite'
import { backupBeforeMigrate, closeDb, openDb } from '../src/main/db/connection'
import { getSettings, initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import {
  createDeck,
  deckNewPerDay,
  listDecks,
  removeDeck,
  updateDeck
} from '../src/main/db/decks'
import {
  copyNotes,
  createNote,
  deleteNotes,
  getNote,
  listNotes,
  moveNotes
} from '../src/main/db/notes'
import {
  countUnlearned,
  findExistingItemId,
  learnQueue,
  learnedTodayCount,
  upsertItem
} from '../src/main/db/items'
import { countDue, dailyPlan, dueQueue, markItemLearned } from '../src/main/db/cards'
import { dashboardStats } from '../src/main/db/stats'

const dataDir = app.getPath('userData')
const dbFile = path.join(dataDir, 'decks.db')
let seq = 0

/** 建一份笔记并把词条挂进去（词条全局去重，同名会合并） */
function addNote(deckId: number, words: string[]): number {
  seq += 1
  const noteId = createNote({
    title: `笔记 ${seq}`,
    tags: [],
    rawMarkdown: words.join('\n'),
    deckId
  })
  words.forEach((headword, index) => {
    upsertItem({
      kind: 'word',
      headword,
      meanings: [`${headword} 的释义`],
      noteId,
      position: index,
      listenEnabled: false
    })
  })
  return noteId
}

function itemIdOf(headword: string): number {
  const id = findExistingItemId(headword, null, 'word')
  if (!id) throw new Error(`词条不存在：${headword}`)
  return id
}

function heads(items: { headword: string }[]): Set<string> {
  return new Set(items.map((item) => item.headword.toLowerCase()))
}

/** 复习队列是 QueueCard（词条在 .item 里） */
function cardHeads(cards: { item: { headword: string } }[]): Set<string> {
  return new Set(cards.map((card) => card.item.headword.toLowerCase()))
}

function itemIdsOfNote(noteId: number): number[] {
  return (getNote(noteId)?.items ?? []).map((item) => item.id).sort((a, b) => a - b)
}

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

describe('库作用域', () => {
  it('learnQueue / dueQueue / 计数都只在自己库里', () => {
    const A = createDeck({ name: 'scope-A' })
    const B = createDeck({ name: 'scope-B' })
    addNote(A, ['scopeaa', 'scopebb'])
    addNote(B, ['scopeaa', 'scopecc', 'scopedd'])
    markItemLearned(itemIdOf('scopecc'), true)

    expect(heads(learnQueue(50, A))).toEqual(new Set(['scopeaa', 'scopebb']))
    expect(heads(learnQueue(50, B))).toEqual(new Set(['scopeaa', 'scopedd']))

    // 只属于 B 的词不出现在 A 的复习队列里；A 里还没有「学过、待测」的卡
    expect(cardHeads(dueQueue(200, A))).toEqual(new Set())
    expect(cardHeads(dueQueue(200, B))).toEqual(new Set(['scopecc']))

    expect(countDue(A)).toBe(0)
    expect(countDue(B)).toBe(1)
    // 不传库 = 全部库
    expect(countDue()).toBeGreaterThanOrEqual(1)

    expect(learnedTodayCount(A)).toBe(0)
    expect(learnedTodayCount(B)).toBe(1)
    expect(countUnlearned(A)).toBe(2)
    expect(countUnlearned(B)).toBe(2)
  })

  it('同一个词进两个库：学过一次两边都不再算新词，到期卡只出现在两边各一次', () => {
    const A = createDeck({ name: 'shared-A' })
    const B = createDeck({ name: 'shared-B' })
    addNote(A, ['sharedword'])
    addNote(B, ['sharedword'])

    expect(heads(learnQueue(50, A))).toEqual(new Set(['sharedword']))
    expect(heads(learnQueue(50, B))).toEqual(new Set(['sharedword']))

    markItemLearned(itemIdOf('sharedword'), true)
    // 进度跟单词走：B 也不再把它当新词
    expect(heads(learnQueue(50, A))).toEqual(new Set())
    expect(heads(learnQueue(50, B))).toEqual(new Set())
    expect(learnedTodayCount(A)).toBe(1)
    expect(learnedTodayCount(B)).toBe(1)
    // 卡片只有一张：两边都看到同一个 due，但复习一次就会前移
    expect(cardHeads(dueQueue(200, A))).toEqual(new Set(['sharedword']))
    expect(cardHeads(dueQueue(200, B))).toEqual(new Set(['sharedword']))
  })

  it('统计页按库过滤，热力图/连续天数不分库', () => {
    const A = createDeck({ name: 'stats-A' })
    addNote(A, ['statsa', 'statsb'])
    const all = dashboardStats(null)
    const scoped = dashboardStats(A)
    expect(scoped.totalNotes).toBe(1)
    expect(scoped.totalItems).toBe(2)
    expect(scoped.dueToday).toBe(countDue(A))
    expect(scoped.totalNotes).toBeLessThan(all.totalNotes)
    // 复习记录没有库维度：热力图和连续天数始终是全局的
    expect(scoped.heatmap).toEqual(all.heatmap)
    expect(scoped.streak).toBe(all.streak)
  })
})

describe('每库一份新词额度', () => {
  it('库覆盖优先，NULL 回落到全局 settings.newPerDay', () => {
    const deck = createDeck({ name: 'quota-5', newPerDay: 5 })
    addNote(deck, ['qu1', 'qu2', 'qu3', 'qu4', 'qu5', 'qu6', 'qu7', 'qu8'])
    expect(deckNewPerDay(deck)).toBe(5)

    const plan = dailyPlan(deck)
    expect(plan.learnQuota).toBe(5)
    expect(plan.learnItems).toHaveLength(5)

    markItemLearned(itemIdOf('qu1'), true)
    markItemLearned(itemIdOf('qu2'), true)
    const plan2 = dailyPlan(deck)
    expect(learnedTodayCount(deck)).toBe(2)
    expect(plan2.learnQuota).toBe(3)
    expect(plan2.learnItems).toHaveLength(3)

    updateDeck(deck, { newPerDay: null })
    expect(deckNewPerDay(deck)).toBe(Math.max(0, getSettings().newPerDay))
  })

  it('改一个库的额度不影响另一个库', () => {
    const A = createDeck({ name: 'quota-A', newPerDay: 2 })
    const B = createDeck({ name: 'quota-B', newPerDay: 2 })
    addNote(A, ['qba1', 'qba2', 'qba3'])
    addNote(B, ['qbb1', 'qbb2', 'qbb3'])
    markItemLearned(itemIdOf('qba1'), true)
    markItemLearned(itemIdOf('qba2'), true)
    updateDeck(A, { newPerDay: 5 })
    expect(dailyPlan(A).learnQuota).toBe(3)
    expect(dailyPlan(B).learnQuota).toBe(2)
  })
})

describe('批量移动 / 复制 / 删除', () => {
  it('移动只改归属，词条与进度一个字节都不动', () => {
    const X = createDeck({ name: 'batch-X' })
    const Y = createDeck({ name: 'batch-Y' })
    const n1 = addNote(X, ['mv1', 'mv2'])
    const n2 = addNote(X, ['mv3'])
    const before = itemIdsOfNote(n1)

    const moved = moveNotes([n1, n2], Y)
    expect(moved.moved).toBe(2)
    expect(listNotes({ deckId: Y })).toHaveLength(2)
    expect(listNotes({ deckId: X })).toHaveLength(0)
    expect(itemIdsOfNote(n1)).toEqual(before)
    expect(getNote(n1)?.deckId).toBe(Y)

    // 已在目标库 = 无操作
    expect(moveNotes([n1, n2], Y).moved).toBe(0)
  })

  it('复制只复制笔记与词条关联，不复制词条，也不复制进度', () => {
    const X = createDeck({ name: 'copy-X' })
    const n1 = addNote(X, ['cp1', 'cp2'])
    markItemLearned(itemIdOf('cp1'), true)
    const sourceItems = itemIdsOfNote(n1)
    const result = copyNotes([n1], X)
    expect(result.copied).toBe(1)
    expect(result.noteIds).toHaveLength(1)
    const copy = getNote(result.noteIds[0])
    expect(copy).not.toBeNull()
    expect(copy!.deckId).toBe(X)
    expect(copy!.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(sourceItems)
    // 同一个词条只有一份，learned_at 是共享的
    expect(copy!.items.find((item) => item.headword === 'cp1')?.learnedAt).toBeTruthy()
  })

  it('删除只在词不再被引用时才删词条与卡片', () => {
    const D = createDeck({ name: 'delete-D' })
    const keep = addNote(D, ['keepword'])
    const drop = addNote(D, ['keepword', 'onlyword'])
    const sharedId = itemIdOf('keepword')
    deleteNotes([drop])
    expect(itemIdOf('keepword')).toBe(sharedId)
    expect(findExistingItemId('onlyword', null, 'word')).toBeNull()
    expect(getNote(keep)).not.toBeNull()
  })
})

describe('合并与分裂（组合动作）', () => {
  it('移动 + 删空库 = 合并；复制一部分到新库 = 分裂', () => {
    const A = createDeck({ name: 'merge-A' })
    const B = createDeck({ name: 'merge-B' })
    addNote(A, ['ma1', 'ma2'])
    addNote(A, ['ma2', 'ma3'])
    const bNote = addNote(B, ['mb1', 'ma1'])

    const allNotes = listNotes({ deckId: B }).map((note) => note.id)
    expect(allNotes).toEqual([bNote])
    expect(moveNotes(allNotes, A).moved).toBe(1)
    // 移动之后 B 已经是空的：删库只是删掉空壳
    const removed = removeDeck(B, A)
    expect(removed.moved).toBe(0)
    expect(listDecks().some((deck) => deck.id === B)).toBe(false)

    const merged = listDecks().find((deck) => deck.id === A)!
    expect(merged.noteCount).toBe(3)
    // 同名词只算一次：ma1、ma2、ma3、mb1
    expect(merged.itemCount).toBe(4)

    // 分裂：把第一份笔记复制到新库
    const first = listNotes({ deckId: A })[0]
    const C = createDeck({ name: 'split-C' })
    const copied = copyNotes([first.id], C)
    expect(copied.copied).toBe(1)
    const split = listDecks().find((deck) => deck.id === C)!
    expect(split.noteCount).toBe(1)
    expect(split.itemCount).toBe(first.itemCount)
    // 复制不产生新词条
    expect(listDecks().find((deck) => deck.id === A)!.itemCount).toBe(4)
  })
})

describe('库管理', () => {
  it('改名 / 拒绝重名 / 调整额度', () => {
    const deck = createDeck({ name: '管理-原名字' })
    updateDeck(deck, { name: '管理-新名字', newPerDay: 7 })
    const found = listDecks().find((item) => item.id === deck)!
    expect(found.name).toBe('管理-新名字')
    expect(found.newPerDay).toBe(7)
    const other = createDeck({ name: '管理-另一个' })
    expect(() => updateDeck(other, { name: '管理-新名字' })).toThrow(/已经有/)
    expect(() => updateDeck(deck, { name: '  ' })).toThrow(/不能为空/)
  })

  it('删库必须先把笔记移到目标库', () => {
    const from = createDeck({ name: '删库-源' })
    const to = createDeck({ name: '删库-目标' })
    addNote(from, ['del1', 'del2'])
    expect(() => removeDeck(from, from)).toThrow(/正在删除/)
    expect(() => removeDeck(from, 999999)).toThrow(/目标库不存在/)
    // 还有别的库时不能「丢成未归类」：必须指名目标库
    expect(() => removeDeck(from, null)).toThrow(/还有别的库/)
    const result = removeDeck(from, to)
    expect(result.moved).toBe(1)
    expect(result.unassigned).toBe(0)
    expect(listNotes({ deckId: to }).some((note) => note.deckId === to)).toBe(true)
    expect(listDecks().some((deck) => deck.id === from)).toBe(false)
  })

  it('删掉最后一个库：笔记变成「未归类」，不丢', () => {
    const only = createDeck({ name: '最后一个库' })
    const noteId = addNote(only, ['lastword'])
    // 把别处的库先清空，确保这里真的是最后一个
    for (const deck of listDecks()) {
      if (deck.id !== only) removeDeck(deck.id, only)
    }
    const result = removeDeck(only, null)
    expect(result.unassigned).toBeGreaterThanOrEqual(1)
    expect(listDecks()).toHaveLength(0)
    const note = getNote(noteId)!
    expect(note.deckId).toBe(0)
    expect(note.deckName).toBe('未归类')
    expect(listNotes({}).some((item) => item.id === noteId)).toBe(true)
    // 词条/卡片都还在：只是没了库
    expect(itemIdOf('lastword')).toBeGreaterThan(0)
  })
})

describe('迁移：老库进默认库，迁移前先备份', () => {
  it('补列、建默认库、回填 deck_id，并留下 pre-migrate 备份', () => {
    const legacyFile = path.join(dataDir, 'legacy-v1.db')
    const backupDir = path.join(dataDir, 'backups-legacy')
    if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile)
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true })

    const legacy = new DatabaseSync(legacyFile)
    legacy.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'word',
        headword TEXT NOT NULL,
        headword_norm TEXT NOT NULL,
        pos TEXT,
        phonetic TEXT,
        meanings TEXT NOT NULL DEFAULT '[]',
        examples TEXT NOT NULL DEFAULT '[]',
        extra TEXT,
        accepted_zh TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER,
        title TEXT NOT NULL,
        note_date TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        raw_markdown TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'validated',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE note_items (
        note_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        raw_line TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (note_id, item_id)
      );
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        due_at TEXT NOT NULL,
        stability REAL,
        difficulty REAL,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT 0,
        last_review TEXT,
        suspended INTEGER NOT NULL DEFAULT 0,
        fsrs_json TEXT NOT NULL,
        UNIQUE(item_id, direction)
      );
      CREATE TABLE import_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT,
        file_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        original_path TEXT,
        stored_path TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        edited INTEGER NOT NULL DEFAULT 0,
        note_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO notes (title, tags, raw_markdown, created_at, updated_at)
        VALUES ('老笔记', '[]', '# old', '2026-01-01T00:00:00', '2026-01-01T00:00:00');
      INSERT INTO items (headword, headword_norm, meanings, created_at)
        VALUES ('legacy', 'legacy', '["旧的"]', '2026-01-01T00:00:00');
      INSERT INTO note_items (note_id, item_id, position) VALUES (1, 1, 0);
      INSERT INTO cards (item_id, direction, due_at, fsrs_json)
        VALUES (1, 'en2zh', '2026-01-01T00:00:00', '{}');
    `)
    legacy.close()

    const backup = backupBeforeMigrate(legacyFile, backupDir)
    expect(backup).not.toBeNull()
    expect(fs.existsSync(backup!)).toBe(true)
    // 备份的是迁移前的库：里面还没有 decks 表
    const backupDb = new DatabaseSync(backup!, { readOnly: true })
    const decksInBackup = backupDb
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'decks'")
      .get()
    backupDb.close()
    expect(Boolean(decksInBackup)).toBe(false)

    closeDb()
    openDb(legacyFile)

    const decks = listDecks()
    expect(decks).toHaveLength(1)
    expect(decks[0].name).toBe('默认库')
    const notes = listNotes({})
    expect(notes).toHaveLength(1)
    expect(notes[0].deckId).toBe(decks[0].id)
    expect(notes[0].deckName).toBe('默认库')
    expect(findExistingItemId('legacy', null, 'word')).not.toBeNull()
    // 结构版本已升到当前版本；再启动不需要备份
    expect(backupBeforeMigrate(legacyFile, backupDir)).toBeNull()

    // 2026-11-20 起允许一个库都没有：删最后一个库 → 笔记变「未归类」，不删数据
    const removed = removeDeck(decks[0].id, null)
    expect(removed.unassigned).toBe(1)
    expect(listDecks()).toHaveLength(0)
    const left = listNotes({})
    expect(left).toHaveLength(1)
    expect(left[0].deckId).toBe(0)
    expect(left[0].deckName).toBe('未归类')

    // 重启后不许自己长出默认库（用户主动删空的库要保住）
    closeDb()
    openDb(legacyFile)
    expect(listDecks()).toHaveLength(0)
    expect(listNotes({})[0].deckName).toBe('未归类')
  })
})
