import { describe, expect, it } from 'vitest'
import { QUOTA_PAUSE_THRESHOLD, quotaState } from '../src/main/sync/quota'

// D-02：额度 < 100 时暂停自动同步（PLAN-SYNC §7 的对策，之前只显示数字、没有降级）。

const NOW = Date.parse('2026-11-26T08:00:00')
const RESET_SEC = Math.floor(NOW / 1000) + 1800 // 半小时后（GitHub 给的是秒）

describe('额度降级判定', () => {
  it('额度充足：不暂停', () => {
    expect(quotaState(4000, RESET_SEC, NOW)).toEqual({ paused: false, resumeAt: null })
    expect(quotaState(QUOTA_PAUSE_THRESHOLD, RESET_SEC, NOW).paused).toBe(false)
  })

  it('额度低于阈值：暂停，并给出重置时间', () => {
    const state = quotaState(99, RESET_SEC, NOW)
    expect(state.paused).toBe(true)
    expect(state.resumeAt).toBe(RESET_SEC * 1000)
  })

  it('重置时间已过：自动恢复（不能一直拦着）', () => {
    const past = Math.floor(NOW / 1000) - 60
    expect(quotaState(10, past, NOW)).toEqual({ paused: false, resumeAt: null })
  })

  it('还没拿到过额度（null）：不暂停，避免误伤', () => {
    expect(quotaState(null, RESET_SEC, NOW)).toEqual({ paused: false, resumeAt: null })
    expect(quotaState(undefined, undefined, NOW)).toEqual({ paused: false, resumeAt: null })
  })

  it('兼容毫秒形式的重置时间', () => {
    const ms = NOW + 600_000
    expect(quotaState(5, ms, NOW)).toEqual({ paused: true, resumeAt: ms })
  })

  it('没有重置时间又额度不足：仍然暂停（宁可少同步，也别连续失败）', () => {
    expect(quotaState(5, null, NOW)).toEqual({ paused: true, resumeAt: null })
  })
})
