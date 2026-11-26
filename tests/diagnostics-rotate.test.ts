import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { afterAll, describe, expect, it } from 'vitest'
import { log, LOG_MAX_BYTES, shouldRotateLog } from '../src/main/diagnostics'

// F-04：diagnostics.log 以前只 append，不轮转、无上限，会一直长。
// 现在超过 2 MB 就先滚成 diagnostics.log.1（只留一份备份），再写新的。

const previous = process.env.WORDMEMO_DATA_DIR

afterAll(() => {
  if (previous === undefined) delete process.env.WORDMEMO_DATA_DIR
  else process.env.WORDMEMO_DATA_DIR = previous
})

describe('诊断日志轮转', () => {
  it('阈值判断', () => {
    expect(shouldRotateLog(LOG_MAX_BYTES - 1)).toBe(false)
    expect(shouldRotateLog(LOG_MAX_BYTES)).toBe(true)
    expect(shouldRotateLog(Number.NaN)).toBe(false)
    expect(shouldRotateLog(10, 10)).toBe(true)
  })

  it('超过上限时滚成 .1，新文件只含刚写的一条', () => {
    const dir = app.getPath('userData')
    const file = path.join(dir, 'diagnostics.log')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES + 10), 'utf8')

    log('rotate-test', { ok: true })

    expect(fs.existsSync(`${file}.1`)).toBe(true)
    const fresh = fs.readFileSync(file, 'utf8')
    expect(fresh).toContain('rotate-test')
    expect(fresh.length).toBeLessThan(1000)
  })

  it('没到上限时只追加，不产生 .1', () => {
    const dir = app.getPath('userData')
    const file = path.join(dir, 'diagnostics.log')
    fs.rmSync(`${file}.1`, { force: true })
    fs.writeFileSync(file, '', 'utf8')

    log('small-1')
    log('small-2')

    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('small-1')
    expect(text).toContain('small-2')
    expect(fs.existsSync(`${file}.1`)).toBe(false)
  })
})
