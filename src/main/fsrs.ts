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
  longTermScheduler = await DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: options.longTermRetention,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: true,
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
