import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ExamInput,
  ImportDraftPatch,
  ImportResult,
  Item,
  NoteInput,
  NoteQuery,
  ReviewMode,
  SettingsPatch,
  SubmitReview
} from '@shared/types'
import { createNote, deleteNote, getNote, listNotes, updateNote } from './db/notes'
import { deleteItem, getItem, listItems, setDirection, updateItem } from './db/items'
import { applyReview, dailyPlan, markItemLearned } from './db/cards'
import { createExam, deleteExam, listExams, updateExam } from './db/exams'
import { buildExamPlan } from './planner'
import { dashboardStats } from './db/stats'
import { ingestFile } from './importers/ingest'
import { fillPhoneticsForDraft, fillPhoneticsForDrafts, refreshNotePhonetics } from './importers/phonetics'
import { judgeAnswer } from './judge'
import { clearApiKey, getSettings, setApiKey, updateSettings } from './settings'
import { clearTtsCache, getTts, ttsCacheSize } from './media/tts'
import { enrichNote } from './enrich'
import { semanticSearch } from './search'
import { lookupPhonetic } from './media/phonetic'
import { getDb } from './db/connection'
import { testApiKey } from './ai/client'
import { getDiagnostics } from './diagnostics'
import {
  commitAllDrafts,
  commitDraft,
  countDrafts,
  discardDraft,
  draftBytes,
  draftIssueSummary,
  draftStoredPath,
  getDraft,
  listDraftMetas,
  revalidateDraft,
  saveDraft
} from './db/importDrafts'
import { storedFileAbs } from './storage'

