import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { openDb, closeDb, getDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs, replayCard, type ReplayReview } from '../src/main/fsrs'
import { createNote } from '../src/main/db/notes'
import { upsertItem } from '../src/main/db/items'
import { applyReview, getCardRow } from '../src/main/db/cards'
import type { SubmitReview } from '../src/shared/types'

// PLAN-SYNC §3.3 的 S0 判据：卡片状态必须是复习记录的函数。
// 这是「重放 == 真实卡片」的 golden test——S0 不通过就别往下做同步。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-replay-'))
const dbFile = path.join(dir, 'replay.db')

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function review(
  cardId: number,
  rating: 1 | 2 | 3 | 4,
  mode: SubmitReview['mode'] = 'longterm'
): SubmitReview {
  return { cardId, rating, answer: 'test', correct: rating >= 3, elapsedMs: 1200, mode, judgeBy: 'self' }
}

/** 从库里读出某张卡的全部复习记录（按时间、id 排序），转成重放输入 */
function reviewsOf(cardId: number): ReplayReview[] {
  const rows = getDb()
    .prepare('SELECT reviewed_at, rating FROM reviews WHERE card_id = ? ORDER BY reviewed_at ASC, id ASC')
    .all(cardId) as unknown as { reviewed_at: string; rating: number }[]
  return rows.map((row) => ({ reviewedAt: new Date(row.reviewed_at), rating: row.rating as 1 | 2 | 3 | 4 }))
}

function cardIdOf(cardId: number): string {
  const row = getCardRow(cardId)!
  return JSON.parse(row.fsrs_json).cardId
}

function firstCard(itemId: number): { id: number } {
  return getDb()
    .prepare('SELECT id FROM cards WHERE item_id = ? ORDER BY id ASC LIMIT 1')
    .get(itemId) as unknown as { id: number }
}

/** 造一条笔记 + 一个词条（顺带建好卡片），返回第一张卡 */
function makeCard(title: string, headword: string): { id: number } {
  const noteId = createNote({ title, tags: [], rawMarkdown: `# ${title}` })
  const itemId = upsertItem({
    kind: 'word',
    headword,
    meanings: ['测试'],
    noteId,
    position: 0,
    listenEnabled: false
  })
  return firstCard(itemId)
}

describe('replayCards：卡片状态 = 复习记录的函数', () => {
  it('同一串复习（含考试模式、连错、长间隔）重放结果与真实卡片逐字段相等', () => {
    const card = makeCard('replay', 'replay')
    const t0 = new Date('2026-11-01T09:00:00')
    const steps: { at: Date; rating: 1 | 2 | 3 | 4; mode?: SubmitReview['mode'] }[] = [
      { at: t0, rating: 3 },
      { at: new Date('2026-11-01T09:10:00'), rating: 3 },
      { at: new Date('2026-11-02T09:00:00'), rating: 2 },
      { at: new Date('2026-11-02T09:12:00'), rating: 3 },
      { at: new Date('2026-11-05T20:30:00'), rating: 4, mode: 'exam' },
      { at: new Date('2026-11-20T07:45:00'), rating: 1 },
      { at: new Date('2026-11-20T07:58:00'), rating: 3 }
    ]
    for (const step of steps) applyReview(review(card.id, step.rating, step.mode ?? 'longterm'), step.at)

    const row = getCardRow(card.id)!
    const replayed = replayCard(reviewsOf(card.id), JSON.parse(row.fsrs_json).cardId)

    expect(replayed.dueAt).toBe(row.due_at)
    expect(replayed.state).toBe(row.state)
    expect(replayed.reps).toBe(row.reps)
    expect(replayed.lapses).toBe(row.lapses)
    expect(replayed.stability).toBeCloseTo(Number(row.stability), 10)
    expect(replayed.difficulty).toBeCloseTo(Number(row.difficulty), 10)
    expect(replayed.fsrsJson).toBe(row.fsrs_json)
  })

  it('重放是确定的：同一串记录连跑三次结果完全一致', () => {
    const card = makeCard('determinism', 'determinism')
    const t0 = new Date('2026-10-01T08:00:00')
    const ratings: (1 | 2 | 3 | 4)[] = [3, 3, 4, 2, 3]
    ratings.forEach((rating, i) => applyReview(review(card.id, rating), new Date(t0.getTime() + i * 86_400_000)))
    const input = reviewsOf(card.id)
    expect(replayCard(input, cardIdOf(card.id))).toEqual(replayCard(input, cardIdOf(card.id)))
    expect(replayCard(input, cardIdOf(card.id))).toEqual(replayCard(input, cardIdOf(card.id)))
  })

  it('生产时钟（带毫秒）下重放只差亚秒级，不改变任何整数状态', () => {
    const card = makeCard('wallclock', 'wallclock')
    // 显式给一个带毫秒的时钟：仍然验证「生产时钟带毫秒、reviews 只存到秒」这件事，
    // 但两次复习不再各自取当前时间——并行跑测试时它们可能跨过整秒，导致这个用例偶发失败。
    const now = new Date('2026-11-23T10:00:00.456')
    applyReview(review(card.id, 3), now)
    applyReview(review(card.id, 3), new Date(now.getTime() + 10 * 60_000))

    const row = getCardRow(card.id)!
    const replayed = replayCard(reviewsOf(card.id), JSON.parse(row.fsrs_json).cardId)
    expect(replayed.reps).toBe(row.reps)
    expect(replayed.state).toBe(row.state)
    // reviews.reviewed_at 只存到秒（localIso），而生产时钟带毫秒；早复习时这点差别会被
    // 「按秒取整」放大到几秒。合并时每台设备都从同一批记录重放，收敛性不受影响，
    // 但本地那张卡的 due_at 会挪动几秒——这是可接受的（due_at 只用于排序/到期判断）。
    const delta = Math.abs(new Date(replayed.dueAt).getTime() - new Date(row.due_at).getTime())
    expect(delta).toBeLessThanOrEqual(30_000)
    expect(replayed.stability).toBeCloseTo(Number(row.stability), 4)
  })
})
