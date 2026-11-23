/**
 * GitHub 客户端（PLAN-SYNC §3.7）：只做「这个仓库里读写文件」这一件事。
 *
 * 设计约束：
 * - **错误归一**：调用方只看到 `SyncApiError.code`（`pat_invalid` / `not_found` / …），
 *   不解析 GitHub 的英文错误串；界面按 code 给中文文案。
 * - **条件请求**：`getFile(path, etag)` 会带 `If-None-Match`，304 不占配额。
 * - **两条写路径**：小文件走 Contents API；>1 MB 走 Git Data（blob → tree → commit → ref）。
 * - token 只放在请求头里，绝不进日志/错误信息。
 */

export type SyncApiErrorCode =
  | 'pat_invalid'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'not_private'
  | 'unknown'

export class SyncApiError extends Error {
  code: SyncApiErrorCode
  status: number

  constructor(code: SyncApiErrorCode, status: number, message: string) {
    super(message)
    this.name = 'SyncApiError'
    this.code = code
    this.status = status
  }
}

export interface GitHubConfig {
  token: string
  owner: string
  repo: string
  /** 默认 https://api.github.com；走代理时可改 */
  apiBase?: string
  userAgent?: string
  timeoutMs?: number
}

export interface RemoteFile {
  status: 200 | 304
  sha: string | null
  content: Buffer | null
  etag: string | null
}

export interface RepoInfo {
  private: boolean
  defaultBranch: string
  permissions: { push?: boolean; admin?: boolean } | null
}

export interface DirEntry {
  name: string
  path: string
  sha: string
  type: 'file' | 'dir' | string
}

interface RequestInitLite {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  /** 304 直接返回，不抛错 */
  allow304?: boolean
  signal?: AbortSignal
}

interface RateLimit {
  remaining: number | null
  resetAt: number | null
}

const CONTENT_LIMIT = 1024 * 1024

export class GitHubClient {
  private readonly config: Required<Pick<GitHubConfig, 'token' | 'owner' | 'repo' | 'apiBase' | 'userAgent' | 'timeoutMs'>>
  private rate: RateLimit = { remaining: null, resetAt: null }

  constructor(config: GitHubConfig) {
    this.config = {
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      apiBase: (config.apiBase || 'https://api.github.com').replace(/\/+$/, ''),
      userAgent: config.userAgent || 'WordMemo-sync',
      timeoutMs: config.timeoutMs ?? 30_000
    }
  }

  /** 最近一次响应里的配额（S3 的降级策略会用） */
  get rateLimit(): RateLimit {
    return this.rate
  }

