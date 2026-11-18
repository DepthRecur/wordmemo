import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiModelInfo } from '@shared/types'
import { cls } from '../lib/utils'

interface Props {
  /** 真正写给 API 的模型名（也是输入框里的值） */
  value: string
  /** 候选：只来自该家 /models 目录，没拉过就是空 */
  models: AiModelInfo[]
  onChange: (id: string) => void
  placeholder?: string
  /** 目录为空时显示什么 */
  emptyHint?: string
}

function priceText(model: AiModelInfo): string {
  if (!model.priced || model.input == null || model.output == null) return '费用未知'
  return `≈$${model.input}/M 入 · $${model.output}/M 出`
}

/**
 * 模型选择：可搜索下拉 + 永远允许手填。
 *
 * - 输入框里的值就是最终写给 API 的 id；
 * - 下拉列表只来自 `/models`（这个 Key 真能用的那些），公开名放前面、id 放后面；
 * - 搜索同时匹配公开名和 id；键盘 ↑↓ / Enter / Esc。
 */
export function ModelPicker({ value, models, onChange, placeholder, emptyHint }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    )
  }, [models, query])

  const inCatalog = models.some((m) => m.id === value)

  const openList = () => {
    setOpen(true)
    setQuery('')
    // 打开时把高亮停在当前值上，避免手滑按 Enter 换成第一个
    const index = models.findIndex((m) => m.id === value)
    setHighlight(index > 0 ? index : 0)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (model: AiModelInfo) => {
    onChange(model.id)
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        openList()
        return
      }
      setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (event.key === 'Enter') {
      if (open && filtered[highlight]) {
        event.preventDefault()
        choose(filtered[highlight])
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="combo" ref={boxRef}>
      <div className="combo-row">
        <input
          ref={inputRef}
          className="input"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value)
            setQuery(event.target.value)
            if (!open) setOpen(true)
          }}
          onFocus={openList}
          onClick={() => {
            if (!open) openList()
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="选择模型"
          title="从目录里选"
          onClick={() => {
            if (open) setOpen(false)
            else {
              openList()
              inputRef.current?.focus()
            }
          }}
        >
          ▾
        </button>
      </div>

      {open && (
        <div className="combo-list" role="listbox">
          {value && !inCatalog && !query && (
            <div className="combo-item current">
              当前：<span className="mono">{value}</span>（不在目录里，可以直接手填）
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="combo-empty">
              {models.length
                ? '没有匹配的模型，可以直接用手填的名字'
                : (emptyHint ?? '目录里还没有模型：先配好 Key 再点「刷新目录」。')}
            </div>
          ) : (
            filtered.map((model, index) => (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={model.id === value}
                className={cls(
                  'combo-item',
                  index === highlight && 'active',
                  model.id === value && 'selected'
                )}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(model)}
              >
                <span className="combo-main">
                  <span className="combo-name">{model.name}</span>
                  <span className="combo-id mono">{model.id}</span>
                </span>
                <span className="combo-price">{priceText(model)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
