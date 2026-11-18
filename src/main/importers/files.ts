import fs from 'node:fs'
import path from 'node:path'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import ExcelJS from 'exceljs'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import type { ImportPreview } from '@shared/types'

export type SourceKind = ImportPreview['sourceKind']

export function detectSourceKind(file: string): SourceKind | null {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return 'image'
  if (ext === '.txt') return 'txt'
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx') return 'xlsx'
  return null
}

export function fileTitle(file: string): string {
  return path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').trim() || '未命名笔记'
}

export function guessDateFromName(file: string): string | null {
  const name = path.basename(file)
  const full = name.match(/(20\d{2})[-_.年](\d{1,2})[-_.月](\d{1,2})/)
  if (full) {
    return `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')}`
  }
  const short = name.match(/(?:^|[^\d])(\d{1,2})[-_.月](\d{1,2})(?:[^\d]|$)/)
  if (short) {
    const now = new Date()
    return `${now.getFullYear()}-${String(short[1]).padStart(2, '0')}-${String(short[2]).padStart(2, '0')}`
  }
  return null
}

function decodeText(buf: Buffer): string {
  const detected = (chardet as unknown as { detect: (b: Buffer) => string | null }).detect(buf)
  let enc = (detected || 'UTF-8').toLowerCase()
  if (enc === 'gbk' || enc === 'gb2312') enc = 'gb18030'
  if (enc === 'ascii') enc = 'utf-8'
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  try {
    if (iconv.encodingExists(enc)) return iconv.decode(buf, enc)
  } catch {
    /* ignore */
  }
  return buf.toString('utf8')
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
})

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  if (Array.isArray(value)) return value.map(cellText).join(' ')
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.text === 'string') return v.text
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('')
    }
    if (v.result !== undefined) return cellText(v.result)
    if (v.hyperlink && typeof v.hyperlink === 'string') return String(v.text ?? v.hyperlink)
  }
  return String(value)
}

function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim()
}

async function parseXlsx(file: string): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const blocks: string[] = []
  workbook.eachSheet((sheet) => {
    const rows: string[][] = []
    let maxCols = 0
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = []
      const count = Math.max(row.cellCount, 1)
      for (let c = 1; c <= count; c++) values.push(cellText(row.getCell(c).value))
      if (values.some((v) => v.trim())) {
        rows.push(values)
        maxCols = Math.max(maxCols, values.length)
      }
    })
    if (!rows.length) return
    const padded = rows.map((r) => [...r, ...Array(maxCols - r.length).fill('')])
    const lines = [`## ${sheet.name}`, '']
    lines.push(`| ${padded[0].map(escapeCell).join(' | ')} |`)
    lines.push(`| ${padded[0].map(() => '---').join(' | ')} |`)
    for (const r of padded.slice(1)) lines.push(`| ${r.map(escapeCell).join(' | ')} |`)
    blocks.push(lines.join('\n'))
  })
  return blocks.join('\n\n')
}

async function parseDocx(file: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: file })
  const html = result.value || ''
  return turndown.turndown(html)
}

export interface ParsedFile {
  kind: SourceKind
  fileName: string
  rawText: string
  image?: { base64: string; mime: string }
}

export async function parseFile(file: string): Promise<ParsedFile> {
  const kind = detectSourceKind(file)
  if (!kind) throw new Error('不支持的文件类型（仅支持 png/jpg/jpeg/txt/md/docx/xlsx）')
  const fileName = path.basename(file)

  if (kind === 'image') {
    const buf = fs.readFileSync(file)
    let mime = ''
    if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      mime = 'image/png'
    } else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      mime = 'image/jpeg'
    } else {
      throw new Error('图片格式不正确（仅支持 PNG / JPEG）')
    }
    return { kind, fileName, rawText: '', image: { base64: buf.toString('base64'), mime } }
  }

  if (kind === 'txt') {
    return { kind, fileName, rawText: decodeText(fs.readFileSync(file)) }
  }
  if (kind === 'md') {
    return { kind, fileName, rawText: decodeText(fs.readFileSync(file)) }
  }
  if (kind === 'docx') {
    return { kind, fileName, rawText: await parseDocx(file) }
  }
  return { kind, fileName, rawText: await parseXlsx(file) }
}
