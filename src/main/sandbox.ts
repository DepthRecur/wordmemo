/**
 * U1 兼容模式（PLAN-UPDATE §11.2 / §3.3）。
 *
 * `userData/sandbox-state.json` 同时被 Electron 主进程和便携版启动器读写：
 * - 启动器在拉起 app 之前判断 `compatMode`，只在为 true 时传 `--no-sandbox`；
 * - 启动器也负责给「连 JS 都没起来」的启动写 probe / 计失败（source = 'launcher'）；
 * - 主进程在 `app.whenReady()` 之前读同一个文件，用 `appendSwitch` 兜底（直接双击 app 的入口）。
 *
 * 失败判定（只在能确认「上次进程已不在、且是刚启动就没了」时计一次）：
 *   probe.ok === false
 *   && probe.pid > 0 && 进程不存在
 *   && probe.startedAt 距今 >= 0 且 < 30 秒
 *   && probe 比 lastReadyAt 新（防止启动器在应用已经 ready 之后才写 probe 的竞态）
 * 连续 3 次才把 compatMode 置 true。
 *
 * 启动器写的 probe（source=launcher）由启动器自己结算；主进程看到它会直接跳过，
 * 避免「启动器还没退出、app 已经在跑」时把同一次启动重复算成失败。
 *
 * 注意：这里故意不 import electron，所有目录由调用方传入，单测可以直接用临时目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SandboxInfo } from '@shared/types'

export const SANDBOX_STATE_FILE = 'sandbox-state.json'
/** 只统计「启动后 30 秒内就没了」的进程 */
export const PROBE_WINDOW_MS = 30_000
/** 连续失败多少次才自动切兼容模式 */
export const MAX_FAIL_STREAK = 3

export interface SandboxProbe {
  pid: number
  startedAt: string
  ok: boolean
  /** 谁写的：启动器的 probe 由启动器自己算账，主进程不要重复计数 */
  source: 'app' | 'launcher'
}

export interface SandboxState {
  compatMode: boolean
  failStreak: number
  probe: SandboxProbe | null
  /** 由自动探测开启（而不是用户在设置里手动打开） */
  autoEnabled: boolean
  /** 自动降级的提示已经展示过 */
  noticeSeen: boolean
  /** 最近一次 ready-to-show；用来忽略「应用已经启动成功后启动器才写的 probe」 */
  lastReadyAt: string | null
}

export interface SandboxDecision {
  state: SandboxState
  changed: boolean
  justEnabled: boolean
}

export function defaultSandboxState(): SandboxState {
  return {
    compatMode: false,
    failStreak: 0,
    probe: null,
    autoEnabled: false,
    noticeSeen: false,
    lastReadyAt: null
  }
}

