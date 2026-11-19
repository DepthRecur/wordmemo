import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Plus, RefreshCw, Trash2, Play } from 'lucide-react'
import type { Deck, Exam, ExamLevel, ExamPlan, NoteSummary, Settings } from '@shared/types'
import { DeckSelect } from '../components/DeckPicker'
import { Badge, Button, Empty, Field, Modal, Progress, Spinner } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { formatDate, pct, todayKey, weekdayCN } from '../lib/utils'

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
}

export default function ExamPage({ notify, navigate, refreshStats, decks, deckId }: Props) {
  const [exams, setExams] = useState<Exam[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [plan, setPlan] = useState<ExamPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [planLoading, setPlanLoading] = useState(false)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    title: '英语听写',
    examDate: todayKey(),
    level: 'dictate' as ExamLevel,
    minutes: 20,
    retention: 0.95,
    /** null = 全部库 */
    deckId: null as number | null,
    scope: [] as number[],
    allNotes: true
  })

  const loadExams = useCallback(async () => {
    setLoading(true)
    try {
      const [list, ns] = await Promise.all([window.api.exams.list(), window.api.notes.list({})])
      setExams(list)
      setNotes(ns)
      if (list.length && selected === null) setSelected(list[0].id)
    } catch (err) {
      notify(`加载考试失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setLoading(false)
    }
  }, [notify, selected])

  useEffect(() => {
    void loadExams()
  }, [])

  const loadPlan = useCallback(
    async (id: number) => {
      setPlanLoading(true)
      try {
        const p = await window.api.exams.plan(id)
        setPlan(p)
      } catch (err) {
        notify(`生成计划失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      } finally {
        setPlanLoading(false)
      }
    },
    [notify]
  )

  useEffect(() => {
    if (selected) void loadPlan(selected)
    else setPlan(null)
  }, [selected, loadPlan])

  const create = async () => {
    try {
      const deckScope = form.deckId ? { deckId: form.deckId } : {}
      const id = await window.api.exams.create({
        title: form.title.trim() || '英语听写',
        examDate: form.examDate,
        scope:
          form.allNotes || form.scope.length === 0
            ? deckScope
            : { ...deckScope, noteIds: form.scope },
        level: form.level,
        targetRetention: form.retention,
        dailyMinutes: form.minutes
      })
      setCreating(false)
      await loadExams()
      setSelected(id)
      notify('听写计划已创建', 'ok')
      void refreshStats()
    } catch (err) {
      notify(`创建失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const remove = async () => {
    if (!selected) return
    try {
      await window.api.exams.remove(selected)
      setSelected(null)
      setPlan(null)
      await loadExams()
      notify('已删除', 'ok')
    } catch (err) {
      notify(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">听写冲刺</h1>
          <div className="page-sub">
            设置老师下次听写的日期，按剩余天数把任务分配到每天；复习记录同时计入长期记忆。
          </div>
        </div>
        <div className="page-actions">
          <Button onClick={() => selected && void loadPlan(selected)} disabled={!selected}>
            <RefreshCw size={15} /> 重算
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> 新建听写
          </Button>
        </div>
      </div>

      <div className="page-scroll">
      {loading ? (
        <div className="empty"><Spinner /></div>
      ) : exams.length === 0 ? (
        <Empty
          icon="📅"
          title="还没有设置听写日期"
          desc="设置之后，每天打开就知道该背哪些，不需要自己安排。"
          action={<Button variant="primary" onClick={() => setCreating(true)}>新建听写计划</Button>}
        />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '280px 1fr', alignItems: 'start' }}>
          <div className="col">
            {exams.map((e) => {
              const active = e.id === selected
              return (
                <button
                  key={e.id}
                  className="panel"
                  onClick={() => setSelected(e.id)}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: active ? 'rgba(108,140,255,0.55)' : undefined,
                    background: active ? 'rgba(108,140,255,0.08)' : undefined,
                    padding: 14
                  }}
                >
                  <div className="row-between">
                    <strong>{e.title}</strong>
                    <Badge tone={e.status === 'active' ? 'accent' : 'default'}>
                      {e.status === 'active' ? '进行中' : '已结束'}
                    </Badge>
                  </div>
                  <div className="note-meta" style={{ marginTop: 6 }}>
                    <span>{formatDate(e.examDate)}</span>
                    <span>{e.level === 'recognize' ? '只认' : e.level === 'dictate' ? '听写' : '混合'}</span>
                  </div>
                </button>
              )
            })}
          </div>

          {planLoading || !plan ? (
            <div className="empty"><Spinner /></div>
          ) : (
            <div className="col" style={{ gap: 14 }}>
              <div className="panel">
                <div className="row-between">
                  <div>
                    <div className="row">
                      <CalendarClock size={18} style={{ color: 'var(--accent)' }} />
                      <span style={{ fontSize: 16, fontWeight: 600 }}>{plan.exam.title}</span>
                      <Badge tone={plan.daysLeft <= 1 ? 'red' : plan.daysLeft <= 3 ? 'yellow' : 'accent'}>
                        {plan.daysLeft === 0 ? '今天听写' : `还有 ${plan.daysLeft} 天`}
                      </Badge>
                    </div>
                    <div className="muted tiny" style={{ marginTop: 6 }}>
                      听写日 {formatDate(plan.exam.examDate)} · 目标记忆率 {pct(plan.exam.targetRetention)} · 每天{' '}
                      {plan.exam.dailyMinutes} 分钟
                      {plan.exam.scope.deckId
                        ? ` · 范围：${decks.find((d) => d.id === plan.exam.scope.deckId)?.name ?? '已删除的库'}`
                        : ' · 范围：全部库'}
                    </div>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => void remove()}>
                    <Trash2 size={14} /> 删除
                  </Button>
                </div>

                <div className="grid grid-4" style={{ marginTop: 18 }}>
                  <div className="stat">
                    <div className="stat-value">{plan.totalCards}</div>
                    <div className="stat-label">范围内卡片</div>
                  </div>
                  <div className="stat">
                    <div className="stat-value stat-green">{plan.coveredCards}</div>
                    <div className="stat-label">已达标</div>
                  </div>
                  <div className="stat">
                    <div className="stat-value stat-yellow">{pct(plan.projectedRetention)}</div>
                    <div className="stat-label">当前预测记忆率</div>
                  </div>
                  <div className="stat">
                    <div className="stat-value stat-accent">{plan.todayCount}</div>
                    <div className="stat-label">今日任务（约 {plan.todayMinutes} 分钟）</div>
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <div className="row-between tiny muted" style={{ marginBottom: 6 }}>
                    <span>范围覆盖</span>
                    <span>{plan.totalCards ? pct(plan.coveredCards / plan.totalCards) : '—'}</span>
                  </div>
                  <Progress value={plan.totalCards ? plan.coveredCards / plan.totalCards : 0} />
                </div>

                {plan.warning && (
                  <div className="issue" style={{ marginTop: 14, borderColor: 'var(--yellow)' }}>
                    {plan.warning}
                  </div>
                )}

                <div className="row" style={{ marginTop: 16 }}>
                  <Button
                    variant="primary"
                    onClick={() => navigate('review', plan.exam.id)}
                    disabled={plan.todayCount === 0}
                  >
                    <Play size={15} /> 开始今日冲刺
                  </Button>
                  <span className="hint">
                    {plan.todayCount === 0
                      ? '今天的任务已完成，明天再来'
                      : `今天还有 ${plan.todayCount} 张卡，建议先做听写方向`}
                  </span>
                </div>
              </div>

              <div className="panel">
                <div className="panel-title">每日任务分布</div>
                <div className="row" style={{ overflowX: 'auto', paddingBottom: 4, gap: 8 }}>
                  {plan.daily.map((d) => (
                    <div key={d.date} className={`day-cell${d.isToday ? ' today' : ''}`}>
                      <div className="d">
                        {formatDate(d.date).slice(5)} 周{weekdayCN(d.date)}
                      </div>
                      <div className="n">{d.count}</div>
                      <div className="d">{d.isToday ? (d.done ? `已完成 ${d.done}` : '今天') : '计划'}</div>
                    </div>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 10 }}>
                  计划每天重算：新导入的词、当天没做完的任务、考试改期都会自动调整。
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      <Modal
        open={creating}
        title="新建听写计划"
        onClose={() => setCreating(false)}
        width={640}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>取消</Button>
            <Button variant="primary" onClick={() => void create()}>
              创建
            </Button>
          </>
        }
      >
        <div className="grid grid-2">
          <Field label="名称">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="听写日期">
            <input
              className="input"
              type="date"
              value={form.examDate}
              onChange={(e) => setForm({ ...form, examDate: e.target.value })}
            />
          </Field>
          <Field label="要求">
            <select
              className="select"
              value={form.level}
              onChange={(e) => setForm({ ...form, level: e.target.value as ExamLevel })}
            >
              <option value="dictate">听写（中→英 + 听→写）</option>
              <option value="recognize">只要求认识（英→中）</option>
              <option value="mixed">混合（全部方向）</option>
            </select>
          </Field>
          <Field label="每天预算（分钟）">
            <input
              className="input"
              type="number"
              min={5}
              max={180}
              value={form.minutes}
              onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}
            />
          </Field>
          <Field label="目标记忆率" hint="越高越稳，但每天任务更多；建议 0.93 ~ 0.97">
            <input
              className="input"
              type="number"
              min={0.8}
              max={0.99}
              step={0.01}
              value={form.retention}
              onChange={(e) => setForm({ ...form, retention: Number(e.target.value) })}
            />
          </Field>
          <Field label="范围">
            <select
              className="select"
              value={form.allNotes ? 'all' : 'custom'}
              onChange={(e) => setForm({ ...form, allNotes: e.target.value === 'all' })}
            >
              <option value="all">全部笔记</option>
              <option value="custom">指定笔记</option>
            </select>
          </Field>
          <Field label="范围库" hint="与「范围」是与关系；选「全部库」= 不分库">
            <DeckSelect
              decks={decks}
              value={form.deckId}
              includeAll
              onChange={(id) => setForm({ ...form, deckId: id, scope: [] })}
            />
          </Field>
        </div>

        {!form.allNotes && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label" style={{ marginBottom: 6 }}>选择笔记</div>
            <div className="col" style={{ gap: 4, maxHeight: 220, overflow: 'auto' }}>
              {notes
                .filter((n) => !form.deckId || n.deckId === form.deckId)
                .map((n) => (
                <label key={n.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.scope.includes(n.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        scope: e.target.checked ? [...form.scope, n.id] : form.scope.filter((id) => id !== n.id)
                      })
                    }
                    style={{ accentColor: '#6c8cff' }}
                  />
                  <span>{n.title}</span>
                  <span className="muted tiny">{formatDate(n.noteDate ?? n.createdAt)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
