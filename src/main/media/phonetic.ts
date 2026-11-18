import { normalizeEn } from '@shared/normalize'

const cache = new Map<string, string | null>()

interface DictionaryEntry {
  phonetic?: string
  phonetics?: { text?: string }[]
}

interface YoudaoWord {
  usphone?: string
  ukphone?: string
}

interface YoudaoResponse {
  simple?: { word?: YoudaoWord[] }
  ec?: { word?: YoudaoWord[] }
  collins?: {
    collins_entries?: {
      entries?: { entry?: { phonetic?: string }[] }[]
    }[]
  }
}

function normalizeIpa(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/['’]/g, 'ˈ').replace(/\s+/g, ' ')
  if (!value || /^null$/i.test(value)) return null
  // 有道会返回 "biː; bi" 这种多音标串，取第一个合法音标
  for (const piece of value.split(/[;；,，]+/)) {
    const part = piece.trim()
    if (!part) continue
    const wrapped = part.match(/\/[^/]{1,80}\//)
    if (wrapped) return wrapped[0]
    // 有道返回的音标通常不带斜杠，如 əˈsesmənt
    if (/^[a-zɑæʌəɜɛɪɔʊɒɚɝθðʃʒŋɹɾʔˈˌːɡʰʲ̃]+$/i.test(part)) return `/${part}/`
  }
  return null
}

function candidatesFromDictionary(data: DictionaryEntry[]): string[] {
  const out: string[] = []
  for (const entry of data) {
    if (entry.phonetic) out.push(entry.phonetic)
    if (Array.isArray(entry.phonetics)) {
      for (const p of entry.phonetics) if (p.text) out.push(p.text)
    }
  }
  return out
}

function candidatesFromYoudao(data: YoudaoResponse): string[] {
  const out: string[] = []
  for (const group of [data.simple?.word, data.ec?.word]) {
    if (Array.isArray(group)) {
      for (const word of group) {
        if (word.usphone) out.push(word.usphone)
        if (word.ukphone) out.push(word.ukphone)
      }
    }
  }
  const collins = data.collins?.collins_entries
  if (Array.isArray(collins)) {
    for (const entry of collins) {
      if (!Array.isArray(entry.entries)) continue
      for (const sub of entry.entries) {
        if (!Array.isArray(sub.entry)) continue
        for (const item of sub.entry) {
          if (item.phonetic) out.push(item.phonetic)
        }
      }
    }
  }
  return out
}

function firstIpa(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const ipa = normalizeIpa(candidate)
    if (ipa) return ipa
  }
  return null
}

async function fromFreeDictionary(word: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      {
        headers: { 'User-Agent': 'WordMemo/0.1' },
        signal: AbortSignal.timeout(8_000)
      }
    )
    if (!res.ok) return null
    const data = (await res.json()) as DictionaryEntry[]
    if (!Array.isArray(data)) return null
    return firstIpa(candidatesFromDictionary(data))
  } catch {
    return null
  }
}

