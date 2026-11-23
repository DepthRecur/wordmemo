import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote, deleteNotes, updateNote } from '../src/main/db/notes'
import { setDirection, upsertItem } from '../src/main/db/items'
import { applyReview, markItemLearned } from '../src/main/db/cards'
import { createExam } from '../src/main/db/exams'
import { createDeck } from '../src/main/db/decks'
import { exportSnapshot, importSnapshot, readCheckpoint } from '../src/main/db/checkpoint'
import { pendingSyncOps } from '../src/main/db/sync'

// PLAN-SYNC §5 的 S1 验收：造两台「设备」（两个库文件）——
// A 导出 → B 导入 → 双向各改一条 → 再对齐 → 内容一致；重复导入 10 次结果不变。
// 另外验证删除的传播（tombstone）与格式版本拒绝。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-snapshot-'))
const dbA = path.join(dir, 'a.db')
const dbB = path.join(dir, 'b.db')
const fileA = path.join(dir, 'a.wmsync')
const fileB = path.join(dir, 'b.wmsync')
const fileA2 = path.join(dir, 'a2.wmsync')

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

function useDb(file: string): void {
  closeDb()
  openDb(file)
}

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[]
}

function uid(sql: string, ...params: unknown[]): string {
  const row = q<{ uid: string }>(sql, ...params)[0]
  return row?.uid ?? ''
}

function totalOps(): number {
  return (q<{ c: number }>('SELECT COUNT(*) AS c FROM sync_ops')[0]?.c ?? 0) as number
}

/** 整库数据指纹：忽略 sync_ops（它会因导入而增长），只比业务数据 */
function fingerprint(): string {
  return [
    q('SELECT uid, name, color, position, new_per_day, created_at FROM decks ORDER BY uid'),
    q(
      'SELECT uid, title, note_date, tags, raw_markdown, status, deck_id, created_at, updated_at FROM notes ORDER BY uid'
    ),
    q(
      `SELECT uid, kind, headword, headword_norm, pos, phonetic, meanings, collocations, examples, extra, accepted_zh, learned_at, created_at
       FROM items ORDER BY uid`
    ),
    q(
      `SELECT uid, card_id, reviewed_at, rating, answer, correct, elapsed_ms, mode, judge_by, exam_id
       FROM reviews ORDER BY uid`
    ),
    q(
      'SELECT uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at FROM exams ORDER BY uid'
    ),
    q('SELECT note_id, item_id, raw_line, position FROM note_items ORDER BY note_id, item_id'),
    q(
      `SELECT item_id, direction, due_at, stability, difficulty, reps, lapses, state, last_review,
              suspended, needs_check, learn_mark, buried_until, fsrs_json
       FROM cards ORDER BY item_id, direction`
    )
  ].map((rows) => JSON.stringify(rows)).join('|')
}

