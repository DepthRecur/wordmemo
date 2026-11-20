import { getSettings, updateSettings } from '../settings'
import { monthAiCost } from '../db/ai'

/**
 * 预算只做提醒，不拦调用（P-02）。
 *
 * 强制暂停的代价比多花几毛钱大：用户要重来一遍，浪费时间和已经花掉的 token；
 * 而且厂商账上通常还有余额。所以超预算时只提醒一次，而且「本月不再提示」会
 * 一直有效到这个月底。
 */

/** 预算降级成 token 上限时的粗估：$1 ≈ 200 万 token（有未定价调用时才用） */
const TOKENS_PER_USD = 2_000_000

/**
 * 有价按金额；这个月只要出现过「没有价格」的调用，就同时按 token 上限兜底
 * （`TOKENS_PER_USD` 是粗估，宁可早点提示，也不要因为看不到价格就无限花）。
 */
export function overBudget(): boolean {
  const s = getSettings()
  if (!s.monthlyBudgetUsd || s.monthlyBudgetUsd <= 0) return false
  const month = monthAiCost()
  if (month.cost >= s.monthlyBudgetUsd) return true
  if (month.unpricedCalls > 0) {
    return month.tokens >= s.monthlyBudgetUsd * TOKENS_PER_USD
  }
  return false
}

/** 「本月」的标记：静音存成 2026-11 这样的字符串，换月自动失效 */
export function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function budgetNoticeMuted(): boolean {
  return getSettings().ai.budgetMutedMonth === currentMonthKey()
}

/** 点「本月不再提示」：只静音到月底，下个月自动恢复提醒 */
export function muteBudgetNotice(): string {
  const s = getSettings()
  const month = currentMonthKey()
  updateSettings({ ai: { ...s.ai, budgetMutedMonth: month } })
  return month
}

export interface BudgetNotice {
  spent: number
  budget: number
  month: string
}

let notified = false
let listener: ((info: BudgetNotice) => void) | null = null

/** 主进程启动时挂一次：把提醒转给窗口 */
export function onBudgetExhausted(cb: (info: BudgetNotice) => void): void {
  listener = cb
}

/**
 * 每次 AI 调用前问一句：本月超预算了吗？超了就提醒一次（不拦请求）。
 * 一次会话最多提醒一次，避免每张卡片都弹。
 */
export function noteBudget(): void {
  if (notified) return
  if (!overBudget()) return
  notified = true
  if (budgetNoticeMuted()) return
  listener?.({
    spent: monthAiCost().cost,
    budget: getSettings().monthlyBudgetUsd,
    month: currentMonthKey()
  })
}

/** 只在测试里用：清掉「本次会话已提醒」 */
export function resetBudgetNoticeForTest(): void {
  notified = false
}
