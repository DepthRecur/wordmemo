import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from 'electron'
import type { QueueCard, ReviewSession } from '../src/shared/types'
import { clearReviewSession, readReviewSession, saveReviewSession } from '../src/main/reviewSession'

const file = () => path.join(app.getPath('userData'), 'review-session.json')

const card: QueueCard = {
  id: 42,
  itemId: 7,
  direction: 'zh2en',
  dueAt: '2026-11-20T12:00:00',
  stability: 1,
  difficulty: 5,
  reps: 1,
  lapses: 0,
  state: 2,
  suspended: false,
  lastReview: null,
  isNew: false,
  item: {
    id: 7,
    kind: 'phrase',
    headword: 'be second to none',
    pos: null,
    phonetic: null,
    meanings: ['首屈一指'],
    collocations: [],
    examples: [],
    extra: null,
    acceptedZh: [],
    learnedAt: '2026-11-20T11:00:00',
    createdAt: '2026-11-20T10:00:00',
    noteIds: [1],
    directions: ['en2zh', 'zh2en']
  }
}

function sample(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    scope: 'deck:1',
    card,
    answer: 'be second to none',
    result: null,
    answeredMs: null,
    stats: { total: 3, correct: 2 },
    position: 4,
    total: 10,
    savedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('复习现场（离开后回来接着上一张卡）', () => {
  beforeEach(() => clearReviewSession())

  it('存了再读：卡片本身、答案、判分、用时、进度都还在', () => {
    const session = sample({
      result: { correct: true, confidence: 1, source: 'exact', reason: '拼写一致' },
      answeredMs: 4200
    })
    saveReviewSession(session)
    expect(fs.existsSync(file())).toBe(true)

    const restored = readReviewSession()
    expect(restored).not.toBeNull()
    expect(restored!.card.id).toBe(42)
    expect(restored!.card.item.headword).toBe('be second to none')
    expect(restored!.scope).toBe('deck:1')
    expect(restored!.answer).toBe('be second to none')
    expect(restored!.answeredMs).toBe(4200)
    expect(restored!.result?.correct).toBe(true)
    expect(restored!.stats).toEqual({ total: 3, correct: 2 })
    expect(restored!.position).toBe(4)
    expect(restored!.total).toBe(10)
  })

  it('「没提交」也是一种状态：result/answeredMs 为 null', () => {
    saveReviewSession(sample({ answer: 'be sec', result: null, answeredMs: null }))
    const restored = readReviewSession()!
    expect(restored.answer).toBe('be sec')
    expect(restored.result).toBeNull()
    expect(restored.answeredMs).toBeNull()
  })

  it('过期（超过 12 小时）就作废，并顺手把文件删掉', () => {
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()
    fs.writeFileSync(file(), JSON.stringify(sample({ savedAt: old })), 'utf8')
    expect(readReviewSession()).toBeNull()
    expect(fs.existsSync(file())).toBe(false)
  })

  it('文件坏了 / 缺卡片：当作没有现场，不抛错', () => {
    fs.writeFileSync(file(), '{not json', 'utf8')
    expect(readReviewSession()).toBeNull()

    fs.writeFileSync(file(), JSON.stringify({ scope: 'deck:1' }), 'utf8')
    expect(readReviewSession()).toBeNull()
  })

  it('clear 之后读不到', () => {
    saveReviewSession(sample())
    clearReviewSession()
    expect(readReviewSession()).toBeNull()
  })
})
