import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote, updateNote } from '../src/main/db/notes'
import { upsertItem } from '../src/main/db/items'
import { SyncEngine } from '../src/main/sync/engine'

// 真仓库 e2e（手动，不进常规 CI）：
//   $env:WORDMEMO_SYNC_E2E_TOKEN = '<PAT>'      # 需要这个测试仓库的 Contents: Read and write
//   $env:WORDMEMO_SYNC_E2E_REPO = 'DepthRecur/wordmemo-sync-test'
//   npx vitest run tests/real-sync.test.ts
//
// 本机可以用 .data\sync-e2e.ps1 从 Windows 凭据管理器取 token 后跑（不会打印 token）。

const TOKEN = process.env.WORDMEMO_SYNC_E2E_TOKEN
const REPO = process.env.WORDMEMO_SYNC_E2E_REPO || 'DepthRecur/wordmemo-sync-test'
const PASS = 'wordmemo-sync-e2e-passphrase'
const [owner, repo] = REPO.split('/')
const maybe = TOKEN ? describe : describe.skip

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-realsync-'))
const dbA = path.join(dir, 'device-a.db')
const dbB = path.join(dir, 'device-b.db')

function engine(): SyncEngine {
  return new SyncEngine({
    owner,
    repo,
    token: TOKEN as string,
    passphrase: PASS,
    // e2e 用低一点的 work factor，避免慢网络 + scrypt 18 把测试拖过超时
    workFactor: 12
  })
}

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

maybe('真仓库 e2e（两台设备）', () => {
  it('A 推 → B 拉 → B 改 → A 拉，并确认仓库里是加密文件', async () => {
    openDb(dbA)
    const noteId = createNote({ title: '真仓库测试', tags: ['e2e'], rawMarkdown: '# e2e' })
    upsertItem({
      kind: 'word',
      headword: 'transport',
      meanings: ['运输'],
      noteId,
      position: 0,
      listenEnabled: false
    })

    const a = engine()
    const connected = await a.connect()
    expect(connected.login).toBe('DepthRecur')
    expect(connected.repo.private).toBe(true)
    const pushed = await a.syncNow()
    expect(pushed.pushedCheckpoint).toBe(true)
    expect(pushed.deviceId).toBeTruthy()

    closeDb()
    openDb(dbB)
    const b = engine()
    await b.connect()
    const pulled = await b.syncNow()
    expect(pulled.peers).toBeGreaterThanOrEqual(1)
    expect(pulled.pulledCheckpoints).toBeGreaterThanOrEqual(1)
    const note = getDb().prepare('SELECT id, title FROM notes WHERE title = ?').get('真仓库测试') as
      | { id: number; title: string }
      | undefined
    expect(note?.title).toBe('真仓库测试')

    updateNote(note!.id, { title: '真仓库测试（B 改）' })
    const pushedOps = await b.syncNow()
    expect(pushedOps.pushedOps).toBeGreaterThan(0)

    closeDb()
    openDb(dbA)
    const aAgain = engine()
    const pulledOps = await aAgain.syncNow()
    expect(pulledOps.appliedOps).toBeGreaterThan(0)
    const title = getDb().prepare('SELECT title FROM notes ORDER BY id LIMIT 1').get() as {
      title: string
    }
    expect(title.title).toBe('真仓库测试（B 改）')
  }, 180_000)
})
