import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'unknown'

export interface TrayState {
  /** null = 还没检测完；false = 确认没创建成功 */
  ok: boolean | null
  reason: string | null
  bounds: { width: number; height: number } | null
}

/** 主进程模块加载时刻 = 本次启动时间（不是构建时间） */
export const startedAt = new Date().toISOString()

let integrity: IntegrityLevel | null = null
let trayState: TrayState = { ok: null, reason: null, bounds: null }

/**
 * 读取当前进程的完整性级别。
 * Windows 托盘属于 Explorer（Medium），Low 进程会被 UIPI 拒绝注册图标。
 */
export function getIntegrity(): IntegrityLevel {
  if (integrity) return integrity
  try {
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
    const out = execFileSync(whoami, ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    const match = out.match(/Mandatory Label\\(Low|Medium|High|System)/i)
    const level = match?.[1]?.toLowerCase()
    integrity =
      level === 'low' || level === 'medium' || level === 'high' || level === 'system'
        ? (level as IntegrityLevel)
        : 'unknown'
  } catch {
    integrity = 'unknown'
  }
  return integrity
}

export function setTrayState(state: TrayState): void {
  trayState = state
  log('tray-state', { ...state, integrity: getIntegrity() })
}

export function getTrayState(): TrayState {
  return trayState
}

export function getDiagnostics(): {
  startedAt: string
  integrity: IntegrityLevel
  tray: TrayState
  session: string | null
} {
  return {
    startedAt,
    integrity: getIntegrity(),
    tray: trayState,
    session: process.env.SESSIONNAME ?? null
  }
}

/** 追加写入 <userData>/diagnostics.log，方便出问题时直接看 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  try {
    const file = path.join(app.getPath('userData'), 'diagnostics.log')
    fs.appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`,
      'utf8'
    )
  } catch {
    /* ignore */
  }
}
