import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote } from '../src/main/db/notes'
import { upsertItem } from '../src/main/db/items'
import {
  exportEncryptedSnapshot,
  importEncryptedSnapshot
} from '../src/main/db/checkpoint'

// S2 的加密 `.wmsync`：明文里不能出现笔记内容，口令错必须当场拒绝。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-snapcrypto-'))
const dbA = path.join(dir, 'a.db')
const dbB = path.join(dir, 'b.db')
const file = path.join(dir, 'secret.wmsync')
const PASS = 'cobalt-tiger-lantern-vivid-otter'

function count(table: string): number {
  return Number(
    (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number })?.c ?? 0
  )
}

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  openDb(dbA)
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('加密快照（.wmsync）', () => {
  it('导出后文件是密文，导入另一台设备能还原', async () => {
    const noteId = createNote({ title: '加密笔记', tags: ['私密'], rawMarkdown: '# 加密笔记' })
    upsertItem({
      kind: 'word',
      headword: 'secretword',
      meanings: ['秘密'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    await exportEncryptedSnapshot(file, PASS, 12)

    const raw = fs.readFileSync(file)
    expect(raw.subarray(0, 16).toString('utf8')).toBe('WORDMEMO-SYNC 1\n')
    // 明文里不能出现标题/单词（密文头也没有内容）
    expect(raw.toString('utf8')).not.toContain('加密笔记')
    expect(raw.toString('utf8')).not.toContain('secretword')

    closeDb()
    openDb(dbB)
    expect(count('notes')).toBe(0)

    await expect(
      importEncryptedSnapshot(file, 'wrong-passphrase-123')
    ).rejects.toThrow(/密码不对|损坏/)
    expect(count('notes')).toBe(0)

    const { stats } = await importEncryptedSnapshot(file, PASS)
    expect(stats.notes).toBe(1)
    expect(stats.items).toBe(1)
    expect(count('notes')).toBe(1)
    const note = getDb().prepare('SELECT title FROM notes').get() as { title: string }
    expect(note.title).toBe('加密笔记')

    // 同一份再导入一次：幂等，没有新变更
    const again = await importEncryptedSnapshot(file, PASS)
    expect(again.stats.notes).toBe(0)
    expect(again.stats.items).toBe(0)
    expect(count('notes')).toBe(1)
  })
})
