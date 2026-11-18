// 对照人工真值评估 OCR 结果的词条召回/释义准确率。
// 支持一行里并排写了两组「英文+词性+释义」的情况（按词性标记拆开）。
// 用法: node eval.mjs <gt.tsv> <out.md>
import fs from 'node:fs'

const CJK = /[\u4e00-\u9fff]/
const POS_WORD = /\b(?:vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|n|v|phr|abbr)\.?\b/gi
// 行内拆分：英文单词 + 词性标记，说明又开始了新词条
const SPLIT = /\s+(?=[A-Za-z][A-Za-z'’\-]*\s+(?:v|n|adj|adv|prep|conj|pron|vt|vi|phr)\.)/

function normEn(s) {
  return s
    .toLowerCase()
    .replace(POS_WORD, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
const normZh = (s) => s.replace(/[\s，。、；：！？“”‘’（）()…·,.;:!?"'[\]_-]/g, '')
const tokens = (s) => new Set(s.split(' ').filter(Boolean))

function cleanLine(raw) {
  return raw
    .replace(/^\s*(?:[-*•·>]+|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, '')
    .replace(/^\s*[A-Za-z]\s*[*]\s*/, '')
    .trim()
}

export function parseChunks(raw) {
  const line = cleanLine(raw)
  if (!line) return []
  const chunks = line.split(SPLIT)
  const out = []
  for (const chunk of chunks) {
    const idx = chunk.search(CJK)
    if (idx <= 0) continue
    const en = normEn(chunk.slice(0, idx))
    if (!en || !/[a-z]/.test(en)) continue
    out.push({ en, zh: normZh(chunk.slice(idx)), raw: chunk.trim() })
  }
  return out
}

export function evaluate(gtPath, mdPath) {
  const gt = fs
    .readFileSync(gtPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [en, zh] = l.split('\t')
      return { en: normEn(en), zh: normZh(zh ?? '') }
    })

  const lines = []
  for (const raw of fs.readFileSync(mdPath, 'utf8').split(/\r?\n/)) lines.push(...parseChunks(raw))

  let hit = 0
  let meaningOk = 0
  const missing = []
  const wrong = []
  for (const g of gt) {
    const gtok = tokens(g.en)
    const cands = lines.filter((l) => l.en === g.en || [...gtok].every((t) => tokens(l.en).has(t)))
    if (!cands.length) {
      missing.push(g.en)
      continue
    }
    hit++
    const ok = cands.some((c) => {
      const a = c.zh
      const b = g.zh
      if (!b) return true
      return a === b || a.includes(b) || b.includes(a) || a.includes(b.slice(0, 2))
    })
    if (ok) meaningOk++
    else wrong.push(`${g.en}: 期望「${g.zh}」得到「${cands.map((c) => c.zh).join(' | ')}」`)
  }

  const gtSet = new Set(gt.map((g) => g.en))
  const extra = lines
    .filter((l) => ![...gtSet].some((g) => [...tokens(g)].every((t) => tokens(l.en).has(t))))
    .map((l) => l.raw)
  const pct = (n) => `${((100 * n) / gt.length).toFixed(1)}%`

  return {
    真值条数: gt.length,
    输出词条数: lines.length,
    命中: hit,
    词条召回: pct(hit),
    释义正确: meaningOk,
    释义准确率: pct(meaningOk),
    缺失: missing,
    释义不符: wrong,
    多余词条: extra
  }
}

if (process.argv[1] && process.argv[1].endsWith('eval.mjs')) {
  console.log(JSON.stringify(evaluate(process.argv[2], process.argv[3]), null, 2))
}
