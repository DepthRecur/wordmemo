import type { ImportPreview, ItemKind, ParsedItem, ValidationIssue } from '@shared/types'
import { guessKind, guessPos, mergePosText, normalizeEn, splitMeanings } from '@shared/normalize'
import { splitEntryLine } from '@shared/ocrLayout'
import { getSettings, hasApiKey } from '../settings'
import { aiAvailable } from '../ai/client'
import { PROVIDERS } from '../ai/providers'
import { ocrImage, structurize, validateItems, enrichItems, type AiStructItem } from '../ai/import'
import { parseFile, fileTitle, guessDateFromName } from './files'
import { findExistingItemId } from '../db/items'

const CJK = /[\u4e00-\u9fff]/
const POS_TOKEN = '(?:vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|phrase|phr|abbr|n|v)\\.?'

function normalizePos(raw: string): string | null {
  const tokens = raw
    .split(/[\s/,;、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const token of tokens) {
    const pos = guessPos(token)
    if (pos && !out.includes(pos)) out.push(pos)
  }
  return out.length ? out.join(' / ') : null
}

function matchTrailingPos(left: string): { pos: string; index: number } | null {
  const re = new RegExp(`(?:^|\\s)(${POS_TOKEN}(?:\\s*[/,;、]?\\s*${POS_TOKEN})*)\\s*$`, 'i')
  const m = left.match(re)
  if (!m) return null
  const pos = normalizePos(m[1])
  return pos ? { pos, index: m.index ?? 0 } : null
}

function stripBullet(line: string): string {
  return line
    .replace(/^\s*(?:[-*•·>]+|\d+[.)、])\s*/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .trim()
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
}

function parseTableRow(line: string): ParsedItem | null {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
  if (cells.length < 2 || isSeparatorRow(cells)) return null
  const enCell = cells.find((c) => /^[A-Za-z][A-Za-z'’\- ./]*$/.test(c) && c.length <= 48)
  const zhCell = cells.find((c) => CJK.test(c))
  if (!enCell || !zhCell) return null
  if (/^(word|english|vocabulary|phrase)$/i.test(enCell)) return null
  if (/^(单词|词汇|英文|释义|中文|意思|词性)$/.test(zhCell)) return null
  const posCell = cells.find((c) =>
    new RegExp(`^${POS_TOKEN}(?:\\s*[/,;、]\\s*${POS_TOKEN})*$`, 'i').test(c)
  )
  const headword = enCell.replace(/\/[^/]*\//g, '').trim()
  if (!headword) return null
  return {
    tempId: '',
    kind: guessKind(headword),
    headword,
    pos: posCell ? normalizePos(posCell) : null,
    meanings: splitMeanings(zhCell),
    collocations: [],
    examples: [],
    extra: null,
    sourceLine: line.trim(),
    selected: true
  }
}

function parseTextLine(raw: string): ParsedItem | null {
  const line = stripBullet(raw).replace(/\u00a0/g, ' ')
  if (!line || line.length < 3) return null
  if (line.startsWith('#')) return null
  if (/^```/.test(line)) return null

  const cjkIdx = line.search(CJK)
  if (cjkIdx <= 0) return null
  if (cjkIdx > 70) return null

  let left = line.slice(0, cjkIdx).trim()
  const right = line.slice(cjkIdx).trim()
  if (!/[A-Za-z]/.test(left)) return null

  // 章节标题：「Unit 3 词汇笔记」「Lesson 2 语法」不是词条
  if (/^(unit|lesson|module|chapter|part|section|exercise|page|book|grade)\b/i.test(left) && /\d/.test(left)) {
    return null
  }

  let phonetic: string | null = null
  const ipa = left.match(/\/[^/]{1,40}\/\s*$/)
  if (ipa) {
    phonetic = ipa[0].trim()
    left = left.slice(0, ipa.index).trim()
  }

  left = left.replace(/[（(]\s*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
  left = left.replace(/[\s\-—–:：=,，;；|]+$/g, '').trim()

  let pos: string | null = null
  const trailing = matchTrailingPos(left)
  if (trailing) {
    pos = trailing.pos
    left = left.slice(0, trailing.index).trim()
  }

  // 括号里是词性，如 abandon (v.) / abandon (n. / v.)
  const bracketPos = left.match(
    new RegExp(`[（(]\\s*(${POS_TOKEN}(?:\\s*[/,;、]\\s*${POS_TOKEN})*)\\s*[）)]\\s*$`, 'i')
  )
  if (bracketPos) {
    pos = pos ?? normalizePos(bracketPos[1])
    left = left.slice(0, bracketPos.index).trim()
  }

  left = left.replace(/^[\s|]+|[\s|]+$/g, '').replace(/[（(]\s*$/g, '').trim()
  if (!left || !/^[A-Za-z]/.test(left)) return null

  // resemble = imitate v. 模仿 —— 用「=」并列同义词时，前一个才是词头
  let extra: string | null = null
  const equals = left.match(/^(.+?)\s*[=＝]\s*(.+)$/)
  if (equals && /[A-Za-z]/.test(equals[2])) {
    extra = `= ${equals[2].trim()}`
    left = equals[1].trim()
  }

  if (left.split(/\s+/).length > 7) return null
  if (left.length > 56) return null

  const meanings = splitMeanings(right)
  if (!meanings.length) return null

  return {
    tempId: '',
    kind: guessKind(left),
    headword: left,
    pos,
    phonetic,
    meanings,
    collocations: [],
    examples: [],
    extra,
    sourceLine: line,
    selected: true
  }
}

export function parseEntryLine(raw: string): ParsedItem[] {
  const parts = splitEntryLine(raw)
  if (parts.length > 1) {
    const many: ParsedItem[] = []
    for (const part of parts) {
      const item = parseTextLine(part)
      if (item) many.push(item)
    }
    if (many.length) return many
  }
  const line = raw.trim()
  const single = line.startsWith('|') ? parseTableRow(line) : parseTextLine(line)
  return single ? [single] : []
}

export function heuristicExtract(markdown: string): ParsedItem[] {
  const lines = markdown.split(/\r?\n/)
  const byWord = new Map<string, ParsedItem>()

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    for (const item of parseEntryLine(trimmed)) {
      const key = normalizeEn(item.headword)
      const existing = byWord.get(key)
      if (existing) mergeParsed(existing, item)
      else byWord.set(key, item)
    }
  }
  return Array.from(byWord.values())
}

function mapAiKind(kind: string | undefined, headword: string): ItemKind {
  const k = (kind ?? '').toLowerCase()
  if (k === 'word' || k === 'phrase' || k === 'sentence' || k === 'grammar') return k as ItemKind
  return guessKind(headword)
}

function mapAiItems(items: AiStructItem[] | undefined): ParsedItem[] {
  if (!Array.isArray(items)) return []
  const out: ParsedItem[] = []
  for (const it of items) {
    const headword = (it.headword ?? '').trim()
    if (!headword || !/[A-Za-z]/.test(headword)) continue
    const meanings = Array.isArray(it.meanings)
      ? it.meanings.map((m) => String(m).trim()).filter(Boolean)
      : []
    if (!meanings.length) continue
    const rawPos = Array.isArray(it.pos) ? it.pos.join(' / ') : it.pos
    out.push({
      tempId: '',
      kind: mapAiKind(it.kind, headword),
      headword,
      pos: rawPos ? normalizePos(rawPos) : null,
      meanings,
      collocations: Array.isArray(it.collocations)
        ? it.collocations.map((c) => String(c).trim()).filter(Boolean).slice(0, 4)
        : [],
      examples: Array.isArray(it.examples)
        ? it.examples
            .map((e) => ({ en: String(e.en ?? '').trim(), zh: e.zh ? String(e.zh).trim() : undefined }))
            .filter((e) => e.en)
        : [],
      extra: it.extra?.trim() || null,
      sourceLine: it.source_line ?? null,
      selected: true
    })
  }
  return out
}

function mergeParsed(target: ParsedItem, source: ParsedItem): void {
  target.pos = mergePosText(target.pos, source.pos)
  target.kind = target.kind === 'word' || source.kind === 'word' ? 'word' : target.kind
  target.meanings = Array.from(new Set([...target.meanings, ...source.meanings].map((m) => m.trim()).filter(Boolean)))
  target.collocations = Array.from(
    new Set([...(target.collocations ?? []), ...(source.collocations ?? [])].map((c) => c.trim()).filter(Boolean))
  )
  const seen = new Set(target.examples.map((e) => normalizeEn(e.en)))
  for (const example of source.examples) {
    const key = normalizeEn(example.en)
    if (key && !seen.has(key)) {
      seen.add(key)
      target.examples.push(example)
    }
  }
  if (!target.extra && source.extra) target.extra = source.extra
}

function mergeItems(primary: ParsedItem[], secondary: ParsedItem[]): ParsedItem[] {
  const byWord = new Map<string, ParsedItem>()
  for (const item of [...primary, ...secondary]) {
    const key = normalizeEn(item.headword)
    const existing = byWord.get(key)
    if (existing) mergeParsed(existing, item)
    else byWord.set(key, { ...item, examples: [...item.examples] })
  }
  return Array.from(byWord.values())
}

export async function analyzeFile(file: string): Promise<ImportPreview> {
  const parsed = await parseFile(file)
  const settings = getSettings()
  const warnings: string[] = []
  let aiUsed = false
  let rawText = parsed.rawText

  if (parsed.kind === 'image') {
    if (!parsed.image) throw new Error('图片读取失败')
    const ocr = await ocrImage(parsed.image.base64, parsed.image.mime)
    rawText = ocr.text
    aiUsed = true
  }

  rawText = rawText.replace(/\r\n/g, '\n').trim()
  if (!rawText) throw new Error('没有从文件中解析到任何文字')

  let items = heuristicExtract(rawText)
  const imageNeedsAi = parsed.kind === 'image'
  if (aiAvailable() && (imageNeedsAi || items.length < 2)) {
    try {
      const structured = await structurize(rawText)
      const aiItems = mapAiItems(structured.items)
      if (aiItems.length) {
        items = items.length ? mergeItems(aiItems, items) : aiItems
        aiUsed = true
      }
      for (const w of structured.warnings ?? []) {
        if (w.reason) warnings.push(`AI 提示：${w.line ? `${w.line} ` : ''}${w.reason}`)
      }
    } catch (err) {
      warnings.push(`AI 结构化失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!items.length) {
    warnings.push('没有自动识别出词条，请检查原文或手动编辑后再入库。')
  }

  items = items.map((it, idx) => ({
    ...it,
    tempId: `t${idx + 1}`,
    collocations: it.collocations ?? [],
    existingItemId: findExistingItemId(it.headword, it.pos ?? null, it.kind)
  }))

  // AI 补充常用搭配和例句（分批，避免一次太长）
  if (aiAvailable() && settings.aiValidate && items.length) {
    try {
      for (let start = 0; start < items.length; start += 20) {
        const chunk = items.slice(start, start + 20)
        const enriched = await enrichItems(chunk)
        for (const e of enriched) {
          const idx = start + Number(e.index) - 1
          const target = items[idx]
          if (!target) continue
          const collocations = (e.collocations ?? []).map((c) => String(c).trim()).filter(Boolean)
          if (collocations.length) {
            const seen = new Set((target.collocations ?? []).map((c) => normalizeEn(c)))
            for (const c of collocations) {
              const key = normalizeEn(c)
              if (key && !seen.has(key)) {
                seen.add(key)
                target.collocations = [...(target.collocations ?? []), c]
              }
            }
            target.collocations = (target.collocations ?? []).slice(0, 4)
          }
          if (e.example?.en && !(target.examples?.length)) {
            target.examples = [
              {
                en: String(e.example.en).trim(),
                zh: e.example.zh ? String(e.example.zh).trim() : undefined
              }
            ]
          }
        }
      }
      aiUsed = true
    } catch (err) {
      warnings.push(`AI 补充搭配失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const issues: ValidationIssue[] = []
  if (rawText.includes('⟦?⟧')) {
    issues.push({
      severity: 'warning',
      field: 'line',
      message: '图片中有无法确认的字符（⟦?⟧），请对照原图核对',
      suggestion: null
    })
  }
  const dup = new Map<string, number>()
  for (const it of items) {
    const k = `${normalizeEn(it.headword)}|${(it.pos ?? '').toLowerCase()}`
    dup.set(k, (dup.get(k) ?? 0) + 1)
  }
  for (const [k, count] of dup) {
    if (count > 1) {
      const sample = items.find((i) => `${normalizeEn(i.headword)}|${(i.pos ?? '').toLowerCase()}` === k)
      issues.push({
        tempId: sample?.tempId,
        severity: 'warning',
        field: 'headword',
        message: `同一份笔记里出现了 ${count} 次「${sample?.headword ?? k}」`,
        suggestion: '入库时会自动合并释义'
      })
    }
  }

  if (aiAvailable() && settings.aiValidate && items.length) {
    // 校验失败不能降级成 warning：没校验过的词条会被当成「检查过了」入库。
    // 直接抛给调用方，让用户看到失败并重试。
    const aiIssues = await validateItems(items)
    for (const raw of aiIssues) {
      const idx = Number(raw.index) - 1
      const target = Number.isInteger(idx) && idx >= 0 && idx < items.length ? items[idx] : null
      const field = (raw.field ?? 'general') as ValidationIssue['field']
      issues.push({
        tempId: target?.tempId ?? null,
        severity: raw.severity === 'error' ? 'error' : 'warning',
        field: ['headword', 'pos', 'meaning', 'example', 'line'].includes(field as string)
          ? field
          : 'general',
        message: raw.message?.trim() || 'AI 未说明原因',
        suggestion: raw.suggestion?.trim() || null
      })
    }
  } else if (!aiAvailable() && settings.aiValidate && items.length) {
    // 没配 Key/模型是正常状态（用户可以不启用 AI），只作为「解析提示」展示，
    // 不算待处理的校验问题；文案跟随默认角色那家，并且分清缺的是 Key 还是模型。
    const id = settings.ai.default.provider
    const label = PROVIDERS[id]?.label ?? '默认模型'
    warnings.push(
      hasApiKey(id)
        ? `还没有给 ${label} 选模型，本次跳过了 AI 校验`
        : `尚未配置 ${label} 的 API Key，本次跳过了 AI 校验`
    )
  }

  return {
    fileName: parsed.fileName,
    sourceKind: parsed.kind,
    rawText,
    title: fileTitle(file),
    noteDate: guessDateFromName(file),
    items,
    issues,
    warnings,
    aiUsed
  }
}
