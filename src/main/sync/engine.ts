import {
  applyRemoteOps,
  exportCheckpoint,
  mergeCheckpoint,
  validateCheckpoint,
  type MergeStats,
  type RemoteSyncOp,
  type SyncCheckpoint
} from '../db/checkpoint'
import { getDb, localDate, localIso, toInt } from '../db/connection'
import { getSyncState, pendingSyncOps, updateSyncState } from '../db/sync'
import { SYNC_FORMAT_VERSION } from '@shared/sync'
import {
  decryptEnvelope,
  encryptEnvelope,
  kdfVerifier,
  makeSalt,
  verifyKdfVerifier,
  DEFAULT_SCRYPT_WORK_FACTOR
} from './crypto'
import { GitHubClient, SyncApiError } from './github'

/**
 * 同步引擎（PLAN-SYNC S2）：一次 `syncNow()` = 连上仓库 → 推本地变更 → 拉别的设备。
 *
 * 远端布局（§3.6）：
 *   meta.json                                  明文：salt + kdfVerifier + formatVersion
 *   devices/<deviceId>/checkpoint.json.age     全量状态（首次同步 / 攒够 op / 超过 7 天）
 *   devices/<deviceId>/ops/YYYYMMDD.jsonl.age  当天的本地 op（每次推送重写这一天的文件）
 *   devices/<deviceId>/info.json.age           设备名（给设备列表用）
 *
 * 拉取顺序固定：先 checkpoint 再 ops（op 是 checkpoint 之后的增量）。
 */

export type SyncSetupCode =
  | 'bad_passphrase'
  | 'not_private'
  | 'no_write_access'
  | 'format_too_new'
  | 'bad_meta'

export class SyncSetupError extends Error {
  code: SyncSetupCode

  constructor(code: SyncSetupCode, message: string) {
    super(message)
    this.name = 'SyncSetupError'
    this.code = code
  }
}

export interface SyncSettings {
  owner: string
  repo: string
  token: string
  passphrase: string
  apiBase?: string
  /** 测试用：把 age 的 scrypt work factor 调低；生产不传 */
  workFactor?: number
}

export interface MetaFile {
  formatVersion: number
  salt: string
  kdfVerifier: string
  createdAt: string
  app: 'WordMemo'
}

export interface SyncResult {
  deviceId: string
  pushedOps: number
  pushedCheckpoint: boolean
  peers: number
  pulledCheckpoints: number
  pulledOpsFiles: number
  appliedOps: number
  merged: MergeStats[]
  startedAt: string
  finishedAt: string
}

/** 攒够这么多 op 或超过 7 天就重写 checkpoint，否则只追加当天的 op 分片 */
const CHECKPOINT_EVERY_OPS = 200
const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 3_600_000

interface CacheEntry {
  sha: string | null
  etag: string | null
}

function cacheGet(path: string): CacheEntry | undefined {
  const row = getDb()
    .prepare('SELECT sha, etag FROM sync_files WHERE path = ?')
    .get(path) as { sha: string | null; etag: string | null } | undefined
  return row ?? undefined
}

