import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_FAIL_STREAK,
  PROBE_WINDOW_MS,
  ackSandboxNotice,
  beginProbe,
  decideSandboxState,
  defaultSandboxState,
  evaluateSandboxOnStart,
  isProcessAlive,
  markReady,
  readSandboxState,
  sandboxInfo,
  setCompatMode,
  writeSandboxState,
  type SandboxState
} from '../src/main/sandbox'

const dirs: string[] = []
const NOW = Date.parse('2026-11-21T00:00:00.000Z')

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-sandbox-'))
  dirs.push(dir)
  return dir
}

function state(overrides: Partial<SandboxState> = {}): SandboxState {
  return { ...defaultSandboxState(), ...overrides }
}

function probe(pid: number, startedAt: string, ok = false, source: 'app' | 'launcher' = 'app') {
  return { pid, startedAt, ok, source }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
})

describe('sandbox 判定', () => {
  it('没有 probe：不改状态、不算失败', () => {
    const result = decideSandboxState(state(), { now: NOW, pidAlive: false })
    expect(result.changed).toBe(false)
    expect(result.justEnabled).toBe(false)
    expect(result.state).toEqual(state())
  })

  it('probe.ok=false 但进程还活着：不算失败（可能只是第二个实例）', () => {
    const prev = state({
      failStreak: 1,
      probe: probe(1234, new Date(NOW - 1000).toISOString())
    })
    const result = decideSandboxState(prev, { now: NOW, pidAlive: true })
    expect(result.state.failStreak).toBe(1)
    expect(result.state.probe).toEqual(prev.probe)
  })

  it('只统计启动后 30 秒内消失的进程', () => {
    const old = state({
      probe: probe(1234, new Date(NOW - PROBE_WINDOW_MS).toISOString())
    })
    expect(decideSandboxState(old, { now: NOW, pidAlive: false }).state.failStreak).toBe(0)

    const fresh = state({
      probe: probe(1234, new Date(NOW - PROBE_WINDOW_MS + 1).toISOString())
    })
    expect(decideSandboxState(fresh, { now: NOW, pidAlive: false }).state.failStreak).toBe(1)
  })

  it('未来时间 / probe 早于 lastReadyAt：都不算失败', () => {
    const future = state({
      probe: probe(1, new Date(NOW + 1000).toISOString())
    })
    expect(decideSandboxState(future, { now: NOW, pidAlive: false }).state.failStreak).toBe(0)

    const stale = state({
      lastReadyAt: new Date(NOW - 500).toISOString(),
      probe: probe(1, new Date(NOW - 1000).toISOString())
    })
    expect(decideSandboxState(stale, { now: NOW, pidAlive: false }).state.failStreak).toBe(0)
  })

  it('连续 3 次失败才打开 compatMode，并标记自动开启', () => {
    let current = state()
    for (let i = 1; i <= 2; i++) {
      const result = decideSandboxState(
        { ...current, probe: probe(100 + i, new Date(NOW - 1000).toISOString()) },
        { now: NOW, pidAlive: false }
      )
      expect(result.justEnabled).toBe(false)
      expect(result.state.compatMode).toBe(false)
      expect(result.state.failStreak).toBe(i)
      current = { ...result.state }
    }

    const third = decideSandboxState(
      { ...current, probe: probe(103, new Date(NOW - 1000).toISOString()) },
      { now: NOW, pidAlive: false }
    )
    expect(third.justEnabled).toBe(true)
    expect(third.state.compatMode).toBe(true)
    expect(third.state.autoEnabled).toBe(true)
    expect(third.state.noticeSeen).toBe(false)
    expect(third.state.failStreak).toBe(MAX_FAIL_STREAK)
  })

  it('已经 compatMode=true 时不再累计失败', () => {
    const prev = state({
      compatMode: true,
      autoEnabled: true,
      failStreak: 2,
      probe: probe(1, new Date(NOW - 1000).toISOString())
    })
    const result = decideSandboxState(prev, { now: NOW, pidAlive: false })
    expect(result.state.compatMode).toBe(true)
    expect(result.state.failStreak).toBe(2)
  })

  it('成功 probe 会清掉 probe 和 failStreak', () => {
    const prev = state({
      failStreak: 2,
      probe: probe(1, new Date(NOW - 1000).toISOString(), true)
    })
    const result = decideSandboxState(prev, { now: NOW, pidAlive: false })
    expect(result.state.probe).toBeNull()
    expect(result.state.failStreak).toBe(0)
  })
})

