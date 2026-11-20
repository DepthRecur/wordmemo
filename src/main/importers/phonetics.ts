import type { Item, ParsedItem, PhoneticRefreshResult } from '@shared/types'
import { aiAvailable } from '../ai/client'
import { phoneticForItems } from '../ai/import'
import { getDraft } from '../db/importDrafts'
import { getNote } from '../db/notes'
import { updateItem } from '../db/items'
import { log } from '../diagnostics'
import { lookupPhonetic } from '../media/phonetic'

interface Candidate {
  draftId: number
  item: ParsedItem
}

const AI_CHUNK = 30
const WORD_CONCURRENCY = 5
const PHRASE_FALLBACK_CONCURRENCY = 3

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

function sanitizeIpa(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/^["'“”]+|["'“”]+$/g, '')
  if (!value || /^null$/i.test(value)) return null
  const wrapped = value.match(/\/[^/]{1,160}\//)
  if (wrapped) return wrapped[0]
  if (/^[a-zɑæʌəɜɛɪɔʊɒɚɝθðʃʒŋɹɾʔˈˌːɡʰʲ̃ \-]+$/i.test(value)) return `/${value}/`
  return null
}

function formatPair(us: string | null, uk: string | null): string | null {
  if (us && uk) return `美 ${us} · 英 ${uk}`
  if (us) return `美 ${us}`
  if (uk) return `英 ${uk}`
  return null
}

function isPhrase(item: { headword: string }): boolean {
  return /\s/.test(item.headword.trim())
}

/**
 * 入库前补全音标：
 * - 单词先查词典，查不到的词和所有词组一起交给 AI（美式在前、英式在后）；
 * - AI 不可用或失败时，词组回退到逐词拼接；
 * - 任何失败都不影响入库，只是该词条没有音标。
 */
export async function fillPhoneticsForDrafts(
  draftIds: number[]
): Promise<Map<number, Record<string, string>>> {
  const result = new Map<number, Record<string, string>>()
  const candidates: Candidate[] = []

  for (const draftId of draftIds) {
    const draft = getDraft(draftId)
    if (!draft) continue
    result.set(draftId, {})
    for (const item of draft.items) {
      if (!item.selected || !item.headword.trim()) continue
      if (!/[A-Za-z]/.test(item.headword)) continue
      if (item.phonetic?.trim()) continue
      candidates.push({ draftId, item })
    }
  }
  if (!candidates.length) return result

  const words: Candidate[] = []
  const phrases: Candidate[] = []
  for (const candidate of candidates) {
    if (isPhrase(candidate.item)) phrases.push(candidate)
    else words.push(candidate)
  }

  const assign = (candidate: Candidate, phonetic: string | null): boolean => {
    const clean = sanitizeIpa(phonetic)
    if (!clean || clean.includes('…')) return false
    const record = result.get(candidate.draftId)
    if (!record) return false
    record[candidate.item.tempId] = clean
    return true
  }

  /** AI 已经拼好「美 … · 英 …」，不能再按单条音标截断 */
  const assignFormatted = (candidate: Candidate, value: string | null): boolean => {
    if (!value || value.includes('…')) return false
    const record = result.get(candidate.draftId)
    if (!record) return false
    record[candidate.item.tempId] = value
    return true
  }

  // 单词直接查词典
  const wordResults = await mapLimit(words, WORD_CONCURRENCY, async (candidate) => {
    try {
      return await lookupPhonetic(candidate.item.headword)
    } catch {
      return null
    }
  })
  const wordFailed: Candidate[] = []
  wordResults.forEach((ipa, index) => {
    if (!assign(words[index], ipa)) wordFailed.push(words[index])
  })

  // 词组 + 词典没查到的词交给 AI（整批，每 30 个一批）
  const aiCandidates = [...phrases, ...wordFailed]
  const aiEnabled = aiCandidates.length > 0 && aiAvailable()
  if (aiEnabled) {
    for (let start = 0; start < aiCandidates.length; start += AI_CHUNK) {
      const chunk = aiCandidates.slice(start, start + AI_CHUNK)
      try {
        const aiItems = await phoneticForItems(
          chunk.map((candidate) => ({
            headword: candidate.item.headword,
            kind: candidate.item.kind
          }))
        )
        for (const ai of aiItems) {
          const index = Number(ai.index) - 1
          const target = chunk[index]
          if (!target) continue
          const pair = formatPair(sanitizeIpa(ai.us), sanitizeIpa(ai.uk))
          if (pair) assignFormatted(target, pair)
        }
      } catch (err) {
        log('phonetic-ai-failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  // 词组兜底：AI 不可用/失败时逐词拼接（不写回残缺的 … 结果）
  const missingPhrases = phrases.filter(
    (candidate) => !result.get(candidate.draftId)?.[candidate.item.tempId]
  )
  if (missingPhrases.length) {
    const fallbacks = await mapLimit(
      missingPhrases,
      PHRASE_FALLBACK_CONCURRENCY,
      async (candidate) => {
        try {
          return await lookupPhonetic(candidate.item.headword)
        } catch {
          return null
        }
      }
    )
    fallbacks.forEach((ipa, index) => {
      assign(missingPhrases[index], ipa)
    })
  }

  log('phonetic-fill', {
    drafts: draftIds.length,
    words: words.length,
    phrases: phrases.length,
    ai: aiEnabled
  })
  return result
}

export async function fillPhoneticsForDraft(draftId: number): Promise<Record<string, string>> {
  const map = await fillPhoneticsForDrafts([draftId])
  return map.get(draftId) ?? {}
}

/**
 * 整份笔记重爬音标：忽略内存缓存，重新查一遍并覆盖已有音标（包括手动改过的）。
 * 单词走词典，词组和词典查不到的词交给 AI 拼「美 / 英」，最后用逐词拼接兜底。
 */
export async function refreshNotePhonetics(noteId: number): Promise<PhoneticRefreshResult> {
  const note = getNote(noteId)
  if (!note) return { total: 0, updated: 0, missing: 0 }
  const items: Item[] = note.items.filter((item) => /[A-Za-z]/.test(item.headword))
  const result: PhoneticRefreshResult = { total: items.length, updated: 0, missing: 0 }
  if (!items.length) return result

  const next = new Map<number, string>()
  const words = items.filter((item) => !isPhrase(item))
  const phrases = items.filter((item) => isPhrase(item))

  // 单词：强制跳过内存缓存，重新查词典
  await mapLimit(words, WORD_CONCURRENCY, async (item) => {
    try {
      const clean = sanitizeIpa(await lookupPhonetic(item.headword, true))
      if (clean && !clean.includes('…')) next.set(item.id, clean)
    } catch {
      /* 单个词失败不影响其他词 */
    }
  })

  // 词组 + 词典没查到的词：交给 AI（美式在前、英式在后）
  const aiCandidates = [...phrases, ...words.filter((item) => !next.has(item.id))]
  if (aiCandidates.length && aiAvailable()) {
    for (let start = 0; start < aiCandidates.length; start += AI_CHUNK) {
      const chunk = aiCandidates.slice(start, start + AI_CHUNK)
      try {
        const aiItems = await phoneticForItems(
          chunk.map((item) => ({ headword: item.headword, kind: item.kind }))
        )
        for (const ai of aiItems) {
          const target = chunk[Number(ai.index) - 1]
          if (!target) continue
          const pair = formatPair(sanitizeIpa(ai.us), sanitizeIpa(ai.uk))
          if (pair) next.set(target.id, pair)
        }
      } catch (err) {
        log('phonetic-ai-failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  // 词组兜底：AI 不可用/失败时逐词拼接（不写回残缺的 … 结果）
  const missingPhrases = phrases.filter((item) => !next.has(item.id))
  if (missingPhrases.length) {
    const fallbacks = await mapLimit(
      missingPhrases,
      PHRASE_FALLBACK_CONCURRENCY,
      async (item) => {
        try {
          return sanitizeIpa(await lookupPhonetic(item.headword, true))
        } catch {
          return null
        }
      }
    )
    fallbacks.forEach((ipa, index) => {
      if (ipa && !ipa.includes('…')) next.set(missingPhrases[index].id, ipa)
    })
  }

  for (const item of items) {
    const value = next.get(item.id)
    if (!value) {
      result.missing++
      continue
    }
    if (value !== item.phonetic) {
      updateItem(item.id, { phonetic: value })
      result.updated++
    }
  }

  log('phonetic-refresh', { noteId, ...result })
  return result
}
