import type { ItemKind } from './types'

/** 全角转半角、统一空白 */
export function nfkc(input: string): string {
  return (input ?? '').normalize('NFKC')
}

export function normalizeEn(input: string): string {
  return nfkc(input)
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'(（【[]+/, '')
    .replace(/[\s"'.)）】\]!?,;:。，；：！？]+$/, '')
}

export function normalizeZh(input: string): string {
  return nfkc(input)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。，、；：！？""''（）()【】\[\]{}…·~～<>《》]/g, '')
    .trim()
}

export function splitMeanings(raw: string): string[] {
  const parts = nfkc(raw)
    .split(/[;；,，、/|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : [raw.trim()].filter(Boolean)
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array<number>(b.length + 1)
  const cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

/** 英式/美式、连字符/空格等常见等价拼写 */
export function enVariants(input: string): Set<string> {
  const base = normalizeEn(input)
  const out = new Set<string>([base])
  const add = (s: string) => {
    const v = s.replace(/\s+/g, ' ').trim()
    if (v) out.add(v)
  }

  add(base.replace(/^to\s+/, ''))
  add(base.replace(/our/g, 'or'))
  add(base.replace(/ise\b/g, 'ize').replace(/isation\b/g, 'ization').replace(/yse\b/g, 'yze'))
  add(base.replace(/re\b/g, 'er'))
  add(base.replace(/-/g, ' '))
  add(base.replace(/\s+/g, '-'))
  add(base.replace(/ll\b/g, 'l'))

  // 对以上结果再做一次交叉组合（英式 + 连字符等）
  for (const v of Array.from(out)) {
    add(v.replace(/our/g, 'or'))
    add(v.replace(/-/g, ' '))
  }
  return out
}

export function matchEnglish(answer: string, headword: string): 'exact' | 'variant' | null {
  const a = normalizeEn(answer)
  const h = normalizeEn(headword)
  if (!a) return null
  if (a === h) return 'exact'
  const av = enVariants(a)
  const hv = enVariants(h)
  for (const v of av) if (hv.has(v)) return 'variant'
  return null
}

/**
 * 用户主动放弃作答：只有「不知道」和「XXX」两种写法（含大小写、全角、结尾标点差异）。
 * 刻意不做模糊匹配——有些词条的意思就是“不记得”，放宽会误伤正常作答。
 */
export function isGiveUpAnswer(answer: string): boolean {
  const value = nfkc(answer ?? '')
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？,，、;；:：~～\s]+$/g, '')
  return value === '不知道' || value === 'xxx'
}

export function matchChinese(answer: string, meanings: string[]): boolean {
  const a = normalizeZh(answer)
  if (!a) return false
  for (const raw of meanings) {
    for (const m of splitMeanings(raw)) {
      const nm = normalizeZh(m)
      if (!nm) continue
      if (a === nm) return true
      if (nm.length >= 2 && a.includes(nm)) return true
      if (a.length >= 2 && nm.includes(a)) return true
    }
  }
  return false
}

/** 拼写编辑距离；保留给后续可能的模糊匹配使用 */

export function guessKind(headword: string): ItemKind {
  const h = headword.trim()
  if (!h) return 'word'
  const words = h.split(/\s+/)
  if (h.endsWith('.') && words.length >= 5) return 'sentence'
  if (words.length >= 3) return 'phrase'
  return 'word'
}

const POS_RE = /^(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|phr|phrase|abbr)\.?$/i

export function guessPos(token: string): string | null {
  const t = token.trim().replace(/[.,;:]$/, '')
  return POS_RE.test(t) ? t.replace(/\.$/, '').toLowerCase() + '.' : null
}

/** 合并同一单词的多个词性，如 v. + n. -> "v. / n." */
export function mergePosText(a: string | null | undefined, b: string | null | undefined): string | null {
  const out: string[] = []
  for (const raw of [...(a ?? '').split(/[/,;、]/), ...(b ?? '').split(/[/,;、]/)]) {
    const token = raw.trim()
    if (!token) continue
    const pos = guessPos(token) ?? token
    if (!out.includes(pos)) out.push(pos)
  }
  return out.length ? out.join(' / ') : null
}

/** 本地时间 date key: YYYY-MM-DD */
export function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dateKey(dt)
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const da = Date.UTC(ay, am - 1, ad)
  const db = Date.UTC(by, bm - 1, bd)
  return Math.round((db - da) / 86400000)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${dateKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 学习者更熟悉的音标写法：IPA 的 ɹ 用 r 表示（多数学习词典也这样写） */
export function displayPhonetic(ipa: string | null | undefined): string {
  if (!ipa) return ''
  return ipa.replace(/ɹ/g, 'r')
}

/** 清理 AI 校验建议里的“补充：/改为：”等前缀，只保留最终值 */
export function cleanSuggestion(field: string, raw: string): string {
  let value = (raw ?? '').trim()
  value = value.replace(/^(?:建议|补充|改为|应改为|修正为|应为|正确写法|正确释义)\s*[:：]\s*/i, '')
  value = value.replace(/^[“”"'‘’]+|[“”"'‘’]+$/g, '').trim()
  if (field === 'pos') {
    const tokens = value.match(/\b(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|phr|phrase|abbr)\.?/gi) ?? []
    const normalized = Array.from(new Set(tokens.map((t) => t.replace(/\.$/, '').toLowerCase() + '.')))
    if (normalized.length) value = normalized.join(' / ')
  }
  return value.trim()
}
