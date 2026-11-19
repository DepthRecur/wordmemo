import { useCallback, useEffect, useState } from 'react'
import type { DashboardStats, Deck } from '@shared/types'
import { DeckSelect } from '../components/DeckPicker'
import { Button, Progress, Spinner } from '../components/UI'
import { formatDate, pct, weekdayCN } from '../lib/utils'

const HEAT_COLORS = ['#2a3648', '#145c46', '#1f8a63', '#35c98a', '#9af0c9']

interface Props {
  stats: DashboardStats | null
  onRefresh: () => Promise<void>
  decks: Deck[]
  deckId: number | null
}

export default function StatsPage({ stats: initialStats, onRefresh, decks, deckId }: Props) {
  // 统计页可以单独看某个库（含「全部库」），和「当前库」是两件事
  const [filter, setFilter] = useState<number | null>(deckId)
  const [data, setData] = useState<DashboardStats | null>(initialStats)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (id: number | null) => {
    setLoading(true)
    try {
      setData(await window.api.stats.dashboard(id))
    } catch {
      /* 失败保留上一次的数据 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setFilter(deckId)
  }, [deckId])

  useEffect(() => {
    void load(filter)
  }, [filter, load])

  // App 每 60 秒刷新当前库的统计；只看当前库时跟着它走，不用自己再拉
  useEffect(() => {
    if (filter === deckId && initialStats) setData(initialStats)
  }, [initialStats, deckId, filter])

  const stats = data

  if (!stats) {
    return (
      <div className="page">
        <div className="empty">
          <Spinner />
        </div>
      </div>
    )
  }

  const maxForecast = Math.max(1, ...stats.forecast.map((f) => f.count))
  const maxHeat = Math.max(1, ...stats.heatmap.map((h) => h.count))
  const weeks: typeof stats.heatmap[] = []
  for (let i = 0; i < stats.heatmap.length; i += 7) weeks.push(stats.heatmap.slice(i, i + 7))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">学习统计</h1>
          <div className="page-sub">复习量、记忆保持率和未来到期的分布。</div>
        </div>
        <div className="page-actions">
          <div className="row" style={{ gap: 6 }}>
            <span className="hint">统计范围</span>
            <DeckSelect
              decks={decks}
              value={filter}
              includeAll
              onChange={(id) => setFilter(id)}
              style={{ width: 150 }}
            />
          </div>
          <Button
            onClick={() => {
              void load(filter)
              if (filter === deckId) void onRefresh()
            }}
          >
            刷新
          </Button>
        </div>
      </div>

      <div className="page-scroll">
        <div className="hint" style={{ marginBottom: 10 }}>
          数量类指标按「{filter === null ? '全部库' : (decks.find((d) => d.id === filter)?.name ?? '当前库')}」统计；
          热力图、连续天数和正确率跨库合并，跨库学习也算连续。
        </div>
        <div className="grid grid-4">
        <div className="stat">
          <div className="stat-value stat-accent">{stats.dueToday}</div>
          <div className="stat-label">今天到期</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.reviewedToday}</div>
          <div className="stat-label">今天已复习</div>
        </div>
        <div className="stat">
          <div className="stat-value stat-green">{stats.streak}</div>
          <div className="stat-label">连续复习天数</div>
        </div>
        <div className="stat">
          <div className="stat-value stat-yellow">
            {stats.retention30d === null ? '—' : pct(stats.retention30d)}
          </div>
          <div className="stat-label">近 30 天正确率</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', marginTop: 14 }}>
        <div className="panel">
          <div className="panel-title">未来 30 天到期预测</div>
          <div className="bars">
            {stats.forecast.map((f) => (
              <div
                key={f.date}
                className="bar"
                style={{ height: `${Math.max(2, (f.count / maxForecast) * 100)}%` }}
                title={`${f.date}：${f.count} 张`}
              />
            ))}
          </div>
          <div className="row-between tiny muted" style={{ marginTop: 8 }}>
            <span>{stats.forecast[0]?.date.slice(5)}</span>
            <span>{stats.forecast[stats.forecast.length - 1]?.date.slice(5)}</span>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            柱子越高，那天到期的卡片越多。如果某天特别高，可以提前在「今日任务」里消化一部分。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">词库概况</div>
          <div className="col" style={{ gap: 10 }}>
            <div className="row-between">
              <span className="muted">笔记</span>
              <strong>{stats.totalNotes}</strong>
            </div>
            <div className="row-between">
              <span className="muted">词条</span>
              <strong>{stats.totalItems}</strong>
            </div>
            <div className="row-between">
              <span className="muted">累计复习</span>
              <strong>{stats.totalReviews}</strong>
            </div>
            <div className="row-between">
              <span className="muted">本月 AI 花费</span>
              <strong>${stats.aiCostMonth.toFixed(4)}</strong>
            </div>
            <div className="row-between">
              <span className="muted">本月 AI 调用</span>
              <strong>{stats.aiCallsMonth}</strong>
            </div>
            {stats.aiByProvider.length > 0 && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                {stats.aiByProvider.map((row) => (
                  <div key={row.provider} className="row-between tiny" style={{ marginTop: 2 }}>
                    <span className="muted">{row.label}</span>
                    <span>
                      {row.calls} 次 · ${row.cost.toFixed(4)}
                    </span>
                  </div>
                ))}
                {stats.aiUnpricedCalls > 0 && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    另有 {stats.aiUnpricedCalls} 次调用的模型没有价格，只统计了 token（费用未知）。
                  </div>
                )}
                <div className="hint" style={{ marginTop: 4 }}>
                  金额按公开价格估算，实际账单可能略有出入。
                </div>
              </div>
            )}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="row-between tiny muted" style={{ marginBottom: 6 }}>
              <span>今日进度</span>
              <span>
                {stats.reviewedToday} / {stats.reviewedToday + stats.dueToday}
              </span>
            </div>
            <Progress
              value={
                stats.reviewedToday + stats.dueToday > 0
                  ? stats.reviewedToday / (stats.reviewedToday + stats.dueToday)
                  : 0
              }
            />
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', marginTop: 14 }}>
        <div className="panel">
          <div className="panel-title">复习热力图（近 12 周）</div>
          <div className="heatmap-wrap">
            <div className="heat-weekdays" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="heatmap">
              {weeks.flatMap((week) =>
                week.map((cell) => {
                  const level =
                    cell.count === 0 ? 0 : Math.min(4, Math.ceil((cell.count / maxHeat) * 4))
                  return (
                    <div
                      key={cell.date}
                      className="heat-cell"
                      style={{ background: HEAT_COLORS[level] }}
                      title={`${cell.date} 周${weekdayCN(cell.date)}：${cell.count} 次`}
                    />
                  )
                })
              )}
            </div>
          </div>
          <div className="heat-legend">
            <span>少</span>
            {HEAT_COLORS.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
            <span>多</span>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            最近一次复习：{stats.heatmap.filter((h) => h.count > 0).slice(-1)[0]?.date ?? '还没有记录'}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">难词榜</div>
          {stats.difficult.length === 0 ? (
            <div className="muted tiny">还没有反复遗忘的词，继续保持。</div>
          ) : (
            <table className="table">
              <tbody>
                {stats.difficult.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.headword}</strong>
                      <div className="tiny muted">{d.meanings.join('；')}</div>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--yellow)' }}>忘 {d.lapses} 次</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-title">最近记录</div>
        <div className="hint">
          数据最后更新于 {formatDate(new Date().toISOString())}。所有记录都保存在本机，可在设置页备份。
        </div>
      </div>
      </div>
    </div>
  )
}
