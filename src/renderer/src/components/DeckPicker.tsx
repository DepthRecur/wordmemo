import type { CSSProperties } from 'react'
import type { Deck } from '@shared/types'
import { Select, type SelectOption } from './Select'
import { cls } from '../lib/utils'

interface DeckTabsProps {
  decks: Deck[]
  /** null = 全部库（只有笔记库会出现） */
  value: number | null
  onChange: (id: number | null) => void
  /** 每个标签后面是否显示「待学 N · 到期 M」 */
  counts?: boolean
  /** 「全部库」标签上显示的总数 */
  totalNotes?: number
}

/**
 * 库标签栏（PLAN-DECKS §7.2）。今日任务页只用它来切库，
 * 不提供「全部库」——那正是 3500 词淹没队列的老问题。
 */
export function DeckTabs({ decks, value, onChange, counts = true, totalNotes }: DeckTabsProps) {
  return (
    <div className="deck-tabs">
      {decks.map((deck) => (
        <button
          key={deck.id}
          className={cls('deck-tab', value === deck.id && 'active')}
          onClick={() => onChange(deck.id)}
          title={
            counts
              ? `${deck.name}：${deck.noteCount} 份笔记 · 待学 ${deck.todayNew} · 到期 ${deck.dueCount}`
              : deck.name
          }
        >
          <span className="deck-name">{deck.name}</span>
          {counts && (
            <span className="deck-meta">
              待学 {deck.todayNew} · 到期 {deck.dueCount}
            </span>
          )}
        </button>
      ))}
      {totalNotes !== undefined && (
        <button
          className={cls('deck-tab', value === null && 'active')}
          onClick={() => onChange(null)}
          title="全部库：只用于浏览与统计，不作为学习范围"
        >
          <span className="deck-name">全部</span>
          <span className="deck-meta">{totalNotes} 份笔记</span>
        </button>
      )}
    </div>
  )
}

interface DeckSelectProps {
  decks: Deck[]
  value: number | null
  onChange: (id: number | null) => void
  /** 带「全部库」选项（统计页/考试范围用） */
  includeAll?: boolean
  allLabel?: string
  disabled?: boolean
  width?: number | string
  style?: CSSProperties
}

/** 下拉版：导入 / 考试范围 / 统计过滤用，空间紧张的地方优先选它 */
export function DeckSelect({
  decks,
  value,
  onChange,
  includeAll = false,
  allLabel = '全部库',
  disabled,
  width,
  style
}: DeckSelectProps) {
  const options: SelectOption[] = []
  if (includeAll) options.push({ value: 'all', label: allLabel })
  for (const deck of decks) {
    options.push({
      value: String(deck.id),
      label: deck.name,
      hint: `${deck.noteCount} 份笔记 · 待学 ${deck.todayNew} · 到期 ${deck.dueCount}`
    })
  }
  return (
    <Select
      value={value === null ? 'all' : String(value)}
      options={options}
      onChange={(next) => onChange(next === 'all' ? null : Number(next))}
      disabled={disabled}
      width={width}
      style={style}
    />
  )
}
