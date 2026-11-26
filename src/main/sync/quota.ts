/**
 * GitHub 额度降级（D-02）。
 *
 * PLAN-SYNC §7 的对策：「读 `X-RateLimit-Remaining`，< 100 时降到『只在用户手动时同步』」。
 * 这之前只把剩余额度显示在面板上，没有任何降级——额度用完后定时同步会连续失败，
 * 用户只看到一堆「同步失败」。
 *
 * 这里只做纯计算，方便单测；manager 负责在「自动同步」入口调用它。
 */

/** 低于这个数就暂停自动同步（GitHub 的 hourly quota，正常是 5000） */
export const QUOTA_PAUSE_THRESHOLD = 100

export interface QuotaState {
  /** 是否应该暂停「自动」同步（手动同步永远不受影响） */
  paused: boolean
  /** 额度重置时间（epoch ms）；null = 不知道 */
  resumeAt: number | null
}

/**
 * @param remaining 响应头里的剩余额度；null = 还没拿到过
 * @param resetAt   `x-ratelimit-reset`，GitHub 给的是 **epoch 秒**（也兼容毫秒）
 * @param now       当前时间（epoch ms），测试用来钉时间
 */
export function quotaState(
  remaining: number | null | undefined,
  resetAt: number | null | undefined,
  now: number
): QuotaState {
  const resumeAt = toEpochMs(resetAt)
  if (remaining === null || remaining === undefined) return { paused: false, resumeAt: null }
  if (!Number.isFinite(remaining) || remaining >= QUOTA_PAUSE_THRESHOLD) {
    return { paused: false, resumeAt: null }
  }
  // 重置时间已经到了：额度应该回来了。别一直拦着——下一次真实请求会把 remaining 刷新。
  if (resumeAt !== null && now >= resumeAt) return { paused: false, resumeAt: null }
  return { paused: true, resumeAt }
}

function toEpochMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // GitHub 给秒（10 位），本地测试/代理可能给毫秒（13 位）
  return value > 1e12 ? value : value * 1000
}
