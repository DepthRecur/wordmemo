import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { cls } from '../lib/utils'

export interface SelectOption {
  value: string
  label: string
  /** 第二行小字：库计数、模型 id 之类 */
  hint?: string
  disabled?: boolean
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  width?: number | string
  style?: CSSProperties
  title?: string
}

/**
 * 自定义下拉：原生 <select> 的弹出层是系统样式（方角、无法用 CSS 改），
 * 这里用按钮 + 圆角列表代替，保证"关着"和"打开"都有圆角。
 *
 * 键盘：↑↓ 移动、Enter/Space 选中、Esc 关闭；点外面关闭。
 */
export function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  width,
  style,
  title
}: Props) {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value)

  const firstEnabled = options.findIndex((option) => !option.disabled)

  const openList = () => {
    if (disabled || !options.length) return
    const index = options.findIndex((option) => option.value === value)
    setHighlight(index >= 0 ? index : Math.max(0, firstEnabled))
    // 下方空间不够就往上弹，避免被 page-scroll / modal-body 裁掉
    const box = boxRef.current?.getBoundingClientRect()
    const container = boxRef.current?.closest('.page-scroll, .modal-body') as HTMLElement | null
    const bottom = container?.getBoundingClientRect().bottom ?? window.innerHeight
    setDropUp(Boolean(box) && bottom - box!.bottom < 240)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const move = (step: 1 | -1) => {
    if (!options.length) return
    let index = highlight
    for (let i = 0; i < options.length; i++) {
      index = (index + step + options.length) % options.length
      if (!options[index].disabled) break
    }
    setHighlight(index)
  }

  const choose = (option: SelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openList()
        return
      }
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) openList()
      else if (options[highlight]) choose(options[highlight])
    } else if (event.key === 'Escape') {
      setOpen(false)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="select-wrap" ref={boxRef} style={width !== undefined ? { width } : undefined}>
      <button
        type="button"
        className={cls('select', 'select-btn', open && 'open')}
        style={style}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={cls('select-value', !current && 'select-placeholder')}>
          {current?.label ?? placeholder ?? '请选择'}
        </span>
        <ChevronDown size={14} className="select-arrow" />
      </button>

      {open && (
        <div className={cls('combo-list', 'select-list', dropUp && 'drop-up')} role="listbox">
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              className={cls(
                'combo-item',
                index === highlight && 'active',
                option.value === value && 'selected',
                option.disabled && 'disabled'
              )}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span className="combo-main">
                <span className="combo-name">{option.label}</span>
                {option.hint && <span className="combo-id">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
