import React from 'react'
import { X } from 'lucide-react'
import { cls } from '../lib/utils'

export function Button({
  variant = 'default',
  size,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'lg'
}) {
  return (
    <button
      className={cls(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        size === 'lg' && 'btn-lg',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export function Badge({
  tone = 'default',
  children,
  title
}: {
  tone?: 'default' | 'green' | 'yellow' | 'red' | 'accent'
  children: React.ReactNode
  title?: string
}) {
  return (
    <span className={cls('badge', tone !== 'default' && `badge-${tone}`)} title={title}>
      {children}
    </span>
  )
}

export function Progress({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div className="progress">
      <span style={{ width: `${v * 100}%` }} />
    </div>
  )
}

export function Spinner() {
  return <span className="spinner" />
}

export function Empty({
  icon = '📭',
  title,
  desc,
  action
}: {
  icon?: string
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {desc && <div style={{ marginTop: 6 }}>{desc}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width
}: {
  open: boolean
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          <div style={{ fontWeight: 600 }}>{title}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  style
}: {
  label: string
  hint?: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <label className="field" style={style}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: 'pointer',
        padding: '6px 0'
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, accentColor: '#6c8cff', width: 16, height: 16 }}
      />
      <span>
        <span style={{ fontSize: 13 }}>{label}</span>
        {hint && <span className="hint" style={{ display: 'block' }}>{hint}</span>}
      </span>
    </label>
  )
}
