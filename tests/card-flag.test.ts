import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb, localIso } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote } from '../src/main/db/notes'
import { setDirection, upsertItem } from '../src/main/db/items'
import { applyReview, markItemLearned } from '../src/main/db/cards'
import { pendingSyncOps, type SyncOpRow } from '../src/main/db/sync'

// PLAN-SYNC §3.3：suspended / learn_mark / buried_until / needs_check 不是重放得来的，
// 它们作为 cardFlag 事件同步（字段级 LWW）。这里检查四个入口都发了事件、
// 只记变了的标志、并且不会把本机卡片 id 写进 op。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-cardflag-'))
const dbFile = path.join(dir, 'cardflag.db')

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

function ops(): SyncOpRow[] {
  return pendingSyncOps()
}

function flagOps(): SyncOpRow[] {
  return ops().filter((op) => op.entity === 'cardFlag')
}

function makeItem(headword: string): { itemId: number; itemUid: string } {
  const noteId = createNote({ title: headword, tags: [], rawMarkdown: '' })
  const itemId = upsertItem({
    kind: 'word',
    headword,
    meanings: ['释义'],
    noteId,
    position: 0,
    listenEnabled: false
  })
  const row = getDb().prepare('SELECT uid FROM items WHERE id = ?').get(itemId) as { uid: string }
  return { itemId, itemUid: row.uid }
}

function cardOf(itemId: number, direction: string): { id: number; needs_check: number } {
  return getDb()
    .prepare('SELECT id, needs_check FROM cards WHERE item_id = ? AND direction = ?')
    .get(itemId, direction) as { id: number; needs_check: number }
}

describe('cardFlag 事件', () => {
  it('setDirection 发 suspended 事件：开启建卡、关闭挂起', () => {
    const { itemId, itemUid } = makeItem('listen')
    expect(() => setDirection(itemId, 'en2zh', false)).toThrow()

    clearOps()
    setDirection(itemId, 'listen2en', true)
    expect(flagOps()).toHaveLength(1)
    const enableOp = flagOps()[0]
    expect(enableOp.uid).toBe(`${itemUid}:listen2en`)
    expect(enableOp.op).toBe('upsert')
    expect(enableOp.fields).toEqual({ suspended: 0 })

    clearOps()
    setDirection(itemId, 'listen2en', false)
    expect(flagOps()).toHaveLength(1)
    expect(flagOps()[0].fields).toEqual({ suspended: 1 })
    expect(flagOps()[0].uid).toBe(`${itemUid}:listen2en`)
  })

  it('markItemLearned 给每张未挂起的卡发 needs_check/learn_mark，挂起的不发', () => {
    const { itemId, itemUid } = makeItem('learned')
    // 先关掉听写方向：挂起的卡不该被写标志
    setDirection(itemId, 'listen2en', true)
    setDirection(itemId, 'listen2en', false)
    clearOps()

    markItemLearned(itemId, true)
    const list = ops()
    const itemOp = list.find((op) => op.entity === 'item')!
    expect(itemOp.fields.learned_at).toBeTruthy()
    const flags = flagOps()
    expect(flags.map((op) => op.uid).sort()).toEqual([
      `${itemUid}:en2zh`,
      `${itemUid}:zh2en`
    ])
    for (const flag of flags) expect(flag.fields).toEqual({ needs_check: 1, learn_mark: 1 })

    // 学过一次就不再重复：没有新的 op
    clearOps()
    markItemLearned(itemId, false)
    expect(ops()).toHaveLength(0)
  })

  it('applyReview 清 needs_check、bury 同词条其它方向，只记变了的', () => {
    const { itemId, itemUid } = makeItem('bury')
    markItemLearned(itemId, true)
    const card = cardOf(itemId, 'en2zh')
    expect(card.needs_check).toBe(1)

    const now = new Date('2026-11-23T09:30:00')
    const today = localIso(now).slice(0, 10)
    clearOps()
    applyReview(
      {
        cardId: card.id,
        rating: 3,
        answer: 'bury',
        correct: true,
        elapsedMs: 700,
        mode: 'longterm',
        judgeBy: 'self'
      },
      now
    )
    const list = ops()
    expect(list.map((op) => op.entity).sort()).toEqual(['cardFlag', 'cardFlag', 'review'])
    const cleared = list.find(
      (op) => op.entity === 'cardFlag' && op.uid === `${itemUid}:en2zh`
    )!
    expect(cleared.fields).toEqual({ needs_check: 0 })
    const buried = list.find(
      (op) => op.entity === 'cardFlag' && op.uid === `${itemUid}:zh2en`
    )!
    expect(buried.fields).toEqual({ buried_until: today })

    // 标志不进 review 的字段：那边只有「复习事实」
    const reviewOp = list.find((op) => op.entity === 'review')!
    for (const key of ['needs_check', 'learn_mark', 'buried_until', 'suspended']) {
      expect(reviewOp.fields).not.toHaveProperty(key)
    }
    // 也不能出现本机卡片 id
    expect(reviewOp.fields).not.toHaveProperty('card_id')
    expect(cleared).not.toHaveProperty('card_id')

    // 同一天再复习同一张：needs_check 已经是 0、兄弟卡也 bury 过了 → 只剩 review op
    clearOps()
    applyReview(
      {
        cardId: card.id,
        rating: 3,
        answer: 'bury',
        correct: true,
        elapsedMs: 700,
        mode: 'longterm',
        judgeBy: 'self'
      },
      now
    )
    expect(ops()).toHaveLength(1)
    expect(ops()[0].entity).toBe('review')
  })
})
