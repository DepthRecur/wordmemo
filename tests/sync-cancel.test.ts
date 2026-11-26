import { describe, expect, it } from 'vitest'
import { SyncCancelledError, SyncEngine } from '../src/main/sync/engine'

// D-06：断开连接/换密码时要让在飞的同步停下，而不是继续写远端。
// engine 在每个阶段边界检查 shouldStop()；一开始就作废的话，连网络都不该碰。

describe('同步作废（D-06）', () => {
  it('一开始就 shouldStop：直接抛已取消，不连网', async () => {
    const engine = new SyncEngine({
      owner: 'o',
      repo: 'r',
      token: 'fake-token',
      passphrase: 'correct horse battery',
      apiBase: 'http://127.0.0.1:9/never', // 万一真连了，端口 9 会立刻失败
      workFactor: 2,
      shouldStop: () => true
    })
    await expect(engine.syncNow()).rejects.toBeInstanceOf(SyncCancelledError)
  })

  it('不传 shouldStop 时行为不变（不会误判成取消）', async () => {
    const engine = new SyncEngine({
      owner: 'o',
      repo: 'r',
      token: 'fake-token',
      passphrase: 'correct horse battery',
      apiBase: 'http://127.0.0.1:9/never',
      workFactor: 2
    })
    // 这里只断言「不是 SyncCancelledError」：真实失败原因由网络层决定
    await expect(engine.syncNow()).rejects.not.toBeInstanceOf(SyncCancelledError)
  })
})
