import type { JudgeResult } from '@shared/types'
import { isGiveUpAnswer, matchChinese, matchEnglish, normalizeEn, normalizeZh } from '@shared/normalize'
import { getCardRow } from './db/cards'
import { getItem } from './db/items'
import { getSettings } from './settings'
import { aiAvailable, chatJson, overBudget } from './ai/client'
import { JUDGE_EN_SYSTEM, JUDGE_SYSTEM } from './ai/prompts'
import { hashKey } from './ai/import'

interface AiJudge {
  relation?: 'same' | 'alternative' | 'different'
  equivalent?: boolean
  confidence?: number
  normalized?: string
  reason?: string
}

export async function judgeAnswer(cardId: number, answer: string): Promise<JudgeResult> {
  const clean = answer.trim()
  if (!clean) return { correct: false, confidence: 1, source: 'exact', reason: '没有作答' }
  // 主动放弃：不查词条、不做匹配、不调 AI，直接按错误计
  if (isGiveUpAnswer(clean)) {
    return { correct: false, confidence: 1, source: 'giveup', reason: '已放弃作答，按不会处理' }
  }

  const row = getCardRow(cardId)
  if (!row) throw new Error('卡片不存在')
  const item = getItem(row.item_id)
  if (!item) throw new Error('词条不存在')
  const settings = getSettings()

  if (row.direction === 'zh2en' || row.direction === 'listen2en') {
    const m = matchEnglish(clean, item.headword)
    if (m) return { correct: true, confidence: 1, source: m }
    // 本地没命中：括号可选词、占位符、缩写等写法差异交 AI 判一次。
    // AI 不可用时维持原来的严格判错，不改变离线体验。
    if (!settings.aiJudge || !aiAvailable() || overBudget()) {
      return { correct: false, confidence: 1, source: 'exact', reason: '拼写不正确' }
    }
    const content = `词条：${item.headword}
词性：${item.pos ?? '未知'}
释义：${item.meanings.join('；')}
学生答案：${clean}`
    try {
      const result = await chatJson<AiJudge>({
        kind: 'judge',
        messages: [
          { role: 'system', content: JUDGE_EN_SYSTEM },
          { role: 'user', content }
        ],
        maxTokens: 200,
        cacheKey: hashKey(['judge-en-v2', String(item.id), item.headword, normalizeEn(clean)])
      })
      const confidence = Math.max(0, Math.min(1, Number(result.confidence ?? 0)))
      const relation = result.relation ?? (result.equivalent ? 'same' : 'different')
      if (relation === 'same' && confidence >= 0.6) {
        return {
          correct: true,
          confidence,
          source: 'ai',
          normalized: result.normalized,
          reason: result.reason
        }
      }
      if (relation === 'same' || confidence < 0.5) {
        return {
          correct: false,
          uncertain: true,
          confidence,
          source: 'ai',
          normalized: result.normalized,
          reason: result.reason ?? 'AI 不太确定这个写法，请自行确认'
        }
      }
      return {
        correct: false,
        confidence,
        source: 'ai',
        normalized: result.normalized,
        reason: result.reason ?? '表达不一致'
      }
    } catch {
      return { correct: false, confidence: 1, source: 'exact', reason: '拼写不正确' }
    }
  }

  // en2zh
  const localMeanings = [...item.meanings, ...item.acceptedZh]
  if (matchChinese(clean, localMeanings)) {
    return { correct: true, confidence: 1, source: 'local', normalized: clean }
  }

  if (!settings.aiJudge || !aiAvailable() || overBudget()) {
    return {
      correct: false,
      uncertain: true,
      confidence: 0,
      source: 'manual',
      reason: overBudget() ? '本月 AI 预算已用完，请自评' : '无法自动判定，请自评'
    }
  }

  const content = `单词：${item.headword}
词性：${item.pos ?? '未知'}
标准释义：${item.meanings.join('；')}
学生答案：${clean}`

  try {
    const result = await chatJson<AiJudge>({
      kind: 'judge',
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content }
      ],
      maxTokens: 200,
      cacheKey: hashKey([
        'judge-v2',
        String(item.id),
        item.meanings.join('|'),
        normalizeZh(clean)
      ])
    })
    const confidence = Math.max(0, Math.min(1, Number(result.confidence ?? 0)))
    const relation = result.relation ?? (result.equivalent ? 'same' : 'different')
    if (relation === 'same' && confidence >= 0.6) {
      return {
        correct: true,
        confidence,
        source: 'ai',
        normalized: result.normalized,
        reason: result.reason
      }
    }
    if (relation === 'alternative') {
      if (confidence < 0.5) {
        return {
          correct: false,
          uncertain: true,
          confidence,
          source: 'ai',
          normalized: result.normalized,
          reason: result.reason ?? 'AI 判断这个词可能还有别的义项，请自行确认'
        }
      }
      return {
        correct: false,
        alternative: true,
        confidence,
        source: 'ai',
        normalized: result.normalized,
        reason: result.reason ?? '这个词确实有这个意思，但不在本词条保存的释义里'
      }
    }
    if (relation === 'same' || confidence < 0.5) {
      return {
        correct: false,
        uncertain: true,
        confidence,
        source: 'ai',
        normalized: result.normalized,
        reason: result.reason ?? 'AI 不太确定，请自行确认'
      }
    }
    return {
      correct: false,
      confidence,
      source: 'ai',
      normalized: result.normalized,
      reason: result.reason ?? '语义不一致'
    }
  } catch (err) {
    return {
      correct: false,
      uncertain: true,
      confidence: 0,
      source: 'manual',
      reason: `AI 判定失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}
