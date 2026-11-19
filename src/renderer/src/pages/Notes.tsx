import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Eye, FileText, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type {
  CardDirection,
  Deck,
  Item,
  ItemKind,
  NoteDetail,
  NoteSummary,
  Settings
} from '@shared/types'
import { KIND_LABEL } from '@shared/types'
import { displayPhonetic } from '@shared/normalize'
import { AudioButton } from '../components/AudioButton'
import { DeckTabs } from '../components/DeckPicker'
import { Badge, Button, Empty, Field, Modal, Spinner, Toggle } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { cls, formatDate } from '../lib/utils'

/** 一次最多选这么多份（照 Anki 的 SELECTION_LIMIT，避免全选 3500 份把界面拖死） */
const SELECTION_LIMIT = 500

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
  version: number
  onChanged: () => void
  /** 未入库草稿数量：只在顶部提示，不混进笔记列表 */
  draftCount: number
}

type BatchKind = 'move' | 'copy' | 'delete'

export default function Notes({
  notify,
  settings,
  navigate,
  refreshStats,
  decks,
  deckId,
  setDeck,
  refreshDecks,
  version,
  onChanged,
  draftCount
}: Props) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  // null = 全部库；初值跟当前库走
  const [filter, setFilter] = useState<number | null>(deckId)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [batch, setBatch] = useState<BatchKind | null>(null)
  const [batchDeckId, setBatchDeckId] = useState<number | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [newDeckName, setNewDeckName] = useState('')
  const [createDeckOpen, setCreateDeckOpen] = useState(false)
  const [itemResults, setItemResults] = useState<Item[]>([])
  const [expandedTerms, setExpandedTerms] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // 输入框的即时值 search → 防抖后的 term；切库/排序不经过它，立即请求
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<'noteDate' | 'createdAt' | 'title'>('noteDate')
  const [detail, setDetail] = useState<NoteDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editTags, setEditTags] = useState('')
  const [itemEdit, setItemEdit] = useState<Item | null>(null)
  const [wordDetail, setWordDetail] = useState<Item | null>(null)
  const [itemMeanings, setItemMeanings] = useState('')
  const [itemCollocations, setItemCollocations] = useState('')
  const [itemHeadword, setItemHeadword] = useState('')
  const [itemKind, setItemKind] = useState<ItemKind>('word')
  const [itemPos, setItemPos] = useState('')
  const [itemPhonetic, setItemPhonetic] = useState('')
  const [itemExtra, setItemExtra] = useState('')
  const [itemExamples, setItemExamples] = useState<{ en: string; zh: string }[]>([])
  const [refreshingPhonetics, setRefreshingPhonetics] = useState(false)
  const [confirmPhonetics, setConfirmPhonetics] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<NoteSummary | null>(null)
  const requestId = useRef(0)
  /** 每个「库 + 排序 + 搜索词」的上一份结果：来回切库时先显示缓存，再后台刷新 */
  const listCache = useRef(new Map<string, { notes: NoteSummary[]; items: Item[]; terms: string[] }>())
  const cacheKey = `${filter ?? 'all'}|${sort}|${term.trim()}`

  const load = useCallback(async () => {
    const id = ++requestId.current
    const key = cacheKey
    const cached = listCache.current.get(key)
    if (cached) {
      // 有缓存就先画出来，绝不等网络/主进程
      setNotes(cached.notes)
      setItemResults(cached.items)
      setExpandedTerms(cached.terms)
      setLoading(false)
    } else {
      // 没缓存（第一次进这个库）：清掉上一份，避免标题是 A 库、列表还是 B 库
      setNotes([])
      setItemResults([])
      setExpandedTerms([])
      setLoading(true)
    }
    try {
      const keyword = term.trim()
      let view: { notes: NoteSummary[]; items: Item[]; terms: string[] }
      if (!keyword) {
        const list = await window.api.notes.list({ sort, order: 'desc', deckId: filter })
        view = { notes: list, items: [], terms: [] }
      } else {
        const result = await window.api.search.query(keyword, sort, filter)
        view = { notes: result.notes, items: result.items, terms: result.expandedTerms }
      }
      if (id !== requestId.current) return
      listCache.current.set(key, view)
      setNotes(view.notes)
      setItemResults(view.items)
      setExpandedTerms(view.terms)
    } catch (err) {
      if (id === requestId.current) {
        notify(`加载笔记失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      }
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [cacheKey, filter, sort, term, notify])

  // 数据被改过（version 变化）就丢掉缓存，避免显示旧列表
  useEffect(() => {
    listCache.current.clear()
  }, [version])

  // 只有输入搜索词才防抖；库/排序/刷新立即加载
  useEffect(() => {
    if (search === term) return
    const timer = window.setTimeout(() => setTerm(search), 300)
    return () => window.clearTimeout(timer)
  }, [search, term])

  useEffect(() => {
    void load()
  }, [load, version])

  // 筛选/搜索/排序变化时清空选区（PLAN-DECKS §7.1：全选只作用于当前结果）
  useEffect(() => {
    setSelected(new Set())
    setAnchorId(null)
  }, [filter, search, sort, version])

  // 别处切换了当前库（今日任务/导入页）→ 笔记库跟着切
  useEffect(() => {
    setFilter(deckId)
  }, [deckId])

  const visibleIds = notes.map((n) => n.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someSelected = !allSelected && visibleIds.some((id) => selected.has(id))

  const clearSelection = () => {
    setSelected(new Set())
    setAnchorId(null)
  }

  const selectAllVisible = () => {
    const ids = visibleIds.slice(0, SELECTION_LIMIT)
    if (visibleIds.length > SELECTION_LIMIT) {
      notify(`一次最多选 ${SELECTION_LIMIT} 份，已选前 ${SELECTION_LIMIT} 份；其余请再操作一次`, 'info')
    }
    setSelected(new Set(ids))
    setAnchorId(ids[ids.length - 1] ?? null)
  }

  const invertSelection = () => {
    const next = new Set<number>()
    for (const id of visibleIds) if (!selected.has(id)) next.add(id)
    if (next.size > SELECTION_LIMIT) {
      notify(`反选后有 ${next.size} 项，超过单次上限 ${SELECTION_LIMIT}，只选前 ${SELECTION_LIMIT} 项`, 'info')
      setSelected(new Set(visibleIds.filter((id) => !selected.has(id)).slice(0, SELECTION_LIMIT)))
      return
    }
    setSelected(next)
  }

  /** 复选框点击：Shift = 区间选，其余 = 切换单项 */
  const toggleOne = (id: number, shift: boolean) => {
    const next = new Set(selected)
    if (shift && anchorId !== null) {
      const from = visibleIds.indexOf(anchorId)
      const to = visibleIds.indexOf(id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        for (let i = start; i <= end; i++) next.add(visibleIds[i])
        if (next.size > SELECTION_LIMIT) {
          notify(`一次最多选 ${SELECTION_LIMIT} 份`, 'info')
          return
        }
        setSelected(next)
        setAnchorId(id)
        return
      }
    }
    if (next.has(id)) next.delete(id)
    else if (next.size < SELECTION_LIMIT) next.add(id)
    else {
      notify(`一次最多选 ${SELECTION_LIMIT} 份`, 'info')
      return
    }
    setSelected(next)
    setAnchorId(id)
  }

  // Ctrl+A 全选当前结果，Esc 清空；输入框里不抢键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAllVisible()
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const openDetail = async (id: number) => {
    try {
      const d = await window.api.notes.get(id)
      if (!d) return
      setDetail(d)
      setDetailOpen(true)
      setEditing(false)
      setEditTitle(d.title)
      setEditDate(d.noteDate ?? '')
      setEditTags(d.tags.join(', '))
    } catch (err) {
      notify(`打开笔记失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const saveNote = async () => {
    if (!detail) return
    try {
      await window.api.notes.update(detail.id, {
        title: editTitle,
        noteDate: editDate || null,
        tags: editTags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean)
      })
      notify('笔记已保存', 'ok')
      setEditing(false)
      setDetailOpen(false)
      onChanged()
    } catch (err) {
      notify(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const removeNote = async () => {
    if (!confirmDelete) return
    try {
      await window.api.notes.remove(confirmDelete.id)
      notify('笔记已删除', 'ok')
      setConfirmDelete(null)
      setDetailOpen(false)
      onChanged()
      void refreshStats()
    } catch (err) {
      notify(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const toggleListen = async (item: Item, enabled: boolean) => {
    try {
      await window.api.items.setDirection(item.id, 'listen2en', enabled)
      setDetail((d) =>
        d
          ? {
              ...d,
              items: d.items.map((it) =>
                it.id === item.id
                  ? {
                      ...it,
                      directions: enabled
                        ? Array.from(new Set<CardDirection>([...it.directions, 'listen2en']))
                        : it.directions.filter((x) => x !== 'listen2en')
                    }
                  : it
              )
            }
          : d
      )
    } catch (err) {
      notify(`修改失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const openItemEdit = (item: Item) => {
    setItemEdit(item)
    setItemKind(item.kind)
    setItemHeadword(item.headword)
    setItemPos(item.pos ?? '')
    setItemPhonetic(item.phonetic ?? '')
    setItemMeanings(item.meanings.join('；'))
    setItemCollocations((item.collocations ?? []).join('；'))
    setItemExtra(item.extra ?? '')
    setItemExamples(
      (item.examples ?? []).map((example) => ({ en: example.en ?? '', zh: example.zh ?? '' }))
    )
  }

  const saveItem = async () => {
    if (!itemEdit) return
    try {
      const examples = itemExamples
        .map((example) => ({ en: example.en.trim(), zh: example.zh.trim() }))
        .filter((example) => example.en)
        .map((example) => (example.zh ? { en: example.en, zh: example.zh } : { en: example.en }))
      await window.api.items.update(itemEdit.id, {
        kind: itemKind,
        headword: itemHeadword.trim(),
        pos: itemPos.trim() || null,
        phonetic: itemPhonetic.trim() || null,
        meanings: itemMeanings
          .split(/[;；]/)
          .map((m) => m.trim())
          .filter(Boolean),
        collocations: itemCollocations
          .split(/[;；]/)
          .map((c) => c.trim())
          .filter(Boolean),
        examples,
        extra: itemExtra.trim() || null
      })
      notify('词条已更新', 'ok')
      setItemEdit(null)
      if (detail) void openDetail(detail.id)
      onChanged()
    } catch (err) {
      notify(`更新失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const refreshPhonetics = async () => {
    if (!detail || refreshingPhonetics) return
    setConfirmPhonetics(false)
    setRefreshingPhonetics(true)
    try {
      const result = await window.api.items.refreshPhonetics(detail.id)
      await openDetail(detail.id)
      onChanged()
      const parts = [`共 ${result.total} 个词条`]
      if (result.updated) parts.push(`更新 ${result.updated} 个`)
      if (result.missing) parts.push(`${result.missing} 个没查到`)
      notify(
        result.updated || result.missing ? `音标重爬完成：${parts.join('，')}` : '音标都已是最新，没有变化',
        result.missing && !result.updated ? 'info' : 'ok'
      )
    } catch (err) {
      notify(`重爬音标失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setRefreshingPhonetics(false)
    }
  }

  const enrich = async () => {
    if (!detail || enriching) return
    setEnriching(true)
    try {
      const count = await window.api.items.enrichNote(detail.id)
      await openDetail(detail.id)
      onChanged()
      notify(count > 0 ? `已为 ${count} 个词条补充搭配/例句` : '没有需要补充的内容', 'ok')
    } catch (err) {
      notify(`AI 补充失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setEnriching(false)
    }
  }

  const selectedIds = [...selected]

  const openBatch = (kind: BatchKind) => {
    if (!selectedIds.length) return
    setNewDeckName('')
    if (kind === 'move') {
      setBatchDeckId(decks.find((d) => d.id !== filter)?.id ?? decks[0]?.id ?? null)
    } else if (kind === 'copy') {
      setBatchDeckId(filter ?? decks[0]?.id ?? null)
    }
    setBatch(kind)
  }

  const doMove = async (targetId: number, targetName?: string) => {
    setBatchBusy(true)
    try {
      const res = await window.api.notes.moveMany(selectedIds, targetId)
      const name = targetName ?? decks.find((d) => d.id === targetId)?.name ?? ''
      notify(`已移动 ${res.moved} 份笔记到「${name}」`, 'ok')
      setBatch(null)
      clearSelection()
      onChanged()
      await refreshDecks()
      void refreshStats()
    } catch (err) {
      notify(`移动失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBatchBusy(false)
    }
  }

  const doCopy = async (targetId: number) => {
    setBatchBusy(true)
    try {
      const res = await window.api.notes.copyMany(selectedIds, targetId)
      const name = decks.find((d) => d.id === targetId)?.name ?? ''
      notify(`已复制 ${res.copied} 份笔记到「${name}」；这些词的学习进度是共享的`, 'ok')
      setBatch(null)
      clearSelection()
      onChanged()
      await refreshDecks()
      void refreshStats()
    } catch (err) {
      notify(`复制失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBatchBusy(false)
    }
  }

  const doDelete = async () => {
    setBatchBusy(true)
    try {
      const res = await window.api.notes.removeMany(selectedIds)
      notify(`已删除 ${res.removed} 份笔记`, 'ok')
      setBatch(null)
      clearSelection()
      onChanged()
      await refreshDecks()
      void refreshStats()
    } catch (err) {
      notify(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBatchBusy(false)
    }
  }

  const createDeckAndMove = async () => {
    const name = newDeckName.trim()
    if (!name) {
      notify('先给新库起个名字', 'info')
      return
    }
    setBatchBusy(true)
    try {
      const id = await window.api.decks.create({ name })
      await refreshDecks()
      await doMove(id, name)
    } catch (err) {
      notify(`新建库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      setBatchBusy(false)
    }
  }

  const createDeckFromNotes = async () => {
    const name = newDeckName.trim()
    if (!name) {
      notify('先给新库起个名字', 'info')
      return
    }
    try {
      const id = await window.api.decks.create({ name })
      setNewDeckName('')
      setCreateDeckOpen(false)
      await refreshDecks()
      setFilter(id)
      notify(`已创建「${name}」`, 'ok')
    } catch (err) {
      notify(`新建库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">笔记库</h1>
          <div className="page-sub">
            {filter === null
              ? '全部库的笔记'
              : `「${decks.find((d) => d.id === filter)?.name ?? '当前库'}」里的笔记`}
            ，按上课日期或导入时间排序。
          </div>
        </div>
        <div className="page-actions">
          <div className="row" style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '2px 8px' }}>
            <Search size={15} className="muted" />
            <input
              className="input"
              style={{ border: 'none', background: 'transparent', padding: '7px 4px', width: 220 }}
              placeholder="搜单词、释义或笔记…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="noteDate">按上课日期</option>
            <option value="createdAt">按导入时间</option>
            <option value="title">按标题</option>
          </select>
          <Button onClick={() => void load()} title="刷新">
            <RefreshCw size={15} />
          </Button>
        </div>
      </div>

      <div className="deck-bar">
        <DeckTabs
          decks={decks}
          value={filter}
          onChange={(id) => {
            setFilter(id)
            // 选具体库时顺手把「当前库」也切过去：导入目标、托盘计数都跟着它
            if (id !== null && id !== deckId) void setDeck(id)
          }}
          totalNotes={decks.reduce((sum, deck) => sum + deck.noteCount, 0)}
        />
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setCreateDeckOpen(true)}>
            <Plus size={14} /> 新建库
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('settings', undefined, undefined, 'decks')}>
            库管理
          </Button>
        </div>
      </div>

      <div className="page-scroll">
        {draftCount > 0 && (
          <div className="draft-banner" onClick={() => navigate('import')}>
            <FileText size={16} />
            <span>
              有 {draftCount} 份笔记识别完成但还没入库，点这里继续处理 →
            </span>
          </div>
        )}
        {search.trim() && expandedTerms.length > 0 && (
          <div className="hint" style={{ marginBottom: 10 }}>
            AI 语义扩展：{expandedTerms.join(' / ')}（只发送查询词，不上传词库）
          </div>
        )}
        {search.trim() && itemResults.length > 0 && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-title">匹配的词条（{itemResults.length}）</div>
            <div className="item-results">
              {itemResults.slice(0, 30).map((it) => (
                <button
                  key={it.id}
                  className="item-result"
                  onClick={() => setWordDetail(it)}
                >
                  <span className="item-result-word">{it.headword}</span>
                  <span className="item-result-meaning">{it.meanings.join('；')}</span>
                  {it.pos && <span className="item-result-pos">{it.pos}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 批量栏常驻：0 选中时按钮禁用，不靠右键菜单（PLAN-DECKS §7.1） */}
        <div className="batch-bar">
          <span className="batch-count">
            已选 {selected.size} 项
            {selected.size > 0 && visibleIds.length > 0 && selected.size < visibleIds.length
              ? ` / 共 ${visibleIds.length}`
              : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={selectAllVisible} disabled={!visibleIds.length}>
            全选
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} disabled={!selected.size}>
            全不选
          </Button>
          <Button size="sm" variant="ghost" onClick={invertSelection} disabled={!visibleIds.length}>
            反选
          </Button>
          <span className="spacer" />
          <Button size="sm" onClick={() => openBatch('move')} disabled={!selected.size}>
            移动到…
          </Button>
          <Button size="sm" onClick={() => openBatch('copy')} disabled={!selected.size}>
            <Copy size={14} /> 复制到…
          </Button>
          <Button size="sm" variant="danger" onClick={() => openBatch('delete')} disabled={!selected.size}>
            <Trash2 size={14} /> 删除
          </Button>
        </div>

        {loading && notes.length === 0 ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : notes.length === 0 ? (
          <Empty
            icon="📚"
            title={search ? '没有匹配的笔记' : '还没有笔记'}
            desc={
              search
                ? '换个关键词试试'
                : filter === null
                  ? '把老师发的图片、Word、Excel 或 txt 拖进「导入笔记」。'
                  : '这个库还是空的：去「导入笔记」把目标库切到这里再导入，或从别的库移动几份过来。'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table notes-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected
                      }}
                      onChange={() => (allSelected ? clearSelection() : selectAllVisible())}
                      title="全选当前结果（不是整库）"
                      style={{ accentColor: '#6c8cff' }}
                    />
                  </th>
                  <th>标题</th>
                  <th style={{ width: 110 }}>日期</th>
                  <th style={{ width: 76 }}>词条</th>
                  <th style={{ width: 76 }}>到期</th>
                  <th style={{ width: 130 }}>库</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => (
                  <tr key={n.id} className={cls(selected.has(n.id) && 'row-selected')}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(n.id)}
                        onChange={(e) =>
                          toggleOne(n.id, (e.nativeEvent as MouseEvent).shiftKey)
                        }
                        style={{ accentColor: '#6c8cff' }}
                      />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="word-link" onClick={() => void openDetail(n.id)}>
                          {n.title}
                        </button>
                        {n.issueCount > 0 && (
                          <Badge tone="yellow" title="有未处理的核对项">
                            {n.issueCount} 待核对
                          </Badge>
                        )}
                        {n.tags.length > 0 && (
                          <span className="tiny muted">{n.tags.slice(0, 3).join(' · ')}</span>
                        )}
                      </div>
                    </td>
                    <td className="tiny muted">{formatDate(n.noteDate ?? n.createdAt)}</td>
                    <td className="tiny muted">{n.itemCount}</td>
                    <td className="tiny" style={{ color: n.dueCount > 0 ? 'var(--accent)' : 'var(--muted)' }}>
                      {n.dueCount || '—'}
                    </td>
                    <td>
                      <Badge>{n.deckName}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={detailOpen}
        title={detail?.title ?? '笔记详情'}
        onClose={() => setDetailOpen(false)}
        width={980}
        footer={
          <>
            <Button variant="danger" onClick={() => detail && setConfirmDelete(detail)}>
              <Trash2 size={15} /> 删除笔记
            </Button>
            <span className="spacer" />
            <Button
              onClick={() => void enrich()}
              disabled={enriching || !settings.apiKeySet}
              title={settings.apiKeySet ? '让 AI 为这份笔记补充常用搭配和例句' : '需要先在设置里填写 API Key'}
            >
              {enriching ? <Spinner /> : 'AI 补充搭配'}
            </Button>
            <Button
              onClick={() => setConfirmPhonetics(true)}
              disabled={refreshingPhonetics || !detail?.items.length}
              title="忽略缓存，重新查询这份笔记里所有词条的音标并覆盖"
            >
              {refreshingPhonetics ? <Spinner /> : <RefreshCw size={15} />} 重爬音标
            </Button>
            {editing ? (
              <>
                <Button onClick={() => setEditing(false)}>取消</Button>
                <Button variant="primary" onClick={() => void saveNote()}>
                  保存
                </Button>
              </>
            ) : (
              <Button onClick={() => setEditing(true)}>
                <Pencil size={15} /> 编辑信息
              </Button>
            )}
          </>
        }
      >
        {detail && (
          <>
            {editing ? (
              <div className="grid grid-3" style={{ marginBottom: 16 }}>
                <Field label="标题">
                  <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                </Field>
                <Field label="上课日期">
                  <input className="input" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </Field>
                <Field label="标签（逗号分隔）">
                  <input className="input" value={editTags} onChange={(e) => setEditTags(e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
                <Badge tone="accent">{formatDate(detail.noteDate ?? detail.createdAt)}</Badge>
                <Badge>{detail.itemCount} 个词条</Badge>
                {detail.sourceName && <Badge>{detail.sourceName}</Badge>}
                {detail.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}

            {detail.issueCount > 0 && (
              <div className="issue" style={{ marginBottom: 14 }}>
                这份笔记有 {detail.issueCount} 处 AI 校验提醒，建议对照原文核对。
              </div>
            )}

            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 220 }}>单词 / 短语</th>
                    <th>释义</th>
                    <th style={{ width: 64 }}>类型</th>
                    <th style={{ width: 150 }}>卡片方向</th>
                    <th style={{ width: 108 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((item) => {
                    const hasListen = item.directions.includes('listen2en')
                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button
                              className="word-link"
                              onClick={() => setWordDetail(item)}
                              title="查看词条详情"
                            >
                              {item.headword}
                            </button>
                            {item.pos && <span className="muted tiny">{item.pos}</span>}
                          </div>
                        </td>
                        <td>
                          <div>{item.meanings.join('；')}</div>
                          {item.collocations.length > 0 && (
                            <div className="tiny muted" style={{ marginTop: 2 }}>
                              {item.collocations.join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="muted tiny">{KIND_LABEL[item.kind]}</td>
                        <td>
                          <div className="row" style={{ gap: 2 }}>
                            <Badge tone="accent">英→中</Badge>
                            <Badge tone="accent">中→英</Badge>
                            <label className="row tiny muted" style={{ gap: 4, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={hasListen}
                                onChange={(e) => void toggleListen(item, e.target.checked)}
                                style={{ accentColor: '#6c8cff' }}
                              />
                              听→写
                            </label>
                          </div>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 2 }}>
                            <AudioButton word={item.headword} accent={settings.accent} small />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setWordDetail(item)}
                              title="查看词条详情"
                            >
                              <Eye size={14} />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openItemEdit(item)} title="编辑">
                              <Pencil size={14} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <details style={{ marginTop: 16 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
                查看笔记原文
              </summary>
              <pre
                className="mono"
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  lineHeight: 1.7,
                  background: '#0f151e',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 14,
                  maxHeight: 300,
                  overflow: 'auto'
                }}
              >
                {detail.rawMarkdown}
              </pre>
            </details>
          </>
        )}
      </Modal>

      <Modal
        open={!!itemEdit}
        title="编辑词条"
        onClose={() => setItemEdit(null)}
        width={620}
        footer={
          <>
            <Button onClick={() => setItemEdit(null)}>取消</Button>
            <Button variant="primary" onClick={() => void saveItem()}>
              保存
            </Button>
          </>
        }
      >
        <div className="col">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="类型">
              <select
                className="select"
                value={itemKind}
                onChange={(e) => setItemKind(e.target.value as ItemKind)}
              >
                {(Object.keys(KIND_LABEL) as ItemKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="词性（如 v. / n.）">
              <input
                className="input"
                value={itemPos}
                placeholder="v. / n."
                onChange={(e) => setItemPos(e.target.value)}
              />
            </Field>
          </div>
          <Field label="英文">
            <input className="input" value={itemHeadword} onChange={(e) => setItemHeadword(e.target.value)} />
          </Field>
          <Field label="音标">
            <input
              className="input"
              value={itemPhonetic}
              placeholder="/əˈsesmənt/ 或 美 /…/ · 英 /…/"
              onChange={(e) => setItemPhonetic(e.target.value)}
            />
          </Field>
          <Field label="中文释义（用分号分隔）">
            <textarea className="textarea" value={itemMeanings} onChange={(e) => setItemMeanings(e.target.value)} />
          </Field>
          <Field label="固定搭配（用分号分隔）">
            <textarea
              className="textarea"
              style={{ minHeight: 70 }}
              value={itemCollocations}
              onChange={(e) => setItemCollocations(e.target.value)}
            />
          </Field>
          <Field label="例句">
            <div className="col" style={{ gap: 8 }}>
              {itemExamples.map((example, index) => (
                <div key={index} className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={example.en}
                    placeholder="英文例句"
                    onChange={(e) =>
                      setItemExamples((prev) =>
                        prev.map((ex, i) => (i === index ? { ...ex, en: e.target.value } : ex))
                      )
                    }
                  />
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={example.zh}
                    placeholder="中文翻译（可空）"
                    onChange={(e) =>
                      setItemExamples((prev) =>
                        prev.map((ex, i) => (i === index ? { ...ex, zh: e.target.value } : ex))
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    title="删除这句"
                    onClick={() => setItemExamples((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setItemExamples((prev) => [...prev, { en: '', zh: '' }])}
              >
                <Plus size={14} /> 添加例句
              </Button>
            </div>
          </Field>
          <Field label="备注 / 用法">
            <textarea
              className="textarea"
              style={{ minHeight: 70 }}
              value={itemExtra}
              placeholder="老师标注的用法、易错点等"
              onChange={(e) => setItemExtra(e.target.value)}
            />
          </Field>
          <div className="hint">改英文 / 词性 / 类型后会与已有词条比对，撞词会提示失败。</div>
        </div>
      </Modal>

      <Modal
        open={!!wordDetail}
        title="词条详情"
        onClose={() => setWordDetail(null)}
        width={680}
        footer={
          <>
            {wordDetail?.noteIds[0] && (
              <Button
                variant="ghost"
                onClick={() => {
                  const noteId = wordDetail?.noteIds[0]
                  setWordDetail(null)
                  if (noteId) void openDetail(noteId)
                }}
              >
                查看所属笔记
              </Button>
            )}
            <span className="spacer" />
            <Button
              onClick={() => {
                if (!wordDetail) return
                const item = wordDetail
                setWordDetail(null)
                openItemEdit(item)
              }}
            >
              <Pencil size={15} /> 编辑
            </Button>
            <Button variant="primary" onClick={() => setWordDetail(null)}>
              关闭
            </Button>
          </>
        }
      >
        {wordDetail && (
          <div className="word-detail">
            <div className="word-detail-head">
              <div>
                <div className="word-detail-word">{wordDetail.headword}</div>
                <div className="word-detail-phonetic">
                  {wordDetail.phonetic
                    ? `音标 ${displayPhonetic(wordDetail.phonetic)}`
                    : '音标：暂无'}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>
                  音标只在词条详情显示，复习测验中不会出现。
                </div>
              </div>
              <div className="row" style={{ marginLeft: 'auto' }}>
                <AudioButton word={wordDetail.headword} accent="us" label="美音" />
                <AudioButton word={wordDetail.headword} accent="uk" label="英音" />
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">词性</div>
              <div className="detail-value">{wordDetail.pos || '未标注'}</div>
            </div>

            <div className="detail-section">
              <div className="detail-label">中文释义</div>
              {wordDetail.meanings.length > 0 ? (
                <ul className="detail-list">
                  {wordDetail.meanings.map((meaning) => (
                    <li key={meaning}>{meaning}</li>
                  ))}
                </ul>
              ) : (
                <div className="muted">暂无释义</div>
              )}
            </div>

            <div className="detail-section">
              <div className="detail-label">固定搭配</div>
              {wordDetail.collocations.length > 0 ? (
                <div className="colloc-list">
                  {wordDetail.collocations.map((collocation) => (
                    <span key={collocation} className="colloc">
                      {collocation}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="muted">暂无固定搭配</div>
              )}
            </div>

            <div className="detail-section">
              <div className="detail-label">例句</div>
              {wordDetail.examples.length > 0 ? (
                wordDetail.examples.map((example, index) => (
                  <div key={`${example.en}-${index}`} className="detail-example">
                    <div>{example.en}</div>
                    {example.zh && <div className="zh">{example.zh}</div>}
                  </div>
                ))
              ) : (
                <div className="muted">暂无例句</div>
              )}
            </div>

            {wordDetail.extra && (
              <div className="detail-section">
                <div className="detail-label">用法 / 备注</div>
                <div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>
                  {wordDetail.extra}
                </div>
              </div>
            )}

            <div className="detail-section">
              <div className="detail-label">类型 / 学习状态</div>
              <div className="detail-value">
                {KIND_LABEL[wordDetail.kind]} · {wordDetail.learnedAt ? '已学习' : '待学习'}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmPhonetics}
        title="重爬音标"
        onClose={() => setConfirmPhonetics(false)}
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmPhonetics(false)}>取消</Button>
            <Button variant="primary" onClick={() => void refreshPhonetics()}>
              开始重爬
            </Button>
          </>
        }
      >
        <div>
          会重新查询「{detail?.title ?? '这份笔记'}」里全部 {detail?.items.length ?? 0} 个词条的音标，
          并覆盖已有音标（包括手动改过的）。单词查词典，词组和查不到的词交给 AI 拼读。
        </div>
      </Modal>

      <Modal
        open={!!confirmDelete}
        title="删除笔记"
        onClose={() => setConfirmDelete(null)}
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button variant="danger" onClick={() => void removeNote()}>
              确认删除
            </Button>
          </>
        }
      >
        <div>
          确定删除「{confirmDelete?.title}」吗？若某个词只存在于这份笔记里，它的卡片与复习记录会一起删除。此操作不可撤销。
        </div>
      </Modal>

      <Modal
        open={createDeckOpen}
        title="新建笔记库"
        onClose={() => setCreateDeckOpen(false)}
        width={440}
        footer={
          <>
            <Button onClick={() => setCreateDeckOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void createDeckFromNotes()}>
              创建
            </Button>
          </>
        }
      >
        <Field label="库名" hint="例如「上课笔记」「课标词汇」。同一个词在两个库只学一次。">
          <input
            className="input"
            value={newDeckName}
            autoFocus
            onChange={(e) => setNewDeckName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createDeckFromNotes()
            }}
          />
        </Field>
      </Modal>

      <Modal
        open={batch === 'move'}
        title={`移动 ${selected.size} 份笔记`}
        onClose={() => setBatch(null)}
        width={500}
        footer={
          <>
            <Button onClick={() => setBatch(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={batchBusy || !batchDeckId || batchDeckId === filter}
              onClick={() => {
                if (batchDeckId) void doMove(batchDeckId)
              }}
            >
              移动
            </Button>
          </>
        }
      >
        <div className="col">
          <div>目标库：</div>
          <select
            className="select"
            value={batchDeckId ?? ''}
            onChange={(e) => setBatchDeckId(Number(e.target.value))}
          >
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
                {deck.id === filter ? '（当前筛选的库）' : ''}
              </option>
            ))}
          </select>
          <div className="hint">
            只改笔记的归属，词条、卡片和复习进度一个都不动；目标库里还没学的词会立刻进入它的今日任务。
          </div>
          <div className="row">
            <input
              className="input"
              placeholder="或新建一个库…"
              value={newDeckName}
              onChange={(e) => setNewDeckName(e.target.value)}
            />
            <Button
              size="sm"
              disabled={batchBusy || !newDeckName.trim()}
              onClick={() => void createDeckAndMove()}
            >
              新建并移动
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={batch === 'copy'}
        title={`复制 ${selected.size} 份笔记`}
        onClose={() => setBatch(null)}
        width={500}
        footer={
          <>
            <Button onClick={() => setBatch(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={batchBusy || !batchDeckId}
              onClick={() => {
                if (batchDeckId) void doCopy(batchDeckId)
              }}
            >
              复制
            </Button>
          </>
        }
      >
        <div className="col">
          <div>目标库：</div>
          <select
            className="select"
            value={batchDeckId ?? ''}
            onChange={(e) => setBatchDeckId(Number(e.target.value))}
          >
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
              </option>
            ))}
          </select>
          <div className="hint">
            复制的是笔记内容（标题、日期、标签、原文与词条关联）；这些词的学习进度是共享的，不会重新开始。复制进同一个库会得到一份同名副本。
          </div>
        </div>
      </Modal>

      <Modal
        open={batch === 'delete'}
        title={`删除 ${selected.size} 份笔记`}
        onClose={() => setBatch(null)}
        width={480}
        footer={
          <>
            <Button onClick={() => setBatch(null)}>取消</Button>
            <Button variant="danger" disabled={batchBusy} onClick={() => void doDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <div className="col">
          <div>确定删除选中的 {selected.size} 份笔记吗？此操作不可撤销。</div>
          <div className="hint">
            若某个词只存在于这些笔记里，它的卡片与复习记录会一起删除；同时在别的笔记里出现的词会保留。
          </div>
        </div>
      </Modal>
    </div>
  )
}
