import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncScheduler } from '../src/main/sync/scheduler'

// S2 调度（PLAN-SYNC §3.8）：启动拉一次、写后 debounce 30s、定时、失败退避、抖动。
// 全部用假定时器，不真的等 10 分钟。

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-23T20:00:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SyncScheduler', () => {
  it('启动 60 秒后跑一次；成功后按 intervalMin 继续', async () => {
    const run = vi.fn().mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('连续写入合并成一次 debounce 30 秒；与上次同步至少隔 60 秒', async () => {
    const run = vi.fn().mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    scheduler.markDirty()
    scheduler.markDirty()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)

    // 刚同步完又改：要被 60 秒的最小间隔挡住，而不是 30 秒
    scheduler.markDirty()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('失败退避 1 → 5 → 15 → 60 分钟', async () => {
    const run = vi.fn().mockResolvedValue(false)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(run).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(5)
    // 封顶 60 分钟
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(6)
    scheduler.dispose()
  })

  it('成功后失败计数清零，回到正常间隔', async () => {
    const run = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(scheduler.failureCount).toBe(0)
    // 成功之后按 10 分钟，而不是继续按失败退避
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.dispose()
  })

  it('intervalMin = 0：自动只在启动时拉一次，写入不自动推，手动永远可用', async () => {
    const run = vi.fn().mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 0, run, random: () => 0.5 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.markDirty()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await scheduler.runNow()
    expect(run).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('±20% 抖动：random=0 时启动延迟 48 秒', async () => {
    const run = vi.fn().mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(47_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('dispose 之后不再触发；手动同步会先清掉定时器', async () => {
    const run = vi.fn().mockResolvedValue(true)
    const scheduler = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    scheduler.start()
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).not.toHaveBeenCalled()

    const second = new SyncScheduler({ intervalMin: 10, run, random: () => 0.5 })
    second.start()
    await second.runNow()
    expect(run).toHaveBeenCalledTimes(1)
    second.dispose()
  })
})
