import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { ReviewSession } from '@shared/types'

/**
 * 复习现场（2026-11-20）：练习到一半离开（切页面 / 关窗口 / 退出应用），
 * 回来要回到同一张卡、同一个状态，不再要求重新作答。
 *
 * 为什么单独一个文件而不是进 settings：
 *   它是一次会话的临时状态（几分钟到几小时就作废），写进 settings.json 会污染
 *   「设置」并跟着同步/备份走；放 userData 下一个独立 json 最简单。
 *
 * 存不下、读坏了都只是「恢复不了上次的位置」，不许影响复习本身。
 */
const FILE_NAME = 'review-session.json'
/** 超过这么久就当作过期：到期状态早变了，硬恢复反而奇怪 */
const TTL_MS = 12 * 60 * 60 * 1000

function sessionFile(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function asCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

export function readReviewSession(): ReviewSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as Partial<ReviewSession> | null
    if (!raw || typeof raw !== 'object') return null
    if (!raw.card || typeof raw.card !== 'object' || !Number.isInteger(raw.card.id)) return null
    if (typeof raw.scope !== 'string') return null
    const savedAt = Date.parse(String(raw.savedAt ?? ''))
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > TTL_MS) {
      clearReviewSession()
      return null
    }
    return {
      scope: raw.scope,
      card: raw.card,
      answer: typeof raw.answer === 'string' ? raw.answer : '',
      result: raw.result ?? null,
      answeredMs: typeof raw.answeredMs === 'number' ? raw.answeredMs : null,
      stats: {
        total: asCount(raw.stats?.total),
        correct: asCount(raw.stats?.correct)
      },
      position: Math.max(1, asCount(raw.position) || 1),
      total: Math.max(1, asCount(raw.total) || 1),
      savedAt: String(raw.savedAt)
    }
  } catch {
    return null
  }
}

export function saveReviewSession(session: ReviewSession): void {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify(session), 'utf8')
  } catch {
    /* 恢复不了位置而已，不要因此报错打断复习 */
  }
}

export function clearReviewSession(): void {
  try {
    fs.unlinkSync(sessionFile())
  } catch {
    /* 本来就没有 */
  }
}
