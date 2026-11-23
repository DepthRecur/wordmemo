import http from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GitHubClient, SyncApiError } from '../src/main/sync/github'

// S2 的 GitHub 客户端（PLAN-SYNC §3.7）：用本地 mock 服务器覆盖状态码、条件请求、
// 错误归一与 Git Data 大文件路径。这里不连真网。

interface Recorded {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

let server: http.Server
let base = ''
let recorded: Recorded[] = []
let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(text)
}

function client(timeoutMs = 500): GitHubClient {
  return new GitHubClient({
    token: 'test-token',
    owner: 'DepthRecur',
    repo: 'wordmemo-sync-test',
    apiBase: base,
    timeoutMs
  })
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  base = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  recorded = []
  handler = (_req, res) => sendJson(res, 500, { message: 'no handler' })
})

describe('GitHubClient：读', () => {
  it('getRepo 带认证头，返回私有标记与权限', async () => {
    handler = (_req, res) =>
      sendJson(res, 200, {
        private: true,
        default_branch: 'main',
        permissions: { push: true, admin: true }
      })
    const repo = await client().getRepo()
    expect(repo).toEqual({ private: true, defaultBranch: 'main', permissions: { push: true, admin: true } })
    const request = recorded[0]
    expect(request.url).toBe('/repos/DepthRecur/wordmemo-sync-test')
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['user-agent']).toBe('WordMemo-sync')
    expect(request.headers.accept).toBe('application/vnd.github+json')
  })

  it('getFile 解码 base64，并在第二次带 If-None-Match 拿到 304', async () => {
    handler = (req, res) => {
      if (req.headers['if-none-match'] === '"E1"') {
        res.writeHead(304, { etag: '"E1"' })
        res.end()
        return
      }
      sendJson(
        res,
        200,
        { sha: 'sha1', content: Buffer.from('hello world').toString('base64'), encoding: 'base64' },
        { etag: '"E1"' }
      )
    }
    const gh = client()
    const first = await gh.getFile('devices/dev1/checkpoint.json.age')
    expect(first.status).toBe(200)
    expect(first.sha).toBe('sha1')
    expect(first.content?.toString('utf8')).toBe('hello world')
    expect(first.etag).toBe('"E1"')

    const second = await gh.getFile('devices/dev1/checkpoint.json.age', first.etag)
    expect(second.status).toBe(304)
    expect(second.content).toBeNull()
    expect(recorded[1].headers['if-none-match']).toBe('"E1"')
  })

  it('listDir 解析目录项；返回非数组时报 not_found', async () => {
    handler = (_req, res) =>
      sendJson(res, 200, [
        { name: 'dev1', path: 'devices/dev1', sha: 's1', type: 'dir' },
        { name: 'dev2', path: 'devices/dev2', sha: 's2', type: 'dir' }
      ])
    const entries = await client().listDir('devices')
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ name: 'dev2', path: 'devices/dev2', type: 'dir' })

    handler = (_req, res) => sendJson(res, 200, { message: 'not a list' })
    await expect(client().listDir('devices')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('GitHubClient：写', () => {
  it('putFile 带 sha 更新、内容 base64、返回新 sha', async () => {
    handler = (_req, res) => sendJson(res, 200, { content: { sha: 'new-sha' } })
    const result = await client().putFile(
      'devices/dev1/info.json.age',
      Buffer.from('abc'),
      'sync: dev1',
      'old-sha',
      'main'
    )
    expect(result.sha).toBe('new-sha')
    const request = recorded[0]
    expect(request.method).toBe('PUT')
    const body = JSON.parse(request.body)
    expect(body).toMatchObject({ message: 'sync: dev1', sha: 'old-sha', branch: 'main' })
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('abc')
  })

  it('deleteFile 带 sha 发 DELETE', async () => {
    handler = (_req, res) => sendJson(res, 200, { commit: { sha: 'c1' } })
    await client().deleteFile('devices/dev1/info.json.age', 'sha1', 'remove device')
    expect(recorded[0].method).toBe('DELETE')
    expect(JSON.parse(recorded[0].body)).toMatchObject({ sha: 'sha1', message: 'remove device' })
  })

  it('putLargeFile 走 blob → tree → commit → ref', async () => {
    handler = (req, res) => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url.endsWith('/git/blobs')) return sendJson(res, 201, { sha: 'blob1' })
      if (req.method === 'GET' && url.includes('/git/ref/heads/')) {
        return sendJson(res, 200, { object: { sha: 'head1' } })
      }
      if (req.method === 'GET' && url.includes('/git/commits/')) {
        return sendJson(res, 200, { tree: { sha: 'tree0' } })
      }
      if (req.method === 'POST' && url.endsWith('/git/trees')) return sendJson(res, 201, { sha: 'tree1' })
      if (req.method === 'POST' && url.endsWith('/git/commits')) return sendJson(res, 201, { sha: 'commit1' })
      if (req.method === 'PATCH' && url.includes('/git/refs/heads/')) return sendJson(res, 200, {})
      return sendJson(res, 500, { message: `unexpected ${req.method} ${url}` })
    }
    const result = await client().putLargeFile('devices/dev1/checkpoint.json.age', Buffer.from('x'), 'sync: big')
    expect(result.commit).toBe('commit1')
    expect(recorded.map((r) => `${r.method} ${r.url.split('/').pop()}`)).toEqual([
      'POST blobs',
      'GET main',
      'GET head1',
      'POST trees',
      'POST commits',
      'PATCH main'
    ])
    const treeBody = JSON.parse(recorded[3].body)
    expect(treeBody.base_tree).toBe('tree0')
    expect(treeBody.tree[0]).toMatchObject({ path: 'devices/dev1/checkpoint.json.age', sha: 'blob1' })
  })
})

describe('GitHubClient：错误归一', () => {
  const cases: { status: number; code: string; headers?: Record<string, string> }[] = [
    { status: 401, code: 'pat_invalid' },
    { status: 403, code: 'forbidden' },
    { status: 403, code: 'rate_limited', headers: { 'x-ratelimit-remaining': '0' } },
    { status: 404, code: 'not_found' },
    { status: 409, code: 'conflict' },
    { status: 422, code: 'conflict' },
    { status: 429, code: 'rate_limited' },
    { status: 500, code: 'server_error' }
  ]

  for (const item of cases) {
    it(`${item.status} → ${item.code}`, async () => {
      handler = (_req, res) => sendJson(res, item.status, { message: 'api says no' }, item.headers)
      const error = await client().getRepo().catch((err) => err)
      expect(error).toBeInstanceOf(SyncApiError)
      expect(error.code).toBe(item.code)
      expect(error.status).toBe(item.status)
      // token 绝不能出现在错误信息里
      expect(error.message).not.toContain('test-token')
    })
  }

  it('连不上 → network；超时 → timeout', async () => {
    const offline = new GitHubClient({
      token: 'test-token',
      owner: 'DepthRecur',
      repo: 'wordmemo-sync-test',
      apiBase: 'http://127.0.0.1:1',
      timeoutMs: 300
    })
    await expect(offline.getRepo()).rejects.toMatchObject({ code: 'network' })

    handler = (_req, res) => {
      setTimeout(() => sendJson(res, 200, { private: true }), 400)
    }
    await expect(client(100).getRepo()).rejects.toMatchObject({ code: 'timeout' })
  })
})
