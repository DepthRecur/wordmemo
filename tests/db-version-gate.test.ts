import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from '../src/main/db/sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, DatabaseTooNewError, openDb } from '../src/main/db/connection'
import { SCHEMA_VERSION } from '../src/main/db/schema'

// A-02：旧版本打开新库必须拒绝（PLAN-UPDATE §3.4-4 的红线）。
// 以前 migrate() 无条件把 user_version 写回 4：旧代码读到不认识的表结构会静默写坏数据，
// 而且版本号会被改回旧值，让下次新版再迁移一遍。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-dbversion-'))

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个「更新版本写的」库：只写版本号，不建业务表 */
function makeNewerDb(file: string): number {
  const version = SCHEMA_VERSION + 1
  const raw = new DatabaseSync(file)
  raw.exec('CREATE TABLE IF NOT EXISTS newer_table (id INTEGER PRIMARY KEY)')
  raw.exec(`PRAGMA user_version = ${version}`)
  raw.close()
  return version
}

function userVersion(file: string): number {
  const raw = new DatabaseSync(file, { readOnly: true })
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  raw.close()
  return Number(row?.user_version ?? 0)
}

describe('数据库版本闸门', () => {
  it('库版本比程序新：拒绝打开，且不改写版本号', () => {
    const file = path.join(dir, 'too-new.db')
    const version = makeNewerDb(file)

    let caught: unknown = null
    try {
      openDb(file)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DatabaseTooNewError)
    const err = caught as DatabaseTooNewError
    expect(err.dbVersion).toBe(version)
    expect(err.supportedVersion).toBe(SCHEMA_VERSION)
    // 关键：旧版本没有把它「降级」写回自己的版本
    expect(userVersion(file)).toBe(version)
  })

  it('同版本与更老的库照常打开', () => {
    const current = path.join(dir, 'current.db')
    openDb(current)
    expect(userVersion(current)).toBe(SCHEMA_VERSION)
    closeDb()

    // 再开一次（已经有了全部表）不应该抛
    expect(() => openDb(current)).not.toThrow()
    expect(userVersion(current)).toBe(SCHEMA_VERSION)
    closeDb()
  })
})
