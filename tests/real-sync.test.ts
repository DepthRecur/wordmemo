import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote, deleteNote, getNote, updateNote } from '../src/main/db/notes'
import { createDeck, listDecks } from '../src/main/db/decks'
import { upsertItem, getItem, updateItem, findExistingItemId } from '../src/main/db/items'
import { exportEncryptedSnapshot, importEncryptedSnapshot } from '../src/main/db/checkpoint'
import { countPendingOps, getSyncState } from '../src/main/db/sync'
import { SyncEngine, SyncSetupError } from '../src/main/sync/engine'
import { GitHubClient, SyncApiError } from '../src/main/sync/github'

// 真仓库 e2e（手动，不进常规 CI）：
//   $env:WORDMEMO_SYNC_E2E_TOKEN = '<PAT>'      # 需要这个测试仓库的 Contents: Read and write
//   $env:WORDMEMO_SYNC_E2E_REPO = 'DepthRecur/wordmemo-sync-test'
//   npx vitest run tests/real-sync.test.ts
//
// 本机可以用 .data\sync-e2e.ps1 从 Windows 凭据管理器取 token 后跑（不会打印 token）。
// 这套用例会先把测试仓库清空，跑完再清空一次；中途失败可能留下数据，重跑即可。

const TOKEN = process.env.WORDMEMO_SYNC_E2E_TOKEN
const REPO = process.env.WORDMEMO_SYNC_E2E_REPO || 'DepthRecur/wordmemo-sync-test'
const PASS = 'wordmemo-sync-e2e-passphrase'
const PASS2 = 'wordmemo-sync-e2e-passphrase-2'
const [owner, repo] = REPO.split('/')
const maybe = TOKEN ? describe : describe.skip
const MAGIC = 'WORDMEMO-SYNC 1\n'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-realsync-'))
const snapshotFile = path.join(dir, 'snapshot.wmsync')

function use(name: string): void {
  closeDb()
  openDb(path.join(dir, `${name}.db`))
}

function engine(passphrase = PASS, extra: { apiBase?: string } = {}): SyncEngine {
  return new SyncEngine({
    owner,
    repo,
    token: TOKEN as string,
    passphrase,
    // e2e 用低一点的 work factor，避免慢网络 + scrypt 18 把测试拖过超时
    workFactor: 12,
    ...extra
  })
}

function client(): GitHubClient {
  return new GitHubClient({ token: TOKEN as string, owner, repo })
}

/** 清空测试仓库：删 meta.json 和 devices/ 下所有文件（递归） */
async function cleanRemote(): Promise<void> {
  const gh = client()
  try {
    const meta = await gh.getFile('meta.json')
    if (meta.content) await gh.deleteFile('meta.json', meta.sha as string, 'sync: clean')
  } catch (error) {
    if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
  }
  const files: { path: string; sha: string }[] = []
  const walk = async (root: string): Promise<void> => {
    let entries: { name: string; path: string; sha: string; type: string }[] = []
    try {
      entries = await gh.listDir(root)
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return
      throw error
    }
    for (const entry of entries) {
      if (entry.type === 'dir') await walk(entry.path)
      else if (entry.type === 'file') files.push({ path: entry.path, sha: entry.sha })
    }
  }
  await walk('devices')
  for (const file of files) await gh.deleteFile(file.path, file.sha, 'sync: clean')
}

function noteId(title: string): number | null {
  const row = getDb().prepare('SELECT id FROM notes WHERE title = ?').get(title) as
    | { id: number }
    | undefined
  return row?.id ?? null
}

function noteCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }
  return row.n
}

async function expectSetupError(run: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(caught, `期望抛出 ${code}，实际没有抛错`).toBeInstanceOf(SyncSetupError)
  expect((caught as SyncSetupError).code).toBe(code)
}

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  if (TOKEN) await cleanRemote()
}, 120_000)