export function sandboxStatePath(dir: string): string {
  return path.join(dir, SANDBOX_STATE_FILE)
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function parseProbe(raw: unknown): SandboxProbe | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { pid?: unknown; startedAt?: unknown; ok?: unknown; source?: unknown }
  const pid = Number(value.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  const at = parseDate(value.startedAt)
  if (at === null) return null
  return {
    pid,
    startedAt: new Date(at).toISOString(),
    ok: value.ok === true,
    // 老状态没有 source，按主进程写的 probe 处理
    source: value.source === 'launcher' ? 'launcher' : 'app'
  }
}

/** 文件不存在、空文件、坏 JSON、字段类型不对 → 全部按默认值处理 */
export function parseSandboxState(raw: unknown): SandboxState {
  if (!raw || typeof raw !== 'object') return defaultSandboxState()
  const value = raw as Record<string, unknown>
  const failStreak = Math.max(0, Math.trunc(Number(value.failStreak) || 0))
  return {
    compatMode: value.compatMode === true,
    failStreak,
    probe: parseProbe(value.probe),
    autoEnabled: value.autoEnabled === true,
    noticeSeen: value.noticeSeen === true,
    lastReadyAt: parseDate(value.lastReadyAt) !== null ? new Date(parseDate(value.lastReadyAt)!).toISOString() : null
  }
}

export function readSandboxState(dir: string): SandboxState {
  try {
    const file = sandboxStatePath(dir)
    if (!fs.existsSync(file)) return defaultSandboxState()
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return defaultSandboxState()
    return parseSandboxState(JSON.parse(text))
  } catch {
    return defaultSandboxState()
  }
}

/** tmp + rename；目录不可写时静默失败，绝不让启动流程因为状态文件挂掉 */
export function writeSandboxState(dir: string, state: SandboxState): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = sandboxStatePath(dir)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 只影响兼容模式判定，不影响应用 */
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // Windows 上「存在但无权限」可能报 EPERM，仍然算活着
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 纯判定：给定上次状态、当前时间、上次 probe 的 pid 是否还活着，返回新状态。
 * 不读写文件，单测直接调这个。
 */
export function decideSandboxState(
  prev: SandboxState,
  opts: { now: number; pidAlive: boolean }
): SandboxDecision {
  const next: SandboxState = {
    ...prev,
    probe: prev.probe ? { ...prev.probe } : null
  }
  let changed = false

  // 已经开启兼容模式：不再累计失败；如果看到一次成功 probe，顺手清掉
  if (next.compatMode) {
    if (next.probe?.ok) {
      next.probe = null
      if (next.failStreak !== 0) {
        next.failStreak = 0
      }
      changed = true
    }
    return { state: next, changed, justEnabled: false }
  }

  const probe = next.probe
  if (!probe) return { state: next, changed: false, justEnabled: false }

  if (probe.ok) {
    next.probe = null
    if (next.failStreak !== 0) next.failStreak = 0
    return { state: next, changed: true, justEnabled: false }
  }

  const started = parseDate(probe.startedAt)
  const age = started === null ? Number.NaN : opts.now - started
  const lastReady = parseDate(next.lastReadyAt)
  const inWindow = Number.isFinite(age) && age >= 0 && age < PROBE_WINDOW_MS
  const newerThanReady = lastReady === null || (started !== null && started > lastReady)

  if (!opts.pidAlive && inWindow && newerThanReady) {
    next.failStreak = prev.failStreak + 1
    next.probe = null
    changed = true
    if (next.failStreak >= MAX_FAIL_STREAK) {
      next.compatMode = true
      next.autoEnabled = true
      next.noticeSeen = false
      return { state: next, changed: true, justEnabled: true }
    }
  }
  return { state: next, changed, justEnabled: false }
}

export interface SandboxStartResult extends SandboxDecision {
  /** 本次读取到的状态（决定是否 appendSwitch） */
  state: SandboxState
}

/** 应用启动最早期调用：算一次失败、必要时打开 compatMode，并把结果写盘 */
export function evaluateSandboxOnStart(
  dir: string,
  opts: { now?: number; isPidAlive?: (pid: number) => boolean } = {}
): SandboxStartResult {
  const now = opts.now ?? Date.now()
  const prev = readSandboxState(dir)
  // 启动器写的 probe 由启动器在下次启动时自己结算；主进程现在忽略它，
  // 否则「启动器还没退出、app 已开始跑」时可能把同一次启动算成失败。
  if (prev.probe?.source === 'launcher') {
    return { state: prev, changed: false, justEnabled: false }
  }
  const pidAlive =
    prev.probe && prev.probe.pid > 0
      ? (opts.isPidAlive ?? isProcessAlive)(prev.probe.pid)
      : false
  const decision = decideSandboxState(prev, { now, pidAlive })
  if (decision.changed) writeSandboxState(dir, decision.state)
  return decision
}

/** 写本次启动的 probe（pid/startedAt/ok=false）；由主进程在单实例锁之后调用 */
export function beginProbe(dir: string, pid: number = process.pid, now: number = Date.now()): SandboxState {
  const next: SandboxState = {
    ...readSandboxState(dir),
    probe: { pid, startedAt: new Date(now).toISOString(), ok: false, source: 'app' }
  }
  writeSandboxState(dir, next)
  return next
}

/** 窗口 ready-to-show：成功启动，清零失败计数并清掉 probe */
export function markReady(dir: string, now: number = Date.now()): SandboxState {
  const next: SandboxState = {
    ...readSandboxState(dir),
    probe: null,
    failStreak: 0,
    lastReadyAt: new Date(now).toISOString()
  }
  writeSandboxState(dir, next)
  return next
}

export function shouldDisableSandbox(dir: string): boolean {
  return readSandboxState(dir).compatMode
}

export function sandboxInfo(dir: string): SandboxInfo {
  const state = readSandboxState(dir)
  return {
    compatMode: state.compatMode,
    failStreak: state.failStreak,
    maxFailStreak: MAX_FAIL_STREAK,
    autoEnabled: state.autoEnabled,
    probe: state.probe,
    noticePending: state.compatMode && state.autoEnabled && !state.noticeSeen
  }
}

/** 设置页开关 / 「重新检测」：写盘，下次启动生效 */
export function setCompatMode(dir: string, enabled: boolean, now: number = Date.now()): SandboxInfo {
  const next: SandboxState = {
    ...readSandboxState(dir),
    compatMode: enabled === true,
    failStreak: 0,
    probe: null,
    autoEnabled: false,
    noticeSeen: true,
    lastReadyAt: new Date(now).toISOString()
  }
  writeSandboxState(dir, next)
  return sandboxInfo(dir)
}

export function ackSandboxNotice(dir: string): SandboxInfo {
  const state = readSandboxState(dir)
  if (!state.noticeSeen) {
    state.noticeSeen = true
    writeSandboxState(dir, state)
  }
  return sandboxInfo(dir)
}
