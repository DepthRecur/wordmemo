import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createNote, updateNote } from '../src/main/db/notes'
import { upsertItem } from '../src/main/db/items'
import { applyReview } from '../src/main/db/cards'
import { SyncEngine, SyncSetupError } from '../src/main/sync/engine'

// S2 的传输引擎：两个「设备」（两个库文件）对着一个内存里的假 GitHub 仓库同步。
// 覆盖 meta.json（salt/kdfVerifier）、checkpoint 推送/拉取、当天 op 分片、
// 口令错误与公开仓库拒绝。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-engine-'))
const dbA = path.join(dir, 'a.db')
const dbB = path.join(dir, 'b.db')
const PASS = 'cobalt-tiger-lantern-vivid-otter'

let server: http.Server
let base = ''
let repoPrivate = true
const files = new Map<string, { content: Buffer; sha: string }>()
let shaCounter = 0

function shaOf(content: Buffer): string {
  shaCounter++
  return createHash('sha1').update(content).update(String(shaCounter)).digest('hex')
}

function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function repoPrefix(): string {
  return '/repos/DepthRecur/wordmemo-sync-test'
}

function listDir(prefix: string): { name: string; path: string; sha: string; type: string }[] {
  const entries = new Map<string, 'file' | 'dir'>()
  for (const key of files.keys()) {
    if (!key.startsWith(`${prefix}/`)) continue
    const rest = key.slice(prefix.length + 1)
    const parts = rest.split('/')
    if (!parts[0]) continue
    entries.set(parts[0], parts.length > 1 ? 'dir' : 'file')
  }
  return [...entries.entries()].map(([name, type]) => ({
    name,
    path: `${prefix}/${name}`,
    sha: shaOf(Buffer.from(name)),
    type
  }))
}

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = decodeURIComponent(req.url ?? '')
      const body = Buffer.concat(chunks).toString('utf8')
      const method = req.method ?? 'GET'

      if (url === '/user') return send(res, 200, { login: 'tester' })
      if (url === repoPrefix()) {
        return send(res, 200, {
          private: repoPrivate,
          default_branch: 'main',
          permissions: { push: true, admin: true }
        })
      }
      const contentsPrefix = `${repoPrefix()}/contents/`
      if (url.startsWith(contentsPrefix)) {
        const filePath = url.slice(contentsPrefix.length)
        if (method === 'GET') {
          const entry = files.get(filePath)
          if (entry) {
            if (req.headers['if-none-match'] === entry.sha) {
              res.writeHead(304, { etag: entry.sha })
              return res.end()
            }
            return send(
              res,
              200,
              { sha: entry.sha, content: entry.content.toString('base64'), encoding: 'base64' },
              { etag: entry.sha }
            )
          }
          const children = listDir(filePath)
          if (children.length) return send(res, 200, children)
          return send(res, 404, { message: 'Not Found' })
        }
        if (method === 'DELETE') {
          const existing = files.get(filePath)
          if (!existing) return send(res, 404, { message: 'Not Found' })
          files.delete(filePath)
          return send(res, 200, { commit: { sha: shaOf(Buffer.from(filePath)) } })
        }
        if (method === 'PUT') {
          const payload = JSON.parse(body) as { content: string; sha?: string }
          const existing = files.get(filePath)
          // 带 sha 但文件已经不存在（被别的设备删了）：和真实 GitHub 一样冲突
          if (payload.sha && (!existing || existing.sha !== payload.sha)) {
            return send(res, 409, { message: 'sha mismatch' })
          }
          if (!payload.sha && existing) return send(res, 422, { message: 'sha required' })
          const content = Buffer.from(payload.content, 'base64')
          const sha = shaOf(content)
          files.set(filePath, { content, sha })
          return send(res, 200, { content: { sha } })
        }
      }
      send(res, 404, { message: `unhandled ${method} ${url}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  base = `http://127.0.0.1:${address.port}`
  openDb(dbA)
})