afterAll(async () => {
  closeDb()
  if (TOKEN) {
    try {
      await cleanRemote()
    } catch {
      /* 收尾失败不影响结果，手动清理即可 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}, 120_000)

maybe('真仓库 e2e（两台设备，S2 + S3 全流程）', () => {
  it('A 首次连接：写入 meta.json、info 和加密 checkpoint，仓库里没有明文', async () => {
    use('a')
    const noteIdA = createNote({ title: '真仓库测试', tags: ['e2e'], rawMarkdown: '# e2e' })
    upsertItem({
      kind: 'word',
      headword: 'transport',
      meanings: ['运输'],
      noteId: noteIdA,
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
    expect(pushed.peers).toBe(0)

    const gh = client()
    const meta = await gh.getFile('meta.json')
    const metaText = meta.content.toString('utf8')
    expect(metaText).not.toContain('真仓库测试')
    const metaJson = JSON.parse(metaText) as Record<string, unknown>
    expect(metaJson.formatVersion).toBe(1)
    expect(Object.keys(metaJson).sort()).toEqual(
      ['app', 'createdAt', 'formatVersion', 'kdfVerifier', 'salt', 'revokedDevices'].sort()
    )

    const checkpoint = await gh.getFile(`devices/${pushed.deviceId}/checkpoint.json.age`)
    expect(checkpoint.content.toString('utf8').startsWith(MAGIC)).toBe(true)
    expect(checkpoint.content.toString('utf8')).not.toContain('真仓库测试')
    expect(checkpoint.content.toString('utf8')).not.toContain('transport')
  }, 120_000)

  it('B 连接后拉到 A 的数据；B 补的释义推回 A 后是并集', async () => {
    use('b')
    const b = engine()
    await b.connect()
    const pulled = await b.syncNow()
    expect(pulled.peers).toBeGreaterThanOrEqual(1)
    expect(pulled.pulledCheckpoints).toBeGreaterThanOrEqual(1)
    expect(noteId('真仓库测试')).not.toBeNull()

    const itemId = findExistingItemId('transport', null, 'word')
    expect(itemId).not.toBeNull()
    const before = getItem(itemId as number)
    expect(before?.meanings).toEqual(['运输'])
    updateItem(itemId as number, { meanings: ['运输', '运输工具'] })

    const pushedOps = await b.syncNow()
    expect(pushedOps.pushedOps).toBeGreaterThan(0)

    use('a')
    const a = engine()
    const pulledOps = await a.syncNow()
    expect(pulledOps.appliedOps).toBeGreaterThan(0)
    const merged = getItem(findExistingItemId('transport', null, 'word') as number)
    expect(merged?.meanings).toEqual(expect.arrayContaining(['运输', '运输工具']))
    expect(merged?.meanings.length).toBe(2)
  }, 180_000)

  it('字段级 LWW：A 改标题、B 改标签，合并后两处改动都在', async () => {
    use('a')
    const a = engine()
    updateNote(noteId('真仓库测试') as number, { title: '真仓库测试（A 的标题）' })
    await a.syncNow()

    use('b')
    const b = engine()
    await b.syncNow()
    expect(noteId('真仓库测试（A 的标题）')).not.toBeNull()
    updateNote(noteId('真仓库测试（A 的标题）') as number, { tags: ['e2e', 'b-tag'] })
    await b.syncNow()

    use('a')
    const a2 = engine()
    await a2.syncNow()
    const note = getNote(noteId('真仓库测试（A 的标题）') as number)
    expect(note?.title).toBe('真仓库测试（A 的标题）')
    expect(note?.tags).toEqual(expect.arrayContaining(['e2e', 'b-tag']))
  }, 180_000)

  it('同名库合并成一本，两边的笔记都落在这本里（alias）', async () => {
    use('a')
    const deckA = createDeck({ name: '英语' })
    createNote({ title: 'A 的英语笔记', deckId: deckA, rawMarkdown: '# a' })
    await engine().syncNow()

    use('b')
    const deckB = createDeck({ name: '英语' })
    createNote({ title: 'B 的英语笔记', deckId: deckB, rawMarkdown: '# b' })
    const b = engine()
    await b.syncNow()
    await b.syncNow()

    use('a')
    const a = engine()
    await a.syncNow()
    await a.syncNow()

    for (const device of ['a', 'b']) {
      use(device)
      const decks = listDecks().filter((deck) => deck.name === '英语')
      expect(decks.length, `${device} 里「英语」应该只有一本`).toBe(1)
      const notes = getDb()
        .prepare('SELECT title, deck_id FROM notes WHERE title IN (?, ?)')
        .all('A 的英语笔记', 'B 的英语笔记') as { title: string; deck_id: number }[]
      expect(notes.length, `${device} 里两边的笔记都在`).toBe(2)
      for (const note of notes) expect(note.deck_id).toBe(decks[0].id)
    }
  }, 240_000)

  it('删除优先：A 删掉的笔记，B 同步后也消失且不会复活', async () => {
    use('a')
    createNote({ title: '待删除', rawMarkdown: '# delete me' })
    await engine().syncNow()

    use('b')
    const b = engine()
    await b.syncNow()
    expect(noteId('待删除')).not.toBeNull()

    use('a')
    const a = engine()
    deleteNote(noteId('待删除') as number)
    await a.syncNow()
    await a.syncNow() // 推完再拉一次，确认自己不会被远端旧数据复活

    use('b')
    const b2 = engine()
    await b2.syncNow()
    expect(noteId('待删除')).toBeNull()

    use('a')
    const a2 = engine()
    await a2.syncNow()
    expect(noteId('待删除')).toBeNull()
  }, 180_000)

  it('设备列表能看到两台；换密码后旧密码被拒、新密码能重连', async () => {
    use('a')
    const a = engine()
    await a.connect()
    const devicesBefore = await a.listDevices()
    expect(devicesBefore.length).toBe(2)
    expect(devicesBefore.filter((device) => device.isCurrent).length).toBe(1)

    const bId = devicesBefore.find((device) => !device.isCurrent)?.id as string
    expect(bId).toBeTruthy()

    await a.changePassphrase(PASS2)

    const gh = client()
    const meta = JSON.parse((await gh.getFile('meta.json')).content.toString('utf8')) as {
      kdfVerifier: string
    }
    expect(meta.kdfVerifier).toBeTruthy()
    const dirs = await gh.listDir('devices')
    expect(dirs.filter((entry) => entry.type === 'dir').map((entry) => entry.name)).toEqual([
      getSyncState().deviceId
    ])

    use('b')
    await expectSetupError(() => engine(PASS).connect(), 'bad_passphrase')
    const b = engine(PASS2)
    await b.connect()
    const pulled = await b.syncNow()
    expect(pulled.deviceId).toBe(bId)
    expect(noteId('真仓库测试（A 的标题）')).not.toBeNull()
  }, 240_000)

  it('移除设备：B 从列表消失、远端目录被删，B 自己再同步会被拒绝', async () => {
    use('a')
    const a = engine(PASS2)
    await a.connect()
    const b = (await a.listDevices()).find((device) => !device.isCurrent)
    expect(b).toBeTruthy()
    await a.removeDevice((b as { id: string }).id)

    const devicesAfter = await a.listDevices()
    expect(devicesAfter.filter((device) => !device.isCurrent && !device.revoked)).toHaveLength(0)
    const gh = client()
    const dirs = await gh.listDir('devices')
    expect(dirs.map((entry) => entry.name)).not.toContain((b as { id: string }).id)

    use('b')
    await expectSetupError(() => engine(PASS2).connect(), 'device_revoked')
    const bEngine = engine(PASS2)
    await bEngine.connect().catch(() => undefined)
    await expectSetupError(() => bEngine.syncNow(), 'device_revoked')
  }, 240_000)

  it('断网时本地照常写入并排队，恢复后一次补推', async () => {
    use('a')
    const a = engine(PASS2)
    await a.connect()
    const offline = engine(PASS2, { apiBase: 'http://127.0.0.1:9' })
    let failed = false
    try {
      await offline.syncNow()
    } catch (error) {
      failed = true
      expect(error).toBeInstanceOf(SyncApiError)
      expect(['network', 'timeout']).toContain((error as SyncApiError).code)
    }
    expect(failed).toBe(true)

    createNote({ title: '断网期间写的', rawMarkdown: '# offline' })
    expect(countPendingOps()).toBeGreaterThan(0)

    const result = await a.syncNow()
    expect(result.pushedOps).toBeGreaterThan(0)
    expect(countPendingOps()).toBe(0)
  }, 180_000)

  it('重启后连接状态保留：deviceId 不变，无改动时不重推 checkpoint', async () => {
    use('a')
    const deviceId = getSyncState().deviceId
    closeDb()
    openDb(path.join(dir, 'a.db'))
    expect(getSyncState().deviceId).toBe(deviceId)

    const a = engine(PASS2)
    await a.connect()
    const result = await a.syncNow()
    expect(result.deviceId).toBe(deviceId)
    expect(result.pushedCheckpoint).toBe(false)
    expect(result.pushedOps).toBe(0)
  }, 180_000)

  it('加密快照：导出无明文，导入是合并且重复导入幂等', async () => {
    use('a')
    const before = noteCount()
    await exportEncryptedSnapshot(snapshotFile, PASS2, 12)
    const text = fs.readFileSync(snapshotFile, 'utf8')
    expect(text.startsWith(MAGIC)).toBe(true)
    expect(text).not.toContain('真仓库测试')

    use('c')
    const first = await importEncryptedSnapshot(snapshotFile, PASS2)
    expect(first.stats.notes).toBe(before)
    expect(noteId('真仓库测试（A 的标题）')).not.toBeNull()

    const second = await importEncryptedSnapshot(snapshotFile, PASS2)
    expect(second.stats.notes).toBe(0)
    expect(second.stats.items).toBe(0)
    expect(noteCount()).toBe(before)
  }, 180_000)
})