function cachePut(path: string, sha: string | null, etag: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO sync_files (path, sha, etag, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, etag = excluded.etag, updated_at = excluded.updated_at`
    )
    .run(path, sha, etag, localIso())
}

function cacheUpdatedAt(path: string): number {
  const row = getDb().prepare('SELECT updated_at FROM sync_files WHERE path = ?').get(path) as
    | { updated_at?: string }
    | undefined
  const ts = row?.updated_at ? Date.parse(row.updated_at) : NaN
  return Number.isFinite(ts) ? ts : 0
}

function dayRange(now = new Date()): { start: number; end: number; day: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return {
    start: start.getTime(),
    end: start.getTime() + 24 * 3_600_000,
    day: localDate(now).replace(/-/g, '')
  }
}

interface DayOpRow {
  seq: number
  uid: string
  entity: string
  op: string
  fields: string
  ts_utc: number
}

function dayOps(now = new Date()): DayOpRow[] {
  const { start, end } = dayRange(now)
  return getDb()
    .prepare(
      `SELECT seq, uid, entity, op, fields, ts_utc FROM sync_ops
       WHERE origin = 'local' AND ts_utc >= ? AND ts_utc < ? ORDER BY seq ASC`
    )
    .all(start, end) as unknown as DayOpRow[]
}

export class SyncEngine {
  private readonly client: GitHubClient
  private readonly workFactor: number
  private meta: MetaFile | null = null

  constructor(private readonly settings: SyncSettings) {
    this.workFactor = settings.workFactor ?? DEFAULT_SCRYPT_WORK_FACTOR
    this.client = new GitHubClient({
      token: settings.token,
      owner: settings.owner,
      repo: settings.repo,
      apiBase: settings.apiBase
    })
  }

  get rateLimit(): { remaining: number | null; resetAt: number | null } {
    return this.client.rateLimit
  }

  /** 连接校验：PAT 是谁的、仓库是否私有可写、口令与 meta.json 是否一致 */
  async connect(): Promise<{
    login: string
    repo: { private: boolean; defaultBranch: string }
  }> {
    const user = await this.client.getUser()
    const repo = await this.client.getRepo()
    if (!repo.private) {
      throw new SyncSetupError('not_private', '这个仓库是公开的：同步只支持私有仓库')
    }
    if (repo.permissions && repo.permissions.push === false) {
      throw new SyncSetupError('no_write_access', '这个 PAT 没有写权限（需要 Contents: Read and write）')
    }
    this.meta = await this.ensureMeta()
    return { login: user.login, repo: { private: repo.private, defaultBranch: repo.defaultBranch } }
  }

  private async ensureMeta(): Promise<MetaFile> {
    let remote: { sha: string | null; content: Buffer | null; etag: string | null } | null = null
    try {
      const file = await this.client.getFile('meta.json')
      if (file.status === 200) remote = file
    } catch (error) {
      if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
    }

    if (remote?.content) {
      let meta: MetaFile
      try {
        meta = JSON.parse(remote.content.toString('utf8')) as MetaFile
      } catch {
        throw new SyncSetupError('bad_meta', '远端 meta.json 损坏，无法同步')
      }
      if (toInt(meta.formatVersion) !== SYNC_FORMAT_VERSION) {
        throw new SyncSetupError(
          'format_too_new',
          `远端格式版本 ${meta.formatVersion} 与本机（${SYNC_FORMAT_VERSION}）不一致，请升级 WordMemo`
        )
      }
      if (!verifyKdfVerifier(this.settings.passphrase, String(meta.salt), String(meta.kdfVerifier))) {
        throw new SyncSetupError('bad_passphrase', '同步密码不对')
      }
      cachePut('meta.json', remote.sha, remote.etag)
      return meta
    }

    // 新仓库：写入 salt + kdfVerifier，之后每台设备都靠它校验口令
    const salt = makeSalt()
    const meta: MetaFile = {
      formatVersion: SYNC_FORMAT_VERSION,
      salt,
      kdfVerifier: kdfVerifier(this.settings.passphrase, salt),
      createdAt: localIso(),
      app: 'WordMemo'
    }
    const content = Buffer.from(JSON.stringify(meta, null, 2), 'utf8')
    const { sha } = await this.client.putFile('meta.json', content, 'sync: init meta')
    cachePut('meta.json', sha, null)
    return meta
  }

  /** 推一次设备信息（设备列表用；失败不影响同步） */
  async pushInfo(): Promise<void> {
    const state = getSyncState()
    const path = `devices/${state.deviceId}/info.json.age`
    const file = await encryptEnvelope(
      {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'info',
        path,
        deviceId: state.deviceId,
        createdAt: localIso()
      },
      { name: state.deviceName, lastSeenAt: localIso() },
      this.settings.passphrase,
      this.workFactor
    )
    const cached = cacheGet(path)
    const { sha } = await this.client.putFile(
      path,
      file,
      `sync: ${state.deviceId.slice(0, 6)} info`,
      cached?.sha ?? null
    )
    cachePut(path, sha, null)
  }

  /**
   * 一次完整同步。任何一步失败都会抛出（网络错误是 `SyncApiError`，口令/仓库问题是
   * `SyncSetupError`）；已经成功的推送/拉取保持已提交状态，下次可以接着来。
   */
  async syncNow(): Promise<SyncResult> {
    const startedAt = localIso()
    if (!this.meta) await this.connect()
    const state = getSyncState()
    const result: SyncResult = {
      deviceId: state.deviceId,
      pushedOps: 0,
      pushedCheckpoint: false,
      peers: 0,
      pulledCheckpoints: 0,
      pulledOpsFiles: 0,
      appliedOps: 0,
      merged: [],
      startedAt,
      finishedAt: startedAt
    }

    await this.pushInfo()
    await this.push(state.deviceId, result)
    await this.pull(state.deviceId, result)

    result.finishedAt = localIso()
    updateSyncState({ lastPushAt: result.finishedAt, lastPullAt: result.finishedAt })
    return result
  }

  /* ------------------------------ 推送 ------------------------------ */

  private async push(deviceId: string, result: SyncResult): Promise<void> {
    const checkpointPath = `devices/${deviceId}/checkpoint.json.age`
    const pending = pendingSyncOps(100_000)
    const rows = dayOps()
    const lastCheckpoint = cacheUpdatedAt(checkpointPath)
    const needCheckpoint =
      !cacheGet(checkpointPath) ||
      pending.length >= CHECKPOINT_EVERY_OPS ||
      (rows.length > 0 && Date.now() - lastCheckpoint > CHECKPOINT_MAX_AGE_MS)

    if (needCheckpoint && (rows.length > 0 || pending.length > 0 || !cacheGet(checkpointPath))) {
      await this.pushCheckpoint(deviceId, checkpointPath)
      getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE origin = 'local'").run()
      result.pushedCheckpoint = true
      result.pushedOps = rows.length
      return
    }

    if (!rows.length) return
    const path = `devices/${deviceId}/ops/${dayRange().day}.jsonl.age`
    const ops: RemoteSyncOp[] = rows.map((row) => ({
      entity: row.entity as RemoteSyncOp['entity'],
      uid: row.uid,
      op: row.op as RemoteSyncOp['op'],
      fields: JSON.parse(row.fields || '{}') as Record<string, unknown>,
      tsUtc: toInt(row.ts_utc)
    }))
    const file = await encryptEnvelope(
      {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'ops',
        path,
        deviceId,
        createdAt: localIso()
      },
      { ops },
      this.settings.passphrase,
      this.workFactor
    )
    const cached = cacheGet(path)
    const { sha } = await this.client.putFile(
      path,
      file,
      `sync: ${deviceId.slice(0, 6)} ops`,
      cached?.sha ?? null
    )
    cachePut(path, sha, null)
    const maxSeq = Math.max(...rows.map((row) => row.seq))
    getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE origin = 'local' AND seq <= ?").run(maxSeq)
    result.pushedOps = rows.length
  }

  private async pushCheckpoint(deviceId: string, path: string): Promise<void> {
    const checkpoint: SyncCheckpoint = exportCheckpoint('checkpoint')
    const file = await encryptEnvelope(
      {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'checkpoint',
        path,
        deviceId,
        createdAt: checkpoint.createdAt
      },
      checkpoint,
      this.settings.passphrase,
      this.workFactor
    )
    const cached = cacheGet(path)
    const { sha } = await this.client.putFile(
      path,
      file,
      `sync: ${deviceId.slice(0, 6)} checkpoint`,
      cached?.sha ?? null
    )
    cachePut(path, sha, null)
  }

  /* ------------------------------ 拉取 ------------------------------ */

  private async pull(deviceId: string, result: SyncResult): Promise<void> {
    let devices: { name: string; type: string }[] = []
    try {
      devices = await this.client.listDir('devices')
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return
      throw error
    }

    const peers = devices.filter((entry) => entry.type === 'dir' && entry.name !== deviceId)
    result.peers = peers.length
    for (const peer of peers) {
      await this.pullCheckpoint(peer.name, result)
      await this.pullOps(peer.name, result)
    }
  }

  private async pullCheckpoint(peer: string, result: SyncResult): Promise<void> {
    const path = `devices/${peer}/checkpoint.json.age`
    const cached = cacheGet(path)
    let file: { status: 200 | 304; sha: string | null; content: Buffer | null; etag: string | null }
    try {
      file = await this.client.getFile(path, cached?.etag)
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return
      throw error
    }
    if (file.status === 304 || !file.content) return
    const envelope = await decryptEnvelope<unknown>(file.content, this.settings.passphrase, {
      kind: 'checkpoint',
      path
    })
    const checkpoint = validateCheckpoint(envelope.payload)
    result.merged.push(mergeCheckpoint(checkpoint))
    result.pulledCheckpoints++
    cachePut(path, file.sha, file.etag)
    getDb()
      .prepare(
        `INSERT INTO sync_devices (device_id, name, last_seen_at, last_checkpoint_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at,
           last_checkpoint_at = excluded.last_checkpoint_at`
      )
      .run(peer, checkpoint.deviceName ?? null, localIso(), checkpoint.createdAt ?? null)
  }

  private async pullOps(peer: string, result: SyncResult): Promise<void> {
    let files: { path: string; name: string }[] = []
    try {
      files = await this.client.listDir(`devices/${peer}/ops`)
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return
      throw error
    }
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
      const cached = cacheGet(file.path)
      let remote: { status: 200 | 304; sha: string | null; content: Buffer | null; etag: string | null }
      try {
        remote = await this.client.getFile(file.path, cached?.etag)
      } catch (error) {
        if (error instanceof SyncApiError && error.code === 'not_found') continue
        throw error
      }
      if (remote.status === 304 || !remote.content) continue
      const envelope = await decryptEnvelope<{ ops: RemoteSyncOp[] }>(
        remote.content,
        this.settings.passphrase,
        { kind: 'ops', path: file.path }
      )
      const ops = Array.isArray(envelope.payload?.ops) ? envelope.payload.ops : []
      result.appliedOps += applyRemoteOps(ops, `remote:${peer}`)
      result.pulledOpsFiles++
      cachePut(file.path, remote.sha, remote.etag)
      getDb()
        .prepare(
          `INSERT INTO sync_devices (device_id, name, last_seen_at) VALUES (?, NULL, ?)
           ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
        )
        .run(peer, localIso())
    }
  }
}
