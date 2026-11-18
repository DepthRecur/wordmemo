import type { NoteQuery, SearchResult } from '@shared/types'
import { listItems } from './db/items'
import { listNotes } from './db/notes'
import { aiAvailable, chatJson } from './ai/client'
import { SEARCH_EXPAND_SYSTEM } from './ai/prompts'

const CJK = /[\u4e00-\u9fff]/

/** 只把查询词发给 AI，让它给出几个常见英文对应词；不发送词库内容，也不缓存 */
async function expandChineseQuery(query: string): Promise<string[]> {
  const result = await chatJson<{ terms?: unknown }>({
    kind: 'search-expand',
    messages: [
      { role: 'system', content: SEARCH_EXPAND_SYSTEM },
      { role: 'user', content: query }
    ],
    maxTokens: 200,
    temperature: 0
  })
  const terms = Array.isArray(result.terms) ? result.terms : []
  return terms
    .map((t) => String(t).trim())
    .filter((t) => t && /[a-zA-Z]/.test(t))
    .slice(0, 5)
}

/**
 * 搜索策略：
 * 1. 先用原词在本地搜词条、笔记；
 * 2. 中文查询且没有命中任何词条时，让 AI 给出 3~5 个常见英文对应词；
 * 3. 再用这些英文词在本地检索并合并结果；
 * 4. 不把词库发给 AI，也不永久缓存扩展结果。
 */
export async function semanticSearch(
  query: string,
  sort: NoteQuery['sort'] = 'noteDate'
): Promise<SearchResult> {
  const term = query.trim()
  if (!term) return { notes: [], items: [], expandedTerms: [], aiUsed: false }

  const notes = listNotes({ search: term, sort, order: 'desc' })
  const items = listItems(term)
  const chineseChars = term.replace(/[^\u4e00-\u9fff]/g, '')

  if (!CJK.test(term) || items.length > 0 || chineseChars.length < 2 || !aiAvailable()) {
    return { notes, items, expandedTerms: [], aiUsed: false }
  }

  try {
    const expandedTerms = await expandChineseQuery(term)
    if (!expandedTerms.length) return { notes, items, expandedTerms: [], aiUsed: false }

    const itemMap = new Map(items.map((item) => [item.id, item]))
    const noteMap = new Map(notes.map((note) => [note.id, note]))
    for (const expanded of expandedTerms) {
      for (const item of listItems(expanded)) itemMap.set(item.id, item)
      for (const note of listNotes({ search: expanded, sort, order: 'desc' })) {
        noteMap.set(note.id, note)
      }
    }

    return {
      notes: Array.from(noteMap.values()),
      items: Array.from(itemMap.values()),
      expandedTerms,
      aiUsed: true
    }
  } catch {
    return { notes, items, expandedTerms: [], aiUsed: false }
  }
}
