import crypto from 'node:crypto'
import { chat, chatJson, aiAvailable } from './client'
import type { OcrLayout } from '@shared/ocrLayout'
import { normalizeOcrText } from '@shared/ocrLayout'
import { ENRICH_SYSTEM, OCR_SYSTEM, PHONETIC_SYSTEM, STRUCT_SYSTEM, VALIDATE_SYSTEM } from './prompts'

export interface AiStructItem {
  headword?: string
  pos?: string | string[] | null
  kind?: string
  meanings?: string[]
  collocations?: string[]
  examples?: { en?: string; zh?: string }[]
  extra?: string | null
  source_line?: string | null
}

export interface AiStructResult {
  items?: AiStructItem[]
  warnings?: { line?: string; reason?: string }[]
}

export interface AiIssue {
  index?: number
  field?: string
  severity?: string
  message?: string
  suggestion?: string
}

export function hashKey(parts: (string | undefined | null)[]): string {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex')
}

export async function ocrImage(base64: string, mime: string): Promise<OcrLayout> {
  if (!aiAvailable('vision'))
    throw new Error('识别图片需要先在设置里配置 API Key 和图片识别用的模型')
  const content = await chat({
    kind: 'ocr',
    role: 'vision',
    messages: [
      { role: 'system', content: OCR_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请先判断这一页有几栏，再按栏顺序逐行转录，每行标注所属栏号。' },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}`, detail: 'original' }
          }
        ]
      }
    ],
    maxTokens: 4000,
    timeoutMs: 120_000,
    cacheKey: hashKey(['ocr-v2', base64.slice(0, 512), base64.length.toString(), mime])
  })
  return normalizeOcrText(content)
}

export async function structurize(rawText: string): Promise<AiStructResult> {
  if (!aiAvailable()) return {}
  const text = rawText.slice(0, 16_000)
  return chatJson<AiStructResult>({
    kind: 'struct',
    messages: [
      { role: 'system', content: STRUCT_SYSTEM },
      { role: 'user', content: text }
    ],
    maxTokens: 6000,
    cacheKey: hashKey(['struct-v1', text])
  })
}

/** 校验分批（P-04）：一份 3000 词的笔记不再拼成一条超长 prompt */
const VALIDATE_BATCH = 50
/** 同时最多几个批次在飞；四家厂商都扛得住，太小反而白等 */
const VALIDATE_CONCURRENCY = 5

export async function validateItems(
  items: { headword: string; pos?: string | null; meanings: string[] }[]
): Promise<AiIssue[]> {
  if (!aiAvailable() || !items.length) return []

  const batches: { start: number; items: typeof items }[] = []
  for (let start = 0; start < items.length; start += VALIDATE_BATCH) {
    batches.push({ start, items: items.slice(start, start + VALIDATE_BATCH) })
  }

  const issues: AiIssue[] = []
  let next = 0
  let failure: unknown = null

  const runOne = async (start: number, chunk: typeof items): Promise<void> => {
    const lines = chunk
      .map((it, i) => `${i + 1} | ${it.headword} | ${it.pos ?? ''} | ${it.meanings.join('；')}`)
      .join('\n')
    const result = await chatJson<{ issues?: AiIssue[] }>({
      kind: 'validate',
      messages: [
        { role: 'system', content: VALIDATE_SYSTEM },
        { role: 'user', content: lines }
      ],
      maxTokens: 3000,
      cacheKey: hashKey(['validate-v1', lines])
    })
    for (const issue of Array.isArray(result.issues) ? result.issues : []) {
      const local = Number(issue.index)
      // 批次内部从 1 开始编号，返回前换算回整份笔记的序号
      const index =
        Number.isInteger(local) && local >= 1 && local <= chunk.length ? start + local : issue.index
      issues.push({ ...issue, index })
    }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure) return
      const batch = batches[next++]
      if (!batch) return
      try {
        await runOne(batch.start, batch.items)
      } catch (err) {
        // 只要有一批没校验成功，就不返回「半份结果」：宁可整次失败，也不让用户
        // 以为剩下的词条都检查过了
        failure ??= err
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(VALIDATE_CONCURRENCY, batches.length) }, () => worker())
  )
  if (failure) throw failure
  // 并发执行后按序号排好，界面上的问题列表才稳定
  return issues.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
}

export interface AiEnrichItem {
  index?: number
  collocations?: string[]
  example?: { en?: string; zh?: string }
}

/** 为词条补充常用搭配和例句（AI 生成，导入/手动触发） */
export async function enrichItems(
  items: { headword: string; pos?: string | null; meanings: string[] }[]
): Promise<AiEnrichItem[]> {
  if (!aiAvailable() || !items.length) return []
  const lines = items
    .map((it, i) => `${i + 1} | ${it.headword} | ${it.pos ?? ''} | ${it.meanings.join('；')}`)
    .join('\n')
  const result = await chatJson<{ items?: AiEnrichItem[] }>({
    kind: 'enrich',
    messages: [
      { role: 'system', content: ENRICH_SYSTEM },
      { role: 'user', content: lines }
    ],
    maxTokens: 4000,
    cacheKey: hashKey(['enrich-v1', lines])
  })
  return Array.isArray(result.items) ? result.items : []
}

export interface AiPhoneticItem {
  index?: number
  us?: string | null
  uk?: string | null
}

/** 让 AI 为单词/词组标注整体音标（美式、英式各一份），用于入库时补全 */
export async function phoneticForItems(
  items: { headword: string; kind?: string }[]
): Promise<AiPhoneticItem[]> {
  if (!aiAvailable() || !items.length) return []
  const lines = items
    .map((it, i) => `${i + 1} | ${it.headword} | ${it.kind ?? ''}`)
    .join('\n')
  const result = await chatJson<{ items?: AiPhoneticItem[] }>({
    kind: 'phonetic',
    messages: [
      { role: 'system', content: PHONETIC_SYSTEM },
      { role: 'user', content: lines }
    ],
    maxTokens: 4000,
    cacheKey: hashKey(['phonetic-v1', lines])
  })
  return Array.isArray(result.items) ? result.items : []
}
