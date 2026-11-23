import { DefaultScheduler } from 'ts-fsrs'
import type { DefaultSchedulerCard } from 'ts-fsrs'

type FsrsCard = DefaultSchedulerCard<'FSRS-7'> & Record<string, unknown>

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

export interface CardSnapshot {
  dueAt: string
  stability: number | null
  difficulty: number | null
  reps: number
  lapses: number
  state: number
  fsrsJson: string
}

let longTermScheduler: any = null
let examScheduler: any = null

function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export async function initFsrs(options: {
  longTermRetention: number
  examRetention: number
  maximumInterval?: number
}): Promise<void> {
  // 不要开 fuzz（PLAN-SYNC §3.3）：同步要把「复习记录 → 卡片状态」重放出来，
  // 一旦间隔带随机抖动，两台设备重放同一串复习会得到不同 due_at，
  // 于是「cards 是 reviews 的函数」这条前提不成立。关掉只影响间隔的 ±5% 抖动，
  // 不影响记忆模型本身。
  longTermScheduler = await DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: options.longTermRetention,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: false,
    maximumInterval: options.maximumInterval ?? 365
  })
  examScheduler = await DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: options.examRetention,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: false,
    maximumInterval: 365
  })
}

function schedulerFor(mode: 'longterm' | 'exam'): any {
  const s = mode === 'exam' ? examScheduler ?? longTermScheduler : longTermScheduler
  if (!s) throw new Error('FSRS 调度器尚未初始化')
  return s
}

function serialise(card: FsrsCard): string {
  return JSON.stringify({
    ...card,
    dueAt: card.dueAt instanceof Date ? card.dueAt.toISOString() : card.dueAt,
    lastReviewAt: card.lastReviewAt instanceof Date ? card.lastReviewAt.toISOString() : card.lastReviewAt ?? null
  })
}

function revive(json: string): FsrsCard {
  const raw = JSON.parse(json) as Record<string, unknown>
  return {
    ...(raw as object),
    dueAt: raw.dueAt ? new Date(String(raw.dueAt)) : new Date(),
    lastReviewAt: raw.lastReviewAt ? new Date(String(raw.lastReviewAt)) : null
  } as FsrsCard
}

function toSnapshot(card: FsrsCard): CardSnapshot {
  return {
    dueAt: localIso(card.dueAt as Date),
    stability: typeof card.stability === 'number' ? card.stability : null,
    difficulty: typeof card.difficulty === 'number' ? card.difficulty : null,
    reps: Number(card.reps ?? 0),
    lapses: Number(card.lapses ?? 0),
    state: Number(card.state ?? 0),
    fsrsJson: serialise(card)
  }
}

export function newCardSnapshot(now: Date = new Date()): CardSnapshot {
  const card = schedulerFor('longterm').newCard({ now })
  return toSnapshot(card)
}

export function reviewSnapshot(
  fsrsJson: string,
  rating: 1 | 2 | 3 | 4,
  now: Date = new Date(),
  mode: 'longterm' | 'exam' = 'longterm'
): CardSnapshot {
  const card = revive(fsrsJson)
  const scheduler = schedulerFor(mode)
  const result = scheduler.review({ card, grade: rating, now })
  return toSnapshot(result.card as FsrsCard)
}

/** 从现在起 elapsedDays 天后，这张卡的预测记忆率 */
export function retrievabilityAt(fsrsJson: string, target: Date): number {
  let card: FsrsCard
  try {
    card = revive(fsrsJson)
  } catch {
    return 0
  }
  if (!card.lastReviewAt) return 0
  const elapsed = Math.max(0, (target.getTime() - (card.lastReviewAt as Date).getTime()) / 86_400_000)
  try {
    return clamp(Number(longTermScheduler.model.forgettingCurve(card, elapsed)), 0, 1)
  } catch {
    return 0
  }
}

export function retrievabilityNow(fsrsJson: string, now: Date = new Date()): number {
  return retrievabilityAt(fsrsJson, now)
}

/** 模拟“现在复习一次”之后，到 target 日的记忆率（用于冲刺收益估算，不落库） */
export function projectedRetentionAfterGood(
  fsrsJson: string,
  target: Date,
  now: Date = new Date(),
  mode: 'longterm' | 'exam' = 'exam'
): number {
  try {
    const after = reviewSnapshot(fsrsJson, 3, now, mode)
    return retrievabilityAt(after.fsrsJson, target)
  } catch {
    return 0
  }
}

export function isNewCard(fsrsJson: string): boolean {
  try {
    return Number(revive(fsrsJson).state) === 0
  } catch {
    return false
  }
}

/** 一条可重放的复习事实（PLAN-SYNC §3.3）：只留重放用得上的字段 */
export interface ReplayReview {
  reviewedAt: Date
  rating: 1 | 2 | 3 | 4
}

/**
 * 从复习记录重放出卡片状态：`card = replay(reviews 按时间排序)`。
 *
 * 三条约束（改动这里之前先想清楚）：
 * 1. 只用长期调度器：`applyReview` 今天不看 `mode`，重放必须和它一致；
 *    等哪天考试模式真的改了调度，两边要一起改，否则重放立刻对不上。
 * 2. 起点是 `newCard()`，不是库里那张卡——重放只认「这张卡有没有复习过」。
 * 3. 必须确定性：调度器关掉 fuzz（见 initFsrs），同一串记录重放结果必须一致。
 */
export function replayCard(reviews: ReplayReview[], cardId?: string): CardSnapshot {
  const start = reviews[0]?.reviewedAt ?? new Date()
  let card = schedulerFor('longterm').newCard({ now: start })
  // ts-fsrs 的 newCard 每次生成随机 cardId；要逐字段对齐真实卡片就得沿用它的 id
  if (cardId) card = { ...card, cardId }
  for (const review of reviews) {
    card = schedulerFor('longterm').review({ card, grade: review.rating, now: review.reviewedAt }).card
  }
  return toSnapshot(card)
}
