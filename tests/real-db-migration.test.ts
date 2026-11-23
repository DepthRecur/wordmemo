import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupBeforeMigrate, closeDb, getDb, openDb, toInt } from '../src/main/db/connection'
import { DatabaseSync } from '../src/main/db/sqlite'
import { SCHEMA_VERSION } from '../src/main/db/schema'

// 手动验收（HANDOFF-SYNC §3.4）：拿一份真实库的副本跑一次迁移。
// 常规 `npm test` 里整组跳过——它依赖本机的真实数据，不能进 CI。
//
// 用法：
//   $env:WORDMEMO_REAL_DB_COPY='D:\tmp\real\wordmemo.db'
//   npx vitest run tests/real-db-migration.test.ts
//
// 副本请连同 `-wal` / `-shm` 一起复制（应用开着时直接把 .db 拷出来可能是旧页）。

const copy = process.env.WORDMEMO_REAL_DB_COPY
const maybe = copy ? describe : describe.skip
const TABLES = ['notes', 'items', 'reviews', 'exams', 'cards'] as const
const UID_TABLES = ['notes', 'items', 'reviews', 'exams'] as const

interface Snapshot {
  version: number
  counts: Record<string, number>
}

function snapshot(dbFile: string): Snapshot {
  const db = new DatabaseSync(dbFile, { timeout: 4000 })
  try {
    const version = toInt(
      (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
        ?.user_version
    )
    const counts: Record<string, number> = {}
    for (const table of TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number }
      counts[table] = toInt(row?.c)
    }
    return { version, counts }
  } finally {
    db.close()
  }
}

maybe('真实库副本迁移', () => {
  it('迁移前自动备份、迁移后版本升级、uid 齐全、行数不变', () => {
    expect(copy).toBeTruthy()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-real-'))
    const dbFile = path.join(dir, 'wordmemo.db')
    try {
      // 1. 复制副本（含 WAL/SHM）
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${copy}${suffix}`
        if (fs.existsSync(from)) fs.copyFileSync(from, `${dbFile}${suffix}`)
      }
      const before = snapshot(dbFile)
      expect(before.version).toBeLessThan(SCHEMA_VERSION)
      // 真实库不一定四张表都有数据（exam / reviews 可能是空的），有笔记和词条就够
      expect(before.counts.notes).toBeGreaterThan(0)
      expect(before.counts.items).toBeGreaterThan(0)

      // 2. 迁移前备份：必须生成，且内容就是迁移前那份
      const backup = backupBeforeMigrate(dbFile, path.join(dir, 'backups'))
      expect(backup).toBeTruthy()
      expect(path.basename(backup!)).toBe(`wordmemo-pre-migrate-v${before.version}.db`)
      const backupSnapshot = snapshot(backup!)
      expect(backupSnapshot.counts).toEqual(before.counts)

      // 3. 迁移
      openDb(dbFile)
      const after = snapshot(dbFile)
      expect(after.version).toBe(SCHEMA_VERSION)
      expect(after.counts).toEqual(before.counts)

      // 4. uid 齐全且唯一
      for (const table of UID_TABLES) {
        const missing = getDb()
          .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE uid IS NULL OR uid = ''`)
          .get() as { c?: number }
        expect(toInt(missing?.c)).toBe(0)
        const distinct = getDb()
          .prepare(`SELECT COUNT(DISTINCT uid) AS c FROM ${table}`)
          .get() as { c?: number }
        expect(toInt(distinct?.c)).toBe(after.counts[table])
      }

      // 5. 结构自检 + 同步队列就位（S0 不推送，队列应为空）
      const integrity = getDb().prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      expect(integrity.integrity_check).toBe('ok')
      const ops = getDb().prepare('SELECT COUNT(*) AS c FROM sync_ops').get() as { c?: number }
      expect(toInt(ops?.c)).toBe(0)

      // 6. 备份可以原样打开（用户真需要回滚时拿得到东西）
      const reopenedBackup = new DatabaseSync(backup!, { timeout: 4000 })
      try {
        const version = toInt(
          (reopenedBackup.prepare('PRAGMA user_version').get() as { user_version?: number })
            .user_version
        )
        expect(version).toBe(before.version)
      } finally {
        reopenedBackup.close()
      }
    } finally {
      closeDb()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
