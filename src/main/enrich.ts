import { getNote } from './db/notes'
import { getItem, updateItem } from './db/items'
import { enrichItems } from './ai/import'
import { normalizeEn } from '@shared/normalize'

function mergeList(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((s) => normalizeEn(s)))
  const out = [...a]
  for (const raw of b) {
    const value = String(raw).trim()
    const key = normalizeEn(value)
    if (value && key && !seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }
  return out
}

/** 为一份笔记里所有词条补充常用搭配/例句，返回更新的词条数 */
export async function enrichNote(noteId: number): Promise<number> {
  const note = getNote(noteId)
  if (!note) return 0
  let changed = 0
  for (let start = 0; start < note.items.length; start += 20) {
    const chunk = note.items.slice(start, start + 20)
    const results = await enrichItems(chunk)
    for (const raw of results) {
      const item = chunk[Number(raw.index) - 1]
      if (!item) continue
      const current = getItem(item.id)
      if (!current) continue
      const collocations = mergeList(current.collocations, (raw.collocations ?? []).map(String)).slice(0, 4)
      const examples =
        current.examples.length || !raw.example?.en
          ? current.examples
          : [
              {
                en: String(raw.example.en).trim(),
                zh: raw.example.zh ? String(raw.example.zh).trim() : undefined
              }
            ]
      if (
        collocations.length !== current.collocations.length ||
        examples.length !== current.examples.length
      ) {
        updateItem(item.id, { collocations, examples })
        changed++
      }
    }
  }
  return changed
}
