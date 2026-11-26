import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import {
  TOMBSTONE_KEEP_DAYS,
  listTombstones,
  purgeOldTombstones,
  recordTombstone,
  withSync
} from '../src/main/db/sync'

// D-05（方案 B）：删除影子只保留 30 天。表里只有 entity/uid/ts，没有内容快照，
// 所以这里**只**测清理，不测恢复——恢复需要 schema v5，等后续版本（BACKLOG D-05）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-tombstones-'))
const dbFile = path.join(dir, 'tombstones.db')
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-26T12:00:00')

beforeAll(() => {
  openDb(dbFile)
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM sync_tombstones; DELETE FROM sync_ops')
})

function uids(): string[] {
  return listTombstones()
    .map((row) => row.uid)
    .sort()
}

describe('删除影子 30 天清理（D-05 方案 B）', () => {
  it('保留天数是 30 天', () => {
    expect(TOMBSTONE_KEEP_DAYS).toBe(30)
  })

  it('清掉 30 天前的删除，29 天内的留着', () => {
    recordTombstone('note', 'OLD', NOW - 31 * DAY)
    recordTombstone('note', 'FRESH', NOW - 29 * DAY)
    recordTombstone('item', 'ALSO-OLD', NOW - 90 * DAY)

    expect(purgeOldTombstones(NOW)).toBe(2)
    expect(uids()).toEqual(['FRESH'])
  })

  it('正好卡在 30 天边界的不清（判据是严格早于截止点）', () => {
    recordTombstone('note', 'EDGE', NOW - TOMBSTONE_KEEP_DAYS * DAY)
    expect(purgeOldTombstones(NOW)).toBe(0)
    expect(uids()).toEqual(['EDGE'])
  })

  it('还没推出去的删除不清：否则对端旧快照会把内容带回来', () => {
    withSync({ entity: 'note', uid: 'PENDING', op: 'delete', tsUtc: NOW - 40 * DAY }, () => {})

    expect(purgeOldTombstones(NOW)).toBe(0)
    expect(uids()).toEqual(['PENDING'])

    // 推出去之后才允许清
    getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE uid = 'PENDING'").run()
    expect(purgeOldTombstones(NOW)).toBe(1)
    expect(uids()).toEqual([])
  })

  it('同时有本机更新和远端写入时，只按时间判断，不误伤新的', () => {
    recordTombstone('note', 'LOCAL-OLD', NOW - 45 * DAY)
    recordTombstone('note', 'REMOTE-NEW', NOW - 2 * DAY)
    withSync({ entity: 'note', uid: 'LOCAL-PENDING', op: 'delete', tsUtc: NOW - 60 * DAY }, () => {})

    expect(purgeOldTombstones(NOW)).toBe(1)
    expect(uids()).toEqual(['LOCAL-PENDING', 'REMOTE-NEW'])
  })

  it('空表时返回 0，不抛错', () => {
    expect(purgeOldTombstones(NOW)).toBe(0)
  })
})