function dataDir(): string {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 图片草稿缩略图缓存：文件按 sha 命名，内容不会变 */
const thumbCache = new Map<string, string | null>()

export function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => {
    const next = updateSettings(patch)
    if (typeof patch.autoLaunch === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: patch.autoLaunch })
    }
    return next
  })
  ipcMain.handle('settings:setApiKey', (_e, key: string) => {
    const ok = setApiKey(key)
    if (ok) updateSettings({})
    return ok
  })
  ipcMain.handle('settings:clearApiKey', () => {
    clearApiKey()
    updateSettings({})
  })
  ipcMain.handle('settings:testApiKey', (_e, key?: string) => testApiKey(key))

  ipcMain.handle('notes:list', (_e, query?: NoteQuery) => listNotes(query ?? {}))
  ipcMain.handle('notes:get', (_e, id: number) => getNote(id))
  ipcMain.handle('notes:create', (_e, input: NoteInput) => createNote(input))
  ipcMain.handle('notes:update', (_e, id: number, patch: Partial<NoteInput>) => updateNote(id, patch))
  ipcMain.handle('notes:remove', (_e, id: number) => deleteNote(id))

  ipcMain.handle('items:list', (_e, query?: { search?: string }) => listItems(query?.search))
  ipcMain.handle(
    'items:update',
    (
      _e,
      id: number,
      patch: Partial<
        Pick<
          Item,
          'kind' | 'headword' | 'pos' | 'meanings' | 'collocations' | 'examples' | 'extra' | 'phonetic'
        >
      >
    ) => updateItem(id, patch)
  )
  ipcMain.handle('items:remove', (_e, id: number) => deleteItem(id))
  ipcMain.handle('items:setDirection', (_e, itemId: number, direction, enabled: boolean) =>
    setDirection(itemId, direction, enabled)
  )
  ipcMain.handle('items:enrichNote', (_e, noteId: number) => enrichNote(noteId))
  ipcMain.handle('items:refreshPhonetics', (_e, noteId: number) => refreshNotePhonetics(noteId))

  ipcMain.handle('items:ensurePhonetic', async (_e, itemId: number) => {
    const item = getItem(itemId)
    if (!item) return null
    if (item.phonetic?.trim()) return item.phonetic
    const phonetic = await lookupPhonetic(item.headword)
    // 含 … 表示词组里有单词没查到，只作为本次提示，不写回词条，下次可重试
    if (phonetic && !phonetic.includes('…')) updateItem(item.id, { phonetic })
    return phonetic
  })

  ipcMain.handle('importer:pickFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择英语笔记',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '笔记文件', extensions: ['png', 'jpg', 'jpeg', 'txt', 'md', 'docx', 'xlsx'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg'] },
        { name: '文档', extensions: ['txt', 'md', 'docx', 'xlsx'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('importer:parse', async (_e, paths: string[]) => {
    const out: ImportResult[] = []
    for (const p of paths) {
      try {
        out.push(await ingestFile(p))
      } catch (err) {
        out.push({
          ok: false,
          fileName: path.basename(p),
          filePath: p,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return out
  })

  ipcMain.handle('importer:listDrafts', () => listDraftMetas())
  ipcMain.handle('importer:getDraft', (_e, id: number) => getDraft(id))
  ipcMain.handle('importer:saveDraft', (_e, id: number, patch: ImportDraftPatch) => saveDraft(id, patch))
  ipcMain.handle('importer:commit', async (_e, draftId: number) => {
    let phonetics: Record<string, string> = {}
    try {
      phonetics = await fillPhoneticsForDraft(draftId)
    } catch {
      /* 音标补全失败不阻塞入库 */
    }
    return commitDraft(draftId, phonetics)
  })
  ipcMain.handle('importer:commitAll', async () => {
    const ids = listDraftMetas().map((meta) => meta.id)
    let phonetics = new Map<number, Record<string, string>>()
    try {
      phonetics = await fillPhoneticsForDrafts(ids)
    } catch {
      /* 音标补全失败不阻塞入库 */
    }
    return commitAllDrafts(phonetics)
  })
  ipcMain.handle('importer:discardDraft', (_e, id: number) => discardDraft(id))
  ipcMain.handle('importer:revalidateDraft', (_e, id: number) => revalidateDraft(id))
  ipcMain.handle('importer:draftCount', () => countDrafts())
  ipcMain.handle('importer:draftBytes', () => draftBytes())
  ipcMain.handle('importer:draftIssues', () => draftIssueSummary())

  ipcMain.handle('importer:draftThumb', async (_e, id: number) => {
    const info = draftStoredPath(id)
    if (!info || info.kind !== 'image' || !info.path) return null
    const abs = storedFileAbs(info.path)
    if (!abs) return null
    const cacheKey = info.path
    if (thumbCache.has(cacheKey)) return thumbCache.get(cacheKey) ?? null
    try {
      const image = await nativeImage.createThumbnailFromPath(abs, { width: 320, height: 320 })
      const url = image.isEmpty() ? null : image.toDataURL()
      thumbCache.set(cacheKey, url)
      return url
    } catch {
      thumbCache.set(cacheKey, null)
      return null
    }
  })

  ipcMain.handle('review:daily', () => dailyPlan())
  ipcMain.handle('review:learn', (_e, itemId: number, known: boolean) => markItemLearned(itemId, known))
  ipcMain.handle('review:queue', (_e, mode?: ReviewMode, examId?: number) => {
    if (mode === 'exam' && examId) return buildExamPlan(examId).queue
    return dailyPlan().reviewCards
  })
  ipcMain.handle('review:judge', (_e, cardId: number, answer: string) => judgeAnswer(cardId, answer))
  ipcMain.handle('review:submit', (_e, input: SubmitReview) => applyReview(input))

  ipcMain.handle('exams:list', () => listExams())
  ipcMain.handle('exams:create', (_e, input: ExamInput) => createExam(input))
  ipcMain.handle('exams:update', (_e, id: number, patch: Partial<ExamInput> & { status?: 'active' | 'done' }) =>
    updateExam(id, patch)
  )
  ipcMain.handle('exams:remove', (_e, id: number) => deleteExam(id))
  ipcMain.handle('exams:plan', (_e, id: number) => buildExamPlan(id))

  ipcMain.handle('stats:dashboard', () => dashboardStats())

  ipcMain.handle('search:query', (_e, query: string, sort?: NoteQuery['sort']) =>
    semanticSearch(query, sort)
  )

  ipcMain.handle('tts:get', (_e, word: string, accent?: 'us' | 'uk') => getTts(word, accent))
  ipcMain.handle('tts:cacheSize', () => ttsCacheSize())
  ipcMain.handle('tts:clear', () => clearTtsCache())

  ipcMain.handle('system:openDataDir', () => shell.openPath(dataDir()))
  ipcMain.handle('system:backup', () => {
    const dir = path.join(dataDir(), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    try {
      getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    const target = path.join(dir, `wordmemo-${stamp}.db`)
    fs.copyFileSync(path.join(dataDir(), 'wordmemo.db'), target)
    return target
  })
  ipcMain.handle('system:appVersion', () => app.getVersion())
  ipcMain.handle('system:buildInfo', () => {
    let buildTime: string | null = null
    try {
      // 打包后 __filename 就是 out/main/index.js，mtime 即最近一次构建时间
      buildTime = fs.statSync(__filename).mtime.toISOString()
    } catch {
      /* ignore */
    }
    const diag = getDiagnostics()
    return {
      version: app.getVersion(),
      buildTime,
      startedAt: diag.startedAt,
      integrity: diag.integrity,
      tray: diag.tray,
      session: diag.session
    }
  })
  ipcMain.handle('system:reloadWindow', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.reload()
  })
  ipcMain.handle('system:restart', () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('system:quit', () => {
    app.exit(0)
  })
}
