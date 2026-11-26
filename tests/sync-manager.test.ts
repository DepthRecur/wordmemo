import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb } from '../src/main/db/connection'
import { initSettings, updateSettings } from '../src/main/settings'
import type { SyncResult } from '../src/main/sync/engine'
import {
  __setSyncEngineForTests,
  buildStatus,
  disconnectSync,
  flushBeforeQuit,
  resetSyncManagerForTests,
  syncNow
} from '../src/main/sync/manager'

// A-01 / D-06：同步的「同一时刻只有一轮」。
// 以前是 `if (!engine || running) return true`：正在同步时第二次调用直接返回成功，
// 界面会提示「已连接，并完成第一次同步」而其实一次都没跑。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-syncmgr-'))
const previous = process.env.WORDMEMO_DATA_DIR

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function okResult(): SyncResult {
  return {
    deviceId: 'dev-test',
    pushedOps: 0,
    pushedCheckpoint: false,
    peers: 0,
    pulledCheckpoints: 0,
    pulledOpsFiles: 0,
    appliedOps: 0,
    merged: [],
    startedAt: '',
    finishedAt: ''
  }
}

/** 引擎替身：只实现 manager 用到的三个成员（syncNow / rateLimit / repositorySizeKb） */
function fakeEngine(syncNow: () => Promise<SyncResult>, remaining = 4000): { calls: number } {
  const stats = { calls: 0 }
  __setSyncEngineForTests({
    rateLimit: { remaining, resetAt: null },
    repositorySizeKb: null,
    syncNow: async () => {
      stats.calls += 1
      return syncNow()
    }
  })
  return stats
}

beforeAll(() => {
  process.env.WORDMEMO_DATA_DIR = dir
  openDb(path.join(dir, 'wordmemo.db'))
  initSettings()
  // 只手动（intervalMin: 0），避免调度器在测试里自己跑起来
  updateSettings({
    sync: { enabled: true, owner: 'owner', repo: 'repo', apiBase: 'https://api.github.com', intervalMin: 0 }
  })
})

afterAll(() => {
  resetSyncManagerForTests()
  closeDb()
  if (previous === undefined) delete process.env.WORDMEMO_DATA_DIR
  else process.env.WORDMEMO_DATA_DIR = previous
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetSyncManagerForTests()
  // 上一个用例可能已经断开了连接（disconnectSync 会改 settings），这里恢复成「已连接」
  updateSettings({
    sync: { enabled: true, owner: 'owner', repo: 'repo', apiBase: 'https://api.github.com', intervalMin: 0 }
  })
})

describe('同步管理器：同一时刻只有一轮', () => {
  it('正在同步时再点一次：不会并发跑两次，也不会假装成功', async () => {
    const gate = deferred<void>()
    const stats = fakeEngine(async () => {
      await gate.promise
      return okResult()
    })

    const first = syncNow()
    await sleep(10)
    const second = syncNow()
    await sleep(10)

    // 第二次调用没有开启新的一轮
    expect(stats.calls).toBe(1)

    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // 第二次如实说明「正在同步」，而不是冒充「已完成」
    expect(b.message).toContain('正在同步')
    expect(stats.calls).toBe(1)
  })

  it('退出前 flush 会等正在进行的那一轮，不会立刻放弃', async () => {
    const gate = deferred<void>()
    const stats = fakeEngine(async () => {
      await gate.promise
      return okResult()
    })

    const run = syncNow()
    await sleep(10)

    let flushed = false
    const flushing = flushBeforeQuit(2000).then(() => {
      flushed = true
    })
    await sleep(50)
    // 同步还没结束，flush 不能先返回
    expect(flushed).toBe(false)

    gate.resolve()
    await flushing
    await run
    expect(flushed).toBe(true)
    expect(stats.calls).toBe(1)
  })

  it('flush 超时后放弃，不卡住退出', async () => {
    const gate = deferred<void>()
    fakeEngine(async () => {
      await gate.promise
      return okResult()
    })

    void syncNow()
    await sleep(10)

    const startedAt = Date.now()
    await flushBeforeQuit(120)
    expect(Date.now() - startedAt).toBeLessThan(1500)
    gate.resolve()
  })

  it('断开连接时正在跑的同步不会崩，状态回到未连接', async () => {
    const gate = deferred<void>()
    fakeEngine(async () => {
      await gate.promise
      return okResult()
    })

    const run = syncNow()
    await sleep(10)
    expect(() => disconnectSync()).not.toThrow()

    gate.resolve()
    await expect(run).resolves.toBeDefined()
    expect(buildStatus().enabled).toBe(false)
  })

  it('被跳过的记录不会算进「应用了 N 条」，而是单独计数（A-04）', async () => {
    fakeEngine(async () => ({
      ...okResult(),
      appliedOps: 2,
      merged: [
        {
          decks: 1,
          notes: 3,
          items: 0,
          reviews: 0,
          exams: 0,
          noteItems: 0,
          cardFlags: 0,
          tombstones: 4,
          skipped: 5
        }
      ]
    }))

    const result = await syncNow()
    expect(result.ok).toBe(true)
    const status = buildStatus()
    // 2 条 op + (1+3+4) 条真正合并的；skipped 不算改动
    expect(status.lastSyncChanges).toBe(10)
    expect(status.lastSyncSkipped).toBe(5)
  })

  it('额度低于阈值时状态里标记「暂停自动同步」（D-02）', async () => {
    fakeEngine(async () => okResult(), 50)
    await syncNow()
    expect(buildStatus().quotaPaused).toBe(true)

    // 额度恢复后（下一次请求会刷新 remaining）不再暂停
    fakeEngine(async () => okResult(), 4000)
    await syncNow()
    expect(buildStatus().quotaPaused).toBe(false)
  })
})
