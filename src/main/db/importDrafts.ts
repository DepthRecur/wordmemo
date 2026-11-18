import type {
  DraftIssueSummary,
  ImportCommitAllResult,
  ImportCommitResult,
  ImportDraft,
  ImportDraftMeta,
  ImportDraftPatch,
  ImportPreview,
  ParsedItem,
  ValidationIssue
} from '@shared/types'
import { getDb, localIso, parseJson, toInt, tx } from './connection'
import { createNote, createSource } from './notes'
import { findExistingItemId, upsertItem } from './items'
import { getSettings } from '../settings'
import { deleteStoredFileIfUnused, storedFileBytes, storedFileExists } from '../storage'
import { validateItems } from '../ai/import'
import { aiAvailable } from '../ai/client'

interface DraftRow {
  id: number
  sha256: string | null
  file_name: string
  source_kind: string
  original_path: string | null
  stored_path: string | null
  payload: string
  status: string
  edited: number
  note_id: number | null
  created_at: string
  updated_at: string
}

/** 草稿 payload：识别结果 + 校验阶段的所有修改 */
interface DraftPayload {
  rawText: string
  warnings: string[]
  aiUsed: boolean
  title: string
  noteDate: string | null
  tags: string[]
  items: ParsedItem[]
  issues: ValidationIssue[]
  resolved: number[]
}

const DRAFT_COLUMNS =
  'id, sha256, file_name, source_kind, original_path, stored_path, payload, status, edited, note_id, created_at, updated_at'

interface DraftSummary {
  items: number
  selected: number
  issues: number
  errors: number
}

function summarize(payload: DraftPayload): DraftSummary {
  const items = payload.items ?? []
  const issues = payload.issues ?? []
  return {
    items: items.length,
    selected: items.filter((it) => it.selected && it.headword.trim()).length,
    issues: issues.length,
    errors: issues.filter((is) => is.severity === 'error').length
  }
}

function emptyPayload(preview: ImportPreview): DraftPayload {
  return {
    rawText: preview.rawText,
    warnings: preview.warnings ?? [],
    aiUsed: preview.aiUsed ?? false,
    title: preview.title,
    noteDate: preview.noteDate ?? null,
    tags: [],
    items: preview.items ?? [],
    issues: preview.issues ?? [],
    resolved: []
  }
}

function payloadOf(row: DraftRow): DraftPayload {
  return parseJson<DraftPayload>(row.payload, {
    rawText: '',
    warnings: [],
    aiUsed: false,
    title: row.file_name,
    noteDate: null,
    tags: [],
    items: [],
    issues: [],
    resolved: []
  })
}

function rowById(id: number): DraftRow | undefined {
  return getDb().prepare(`SELECT ${DRAFT_COLUMNS} FROM import_drafts WHERE id = ?`).get(id) as
    | DraftRow
    | undefined
}

export interface CreateDraftInput {
  sha256: string | null
  storedPath: string | null
  fileName: string
  sourceKind: ImportPreview['sourceKind']
  originalPath: string | null
  preview: ImportPreview
}

export function createDraft(input: CreateDraftInput): number {
  const now = localIso()
  const payload = emptyPayload(input.preview)
  const res = getDb()
    .prepare(
      `INSERT INTO import_drafts
         (sha256, file_name, source_kind, original_path, stored_path, payload, summary, status, edited, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)`
    )
    .run(
      input.sha256,
      input.fileName,
      input.sourceKind,
      input.originalPath,
      input.storedPath,
      JSON.stringify(payload),
      JSON.stringify(summarize(payload)),
      now,
      now
    )
  return toInt(res.lastInsertRowid)
}