  private repoPath(path = ''): string {
    const suffix = path
      .split('/')
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join('/')
    return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${
      suffix ? `/${suffix}` : ''
    }`
  }

  /** Contents API 的路径：/repos/{owner}/{repo}/contents/{path} */
  private contentsPath(path = ''): string {
    return this.repoPath(`contents${path ? `/${path}` : ''}`)
  }

  private async request<T>(path: string, init: RequestInitLite = {}): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.config.userAgent,
      Authorization: `Bearer ${this.config.token}`,
      ...(init.headers ?? {})
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'

    let response: Response
    try {
      response = await fetch(`${this.config.apiBase}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ?? AbortSignal.timeout(this.config.timeoutMs)
      })
    } catch (error) {
      const name = (error as { name?: string } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SyncApiError('timeout', 0, '连接 GitHub 超时')
      }
      throw new SyncApiError('network', 0, '网络不通，稍后再试')
    }

    this.rate = {
      remaining: toHeaderInt(response.headers.get('x-ratelimit-remaining')),
      resetAt: toHeaderInt(response.headers.get('x-ratelimit-reset'))
    }

    if (response.status === 304 && init.allow304) {
      return { data: null as T, headers: response.headers }
    }
    if (response.ok) {
      const text = await response.text()
      let data: T
      try {
        data = (text ? JSON.parse(text) : null) as T
      } catch {
        throw new SyncApiError('unknown', response.status, 'GitHub 返回了无法解析的内容')
      }
      return { data, headers: response.headers }
    }

    throw await this.errorFor(response)
  }

  private async errorFor(response: Response): Promise<SyncApiError> {
    const status = response.status
    let apiMessage = ''
    try {
      const text = await response.text()
      apiMessage = (JSON.parse(text) as { message?: string })?.message ?? ''
    } catch {
      /* ignore */
    }
    if (status === 401) {
      return new SyncApiError('pat_invalid', status, 'PAT 无效或已过期')
    }
    if (status === 403) {
      const remaining = toHeaderInt(response.headers.get('x-ratelimit-remaining'))
      if (remaining === 0) return new SyncApiError('rate_limited', status, 'GitHub 接口额度用完了')
      return new SyncApiError('forbidden', status, '没有权限访问这个仓库')
    }
    if (status === 404) return new SyncApiError('not_found', status, '仓库或文件不存在')
    if (status === 409 || status === 422) {
      return new SyncApiError('conflict', status, apiMessage || '远端文件冲突')
    }
    if (status === 429) return new SyncApiError('rate_limited', status, '请求太频繁，稍后再试')
    if (status >= 500) return new SyncApiError('server_error', status, 'GitHub 服务器出错')
    return new SyncApiError('unknown', status, apiMessage || `GitHub 返回 ${status}`)
  }

  /** 当前 token 对应的账号（连接时用来确认 PAT 是谁的） */
  async getUser(): Promise<{ login: string }> {
    const { data } = await this.request<{ login: string }>('/user')
    return { login: data.login }
  }

  /** 连接校验：仓库存在、是私有的、有写权限（PLAN-SYNC §3.7 / §7） */
  async getRepo(): Promise<RepoInfo> {
    const { data } = await this.request<{
      private: boolean
      default_branch: string
      permissions?: { push?: boolean; admin?: boolean }
    }>(this.repoPath())
    return {
      private: data.private,
      defaultBranch: data.default_branch,
      permissions: data.permissions ?? null
    }
  }

  /** 读文件；带 etag 时用条件请求，304 返回 status 304 且不解析内容 */
  async getFile(path: string, etag?: string | null): Promise<RemoteFile> {
    const headers: Record<string, string> = {}
    if (etag) headers['If-None-Match'] = etag
    const { data, headers: responseHeaders } = await this.request<{
      sha: string
      content?: string
      encoding?: string
    } | null>(this.contentsPath(path), { headers, allow304: true })
    if (!data) {
      return { status: 304, sha: null, content: null, etag: responseHeaders.get('etag') }
    }
    const content = data.content ? Buffer.from(data.content.replace(/\s+/g, ''), 'base64') : null
    return { status: 200, sha: data.sha, content, etag: responseHeaders.get('etag') }
  }

  /** 写文件（小文件走 Contents API）；sha 不传 = 新建 */
  async putFile(
    path: string,
    content: Buffer,
    message: string,
    sha?: string | null,
    branch?: string
  ): Promise<{ sha: string }> {
    if (content.byteLength > CONTENT_LIMIT) {
      throw new SyncApiError('unknown', 0, '文件超过 1 MB，应走 Git Data 路径')
    }
    const body: Record<string, unknown> = {
      message,
      content: content.toString('base64')
    }
    if (sha) body.sha = sha
    if (branch) body.branch = branch
    const { data } = await this.request<{ content?: { sha?: string } }>(this.contentsPath(path), {
      method: 'PUT',
      body
    })
    const resultSha = data?.content?.sha
    if (!resultSha) throw new SyncApiError('unknown', 0, 'GitHub 没有返回新的文件 sha')
    return { sha: resultSha }
  }

  async deleteFile(path: string, sha: string, message: string, branch?: string): Promise<void> {
    const body: Record<string, unknown> = { message, sha }
    if (branch) body.branch = branch
    await this.request(this.contentsPath(path), { method: 'DELETE', body })
  }

  /** 列目录（远端 devices/ 下有哪些设备） */
  async listDir(path: string): Promise<DirEntry[]> {
    const { data } = await this.request<DirEntry[] | { name: string; path: string; sha: string; type: string }>(
      this.contentsPath(path)
    )
    if (!Array.isArray(data)) throw new SyncApiError('not_found', 404, '远端目录不存在')
    return data.map((entry) => ({
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      type: entry.type
    }))
  }

  /** 分支当前 commit（空仓库返回 null） */
  async getRef(branch: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ object?: { sha?: string } }>(
        `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/git/ref/heads/${encodeURIComponent(branch)}`
      )
      return data?.object?.sha ?? null
    } catch (error) {
      if (error instanceof SyncApiError && (error.code === 'not_found' || error.code === 'conflict')) {
        return null
      }
      throw error
    }
  }

  /**
   * >1 MB 的文件走 Git Data（§3.7）：blob → tree → commit → 移动 ref。
   * 空仓库（还没有分支）时创建首个 commit 和 ref。
   */
  async putLargeFile(
    path: string,
    content: Buffer,
    message: string,
    branch = 'main'
  ): Promise<{ commit: string }> {
    const repoPrefix = `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`
    const { data: blob } = await this.request<{ sha: string }>(`${repoPrefix}/git/blobs`, {
      method: 'POST',
      body: { content: content.toString('base64'), encoding: 'base64' }
    })
    const head = await this.getRef(branch)
    const treeEntries = [{ path, mode: '100644', type: 'blob', sha: blob.sha }]

    let baseTree: string | undefined
    let parents: string[] = []
    if (head) {
      const { data: commit } = await this.request<{ tree?: { sha?: string } }>(
        `${repoPrefix}/git/commits/${head}`
      )
      baseTree = commit?.tree?.sha
      parents = [head]
    }

    const { data: tree } = await this.request<{ sha: string }>(`${repoPrefix}/git/trees`, {
      method: 'POST',
      body: baseTree ? { base_tree: baseTree, tree: treeEntries } : { tree: treeEntries }
    })
    const { data: commit } = await this.request<{ sha: string }>(`${repoPrefix}/git/commits`, {
      method: 'POST',
      body: { message, tree: tree.sha, parents }
    })
    if (head) {
      await this.request(`${repoPrefix}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false }
      })
    } else {
      await this.request(`${repoPrefix}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: commit.sha }
      })
    }
    return { commit: commit.sha }
  }
}

function toHeaderInt(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
