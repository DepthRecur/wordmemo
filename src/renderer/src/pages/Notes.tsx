import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, FileText, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { CardDirection, Item, ItemKind, NoteDetail, NoteSummary, Settings } from '@shared/types'
import { KIND_LABEL } from '@shared/types'
import { displayPhonetic } from '@shared/normalize'
import { AudioButton } from '../components/AudioButton'
import { Badge, Button, Empty, Field, Modal, Spinner, Toggle } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { cls, formatDate } from '../lib/utils'

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
  navigate: Navigate
  refreshStats: () => Promise<void>
  version: number
  onChanged: () => void
  /** 未入库草稿数量：只在顶部提示，不混进笔记列表 */
  draftCount: number
}

export default function Notes({
  notify,
  settings,
  navigate,
  version,
  onChanged,
  refreshStats,
  draftCount
}: Props) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [itemResults, setItemResults] = useState<Item[]>([])
  const [expandedTerms, setExpandedTerms] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
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

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const term = search.trim()
      if (!term) {
        const list = await window.api.notes.list({ sort, order: 'desc' })
        if (id !== requestId.current) return
        setNotes(list)
        setItemResults([])
        setExpandedTerms([])
      } else {
        const result = await window.api.search.query(term, sort)
        if (id !== requestId.current) return
        setNotes(result.notes)
        setItemResults(result.items)
        setExpandedTerms(result.expandedTerms)
      }
    } catch (err) {
      if (id === requestId.current) {
        notify(`加载笔记失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      }
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [search, sort, notify])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 400)
    return () => clearTimeout(timer)
  }, [load, version])

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
      void load()
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
      void load()
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">笔记库</h1>
          <div className="page-sub">所有导入过的笔记与词条，按上课日期或导入时间排序。</div>
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
        {loading ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : notes.length === 0 ? (
          <Empty
            icon="📚"
            title={search ? '没有匹配的笔记' : '还没有笔记'}
            desc={search ? '换个关键词试试' : '把老师发的图片、Word、Excel 或 txt 拖进「导入笔记」。'}
          />
        ) : (
          <div className="grid grid-3">
            {notes.map((n) => (
              <div key={n.id} className="note-card" onClick={() => void openDetail(n.id)}>
                <div className="note-title">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                  {n.issueCount > 0 && <Badge tone="yellow" title="有未处理的核对项">{n.issueCount} 待核对</Badge>}
                </div>
                <div className="note-meta">
                  <span>{formatDate(n.noteDate ?? n.createdAt)}</span>
                  <span>{n.itemCount} 个词条</span>
                  {n.dueCount > 0 && <span style={{ color: 'var(--accent)' }}>{n.dueCount} 张到期</span>}
                </div>
                {n.tags.length > 0 && (
                  <div className="note-tags">
                    {n.tags.slice(0, 4).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
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
          确定删除「{confirmDelete?.title}」吗？笔记与它的复习进度都会删除，此操作不可撤销。
        </div>
      </Modal>
    </div>
  )
}
