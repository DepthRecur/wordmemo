import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Eye, EyeOff, RotateCcw, Volume2, X } from 'lucide-react'
import type { DailyPlan, Item, JudgeResult, QueueCard, Settings } from '@shared/types'
import { DIRECTION_LABEL } from '@shared/types'
import { displayPhonetic } from '@shared/normalize'
import { AudioButton, playWord } from '../components/AudioButton'
import { Badge, Button, Empty, Progress, Spinner } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { cls } from '../lib/utils'

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
  navigate: Navigate
  refreshStats: () => Promise<void>
  examId?: number
  onFinished: () => void
}

type Stage = 'loading' | 'overview' | 'learn' | 'learnDone' | 'review' | 'done'

export default function Review({ notify, settings, navigate, refreshStats, examId, onFinished }: Props) {
  const mode = examId ? 'exam' : 'longterm'
  const [stage, setStage] = useState<Stage>('loading')
  const [plan, setPlan] = useState<DailyPlan | null>(null)
  const [queue, setQueue] = useState<QueueCard[]>([])
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<JudgeResult | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startTs, setStartTs] = useState(Date.now())
  const [stats, setStats] = useState({ total: 0, correct: 0 })
  const [hint, setHint] = useState(false)
  // 音标永远默认隐藏：用户想看自己点，不记忆偏好
  const [phoneticHint, setPhoneticHint] = useState(false)
  const [phoneticBusy, setPhoneticBusy] = useState(false)
  const [learnIndex, setLearnIndex] = useState(0)
  const [learnStats, setLearnStats] = useState({ known: 0, again: 0 })
  const [learnBusy, setLearnBusy] = useState(false)
  const [learnPhonetics, setLearnPhonetics] = useState<Record<number, string | null>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const phoneticRequests = useRef(new Map<number, Promise<string | null>>())
  const card = queue[index]

  const init = useCallback(async () => {
    setStage('loading')
    try {
      if (examId) {
        const q = await window.api.review.queue('exam', examId)
        setQueue(q)
        setIndex(0)
        setStats({ total: 0, correct: 0 })
        setStage(q.length ? 'review' : 'done')
        return
      }
      const p = await window.api.review.daily()
      setPlan(p)
      setStage('overview')
    } catch (err) {
      notify(`加载今日任务失败：${err instanceof Error ? err.message : String(err)}`, 'err')
      setStage('overview')
    }
  }, [examId, notify])

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!card) return
    setStartTs(Date.now())
    setAnswer('')
    setResult(null)
    setRevealed(false)
    setHint(false)
    setPhoneticHint(false)
    const timer = setTimeout(() => inputRef.current?.focus(), 60)
    if (card.direction === 'listen2en' || settings.autoPlayAudio) {
      setTimeout(() => {
        void playWord(card.item.headword, settings.accent)
      }, 260)
    }
    return () => clearTimeout(timer)
  }, [index, card?.id, settings.autoPlayAudio, settings.accent])

  const learnItem: Item | undefined = plan?.learnItems[learnIndex]

  const resolvePhonetic = useCallback(async (item: Item): Promise<string | null> => {
    if (item.phonetic?.trim()) return item.phonetic
    const pending = phoneticRequests.current.get(item.id)
    if (pending) return pending
    const request = window.api.items
      .ensurePhonetic(item.id)
      .then((value) => {
        if (!value) phoneticRequests.current.delete(item.id)
        return value
      })
      .catch(() => {
        phoneticRequests.current.delete(item.id)
        return null
      })
    phoneticRequests.current.set(item.id, request)
    return request
  }, [])

  // 学习阶段开始前就把当天新词的音标批量查好（3 个并发）
  useEffect(() => {
    const items = plan?.learnItems
    if (!items?.length) return
    let cancelled = false
    const pending = [...items]

    const worker = async () => {
      while (!cancelled) {
        const item = pending.shift()
        if (!item) return
        if (item.phonetic?.trim()) {
          setLearnPhonetics((prev) =>
            prev[item.id] === item.phonetic ? prev : { ...prev, [item.id]: item.phonetic! }
          )
          continue
        }
        const phonetic = await resolvePhonetic(item)
        if (!cancelled) {
          setLearnPhonetics((prev) => ({ ...prev, [item.id]: phonetic }))
        }
      }
    }

    void Promise.all([worker(), worker(), worker()])
    return () => {
      cancelled = true
    }
  }, [plan?.learnItems, resolvePhonetic])

  // 如果用户很快就点到某张卡，至少保证当前词优先查一次
  useEffect(() => {
    if (stage !== 'learn' || !learnItem) return
    if (learnItem.phonetic?.trim() || learnPhonetics[learnItem.id] !== undefined) return
    void resolvePhonetic(learnItem).then((phonetic) => {
      setLearnPhonetics((prev) => ({ ...prev, [learnItem.id]: phonetic }))
    })
    // 只在切换词条时触发，不依赖 learnPhonetics，避免重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, learnItem?.id, resolvePhonetic])

  const learnPhoneticText = learnItem
    ? learnItem.phonetic?.trim() ||
      (learnPhonetics[learnItem.id] === undefined
        ? '音标查询中…'
        : learnPhonetics[learnItem.id] || '暂无音标')
    : ''

  useEffect(() => {
    if (stage === 'learn' && learnItem && settings.autoPlayAudio) {
      const timer = setTimeout(() => void playWord(learnItem.headword, settings.accent), 250)
      return () => clearTimeout(timer)
    }
  }, [stage, learnItem?.id, settings.autoPlayAudio, settings.accent])

  const progress = queue.length ? index / queue.length : 0
  const learnProgress = plan?.learnItems.length ? learnIndex / plan.learnItems.length : 0

  const startLearn = () => {
    if (!plan?.learnItems.length) return
    setLearnIndex(0)
    setLearnStats({ known: 0, again: 0 })
    setStage('learn')
  }

  const togglePhoneticHint = async () => {
    if (!card || phoneticBusy) return
    const current = card.item

    if (phoneticHint && current.phonetic) {
      setPhoneticHint(false)
      return
    }
    if (current.phonetic) {
      setPhoneticHint(true)
      return
    }

    setPhoneticBusy(true)
    try {
      const phonetic = await window.api.items.ensurePhonetic(current.id)
      if (!phonetic) {
        notify('暂时查不到音标，可以在笔记详情的词条编辑里手动填写', 'err')
        return
      }
      setQueue((items) =>
        items.map((queueCard) =>
          queueCard.item.id === current.id
            ? { ...queueCard, item: { ...queueCard.item, phonetic } }
            : queueCard
        )
      )
      setPhoneticHint(true)
    } catch (err) {
      notify(`音标查询失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setPhoneticBusy(false)
    }
  }

  const rateLearn = async (known: boolean) => {
    if (!learnItem || learnBusy) return
    setLearnBusy(true)
    try {
      await window.api.review.learn(learnItem.id, known)
      setLearnStats((s) => ({ known: s.known + (known ? 1 : 0), again: s.again + (known ? 0 : 1) }))
      if (learnIndex + 1 < (plan?.learnItems.length ?? 0)) {
        setLearnIndex(learnIndex + 1)
      } else {
        const p = await window.api.review.daily()
        setPlan(p)
        setStage('learnDone')
        void refreshStats()
      }
    } catch (err) {
      notify(`保存学习记录失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setLearnBusy(false)
    }
  }

  const startReview = async () => {
    try {
      const p = await window.api.review.daily()
      setPlan(p)
      if (!p.reviewCards.length) {
        setStage('done')
        return
      }
      setQueue(p.reviewCards)
      setIndex(0)
      setStats({ total: 0, correct: 0 })
      setStage('review')
    } catch (err) {
      notify(`加载复习队列失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const submitAnswer = async () => {
    if (!card || busy) return
    if (!answer.trim()) {
      notify('先写下答案，再按回车', 'info')
      return
    }
    setBusy(true)
    try {
      const r = await window.api.review.judge(card.id, answer)
      setResult(r)
      setRevealed(true)
    } catch (err) {
      notify(`判分失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const finishCard = async (rating: 1 | 2 | 3 | 4, correct: boolean, judgeBy: JudgeResult['source']) => {
    if (!card || busy) return
    setBusy(true)
    try {
      const outcome = await window.api.review.submit({
        cardId: card.id,
        rating,
        answer,
        correct,
        elapsedMs: Date.now() - startTs,
        mode,
        examId: examId ?? null,
        judgeBy
      })
      setStats((s) => ({ total: s.total + 1, correct: s.correct + (correct ? 1 : 0) }))

      // Anki 的 learn ahead：只把 20 分钟内到期的学习卡提前放回本轮队列。
      // 14 小时后才到期的 Hard 卡不会生成“第二批”。
      let nextQueue = queue
      const dueMs = Date.parse(outcome.dueAt)
      const aheadMs = Math.max(0, Number(settings.learnAheadMinutes ?? 20)) * 60_000
      if (
        (outcome.state === 1 || outcome.state === 3) &&
        Number.isFinite(dueMs) &&
        dueMs <= Date.now() + aheadMs
      ) {
        nextQueue = [...queue, card]
        setQueue(nextQueue)
      }

      if (index + 1 >= nextQueue.length) {
        setStage('done')
        onFinished()
        void refreshStats()
      } else {
        setIndex(index + 1)
      }
    } catch (err) {
      notify(`保存复习记录失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const autoRating = (): 1 | 2 | 3 | 4 => {
    if (!result?.correct) return 1
    return Date.now() - startTs < 6000 ? 4 : 3
  }

  if (stage === 'loading') {
    return (
      <div className="page">
        <div className="empty">
          <Spinner />
          <div style={{ marginTop: 12 }}>正在整理今天的任务…</div>
        </div>
      </div>
    )
  }

  if (stage === 'overview') {
    const learnCount = plan?.learnItems.length ?? 0
    const reviewCount = plan?.reviewCards.length ?? 0
    const nothing = learnCount === 0 && reviewCount === 0
    return (
      <div className="page review-shell">
        <div className="page-head">
          <div>
            <h1 className="page-title">今日任务</h1>
            <div className="page-sub">先把新笔记学一遍，再复习到期的旧词。两部分都会计入 FSRS。</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void init()}>
            <RotateCcw size={14} /> 刷新
          </Button>
        </div>

        <div className="task-grid">
          <div className="panel task-card learn">
            <div className="task-num">{learnCount}</div>
            <div className="task-label">待学习的新词</div>
            <div className="hint" style={{ marginTop: 8 }}>
              来自最近导入、还没学过的笔记。每天最多 {settings.newPerDay} 个。
            </div>
          </div>
          <div className="panel task-card review">
            <div className="task-num">{reviewCount}</div>
            <div className="task-label">待复习的卡片</div>
            <div className="hint" style={{ marginTop: 8 }}>
              包含到期卡片和刚学完、处于学习步骤中的卡。
            </div>
          </div>
        </div>

        {nothing ? (
          <div className="panel" style={{ textAlign: 'center', padding: 40, marginTop: 14 }}>
            <div style={{ fontSize: 38 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>今天已经清空</div>
            <div className="muted" style={{ marginTop: 6 }}>
              {plan?.learnedToday ? `今天已学 ${plan.learnedToday} 个新词，` : ''}
              没有到期卡片。可以去导入新笔记，或者明天再来。
            </div>
            <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <Button variant="primary" onClick={() => navigate('import')}>
                去导入笔记 <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {learnCount > 0
                    ? `建议顺序：先学 ${learnCount} 个新词，再复习 ${reviewCount} 张卡`
                    : `今天没有新词，直接复习 ${reviewCount} 张卡`}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  预计用时约 {Math.max(1, Math.round((learnCount * 10 + reviewCount * 15) / 60))} 分钟
                  {plan?.learnedToday ? ` · 今天已学 ${plan.learnedToday} 个` : ''}
                </div>
              </div>
              <div className="row">
                {learnCount > 0 ? (
                  <Button variant="primary" size="lg" onClick={startLearn}>
                    开始学习 <ArrowRight size={16} />
                  </Button>
                ) : (
                  <Button variant="primary" size="lg" onClick={() => void startReview()} disabled={reviewCount === 0}>
                    开始复习 <ArrowRight size={16} />
                  </Button>
                )}
                {learnCount > 0 && reviewCount > 0 && (
                  <Button variant="ghost" onClick={() => void startReview()}>
                    跳过学习，直接复习
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (stage === 'learn' && learnItem) {
    return (
      <div className="page review-shell">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="row">
            <Badge tone="accent">学习新词</Badge>
            <span className="muted tiny">
              {learnIndex + 1} / {plan?.learnItems.length ?? 0}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setStage('overview')}>
            稍后再学
          </Button>
        </div>
        <Progress value={learnProgress} />

        <div className="flashcard learn-card" style={{ marginTop: 16 }}>
          <div className="flash-direction">
            <span>先看一遍，等会儿会测</span>
            <span className="spacer" />
            <AudioButton word={learnItem.headword} accent={settings.accent} />
          </div>
          <div className="flash-word">{learnItem.headword}</div>
          <div className="learn-phonetic">{displayPhonetic(learnPhoneticText)}</div>
          <div className="flash-pos">{learnItem.pos ?? ''}</div>
          <div className="learn-meanings">{learnItem.meanings.join('；')}</div>
          {learnItem.collocations.length > 0 && (
            <div className="colloc-block">
              <div className="colloc-label">固定搭配</div>
              <div className="colloc-list">
                {learnItem.collocations.map((c) => (
                  <span key={c} className="colloc">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
          {learnItem.examples?.slice(0, 2).map((ex, i) => (
            <div key={i} className="learn-example">
              {ex.en}
              {ex.zh ? <span className="muted"> — {ex.zh}</span> : ''}
            </div>
          ))}
          {learnItem.extra && <div className="hint" style={{ marginTop: 10 }}>{learnItem.extra}</div>}

          <div className="grade-row" style={{ marginTop: 28 }}>
            <Button size="lg" variant="ghost" onClick={() => void rateLearn(false)} disabled={learnBusy}>
              还不熟
            </Button>
            <Button size="lg" variant="primary" onClick={() => void rateLearn(true)} disabled={learnBusy}>
              {learnBusy ? <Spinner /> : '记住了'} <Check size={16} />
            </Button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            「还不熟」的词会排在复习队列前面；「记住了」按正常顺序。等会儿复习会测你。
          </div>
        </div>
      </div>
    )
  }

  if (stage === 'learnDone') {
    const total = learnStats.known + learnStats.again
    return (
      <div className="page review-shell">
        <div className="panel" style={{ textAlign: 'center', padding: 42 }}>
          <div style={{ fontSize: 40 }}>📖</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 10 }}>新词学习完成</div>
          <div className="muted" style={{ marginTop: 8 }}>
            这一轮学了 {total} 个词 · 掌握 {learnStats.known} 个 · 需加强 {learnStats.again} 个
          </div>
          <div className="muted tiny" style={{ marginTop: 6 }}>
            接下来用测验巩固一遍，刚才学过的词会优先出现。
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <Button
              variant="primary"
              size="lg"
              onClick={() => void startReview()}
              disabled={(plan?.reviewCards.length ?? 0) === 0}
            >
              开始复习（{plan?.reviewCards.length ?? 0} 张） <ArrowRight size={16} />
            </Button>
            <Button variant="ghost" onClick={() => setStage('overview')}>
              回到今日任务
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (stage === 'done') {
    const accuracy = stats.total ? stats.correct / stats.total : 0
    return (
      <div className="page review-shell">
        <div className="panel" style={{ textAlign: 'center', padding: 42 }}>
          <div style={{ fontSize: 40 }}>{accuracy >= 0.8 ? '🎉' : '💪'}</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 10 }}>
            {examId ? '这一轮冲刺完成' : '今天的任务完成了'}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {stats.total ? `复习 ${stats.total} 张，正确 ${stats.correct} 张，正确率 ${Math.round(accuracy * 100)}%` : '今天没有需要复习的卡片'}
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 22 }}>
            {!examId && (
              <Button onClick={() => void init()}>
                <RotateCcw size={15} /> 回到今日任务
              </Button>
            )}
            <Button variant="primary" onClick={() => navigate('library')}>
              去笔记库 <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!card) {
    return (
      <div className="page">
        <Empty icon="✅" title="没有需要处理的卡片" />
      </div>
    )
  }

  const item = card.item
  const isEn2Zh = card.direction === 'en2zh'
  const isListen = card.direction === 'listen2en'

  return (
    <div className="page review-shell">
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="row">
          <Badge tone={mode === 'exam' ? 'yellow' : 'accent'}>{mode === 'exam' ? '听写冲刺' : '复习旧词'}</Badge>
          <span className="muted tiny">
            {index + 1} / {queue.length}
          </span>
        </div>
        <div className="row tiny muted">
          <span>
            正确 {stats.correct} / {stats.total}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void (examId ? init() : startReview())}>
            重新排队
          </Button>
        </div>
      </div>
      <Progress value={progress} />

      <div className="flashcard" style={{ marginTop: 16 }}>
        <div className="flash-direction">
          <span>{DIRECTION_LABEL[card.direction]}</span>
          <span className="spacer" />
          <Button
            variant={phoneticHint && item.phonetic ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => void togglePhoneticHint()}
            disabled={phoneticBusy}
            title={
              item.phonetic
                ? '音标只作为区分同义词的提示，不影响 FSRS 评分'
                : '点击联网查询音标；音标只作提示，不影响 FSRS 评分'
            }
          >
            {phoneticBusy ? <Spinner /> : phoneticHint && item.phonetic ? <EyeOff size={14} /> : <Eye size={14} />}
            {phoneticBusy ? '查询中…' : phoneticHint && item.phonetic ? '隐藏音标' : '音标提示'}
          </Button>
          <AudioButton word={item.headword} accent={settings.accent} />
        </div>

        {isEn2Zh ? (
          <>
            <div className="flash-word">{item.headword}</div>
            <div className="flash-pos">{item.pos ?? ''}</div>
          </>
        ) : isListen ? (
          <>
            <div className="flash-meaning" style={{ fontSize: 22, color: 'var(--muted)' }}>
              听发音，写出对应的英文单词
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => void playWord(item.headword, settings.accent)}>
                <Volume2 size={15} /> 再听一遍
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setHint((h) => !h)}>
                {hint ? '隐藏提示' : '提示：词性 + 中文'}
              </Button>
            </div>
            {hint && (
              <div className="flash-answer" style={{ marginTop: 12 }}>
                {item.pos && (
                  <div className="flash-pos" style={{ marginBottom: 4 }}>
                    {item.pos}
                  </div>
                )}
                <div style={{ fontSize: 18 }}>{item.meanings.join('；')}</div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flash-meaning">{item.meanings.join('；')}</div>
            <div className="flash-pos">{item.pos ?? ''}</div>
          </>
        )}

        {phoneticHint && item.phonetic && (
          <div className="flash-phonetic">
            {displayPhonetic(item.phonetic)}
            <span>仅提示，不影响评分</span>
          </div>
        )}

        {!revealed ? (
          <>
            <div className="answer-input">
              <input
                ref={inputRef}
                className="input"
                value={answer}
                placeholder={isEn2Zh ? '写下中文意思，回车提交' : '写下英文，回车提交'}
                onChange={(e) => setAnswer(e.target.value)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !composing.current) {
                    e.preventDefault()
                    void submitAnswer()
                  }
                }}
                disabled={busy}
                autoFocus
              />
              <Button variant="primary" onClick={() => void submitAnswer()} disabled={busy}>
                {busy ? <Spinner /> : '提交'}
              </Button>
            </div>
            <div className="hint" style={{ marginTop: 10 }}>
              想不起来可以输入「不知道」或「XXX」，直接记为不会，不再判分。
            </div>
          </>
        ) : (
          <>
            <div className="flash-answer">
              <div className="en">{item.headword}</div>
              <div className="flash-pos">{item.pos ?? ''}</div>
              <div style={{ marginTop: 4 }}>{item.meanings.join('；')}</div>
              {item.collocations.length > 0 && (
                <div className="colloc-block">
                  <div className="colloc-label">固定搭配</div>
                  <div className="colloc-list">
                    {item.collocations.map((c) => (
                      <span key={c} className="colloc">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {item.examples?.slice(0, 2).map((ex, i) => (
                <div key={i} className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                  {ex.en}
                  {ex.zh ? ` — ${ex.zh}` : ''}
                </div>
              ))}
            </div>

            {result && (
              <div
                className={cls(
                  'feedback',
                  result.correct ? 'ok' : result.alternative || result.uncertain ? 'warn' : 'bad'
                )}
              >
                <div className="row" style={{ gap: 6 }}>
                  {result.correct ? <Check size={16} /> : result.alternative || result.uncertain ? '?' : <X size={16} />}
                  <strong>
                    {result.correct
                      ? '正确'
                      : result.alternative
                        ? '这个意思也对'
                        : result.uncertain
                          ? '需要你确认'
                          : '不正确'}
                  </strong>
                  {result.source === 'ai' && <Badge tone="accent">AI 判定</Badge>}
                  {result.alternative && <Badge tone="yellow">跳出舒适圈</Badge>}
                </div>
                {result.reason && <div style={{ marginTop: 4 }}>{result.reason}</div>}
                {result.alternative && (
                  <div className="hint" style={{ marginTop: 6 }}>
                    本词条记的是「{item.meanings.join('；')}」。你答的是这个词的另一个义项，
                    建议补充到词条里，别只停在熟悉的意思上。
                  </div>
                )}
                {!result.correct && !result.uncertain && answer && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    你的答案：{answer}
                  </div>
                )}
              </div>
            )}

            <div className="grade-row">
              {result?.alternative ? (
                <>
                  <Button variant="primary" onClick={() => void finishCard(2, true, result.source)} disabled={busy}>
                    意思对，继续（Hard）
                  </Button>
                  <Button onClick={() => void finishCard(1, false, result.source)} disabled={busy}>
                    算错（Again）
                  </Button>
                </>
              ) : result?.uncertain ? (
                <>
                  <Button variant="primary" onClick={() => void finishCard(3, true, 'manual')} disabled={busy}>
                    算对（Good）
                  </Button>
                  <Button onClick={() => void finishCard(1, false, 'manual')} disabled={busy}>
                    算错（Again）
                  </Button>
                </>
              ) : result?.correct ? (
                <>
                  <Button variant="primary" onClick={() => void finishCard(autoRating(), true, result.source)} disabled={busy}>
                    下一张 <ArrowRight size={15} />
                  </Button>
                  <Button size="sm" onClick={() => void finishCard(2, true, result.source)} disabled={busy}>
                    有点难（Hard）
                  </Button>
                  <Button size="sm" onClick={() => void finishCard(4, true, result.source)} disabled={busy}>
                    很简单（Easy）
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => void finishCard(1, false, result?.source ?? 'exact')} disabled={busy}>
                  下一张 <ArrowRight size={15} />
                </Button>
              )}
              <span className="spacer" />
              <span className="hint" style={{ alignSelf: 'center' }}>
                用时 {Math.round((Date.now() - startTs) / 1000)}s
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