/** assessment 这类词在 Free Dictionary 里可能只有词条、没有 phonetics，用有道补一次 */
async function fromYoudao(word: string): Promise<string | null> {
  try {
    const res = await fetch(`https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156 Safari/537.36',
        Referer: 'https://dict.youdao.com/'
      },
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as YoudaoResponse
    return firstIpa(candidatesFromYoudao(data))
  } catch {
    return null
  }
}

/** 词组按空格/标点拆成单词；保留词内连字符和撇号，如 well-known、don't */
export function splitPhrase(input: string): string[] {
  return input
    .replace(/[^A-Za-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => token.replace(/^[-']+|[-']+$/g, ''))
    .filter((token) => /[A-Za-z]/.test(token))
}

function stripSlashes(ipa: string): string {
  return ipa.replace(/^\/+|\/+$/g, '').replace(/^\[+|\]+$/g, '').trim()
}

/** 把逐词音标拼成词组的音标；缺失的词用 … 占位 */
export function combineIpa(parts: (string | null)[]): string {
  return `/${parts.map((part) => (part ? stripSlashes(part) : '…')).join(' ')}/`
}

/** 常见屈折形式的词形还原候选（按可能性排序，先试最可能的） */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase()
  const out = new Set<string>()
  if (w.length > 3) {
    if (w.endsWith('ies')) out.add(w.slice(0, -3) + 'y')
    if (w.endsWith('ied')) out.add(w.slice(0, -3) + 'y')
    if (w.endsWith('es')) out.add(w.slice(0, -2))
    if (w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1))
    if (w.endsWith('ed')) {
      out.add(w.slice(0, -2))
      out.add(w.slice(0, -1))
    }
    if (w.endsWith('ing')) {
      out.add(w.slice(0, -3))
      out.add(w.slice(0, -3) + 'e')
    }
    const doubled = w.match(/^(.*?)([b-df-hj-np-tv-z])\2(ed|ing)$/)
    if (doubled) out.add(doubled[1] + doubled[2])
  }
  return [...out].filter((lemma) => lemma.length >= 2 && lemma !== w)
}

function lastIpaSound(ipa: string): string {
  return stripSlashes(ipa).replace(/[ˈˌː]+$/g, '').slice(-1)
}

/** 用原形音标推导屈折形式的音标（只处理规则变化；推导不出来返回 null） */
export function inflectIpa(baseIpa: string, word: string): string | null {
  const bare = stripSlashes(baseIpa)
  if (!bare) return null
  const w = word.toLowerCase()
  const last = lastIpaSound(bare)
  if (w.endsWith('s') && !w.endsWith('ss')) {
    if (/[sʃʒz]/.test(last) || /(tʃ|dʒ)$/.test(bare)) return `/${bare}ɪz/`
    if (/[ptkfθ]/.test(last)) return `/${bare}s/`
    return `/${bare}z/`
  }
  if (w.endsWith('ed')) {
    if (/[td]/.test(last)) return `/${bare}ɪd/`
    if (/[ptkfθsʃ]/.test(last)) return `/${bare}t/`
    return `/${bare}d/`
  }
  if (w.endsWith('ing')) return `/${bare}ɪŋ/`
  return null
}

/**
 * 按需查询音标：
 * - 单词：先 Free Dictionary，查不到再用有道补；
 * - 词组：拆成单词逐个查询，再按原顺序拼接（缺失词用 … 表示，不缓存也不写回词条）。
 * 只在内存里缓存完整结果；失败或缺失不缓存，下次点击可以重试。
 * force=true 时忽略并清掉内存缓存，用于「整份笔记重爬音标」。
 */
export async function lookupPhonetic(input: string, force = false): Promise<string | null> {
  const key = normalizeEn(input)
  if (!key) return null
  if (force) cache.delete(key)
  else if (cache.has(key)) return cache.get(key) ?? null

  const tokens = splitPhrase(key)
  if (tokens.length > 1) {
    const unique = [...new Set(tokens)]
    const resolved = new Map<string, string | null>()
    await Promise.all(
      unique.map(async (token) => {
        resolved.set(token, await lookupPhonetic(token, force))
      })
    )
    const parts = tokens.map((token) => resolved.get(token) ?? null)
    if (parts.every((part) => !part)) return null
    const ipa = combineIpa(parts)
    // 有缺失词时不缓存，下次点「音标提示」会只重试缺失的词
    if (!parts.some((part) => !part)) cache.set(key, ipa)
    return ipa
  }

  const word = tokens[0] ?? key
  let ipa = await fromFreeDictionary(word)
  if (!ipa) ipa = await fromYoudao(word)
  // 复数/第三人称/过去式等变形经常没有独立音标，用原形推导
  if (!ipa) {
    for (const lemma of lemmaCandidates(word)) {
      const base = await lookupPhonetic(lemma, force)
      if (!base) continue
      ipa = inflectIpa(base, word)
      if (ipa) break
    }
  }
  if (ipa) cache.set(key, ipa)
  return ipa
}