afterAll(() => {
  closeDb()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function engineWith(passphrase: string): SyncEngine {
  return new SyncEngine({
    owner: 'DepthRecur',
    repo: 'wordmemo-sync-test',
    token: 'test-token',
    passphrase,
    apiBase: base,
    // 测试里降低 age 的 scrypt work factor（生产默认 18）
    workFactor: 12
  })
}

function engine(): SyncEngine {
  return engineWith(PASS)
}

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[]
}

describe('传输引擎：两台设备对着假仓库同步', () => {
  it('A 首次同步：建 meta、推 checkpoint、写设备信息', async () => {
    const noteId = createNote({ title: '第一课', tags: ['t'], rawMarkdown: '# 第一课' })
    const itemId = upsertItem({
      kind: 'word',
      headword: 'transport',
      meanings: ['运输'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    const card = q<{ id: number }>('SELECT id FROM cards WHERE item_id = ? ORDER BY id LIMIT 1', itemId)[0]
    await new Promise((resolve) => setTimeout(resolve, 20))
    applyReview(
      {
        cardId: card.id,
        rating: 3,
        answer: 'transport',
        correct: true,
        elapsedMs: 700,
        mode: 'longterm',
        judgeBy: 'self'
      },
      new Date('2026-11-23T10:00:00')
    )

    const a = engine()
    const connected = await a.connect()
    expect(connected.login).toBe('tester')
    expect(connected.repo.private).toBe(true)

    const result = await a.syncNow()
    expect(result.pushedCheckpoint).toBe(true)
    expect(result.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(files.has('meta.json')).toBe(true)
    expect([...files.keys()].some((key) => key.endsWith('/checkpoint.json.age'))).toBe(true)
    // D-01：还要留一份月度归档（checkpoint-YYYYMM.json.age），保留策略见 checkpointKeep
    expect([...files.keys()].some((key) => /\/checkpoint-\d{6}\.json\.age$/.test(key))).toBe(true)
    expect([...files.keys()].some((key) => key.endsWith('/info.json.age'))).toBe(true)

    const meta = JSON.parse(files.get('meta.json')!.content.toString('utf8'))
    expect(meta.formatVersion).toBe(1)
    expect(meta.kdfVerifier).toMatch(/^[0-9a-f]{32}$/)
  })

  it('B 首次同步：拉 A 的 checkpoint，内容齐全；再同步时不重复应用', async () => {
    closeDb()
    openDb(dbB)
    const b = engine()
    await b.connect()
    const first = await b.syncNow()
    expect(first.peers).toBe(1)
    expect(first.pulledCheckpoints).toBe(1)
    const note = q('SELECT title FROM notes')[0]
    expect(note.title).toBe('第一课')
    expect(q('SELECT meanings FROM items')[0]).toBeTruthy()

    const second = await b.syncNow()
    expect(second.pulledCheckpoints).toBe(0)
    expect(second.merged).toHaveLength(0)
  })

  it('B 改一条 → 推当天 op 分片；A 拉到并应用', async () => {
    const note = q<{ id: number }>('SELECT id FROM notes')[0]
    updateNote(note.id, { title: '第一课（B 改）' })
    upsertItem({
      kind: 'word',
      headword: 'transport',
      meanings: ['运输方式'],
      noteId: note.id,
      position: 0,
      listenEnabled: false
    })

    const b = engine()
    const pushed = await b.syncNow()
    expect(pushed.pushedCheckpoint).toBe(false)
    expect(pushed.pushedOps).toBeGreaterThan(0)
    expect([...files.keys()].some((key) => key.includes('/ops/'))).toBe(true)

    closeDb()
    openDb(dbA)
    const a = engine()
    const pulled = await a.syncNow()
    expect(pulled.pulledOpsFiles).toBeGreaterThan(0)
    expect(pulled.appliedOps).toBeGreaterThan(0)
    expect(q<{ title: string }>('SELECT title FROM notes')[0].title).toBe('第一课（B 改）')

    // 再同步一次：已经应用过，没有新改动
    const again = await a.syncNow()
    expect(again.appliedOps).toBe(0)
  })

  it('口令不对：连 meta 校验都过不去', async () => {
    const wrong = new SyncEngine({
      owner: 'DepthRecur',
      repo: 'wordmemo-sync-test',
      token: 'test-token',
      passphrase: 'definitely-not-the-passphrase',
      apiBase: base,
      workFactor: 12
    })
    const error = await wrong.connect().catch((err) => err)
    expect(error).toBeInstanceOf(SyncSetupError)
    expect(error.code).toBe('bad_passphrase')
  })

  it('公开仓库：直接拒绝', async () => {
    repoPrivate = false
    try {
      const error = await engine().connect().catch((err) => err)
      expect(error).toBeInstanceOf(SyncSetupError)
      expect(error.code).toBe('not_private')
    } finally {
      repoPrivate = true
    }
  })
})

describe('S3：设备管理、换密码与压缩', () => {
  const NEW_PASS = 'granite-harbor-tulip-orbit-zephyr'
  let peerId = ''
  let aDeviceId = ''
  let oldVerifier = ''

  it('设备列表包含本机与对端', async () => {
    const a = engine()
    await a.connect()
    const devices = await a.listDevices()
    expect(devices.some((device) => device.isCurrent)).toBe(true)
    const peer = devices.find((device) => !device.isCurrent)
    expect(peer).toBeTruthy()
    peerId = peer!.id
    aDeviceId = devices.find((device) => device.isCurrent)!.id
    oldVerifier = JSON.parse(files.get('meta.json')!.content.toString('utf8')).kdfVerifier
  })

  it('先产生 op 分片；换密码后本机 checkpoint 覆盖历史并删掉分片与其它设备', async () => {
    const note = q<{ id: number }>('SELECT id FROM notes ORDER BY id LIMIT 1')[0]
    updateNote(note.id, { title: 'S3 换密码前' })
    const a = engine()
    await a.connect()
    const pushed = await a.syncNow()
    expect(pushed.pushedCheckpoint).toBe(false)
    expect(pushed.pushedOps).toBeGreaterThan(0)
    expect([...files.keys()].some((key) => key.startsWith(`devices/${aDeviceId}/ops/`))).toBe(true)

    const changer = engine()
    await changer.connect()
    await changer.changePassphrase(NEW_PASS)

    // 压缩：本机 op 分片被删
    expect([...files.keys()].some((key) => key.startsWith(`devices/${aDeviceId}/ops/`))).toBe(false)
    // 其它设备的目录被删（旧密码加密，换完读不了）
    expect([...files.keys()].some((key) => key.startsWith(`devices/${peerId}/`))).toBe(false)
    // meta 校验值换成新密码的
    const meta = JSON.parse(files.get('meta.json')!.content.toString('utf8'))
    expect(meta.kdfVerifier).not.toBe(oldVerifier)
  })

  it('旧密码连不上；新密码让对端重新加入（缓存 sha 失效时自动重建）', async () => {
    closeDb()
    openDb(dbB)
    const oldEngine = engine()
    const oldError = await oldEngine.connect().catch((error) => error)
    expect(oldError).toBeInstanceOf(SyncSetupError)
    expect(oldError.code).toBe('bad_passphrase')

    const rejoined = engineWith(NEW_PASS)
    await rejoined.connect()
    const pushed = await rejoined.syncNow()
    expect(pushed.pushedCheckpoint).toBe(true)
    expect(
      [...files.keys()].some((key) => key.startsWith(`devices/${peerId}/checkpoint`))
    ).toBe(true)
  })

  it('移除设备：远端目录消失、列表标成已移除、对端被拒绝', async () => {
    closeDb()
    openDb(dbA)
    const a = engineWith(NEW_PASS)
    await a.connect()
    const devices = await a.listDevices()
    const peer = devices.find((device) => !device.isCurrent && !device.revoked)
    expect(peer).toBeTruthy()
    await a.removeDevice(peer!.id)
    expect([...files.keys()].some((key) => key.startsWith(`devices/${peer!.id}/`))).toBe(false)
    const after = await a.listDevices()
    expect(after.find((device) => device.id === peer!.id)?.revoked).toBe(true)

    closeDb()
    openDb(dbB)
    const b = engineWith(NEW_PASS)
    const error = await b.connect().catch((err) => err)
    expect(error).toBeInstanceOf(SyncSetupError)
    expect(error.code).toBe('device_revoked')
  })
})
