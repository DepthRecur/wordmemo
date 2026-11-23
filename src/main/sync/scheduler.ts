/**
 * 同步调度（PLAN-SYNC §3.8）：启动拉一次、写后 debounce 30 秒、定时同步、
 * 失败退避 1→5→15→60 分钟，所有自动触发加 ±20% 抖动，两次自动推送至少隔 60 秒。
 *
 * 定时器、时钟与随机数都可注入，测试里用假定时器驱动，不真等。
 * `intervalMin = 0` = 只手动（启动那次仍会拉一次；写操作不会自动推）。
 */

export interface SyncSchedulerOptions {
  /** 分钟；0 = 只手动 */
  intervalMin: number
  /** 执行一次同步；true = 成功 */
  run: () => Promise<boolean>
  /** 任何状态变化（开始/结束/失败计数）都会调它；manager 用它广播 */
  onChange?: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
  random?: () => number
}

const DEBOUNCE_MS = 30_000
const MIN_GAP_MS = 60_000
const STARTUP_DELAY_MS = 60_000
const BACKOFF_MINUTES = [1, 5, 15, 60]

export class SyncScheduler {
  private readonly intervalMin: number
  private readonly run: () => Promise<boolean>
  private readonly onChange: () => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly now: () => number
  private readonly random: () => number

  private timer: unknown = null
  private running = false
  private disposed = false
  private failures = 0
  private lastRunAt = 0

  constructor(options: SyncSchedulerOptions) {
    this.intervalMin = Math.max(0, Math.trunc(options.intervalMin))
    this.run = options.run
    this.onChange = options.onChange ?? (() => undefined)
    this.setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number)
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  get isRunning(): boolean {
    return this.running
  }

  get failureCount(): number {
    return this.failures
  }

  get lastRunTime(): number {
    return this.lastRunAt
  }

  /** 启动：60 秒（±20%）后先拉一次；之后按 intervalMin 走 */
  start(): void {
    if (this.disposed) return
    this.scheduleJittered(STARTUP_DELAY_MS)
  }

  /** 本地有写入：debounce 30 秒；与上次自动同步至少隔 60 秒 */
  markDirty(): void {
    if (this.disposed || this.running || this.intervalMin <= 0) return
    const sinceLast = this.now() - this.lastRunAt
    const delay = Math.max(DEBOUNCE_MS, MIN_GAP_MS - sinceLast)
    this.clear()
    this.timer = this.setTimer(() => void this.tick(), delay)
  }

  /** 手动「立即同步」：不受抖动/最小间隔限制 */
  async runNow(): Promise<void> {
    if (this.disposed) return
    this.clear()
    await this.tick()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  /** 按状态重新计时：成功后按间隔，失败按退避 */
  private reschedule(ok: boolean): void {
    if (this.disposed || this.intervalMin <= 0) return
    if (ok) {
      this.scheduleJittered(this.intervalMin * 60_000)
      return
    }
    const index = Math.min(this.failures, BACKOFF_MINUTES.length) - 1
    this.scheduleJittered(BACKOFF_MINUTES[Math.max(0, index)] * 60_000)
  }

  private scheduleJittered(baseMs: number): void {
    this.clear()
    const factor = 0.8 + 0.4 * this.random()
    this.timer = this.setTimer(() => void this.tick(), Math.round(baseMs * factor))
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.disposed || this.running) return
    this.running = true
    this.onChange()
    let ok = false
    try {
      ok = await this.run()
    } catch {
      ok = false
    } finally {
      this.running = false
    }
    this.lastRunAt = this.now()
    this.failures = ok ? 0 : this.failures + 1
    this.onChange()
    this.reschedule(ok)
  }

  private clear(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }
}