let uidDeck = ''
let uidDefaultDeckA = ''
let uidNote = ''
let uidItem = ''
let uidReview = ''
let noteIdA = 0
let itemIdA = 0

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  openDb(dbA)
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('两台设备：导出 → 导入 → 双向修改 → 对齐', () => {
  it('A 造数据并导出', async () => {
    const deckId = createDeck({ name: '英语' })
    noteIdA = createNote({ title: '第一课', tags: ['t1'], rawMarkdown: '# 第一课', deckId })
    itemIdA = upsertItem({
      kind: 'word',
      headword: 'alpha',
      meanings: ['阿尔法'],
      noteId: noteIdA,
      position: 0,
      listenEnabled: false
    })
    const card = q<{ id: number }>(
      'SELECT id FROM cards WHERE item_id = ? ORDER BY id ASC LIMIT 1',
      itemIdA
    )[0]
    await tick()
    applyReview(
      {
        cardId: card.id,
        rating: 3,
        answer: 'alpha',
        correct: true,
        elapsedMs: 900,
        mode: 'longterm',
        judgeBy: 'self'
      },
      new Date('2026-11-20T09:00:00')
    )
    setDirection(itemIdA, 'listen2en', true)
    createExam({
      title: '期末',
      examDate: '2026-12-20',
      scope: { deckId },
      level: 'dictate',
      targetRetention: 0.92,
      dailyMinutes: 25
    })

    uidDeck = uid('SELECT uid FROM decks WHERE name = ?', '英语')
    uidDefaultDeckA = uid('SELECT uid FROM decks WHERE name = ?', '默认库')
    uidNote = uid('SELECT uid FROM notes WHERE id = ?', noteIdA)
    uidItem = uid('SELECT uid FROM items WHERE id = ?', itemIdA)
    uidReview = uid('SELECT uid FROM reviews WHERE card_id = ? LIMIT 1', card.id)

    await tick()
    const snapshot = exportSnapshot(fileA)
    expect(snapshot.counts.notes).toBe(1)
    expect(snapshot.counts.items).toBe(1)
    expect(snapshot.counts.reviews).toBe(1)
    expect(snapshot.counts.exams).toBe(1)
    expect(snapshot.cardFlags.length).toBeGreaterThanOrEqual(3)
  })

  it('B 导入后内容齐全：库/笔记/词条/关联/复习/卡片/考试', () => {
    useDb(dbB)
    const { stats } = importSnapshot(fileA)
    expect(stats.notes).toBe(1)
    expect(stats.items).toBe(1)
    expect(stats.reviews).toBe(1)
    expect(stats.exams).toBe(1)
    expect(stats.noteItems).toBe(1)

    const note = q<{ id: number; title: string; deck_id: number }>(
      'SELECT id, title, deck_id FROM notes WHERE uid = ?',
      uidNote
    )[0]
    expect(note.title).toBe('第一课')
    const deck = q<{ name: string }>('SELECT name FROM decks WHERE id = ?', note.deck_id)[0]
    expect(deck.name).toBe('英语')

    const item = q<{ meanings: string; learned_at: string | null }>(
      'SELECT meanings, learned_at FROM items WHERE uid = ?',
      uidItem
    )[0]
    expect(JSON.parse(item.meanings)).toEqual(['阿尔法'])
    expect(item.learned_at).toBeNull()

    // 关联（noteItem）也到了
    const link = q<{ c: number }>(
      'SELECT COUNT(*) AS c FROM note_items WHERE note_id = ? AND item_id = (SELECT id FROM items WHERE uid = ?)',
      note.id,
      uidItem
    )[0]
    expect(link.c).toBe(1)

    // 复习记录并集进来，卡片按重放算出状态
    expect(q('SELECT 1 AS ok FROM reviews WHERE uid = ?', uidReview)).toHaveLength(1)
    const card = q<{ reps: number; state: number }>(
      `SELECT reps, state FROM cards WHERE item_id = (SELECT id FROM items WHERE uid = ?) AND direction = 'en2zh'`,
      uidItem
    )[0]
    expect(card.reps).toBe(1)
    expect(card.state).toBeGreaterThan(0)

    // 听写方向：A 打开过，B 也应有这张卡（cardFlag 事件建卡）
    const listen = q<{ c: number }>(
      `SELECT COUNT(*) AS c FROM cards WHERE item_id = (SELECT id FROM items WHERE uid = ?) AND direction = 'listen2en'`,
      uidItem
    )[0]
    expect(listen.c).toBe(1)

    // 同名默认库：远端 uid 要映射到本机这条，否则笔记会掉进「未归类」
    const alias = q<{ local_uid: string }>(
      "SELECT local_uid FROM sync_aliases WHERE entity = 'deck' AND remote_uid = ?",
      uidDefaultDeckA
    )[0]
    expect(alias?.local_uid).toBe(uid('SELECT uid FROM decks WHERE name = ?', '默认库'))
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM decks')[0].c).toBe(2)

    // 导入的 op 一律是 remote，不进军推送队列
    expect(pendingSyncOps()).toHaveLength(0)
  })

  it('B 双向修改：改标题、补释义、复习、标记已学，再导出', async () => {
    const note = q<{ id: number }>('SELECT id FROM notes WHERE uid = ?', uidNote)[0]
    updateNote(note.id, { title: '第一课（B 改）' })
    upsertItem({
      kind: 'word',
      headword: 'alpha',
      meanings: ['甲'],
      noteId: note.id,
      position: 0,
      listenEnabled: false
    })
    markItemLearned(q<{ id: number }>('SELECT id FROM items WHERE uid = ?', uidItem)[0].id, true)
    const card = q<{ id: number }>(
      `SELECT id FROM cards WHERE item_id = (SELECT id FROM items WHERE uid = ?) AND direction = 'en2zh'`,
      uidItem
    )[0]
    await tick()
    applyReview(
      {
        cardId: card.id,
        rating: 4,
        answer: 'alpha',
        correct: true,
        elapsedMs: 700,
        mode: 'longterm',
        judgeBy: 'self'
      },
      new Date('2026-11-22T10:00:00')
    )
    await tick()
    exportSnapshot(fileB)
  })

  it('A 导入 B 的快照：字段级 LWW、数组并集、复习并集都正确', () => {
    useDb(dbA)
    const { stats } = importSnapshot(fileB)
    expect(stats.reviews).toBe(1)

    const note = q<{ title: string }>('SELECT title FROM notes WHERE uid = ?', uidNote)[0]
    expect(note.title).toBe('第一课（B 改）')

    const item = q<{ meanings: string; learned_at: string | null }>(
      'SELECT meanings, learned_at FROM items WHERE uid = ?',
      uidItem
    )[0]
    expect(JSON.parse(item.meanings).sort()).toEqual(['甲', '阿尔法'].sort())
    expect(item.learned_at).not.toBeNull()

    // B 标记已学 + 复习清除 needs_check：标志也合并过来
    const card = q<{ reps: number; learn_mark: number; needs_check: number; state: number }>(
      `SELECT reps, learn_mark, needs_check, state FROM cards
       WHERE item_id = (SELECT id FROM items WHERE uid = ?) AND direction = 'en2zh'`,
      uidItem
    )[0]
    expect(card.reps).toBe(2)
    expect(card.learn_mark).toBe(1)
    expect(card.needs_check).toBe(0)

    // A 的库没有被复制成第二条
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM decks')[0].c).toBe(2)
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM notes')[0].c).toBe(1)
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM items')[0].c).toBe(1)
  })

  it('重复导入 10 次：数据与队列逐字节不变（幂等）', () => {
    const before = fingerprint()
    const opsBefore = totalOps()
    for (let i = 0; i < 10; i++) importSnapshot(fileB)
    expect(fingerprint()).toBe(before)
    expect(totalOps()).toBe(opsBefore)
  })

  it('删除随快照传播：A 删笔记 → B 导入后也没了', async () => {
    useDb(dbA)
    deleteNotes([noteIdA])
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM notes')[0].c).toBe(0)
    await tick()
    exportSnapshot(fileA2)

    useDb(dbB)
    importSnapshot(fileA2)
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM notes')[0].c).toBe(0)
    // 词条没人引用了，tombstone 也把它删掉；卡片与复习级联
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM items')[0].c).toBe(0)
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM reviews')[0].c).toBe(0)
    expect(q<{ c: number }>('SELECT COUNT(*) AS c FROM cards')[0].c).toBe(0)
  })

  it('S0 之前设的卡片标志没有时钟时，不会被快照里的默认值清掉', async () => {
    // A 造一条词条并把 en2zh 直接挂起（模拟升级前的数据：没有 cardFlag op）
    useDb(dbA)
    const noteId = createNote({ title: '老标志', tags: [], rawMarkdown: '' })
    const itemId = upsertItem({
      kind: 'word',
      headword: 'legacyflag',
      meanings: ['旧'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    const itemUid = uid('SELECT uid FROM items WHERE id = ?', itemId)
    await tick()
    exportSnapshot(path.join(dir, 'legacy-a.wmsync'))

    useDb(dbB)
    importSnapshot(path.join(dir, 'legacy-a.wmsync'))

    // A：直接改库（无 op），再把这条卡片的 cardFlag 历史抹掉 = 老数据
    useDb(dbA)
    getDb()
      .prepare("UPDATE cards SET suspended = 1 WHERE item_id = ? AND direction = 'en2zh'")
      .run(itemId)
    getDb().prepare("DELETE FROM sync_ops WHERE entity = 'cardFlag' AND uid LIKE ?").run(`${itemUid}:%`)

    // B：同样抹掉标志历史，导出的是默认值（suspended = 0）
    useDb(dbB)
    getDb().prepare("DELETE FROM sync_ops WHERE entity = 'cardFlag' AND uid LIKE ?").run(`${itemUid}:%`)
    await tick()
    exportSnapshot(path.join(dir, 'legacy-b.wmsync'))

    useDb(dbA)
    importSnapshot(path.join(dir, 'legacy-b.wmsync'))
    const card = q<{ suspended: number }>(
      `SELECT suspended FROM cards WHERE item_id = ? AND direction = 'en2zh'`,
      itemId
    )[0]
    expect(card.suspended).toBe(1)
  })

  it('格式版本不同 / 坏文件：明确拒绝，不动库', () => {
    useDb(dbB)
    const badVersion = path.join(dir, 'bad-version.wmsync')
    fs.writeFileSync(
      badVersion,
      JSON.stringify({ formatVersion: 99, kind: 'wmsync', decks: [], items: [] }),
      'utf8'
    )
    expect(() => readCheckpoint(badVersion)).toThrow(/格式版本/)

    const corrupt = path.join(dir, 'corrupt.wmsync')
    fs.writeFileSync(corrupt, 'not json at all', 'utf8')
    expect(() => readCheckpoint(corrupt)).toThrow(/无法识别/)

    const before = fingerprint()
    expect(() => importSnapshot(corrupt)).toThrow()
    expect(fingerprint()).toBe(before)
  })
})
