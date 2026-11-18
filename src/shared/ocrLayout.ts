/**
 * OCR 结果的版面后处理。
 *
 * 视觉模型对「左右分栏」几乎必然会犯错：同一次调用里，它有时先写完左栏再写右栏，
 * 有时把左右两栏同一高度的一行拼成一行（实测同一提示词两次运行会来回摇摆）。
 * 因此提示词要求模型给每一行标注它所属的栏号：
 *
 *   [1] assess v. 评估
 *   [1] evaluate v. 评估
 *   [2] pave the way for 为…铺路
 *
 * 这里再把行按栏号稳定排序，阅读顺序由这段确定的代码保证，而不是靠模型自觉。
 * 模型没给栏号时原样返回，等价于旧行为，不会更差。
 */
export interface OcrLayout {
  /** 重排后的正文（栏号已去掉） */
  text: string
  /** 识别出的栏数；0 表示模型没标注 */
  columns: number
  labeled: boolean
}

const LABEL_RE = /^\s*[[【(]\s*(\d{1,2})\s*[\]】)]\s*(.*)$/
// 一行里并排写了两组「英文 + 词性 + 释义」时，在第二个词性标记前切开
// 只在「中文字/字母」之后、且后面紧跟「英文 + 词性」处切开，避免把行首序号切开
const ENTRY_SPLIT =
  /(?<=[\u4e00-\u9fffA-Za-z)\]）])\s+(?=[A-Za-z][A-Za-z'’\-]*\s+(?:v|n|adj|adv|prep|conj|pron|vt|vi|phr)\.\s*)/i

/**
 * 把一行拆成若干词条：`assess v.评估 assessment n.评估` → 两条。
 * 只有确实出现第二个「英文+词性」时才拆，短语行、表格行原样返回。
 */
export function splitEntryLine(line: string): string[] {
  const trimmed = (line ?? '').trim()
  if (!trimmed || trimmed.startsWith('|')) return trimmed ? [trimmed] : []
  const parts = trimmed
    .split(ENTRY_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [trimmed]
}

export function normalizeOcrText(raw: string): OcrLayout {
  const input = (raw ?? '').replace(/\r\n/g, '\n')
  const lines = input.split('\n')
  const buckets = new Map<number, string[]>()
  const before: string[] = []
  let current = 0
  let labeled = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(LABEL_RE)
    if (m) {
      labeled++
      current = Number(m[1])
      const body = m[2].trim()
      if (!body) continue
      if (!buckets.has(current)) buckets.set(current, [])
      buckets.get(current)!.push(body)
      continue
    }
    if (!current) {
      // 第一条带栏号的行之前的内容（标题、日期等）保持在最前面
      before.push(trimmed)
      continue
    }
    // 模型漏标的续行：跟随上一行所属的栏，保持原有先后
    buckets.get(current)!.push(trimmed)
  }

  if (!labeled) return { text: input.trim(), columns: 0, labeled: false }

  const keys = [...buckets.keys()].sort((a, b) => a - b)
  const out = [...before]
  for (const key of keys) out.push(...buckets.get(key)!)
  return { text: out.join('\n'), columns: keys.length, labeled: true }
}
