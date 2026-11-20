import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
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

/** 列表挂到 body 上，用 fixed 定位：不受弹窗 overflow / 滚动容器裁剪 */
interface ListLayout {
  top: number
  left: number | 'auto'
  right: number | 'auto'
  minWidth: number
  maxWidth: number
  maxHeight: number
}

const GAP = 4
const EDGE = 8

/**
 * 自定义下拉：原生 <select> 的弹出层是系统样式（方角、无法用 CSS 改），
 * 这里用按钮 + 圆角列表代替，保证"关着"和"打开"都有圆角。
 *
 * 列表用 portal 渲染到 body：弹窗的 .modal-body 是 overflow:auto，
 * 列表留在里面会被裁掉（上弹也不行）；portal + fixed 后按视口算空间，
 * 只有真的放不下才向上翻，且一定完整可见（超高时列表内部滚动）。
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
  const [layout, setLayout] = useState<ListLayout | null>(null)
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value)

  const firstEnabled = options.findIndex((option) => !option.disabled)

  const openList = () => {
    if (disabled || !options.length) return
    const index = options.findIndex((option) => option.value === value)
    setHighlight(index >= 0 ? index : Math.max(0, firstEnabled))
    setOpen(true)
  }

  /** 按视口可用空间定位；列表高度用 scrollHeight（不受 max-height 影响） */
  const reposition = useCallback(() => {
    const btn = btnRef.current
    const list = listRef.current
    if (!btn || !list) return
    const rect = btn.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    if (rect.bottom < 0 || rect.top > vh) {
      setOpen(false)
      return
    }
    const natural = list.scrollHeight + 1
    const below = vh - rect.bottom - GAP - EDGE
    const above = rect.top - GAP - EDGE
    // 下方放不下、且上方更宽裕时才向上；否则一律向下
    const up = natural > below && above > below
    const avail = Math.max(120, up ? above : below)
    const height = Math.min(natural, avail, 280)
    const top = up ? Math.max(EDGE, rect.top - GAP - height) : rect.bottom + GAP
    // 靠右的触发器改为右对齐，避免列表长出屏幕
    const anchorRight = rect.left > vw / 2
    const room = anchorRight ? rect.right - EDGE : vw - rect.left - EDGE
    const next: ListLayout = {
      top: Math.round(top),
      left: anchorRight ? 'auto' : Math.round(rect.left),
      right: anchorRight ? Math.round(vw - rect.right) : 'auto',
      minWidth: Math.round(rect.width),
      maxWidth: Math.max(Math.round(rect.width), Math.min(360, Math.round(room))),
      maxHeight: Math.ceil(height)
    }
    setLayout((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.right === next.right &&
      prev.minWidth === next.minWidth &&
      prev.maxWidth === next.maxWidth &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next
    )
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null)
      return
    }
    // 第一次打开：列表刚挂载，量完真实高度再显示（layout effect 在绘制前跑，不会闪）
    reposition()
  }, [open, options.length, reposition])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrapRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onScroll = () => reposition()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, reposition])

  // 键盘移动时把高亮项滚进可见区域（列表超高时内部滚动）
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[highlight] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight])

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
    <div className="select-wrap" ref={wrapRef} style={width !== undefined ? { width } : undefined}>
      <button
        ref={btnRef}
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

      {open &&
        createPortal(
          <div
            ref={listRef}
            className="combo-list select-list select-portal"
            role="listbox"
            style={{
              top: layout?.top ?? -9999,
              left: layout?.left ?? 'auto',
              right: layout?.right ?? 'auto',
              minWidth: layout?.minWidth,
              maxWidth: layout?.maxWidth,
              maxHeight: layout?.maxHeight,
              visibility: layout ? 'visible' : 'hidden'
            }}
          >
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
          </div>,
          document.body
        )}
    </div>
  )
}
