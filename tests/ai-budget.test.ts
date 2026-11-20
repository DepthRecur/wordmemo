import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db/connection'
import { logAiUsage } from '../src/main/db/ai'
import { chat } from '../src/main/ai/client'
import {
  budgetNoticeMuted,
  muteBudgetNotice,
  onBudgetExhausted,
  overBudget,
  resetBudgetNoticeForTest
} from '../src/main/ai/budget'
import { getSettings, initSettings, setApiKey, updateSettings } from '../src/main/settings'

/**
 * P-02：预算用完不再中断任何任务，只提醒一次；「本月不再提示」静音到月底。
 */

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 }
})

const realFetch = globalThis.fetch
const dirs: string[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-budget-'))
  dirs.push(dir)
  return path.join(dir, 'wordmemo.db')
}

function stubOk(): void {
  globalThis.fetch = (async () =>
    new Response(OK_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch
}

beforeEach(() => {
  openDb(tmpDb())
  initSettings()
  setApiKey('deepseek', 'sk-budget')
  updateSettings({
    monthlyBudgetUsd: 0.01,
    ai: { default: { provider: 'deepseek' }, vision: null, providers: {} }
  })
  // 已经花掉 $1，远超 $0.01 的预算
  logAiUsage({
    provider: 'deepseek',
    kind: 'judge',
    model: 'deepseek-flash',
    promptTokens: 1000,
    cachedTokens: 0,
    completionTokens: 0,
    costUsd: 1,
    costSource: 'snapshot'
  })
  resetBudgetNoticeForTest()
})

afterEach(() => {
  globalThis.fetch = realFetch
  closeDb()
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
})

describe('P-02 预算只用提醒', () => {
  it('超预算照常发请求，提醒只出现一次', async () => {
    expect(overBudget()).toBe(true)
    const notices: { spent: number; budget: number }[] = []
    onBudgetExhausted((info) => notices.push(info))
    stubOk()

    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], kind: 'budget-a' })).resolves.toBe(
      'ok'
    )
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], kind: 'budget-b' })).resolves.toBe(
      'ok'
    )

    expect(notices).toHaveLength(1)
    expect(notices[0].budget).toBe(0.01)
    expect(notices[0].spent).toBeCloseTo(1, 5)
  })

  it('「本月不再提示」静音到月底，下个月自动恢复', async () => {
    const notices: number[] = []
    onBudgetExhausted(() => notices.push(1))
    stubOk()

    muteBudgetNotice()
    expect(budgetNoticeMuted()).toBe(true)

    resetBudgetNoticeForTest()
    await chat({ messages: [{ role: 'user', content: 'hi' }], kind: 'budget-muted' })
    expect(notices).toHaveLength(0)

    // 换月等价于静音标记不再是本月
    const s = getSettings()
    updateSettings({ ai: { ...s.ai, budgetMutedMonth: '2000-01' } })
    expect(budgetNoticeMuted()).toBe(false)

    resetBudgetNoticeForTest()
    await chat({ messages: [{ role: 'user', content: 'hi' }], kind: 'budget-next-month' })
    expect(notices).toHaveLength(1)
  })
})