/** 同一份文件已经识别过但没入库：直接复用，不再调用 AI */
export function findDraftBySha(sha256: string | null): { id: number; fileName: string } | null {
  if (!sha256) return null
  const row = getDb()
    .prepare(
      `SELECT id, file_name FROM import_drafts
       WHERE status = 'draft' AND sha256 = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(sha256) as { id?: number; file_name?: string } | undefined
  if (!row?.id) return null
  return { id: toInt(row.id), fileName: row.file_name ?? '' }
}

export function listDraftMetas(): ImportDraftMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT id, file_name, source_kind, stored_path, summary, edited, created_at, updated_at,
              length(CAST(payload AS BLOB)) AS payload_bytes
       FROM import_drafts
       WHERE status = 'draft'
       ORDER BY updated_at DESC, id DESC`
    )
    .all() as unknown as {
    id: number
    file_name: string
    source_kind: string
    stored_path: string | null
    summary: string
    edited: number
    created_at: string
    updated_at: string
    payload_bytes: number
  }[]
  return rows.map((row) => {
    const summary = parseJson<DraftSummary>(row.summary, {
      items: 0,
      selected: 0,
      issues: 0,
      errors: 0
    })
    return {
      id: toInt(row.id),
      fileName: row.file_name,
      sourceKind: (row.source_kind as ImportDraftMeta['sourceKind']) ?? 'txt',
      itemCount: toInt(summary.items),
      selectedCount: toInt(summary.selected),
      issueCount: toInt(summary.issues),
      errorCount: toInt(summary.errors),
      edited: toInt(row.edited) === 1,
      hasFile: storedFileExists(row.stored_path),
      bytes: toInt(row.payload_bytes) + storedFileBytes(row.stored_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  })
}

export function getDraft(id: number): ImportDraft | null {
  const row = rowById(id)
  if (!row) return null
  const payload = payloadOf(row)
  // 「词库已有」提示会随着别的草稿入库而失效，每次打开时重算
  const items = (payload.items ?? []).map((it) => ({
    ...it,
    existingItemId: findExistingItemId(it.headword, it.pos ?? null, it.kind)
  }))
  return {
    id: toInt(row.id),
    fileName: row.file_name,
    sourceKind: (row.source_kind as ImportDraft['sourceKind']) ?? 'txt',
    originalPath: row.original_path,
    storedPath: row.stored_path,
    rawText: payload.rawText ?? '',
    warnings: payload.warnings ?? [],
    aiUsed: Boolean(payload.aiUsed),
    title: payload.title ?? row.file_name,
    noteDate: payload.noteDate ?? null,
    tags: payload.tags ?? [],
    items,
    issues: payload.issues ?? [],
    resolved: payload.resolved ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function saveDraft(id: number, patch: ImportDraftPatch): void {
  const row = rowById(id)
  if (!row) throw new Error('草稿不存在（可能已经被入库或丢弃）')
  const payload: DraftPayload = { ...payloadOf(row), ...patch }
  getDb()
    .prepare('UPDATE import_drafts SET payload = ?, summary = ?, edited = 1, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(payload), JSON.stringify(summarize(payload)), localIso(), id)
}

function storedPathReferenced(relPath: string | null): boolean {
  if (!relPath) return false
  const row = getDb().prepare('SELECT 1 AS ok FROM sources WHERE stored_path = ? LIMIT 1').get(relPath)
  return Boolean(row)
}

export function commitDraft(
  id: number,
  phonetics?: Record<string, string>
): ImportCommitResult {
  const row = rowById(id)
  if (!row) throw new Error('草稿不存在（可能已经被入库或丢弃）')
  const payload = payloadOf(row)
  const selected = (payload.items ?? []).filter((it) => it.selected && it.headword.trim())
  if (!selected.length) throw new Error('至少选择一个词条才能入库')

  const listenEnabled = getSettings().listenCardEnabled
  return tx(() => {
    let sourceId: number | null = null
    if (row.stored_path || row.original_path) {
      sourceId = createSource({
        kind: row.source_kind,
        originalName: row.file_name,
        storedPath: row.stored_path,
        sha256: row.sha256,
        rawText: payload.rawText ?? ''
      })
    }
    const noteId = createNote({
      title: (payload.title ?? '').trim() || row.file_name,
      noteDate: payload.noteDate ?? null,
      tags: payload.tags ?? [],
      rawMarkdown: payload.rawText ?? '',
      sourceId
    })

    selected.forEach((item, index) => {
      const phonetic =
        item.phonetic?.trim() || phonetics?.[item.tempId]?.trim() || null
      upsertItem({
        kind: item.kind,
        headword: item.headword,
        pos: item.pos ?? null,
        phonetic,
        meanings: item.meanings ?? [],
        collocations: item.collocations ?? [],
        examples: item.examples ?? [],
        extra: item.extra ?? null,
        rawLine: item.sourceLine ?? null,
        noteId,
        position: index,
        listenEnabled
      })
    })

    const db = getDb()
    for (const issue of payload.issues ?? []) {
      db.prepare(
        `INSERT INTO validation_issues (note_id, item_id, field, severity, message, suggestion, resolved)
         VALUES (?, NULL, ?, ?, ?, ?, 0)`
      ).run(noteId, issue.field ?? 'general', issue.severity, issue.message, issue.suggestion ?? null)
    }

    db.prepare('DELETE FROM import_drafts WHERE id = ?').run(id)
    return { noteId, itemCount: selected.length }
  })
}

export function commitAllDrafts(
  phoneticsByDraft?: Map<number, Record<string, string>>
): ImportCommitAllResult {
  const result: ImportCommitAllResult = { committed: [], failed: [] }
  const rows = getDb()
    .prepare(`SELECT id, file_name FROM import_drafts WHERE status = 'draft' ORDER BY updated_at ASC, id ASC`)
    .all() as unknown as { id: number; file_name: string }[]
  for (const row of rows) {
    try {
      const draftId = toInt(row.id)
      const committed = commitDraft(draftId, phoneticsByDraft?.get(draftId))
      result.committed.push({
        draftId,
        fileName: row.file_name,
        noteId: committed.noteId,
        itemCount: committed.itemCount
      })
    } catch (err) {
      result.failed.push({
        draftId: toInt(row.id),
        fileName: row.file_name,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return result
}

export function discardDraft(id: number): void {
  const row = rowById(id)
  if (!row) return
  getDb().prepare('DELETE FROM import_drafts WHERE id = ?').run(id)
  deleteStoredFileIfUnused(row.stored_path, storedPathReferenced(row.stored_path))
}

/** 用当前（可能改过的）词条重新跑一次 AI 校验，会消耗 token */
export async function revalidateDraft(id: number): Promise<ImportDraft> {
  const draft = getDraft(id)
  if (!draft) throw new Error('草稿不存在（可能已经被入库或丢弃）')
  if (!aiAvailable()) throw new Error('需要先在设置里配置 API Key（默认模型那家）')
  if (!draft.items.length) throw new Error('没有可校验的词条')

  const raw = await validateItems(
    draft.items.map((it) => ({ headword: it.headword, pos: it.pos ?? null, meanings: it.meanings }))
  )
  const issues: ValidationIssue[] = []
  for (const issue of raw) {
    const idx = Number(issue.index) - 1
    const target = Number.isInteger(idx) && idx >= 0 && idx < draft.items.length ? draft.items[idx] : null
    const field = (issue.field ?? 'general') as ValidationIssue['field']
    issues.push({
      tempId: target?.tempId ?? null,
      severity: issue.severity === 'error' ? 'error' : 'warning',
      field: ['headword', 'pos', 'meaning', 'example', 'line'].includes(field as string) ? field : 'general',
      message: issue.message?.trim() || 'AI 未说明原因',
      suggestion: issue.suggestion?.trim() || null
    })
  }
  saveDraft(id, { issues, resolved: [] })
  return getDraft(id) ?? { ...draft, issues, resolved: [] }
}

export function countDrafts(): number {
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM import_drafts WHERE status = 'draft'`)
      .get() as { c?: number } | undefined
    return toInt(row?.c)
  } catch {
    return 0
  }
}

export function draftBytes(): number {
  const rows = getDb().prepare('SELECT payload, stored_path FROM import_drafts').all() as unknown as {
    payload: string
    stored_path: string | null
  }[]
  return rows.reduce(
    (sum, row) => sum + Buffer.byteLength(row.payload ?? '', 'utf8') + storedFileBytes(row.stored_path),
    0
  )
}

/** 只统计未处理（未被「忽略/采纳」）的校验提示，供通知中心使用 */
export function draftIssueSummary(): DraftIssueSummary {
  const rows = getDb()
    .prepare("SELECT payload FROM import_drafts WHERE status = 'draft'")
    .all() as unknown as { payload: string }[]
  let unresolved = 0
  let draftsWithIssues = 0
  for (const row of rows) {
    const payload = parseJson<DraftPayload>(row.payload, {
      rawText: '',
      warnings: [],
      aiUsed: false,
      title: '',
      noteDate: null,
      tags: [],
      items: [],
      issues: [],
      resolved: []
    })
    const resolved = new Set(payload.resolved ?? [])
    const count = (payload.issues ?? []).filter((_, index) => !resolved.has(index)).length
    if (count > 0) {
      draftsWithIssues += 1
      unresolved += count
    }
  }
  return { drafts: rows.length, draftsWithIssues, unresolved }
}

/** 缩略图只需要文件路径，避免为了拿一张图把整份 payload 读出来 */
export function draftStoredPath(id: number): { path: string | null; kind: string } | null {
  const row = getDb()
    .prepare('SELECT stored_path, source_kind FROM import_drafts WHERE id = ?')
    .get(id) as { stored_path?: string | null; source_kind?: string } | undefined
  if (!row) return null
  return { path: row.stored_path ?? null, kind: row.source_kind ?? '' }
}