describe('sandbox 文件与生命周期', () => {
  it('坏文件 / 空文件按默认值处理', () => {
    const dir = tmpDir()
    expect(readSandboxState(dir)).toEqual(defaultSandboxState())
    fs.writeFileSync(path.join(dir, 'sandbox-state.json'), '{ broken', 'utf8')
    expect(readSandboxState(dir)).toEqual(defaultSandboxState())
  })

  it('读写往返；beginProbe 写 pid/startedAt/ok=false；markReady 清 probe 并记 lastReadyAt', () => {
    const dir = tmpDir()
    const written = writeSandboxState(dir, state({ failStreak: 2, probe: probe(7, new Date(NOW).toISOString()) }))
    expect(written).toBeUndefined()
    expect(readSandboxState(dir).failStreak).toBe(2)

    const started = new Date(NOW - 1000).toISOString()
    beginProbe(dir, 4321, NOW - 1000)
    expect(readSandboxState(dir).probe).toEqual({
      pid: 4321,
      startedAt: started,
      ok: false,
      source: 'app'
    })

    markReady(dir, NOW)
    const ready = readSandboxState(dir)
    expect(ready.probe).toBeNull()
    expect(ready.failStreak).toBe(0)
    expect(ready.lastReadyAt).toBe(new Date(NOW).toISOString())
  })

  it('evaluateSandboxOnStart 会把第 3 次失败写进文件', () => {
    const dir = tmpDir()
    writeSandboxState(
      dir,
      state({ failStreak: 2, probe: probe(999, new Date(NOW - 1000).toISOString()) })
    )
    let asked = -1
    const result = evaluateSandboxOnStart(dir, {
      now: NOW,
      isPidAlive: (pid) => {
        asked = pid
        return false
      }
    })
    expect(asked).toBe(999)
    expect(result.justEnabled).toBe(true)
    expect(result.state.compatMode).toBe(true)
    const persisted = readSandboxState(dir)
    expect(persisted.compatMode).toBe(true)
    expect(persisted.failStreak).toBe(MAX_FAIL_STREAK)
  })

  it('主进程不结算启动器的 probe（交给启动器下次启动算）', () => {
    const dir = tmpDir()
    writeSandboxState(
      dir,
      state({
        failStreak: 0,
        probe: probe(777, new Date(NOW - 1000).toISOString(), false, 'launcher')
      })
    )
    let asked = false
    const result = evaluateSandboxOnStart(dir, {
      now: NOW,
      isPidAlive: () => {
        asked = true
        return false
      }
    })
    expect(asked).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.state.failStreak).toBe(0)
    expect(readSandboxState(dir).probe?.source).toBe('launcher')
  })

  it('设置开关重置计数；自动提示可通过 ackNotice 消掉', () => {
    const dir = tmpDir()
    writeSandboxState(dir, state({ compatMode: true, autoEnabled: true, noticeSeen: false }))
    expect(sandboxInfo(dir).noticePending).toBe(true)
    ackSandboxNotice(dir)
    expect(sandboxInfo(dir).noticePending).toBe(false)

    const next = setCompatMode(dir, true)
    expect(next.compatMode).toBe(true)
    expect(next.autoEnabled).toBe(false)
    expect(next.failStreak).toBe(0)
    expect(next.noticePending).toBe(false)
    expect(next.probe).toBeNull()

    expect(setCompatMode(dir, false).compatMode).toBe(false)
    expect(readSandboxState(dir).failStreak).toBe(0)
  })
})

describe('process 存活判断', () => {
  it('当前进程存在，非法 pid 返回 false', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
