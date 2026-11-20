import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type {
  Deck,
  ImportDraft,
  ImportDraftMeta,
  ImportDraftPatch,
  ImportResult,
  ParsedItem,
  Settings,
  ValidationIssue
} from '@shared/types'
import { cleanSuggestion, splitMeanings } from '@shared/normalize'
import { DeckSelect } from '../components/DeckPicker'
import { Badge, Button, Empty, Field, Modal, Spinner } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { cls } from '../lib/utils'

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
  navigate: Navigate
  refreshStats: () => Promise<void>
  decks: Deck[]
  deckId: number | null
  setDeck: (id: number) => Promise<void>
  refreshDecks: () => Promise<Deck[]>
  onImported: () => void
  onDraftsChanged: () => void
  focusDraftId?: number
}

type ConfirmKind = 'discard-all' | 'commit-all' | 'revalidate'

function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function nowIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const SAVE_DELAY = 500

export default function ImportPage({
  notify,
  settings,
  navigate,
  decks,
  deckId,
  setDeck,
  refreshDecks,
  onImported,
  onDraftsChanged,
  focusDraftId
}: Props) {
  // 导入目标库：跟着「当前库」走；库被删了用第一个库兜底
  const targetDeckId = deckId ?? decks[0]?.id ?? null
  const deckName = (id: number | null | undefined) =>
    (id ? decks.find((deck) => deck.id === id)?.name : null) ?? '默认库'
  /** 老草稿（deckId = null）入库时进当前库 */
  const draftDeckLabel = (id: number | null | undefined) =>
    id ? deckName(id) : `当前库（${deckName(targetDeckId)}）`
  const [metas, setMetas] = useState<ImportDraftMeta[]>([])
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [bytes, setBytes] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({})
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)
  const [confirmDraftId, setConfirmDraftId] = useState<number | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [commitOpen, setCommitOpen] = useState(false)

  const draftRef = useRef<ImportDraft | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingSave = useRef<{ id: number; patch: ImportDraftPatch } | null>(null)
  const mounted = useRef(true)
  const focusApplied = useRef(false)
  const flashDelay = useRef<number | null>(null)
  const flashTimer = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** 把挂起的修改立刻写回主进程；返回是否真的写了 */
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    if (!pending) return false
    pendingSave.current = null
    try {
      await window.api.importer.saveDraft(pending.id, pending.patch)
      if (mounted.current) {
        const current = draftRef.current
        setSaving('saved')
        setMetas((list) =>
          list.map((m) =>
            current && m.id === current.id
              ? {
                  ...m,
                  itemCount: current.items.length,
                  selectedCount: current.items.filter((it) => it.selected && it.headword.trim()).length,
                  issueCount: current.issues.length,
                  errorCount: current.issues.filter((is) => is.severity === 'error').length,
                  edited: true,
                  updatedAt: nowIso()
                }
              : m
          )
        )
      }
      onDraftsChanged()
      return true
    } catch {
      if (mounted.current) setSaving('idle')
      return false
    }
  }, [onDraftsChanged])

  const queueSave = useCallback(
    (patch: ImportDraftPatch) => {
      const current = draftRef.current
      if (!current) return
      const previous = pendingSave.current?.id === current.id ? pendingSave.current.patch : {}
      pendingSave.current = { id: current.id, patch: { ...previous, ...patch } }
      if (mounted.current) setSaving('saving')
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void flushSave(), SAVE_DELAY)
    },
    [flushSave]
  )

  const applyPatch = useCallback(
    (patch: ImportDraftPatch) => {
      const current = draftRef.current
      if (!current) return
      const next = { ...current, ...patch }
      draftRef.current = next
      setDraft(next)
      queueSave(patch)
    },
    [queueSave]
  )

  const refreshMetas = useCallback(async (): Promise<ImportDraftMeta[]> => {
    const [list, total] = await Promise.all([
      window.api.importer.listDrafts(),
      window.api.importer.draftBytes()
    ])
    if (mounted.current) {
      setMetas(list)
      setBytes(total)
    }
    onDraftsChanged()
    return list
  }, [onDraftsChanged])

  const openDraft = useCallback(
    async (id: number) => {
      if (draftRef.current?.id === id && draftRef.current) return
      await flushSave()
      const next = await window.api.importer.getDraft(id)
      if (!next) {
        await refreshMetas()
        return
      }
      draftRef.current = next
      pendingSave.current = null
      if (!mounted.current) return
      setDraft(next)
      setShowRaw(false)
      setFlashId(null)
      setSaving('idle')
    },
    [flushSave, refreshMetas]
  )

  // 首次进入：把没入库的草稿全部恢复出来
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingList(true)
      try {
        const list = await window.api.importer.listDrafts()
        if (cancelled || !mounted.current) return
        setMetas(list)
        void window.api.importer.draftBytes().then((total) => mounted.current && setBytes(total))
        onDraftsChanged()
        const target =
          focusDraftId && list.some((m) => m.id === focusDraftId) ? focusDraftId : list[0]?.id
        if (target) {
          const next = await window.api.importer.getDraft(target)
          if (!cancelled && next && mounted.current) {
            draftRef.current = next
            setDraft(next)
          }
        }
      } catch (err) {
        notify(`恢复草稿失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      } finally {
        if (!cancelled && mounted.current) setLoadingList(false)
      }
    })()
    return () => {
      cancelled = true
      // 切换页面也要把最后的修改写回去
      const pending = pendingSave.current
      if (pending) {
        pendingSave.current = null
        void window.api.importer.saveDraft(pending.id, pending.patch)
      }
    }
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 从笔记库 / 托盘带 draftId 跳进来时定位到指定草稿；只生效一次，避免把用户切回去
  useEffect(() => {
    focusApplied.current = false
  }, [focusDraftId])

  useEffect(() => {
    if (!focusDraftId || loadingList || focusApplied.current) return
    if (!metas.some((m) => m.id === focusDraftId)) return
    focusApplied.current = true
    if (draftRef.current?.id === focusDraftId) return
    void openDraft(focusDraftId)
  }, [focusDraftId, loadingList, metas, openDraft])

  // 图片草稿的缩略图按需拉取
  useEffect(() => {
    const targets = metas.filter(
      (m) => m.sourceKind === 'image' && m.hasFile && thumbs[m.id] === undefined
    )
    if (!targets.length) return
    let cancelled = false
    ;(async () => {
      for (const m of targets) {
        try {
          const url = await window.api.importer.draftThumb(m.id)
          if (cancelled || !mounted.current) return
          setThumbs((prev) => ({ ...prev, [m.id]: url }))
        } catch {
          if (!cancelled && mounted.current) setThumbs((prev) => ({ ...prev, [m.id]: null }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [metas, thumbs])

  const locateRow = (tempId: string) => {
    const el = document.getElementById(`row-${tempId}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (flashDelay.current) window.clearTimeout(flashDelay.current)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    setFlashId(null)
    flashDelay.current = window.setTimeout(() => {
      setFlashId(tempId)
      flashTimer.current = window.setTimeout(() => setFlashId(null), 2000)
    }, 220)
  }

  const applyResults = useCallback(
    async (res: ImportResult[]) => {
      const failed = res.filter((r) => !r.ok)
      const created = res.filter((r) => r.ok && !r.resumed).length
      const resumed = res.filter((r) => r.ok && r.resumed).length
      const list = await refreshMetas()
      if (list[0]) await openDraft(list[0].id)
      if (failed.length) {
        notify(
          `${failed.length} 个文件解析失败：${failed[0].error ?? '未知原因'}` +
            (created ? `；其余 ${created} 个已保存为草稿` : ''),
          'err'
        )
        return
      }
      if (resumed) {
        notify(
          `已识别 ${created} 个文件；其中 ${resumed} 份是之前没入库的旧草稿，直接恢复，没有重复调用 AI`,
          'ok'
        )
      } else {
        notify(`已识别 ${created} 个文件，全部保存为草稿（关掉应用也不会丢）`, 'ok')
      }
    },
    [notify, openDraft, refreshMetas]
  )

  const handlePaths = async (paths: string[]) => {
    if (!paths.length) return
    await flushSave()
    setBusy(true)
    setBusyLabel(paths.length > 1 ? `正在识别 ${paths.length} 个文件…` : '正在识别…')
    try {
      const res = await window.api.importer.parse(paths, targetDeckId ?? undefined)
      await applyResults(res)
      void refreshDecks()
    } catch (err) {
      notify(`解析失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      if (mounted.current) {
        setBusy(false)
        setBusyLabel('')
      }
    }
  }

  const pick = async () => {
    const paths = await window.api.importer.pickFiles()
    await handlePaths(paths)
  }

  /** 拖拽与点击添加共用：空状态的大上传区和有草稿时的「继续添加」卡片都走这里 */
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return window.api.importer.pathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (paths.length) void handlePaths(paths)
  }

  const commitCurrent = async () => {
    const current = draftRef.current
    if (!current) return
    const selected = current.items.filter((it) => it.selected && it.headword.trim())
    if (!selected.length) {
      notify('至少选择一个词条才能入库', 'err')
      return
    }
    await flushSave()
    setBusy(true)
    setBusyLabel('正在补全音标并入库…')
    setCommitOpen(true)
    try {
      const res = await window.api.importer.commit(current.id)
      notify(`已入库：${res.itemCount} 个词条`, 'ok')
      onImported()
      void refreshDecks()
      draftRef.current = null
      pendingSave.current = null
      if (mounted.current) setDraft(null)
      const list = await refreshMetas()
      if (list[0]) {
        await openDraft(list[0].id)
        notify(`还有 ${list.length} 份未入库，已切到下一份`, 'info')
      }
    } catch (err) {
      notify(`入库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      if (mounted.current) {
        setCommitOpen(false)
        setBusy(false)
        setBusyLabel('')
      }
    }
  }

  const commitAll = async () => {
    setConfirm(null)
    await flushSave()
    setBusy(true)
    setBusyLabel('正在逐份补全音标并入库…')
    setCommitOpen(true)
    try {
      const res = await window.api.importer.commitAll()
      const itemCount = res.committed.reduce((sum, c) => sum + c.itemCount, 0)
      if (res.committed.length) {
        notify(`已入库 ${res.committed.length} 份笔记，共 ${itemCount} 个词条`, 'ok')
        onImported()
        void refreshDecks()
      }
      if (res.failed.length) {
        notify(`${res.failed.length} 份入库失败：${res.failed[0].error}`, 'err')
      }
      draftRef.current = null
      pendingSave.current = null
      if (mounted.current) setDraft(null)
      const list = await refreshMetas()
      if (list[0]) await openDraft(list[0].id)
    } catch (err) {
      notify(`入库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      if (mounted.current) {
        setCommitOpen(false)
        setBusy(false)
        setBusyLabel('')
      }
    }
  }

  const discardOne = async (id: number) => {
    setConfirm(null)
    setConfirmDraftId(null)
    if (draftRef.current?.id === id) {
      pendingSave.current = null
      draftRef.current = null
      if (mounted.current) setDraft(null)
    }
    try {
      await window.api.importer.discardDraft(id)
      setThumbs((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      const list = await refreshMetas()
      if (!draftRef.current && list[0]) await openDraft(list[0].id)
      notify('已丢弃这份草稿', 'ok')
    } catch (err) {
      notify(`丢弃失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const discardAll = async () => {
    setConfirm(null)
    setManagerOpen(false)
    pendingSave.current = null
    draftRef.current = null
    if (mounted.current) setDraft(null)
    setBusy(true)
    setBusyLabel('正在丢弃草稿…')
    try {
      for (const m of metas) await window.api.importer.discardDraft(m.id)
      setThumbs({})
      await refreshMetas()
      notify('已清空全部未入库草稿', 'ok')
    } catch (err) {
      notify(`清理失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      if (mounted.current) {
        setBusy(false)
        setBusyLabel('')
      }
    }
  }

  const revalidate = async () => {
    const current = draftRef.current
    if (!current) return
    setConfirm(null)
    await flushSave()
    setBusy(true)
    setBusyLabel('正在重新校验…（会消耗少量 token）')
    try {
      const updated = await window.api.importer.revalidateDraft(current.id)
      draftRef.current = updated
      pendingSave.current = null
      if (mounted.current) {
        setDraft(updated)
        setSaving('saved')
      }
      await refreshMetas()
      notify(
        updated.issues.length ? `校验完成：${updated.issues.length} 条提示` : '校验完成：没有发现明显问题',
        'ok'
      )
    } catch (err) {
      notify(`校验失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      if (mounted.current) {
        setBusy(false)
        setBusyLabel('')
      }
    }
  }

  const updateItem = (tempId: string, patch: Partial<ParsedItem>) => {
    const current = draftRef.current
    if (!current) return
    applyPatch({
      items: current.items.map((it) => (it.tempId === tempId ? { ...it, ...patch } : it))
    })
  }

  const issueFor = (tempId?: string | null) => {
    const current = draftRef.current
    if (!current) return [] as ValidationIssue[]
    return current.issues.filter(
      (is, idx) =>
        !current.resolved.includes(idx) && (tempId ? is.tempId === tempId : !is.tempId)
    )
  }

  const rowState = (it: ParsedItem): 'warn' | 'err' | '' => {
    const list = issueFor(it.tempId)
    if (list.some((i) => i.severity === 'error')) return 'err'
    if (list.length) return 'warn'
    return ''
  }

  const resolveIssue = (index: number) => {
    const current = draftRef.current
    if (!current || current.resolved.includes(index)) return
    applyPatch({ resolved: [...current.resolved, index] })
  }

  const applySuggestion = (index: number) => {
    const current = draftRef.current
    const issue = current?.issues[index]
    if (!current || !issue) return
    if (issue.tempId && issue.suggestion) {
      const suggestion = cleanSuggestion(issue.field ?? 'general', issue.suggestion)
      if (issue.field === 'meaning') {
        updateItem(issue.tempId, { meanings: splitMeanings(suggestion) })
      } else if (issue.field === 'headword') {
        updateItem(issue.tempId, { headword: suggestion })
      } else if (issue.field === 'pos') {
        updateItem(issue.tempId, { pos: suggestion })
      }
    }
    resolveIssue(index)
  }

  const items = draft?.items ?? []
  const issues = draft?.issues ?? []
  const resolved = draft?.resolved ?? []
  const selectedCount = items.filter((i) => i.selected && i.headword.trim()).length
  const unresolvedErrors = issues.filter(
    (is, i) => !resolved.includes(i) && is.severity === 'error'
  ).length
  const warnings = useMemo(() => draft?.warnings ?? [], [draft])
  const activeMeta = metas.find((m) => m.id === draft?.id)
  const saveHint =
    saving === 'saving' ? '保存中…' : saving === 'saved' ? '已自动保存' : '改动会自动保存'

  return (
    <div className="page">
      <div className="page-head import-head">
        <div className="page-title-row">
          <h1 className="page-title">导入笔记</h1>
          <span
            className="page-title-hint"
            title="图片走 AI 识别，Word / Excel / txt / md 本地解析。"
          >
            图片走 AI 识别，Word / Excel / txt / md 本地解析。
          </span>
        </div>
        <div className="page-actions">
          <div className="row" style={{ gap: 6 }}>
            <span className="hint">导入到</span>
            <DeckSelect
              decks={decks}
              value={targetDeckId}
              onChange={(id) => {
                if (id !== null) void setDeck(id)
              }}
              width={150}
            />
          </div>
          <Button
            variant="ghost"
            onClick={() => setManagerOpen(true)}
            disabled={!metas.length}
            title={
              metas.length
                ? `${metas.length} 份未入库 · ${formatBytes(bytes)}`
                : '没有未入库草稿'
            }
          >
            草稿管理{metas.length > 0 ? `（${metas.length}）` : ''}
          </Button>
          {metas.length > 1 && (
            <Button onClick={() => setConfirm('commit-all')} disabled={busy}>
              全部入库
            </Button>
          )}
        </div>
      </div>

      {metas.length > 0 && (
        <div className="draft-band">
          {metas.map((m) => {
            const activeCard = m.id === draft?.id
            const thumb = thumbs[m.id]
            return (
              <div
                key={m.id}
                className={cls('draft-card', activeCard && 'active')}
                onClick={() => {
                  if (!busy) void openDraft(m.id)
                }}
              >
                <div className="draft-thumb">
                  {m.sourceKind === 'image' && thumb ? (
                    <img src={thumb} alt={m.fileName} />
                  ) : (
                    <FileText size={22} className="muted" />
                  )}
                </div>
                <div className="draft-info">
                  <div className="draft-name" title={m.fileName}>
                    {m.fileName}
                  </div>
                  <div className="draft-meta">
                    {m.itemCount} 条 · 已选 {m.selectedCount}
                    {m.errorCount > 0 && <span style={{ color: 'var(--red)' }}> · {m.errorCount} 待核对</span>}
                  </div>
                  <div className="draft-meta">
                    {formatWhen(m.updatedAt)}
                    {' · 入库到 '}
                    {draftDeckLabel(m.deckId)}
                    {m.edited && ' · 已改过'}
                    {!m.hasFile && ' · 原文件缺失'}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm draft-x"
                  title="丢弃这份草稿"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDraftId(m.id)
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
          <div
            className={cls('draft-card draft-add', dragging && 'drag')}
            onClick={() => void pick()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <Upload size={18} className="muted" />
            <span className="hint">继续添加</span>
          </div>
        </div>
      )}

      {metas.length === 0 && (
        <div
          className={cls('dropzone', dragging && 'drag')}
          onClick={() => void pick()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <Upload size={26} className="muted" />
          <div className="big">把笔记拖到这里，或点击选择</div>
          <div className="muted tiny">支持 PNG / JPG / JPEG · TXT / MD / DOCX / XLSX，可一次拖多个</div>
        </div>
      )}

      {loadingList ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : !draft ? (
        <Empty
          icon="🗂️"
          title="没有待入库的草稿"
          desc="识别完成的笔记会先存成草稿，随时可以回来继续改；入库后才进入笔记库。"
        />
      ) : (
        <div className="import-body">
          <div className="panel import-items">
            <div className="grid grid-3" style={{ marginBottom: 14 }}>
              <Field label="笔记标题">
                <input className="input" value={draft.title} onChange={(e) => applyPatch({ title: e.target.value })} />
              </Field>
              <Field label="上课日期">
                <input
                  className="input"
                  type="date"
                  value={draft.noteDate ?? ''}
                  onChange={(e) => applyPatch({ noteDate: e.target.value || null })}
                />
              </Field>
              <Field label="标签">
                <input
                  className="input"
                  placeholder="如：Unit 3, 期中"
                  value={draft.tags.join(', ')}
                  onChange={(e) =>
                    applyPatch({
                      tags: e.target.value
                        .split(/[,，]/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                    })
                  }
                />
              </Field>
            </div>

            <div className="row-between" style={{ marginBottom: 8 }}>
              <div className="row">
                <Badge tone="accent">{draft.sourceKind.toUpperCase()}</Badge>
                <Badge>
                  {selectedCount} / {items.length} 条
                </Badge>
                <Badge tone="accent">入库到 {draftDeckLabel(draft.deckId)}</Badge>
                {draft.aiUsed && <Badge tone="green">已用 AI 识别</Badge>}
                <span className="hint">{saveHint}</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? '隐藏原文' : '查看原文'}
              </button>
            </div>

            {showRaw && (
              <pre
                className="mono"
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  lineHeight: 1.65,
                  background: '#0f151e',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 12,
                  maxHeight: 220,
                  overflow: 'auto'
                }}
              >
                {draft.rawText}
              </pre>
            )}

            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}></th>
                    <th style={{ width: 190 }}>英文</th>
                    <th style={{ width: 60 }}>词性</th>
                    <th>中文释义（可直接改）</th>
                    <th style={{ width: 44 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const state = rowState(it)
                    return (
                      <tr
                        key={it.tempId}
                        id={`row-${it.tempId}`}
                        className={cls(state, flashId === it.tempId && 'flash')}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={it.selected}
                            onChange={(e) => updateItem(it.tempId, { selected: e.target.checked })}
                            style={{ accentColor: '#6c8cff' }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: '5px 8px', background: 'transparent', borderColor: 'transparent' }}
                            value={it.headword}
                            onChange={(e) => updateItem(it.tempId, { headword: e.target.value })}
                          />
                          {it.existingItemId && (
                            <div className="tiny" style={{ color: 'var(--accent)' }}>
                              词库已有，将合并释义
                            </div>
                          )}
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: '5px 8px', background: 'transparent', borderColor: 'transparent' }}
                            value={it.pos ?? ''}
                            onChange={(e) => updateItem(it.tempId, { pos: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: '5px 8px', background: 'transparent', borderColor: 'transparent' }}
                            value={it.meanings.join('；')}
                            onChange={(e) =>
                              updateItem(it.tempId, { meanings: splitMeanings(e.target.value) })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="btn btn-ghost btn-sm"
                            title="移除这一条"
                            onClick={() => updateItem(it.tempId, { selected: false })}
                          >
                            <X size={14} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {items.length === 0 && (
              <Empty icon="🔍" title="没有识别出词条" desc="可以在原文里手动整理，或换一张更清晰的图片。" />
            )}
          </div>

          <div className="import-side">
            <div className="panel issue-panel">
              <div className="panel-title row-between">
                <span className="row">
                  <AlertTriangle size={16} style={{ color: 'var(--yellow)' }} /> AI 校验
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirm('revalidate')}
                  disabled={busy || !settings.aiReady}
                >
                  <RefreshCw size={13} /> 重新校验
                </button>
              </div>
              <div className="issue-scroll">
                {issues.length === 0 ? (
                  <div className="row" style={{ color: 'var(--green)', fontSize: 13 }}>
                    <CheckCircle2 size={16} /> 没有发现明显问题
                  </div>
                ) : (
                  <div className="col" style={{ gap: 8 }}>
                    {issues.map((is, idx) =>
                      resolved.includes(idx) ? null : (
                        <div key={idx} className={cls('issue', is.severity === 'error' && 'error')}>
                          <div style={{ fontWeight: 600 }}>
                            {is.severity === 'error' ? '可能影响记忆' : '建议核对'}
                            {is.tempId ? '' : ' · 整份笔记'}
                          </div>
                          <div style={{ marginTop: 3 }}>{is.message}</div>
                          {is.suggestion && (
                            <div className="row" style={{ marginTop: 6 }}>
                              <span className="muted tiny">建议：{is.suggestion}</span>
                              <button className="btn btn-sm" onClick={() => applySuggestion(idx)}>
                                采纳
                              </button>
                            </div>
                          )}
                          <div className="row" style={{ marginTop: 6 }}>
                            {is.tempId && (
                              <button className="btn btn-ghost btn-sm" onClick={() => locateRow(is.tempId!)}>
                                定位
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => resolveIssue(idx)}>
                              忽略
                            </button>
                          </div>
                        </div>
                      )
                    )}
                    {issues.every((_, i) => resolved.includes(i)) && (
                      <div className="row" style={{ color: 'var(--green)', fontSize: 13 }}>
                        <CheckCircle2 size={16} /> 已全部处理
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="panel warnings-panel">
                <div className="panel-title">解析提示</div>
                <div className="col" style={{ gap: 6 }}>
                  {warnings.map((w, i) => (
                    <div key={i} className="hint">
                      · {w}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="panel commit-panel">
              <div className="panel-title">入库</div>
              <div className="hint" style={{ marginBottom: 10 }}>
                入库后会为每个词条建 2~3 张卡（英→中、中→英必选；听→写可在笔记库里单独关闭）。
              </div>
              {unresolvedErrors > 0 && (
                <div className="hint" style={{ color: 'var(--yellow)', marginBottom: 10 }}>
                  还有 {unresolvedErrors} 处「可能影响记忆」的提示未处理，建议先核对。
                </div>
              )}
              <Button
                variant="primary"
                style={{ width: '100%' }}
                onClick={() => void commitCurrent()}
                disabled={busy || items.length === 0}
              >
                {busy ? <Spinner /> : <FileText size={16} />} 确认入库（{selectedCount}）
              </Button>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirmDraftId(draft.id)}
                  disabled={busy}
                >
                  <Trash2 size={13} /> 丢弃这份
                </button>
                <span className="spacer" />
                {activeMeta && <span className="tiny muted">{formatBytes(activeMeta.bytes)}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {busy && busyLabel && !commitOpen && (
        <div className="busy-bar">
          <Spinner /> {busyLabel}
        </div>
      )}

      <Modal open={commitOpen} title="正在入库" onClose={() => undefined} width={430}>
        <div className="commit-wait">
          <Spinner />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>正在补全音标并入库…</div>
            <div className="hint" style={{ marginTop: 4 }}>
              单词查词典，词组交给 AI 标注；可能需要几秒。
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmDraftId !== null}
        title="丢弃这份草稿？"
        onClose={() => setConfirmDraftId(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDraftId(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDraftId !== null) void discardOne(confirmDraftId)
              }}
            >
              确认丢弃
            </Button>
          </>
        }
      >
        <div className="hint">
          丢弃后这份识别结果就真的没有了。已入库的笔记不受影响。
        </div>
      </Modal>

      <Modal
        open={confirm === 'commit-all'}
        title="全部入库？"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button variant="primary" onClick={() => void commitAll()}>
              全部入库（{metas.length}）
            </Button>
          </>
        }
      >
        <div className="hint">
          将按每份草稿自己的标题、日期、标签、勾选状态和所属库逐份入库，共 {metas.length} 份。没有勾选词条的草稿会跳过并提示。
        </div>
        <div className="col" style={{ gap: 4, marginTop: 10 }}>
          {metas.map((m) => (
            <div key={m.id} className="row-between">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.fileName}
              </span>
              <span className="tiny muted">
                {m.selectedCount} / {m.itemCount} 条
              </span>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={confirm === 'revalidate'}
        title="重新跑一次 AI 校验？"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button variant="primary" onClick={() => void revalidate()}>
              开始校验
            </Button>
          </>
        }
      >
        <div className="hint">
          会用当前 {items.length} 个词条重新请求 AI（消耗 token），旧的校验结果会被替换。
        </div>
      </Modal>

      <Modal
        open={managerOpen}
        title={`草稿管理 · ${metas.length} 份 · ${formatBytes(bytes)}`}
        onClose={() => setManagerOpen(false)}
        width={720}
        footer={
          <>
            <Button variant="danger" onClick={() => setConfirm('discard-all')} disabled={!metas.length}>
              <Trash2 size={14} /> 全部丢弃
            </Button>
            <span className="spacer" />
            <Button onClick={() => setManagerOpen(false)}>关闭</Button>
          </>
        }
      >
        {metas.length === 0 ? (
          <div className="hint">没有未入库草稿。</div>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {metas.map((m) => (
              <div key={m.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.fileName}
                  </div>
                  <div className="tiny muted">
                    {m.itemCount} 条 · {formatWhen(m.updatedAt)} · {formatBytes(m.bytes)}
                    {!m.hasFile && ' · 原文件缺失'}
                  </div>
                </div>
                <div className="row">
                  <Button size="sm" onClick={() => { setManagerOpen(false); void openDraft(m.id) }}>
                    打开
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setManagerOpen(false)
                      setConfirmDraftId(m.id)
                    }}
                  >
                    丢弃
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={confirm === 'discard-all'}
        title="丢弃全部未入库草稿？"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button variant="danger" onClick={() => void discardAll()}>
              全部丢弃（{metas.length}）
            </Button>
          </>
        }
      >
        <div className="hint">
          {metas.length} 份识别结果会被删除，此操作不可撤销。
        </div>
      </Modal>

      {!draft && !busy && metas.length === 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('review')}>
            没有要导入的，去今日任务 →
          </button>
        </div>
      )}
    </div>
  )
}
