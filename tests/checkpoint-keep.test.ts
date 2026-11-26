import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_ARCHIVE_KEEP,
  isCheckpointArchive,
  monthStamp,
  pickObsoleteArchives
} from '../src/main/sync/checkpointKeep'

// D-01：checkpoint 不能再只覆盖写一份——文档承诺「保留最近 2 份 / 月度归档」。
// 规范路径 checkpoint.json.age 仍然每次都写（旧客户端只认它），
// 这里测的是「额外的月度归档保留几份」。

describe('checkpoint 归档保留策略', () => {
  it('只认 checkpoint-YYYYMM.json.age', () => {
    expect(isCheckpointArchive('checkpoint-202611.json.age')).toBe(true)
    expect(isCheckpointArchive('checkpoint.json.age')).toBe(false)
    expect(isCheckpointArchive('checkpoint-2026.json.age')).toBe(false)
    expect(isCheckpointArchive('info.json.age')).toBe(false)
    expect(isCheckpointArchive('checkpoint-202611.json.age.bak')).toBe(false)
  })

  it('超过保留份数时删最旧的，新的留着', () => {
    const names = [
      'checkpoint.json.age',
      'checkpoint-202609.json.age',
      'checkpoint-202611.json.age',
      'checkpoint-202610.json.age',
      'info.json.age'
    ]
    // 保留 2 份 → 删 202609
    expect(pickObsoleteArchives(names)).toEqual(['checkpoint-202609.json.age'])
  })

  it('份数不足、或只有规范文件时什么都不删', () => {
    expect(pickObsoleteArchives(['checkpoint.json.age', 'checkpoint-202611.json.age'])).toEqual([])
    expect(pickObsoleteArchives([])).toEqual([])
    expect(CHECKPOINT_ARCHIVE_KEEP).toBe(2)
  })

  it('monthStamp 用本地时间，月份补零', () => {
    expect(monthStamp(new Date(2026, 0, 5))).toBe('202601')
    expect(monthStamp(new Date(2026, 10, 26))).toBe('202611')
  })
})
