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
import type { SyncDeviceInfo } from '@shared/types'
import {
  decryptEnvelope,
  encryptEnvelope,
  kdfVerifier,
  makeSalt,
  verifyKdfVerifier,
  DEFAULT_SCRYPT_WORK_FACTOR
} from './crypto'
import { GitHubClient, SyncApiError } from './github'
import { monthStamp, pickObsoleteArchives } from './checkpointKeep'

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
  | 'device_revoked'
  | 'bad_input'

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
  /** 已移除的设备：不再拉取；它自己下次同步会被拒绝（S3） */
  revokedDevices?: string[]
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

function cacheDrop(path: string): void {
  getDb().prepare('DELETE FROM sync_files WHERE path = ?').run(path)
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
  private repoSizeKb: number | null = null

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

  /** 远端仓库体积（KB；拿不到就是 null） */
  get repositorySizeKb(): number | null {
    return this.repoSizeKb
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
    this.repoSizeKb = repo.sizeKb
    this.meta = await this.ensureMeta()
    this.assertNotRevoked(this.meta)
    return { login: user.login, repo: { private: repo.private, defaultBranch: repo.defaultBranch } }
  }

  /** 解析并校验一份 meta.json（格式版本 + 口令） */
  private parseMeta(content: Buffer): MetaFile {
    let meta: MetaFile
    try {
      meta = JSON.parse(content.toString('utf8')) as MetaFile
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
    return meta
  }

  /** 这台设备是否已经被其它设备移除（它自己下次同步必须被拒绝） */
  private assertNotRevoked(meta: MetaFile): void {
    const id = getSyncState().deviceId
    if (meta.revokedDevices?.includes(id)) {
      throw new SyncSetupError('device_revoked', '这台设备已被移除同步，请重新连接一次')
    }
  }

  /** 每次同步前重新读一次 meta：别的设备可能移除了本机、或改了密码 */
  private async refreshMeta(): Promise<MetaFile> {
    const cached = this.meta ? cacheGet('meta.json') : undefined
    const file = await this.client.getFile('meta.json', cached?.etag ?? null)
    if (file.status === 304 && this.meta) return this.meta
    if (!file.content) throw new SyncSetupError('bad_meta', '远端 meta.json 不见了，请重新连接')
    const meta = this.parseMeta(file.content)
    cachePut('meta.json', file.sha, file.etag)
    this.meta = meta
    return meta
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
      const meta = this.parseMeta(remote.content)
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
      app: 'WordMemo',
      revokedDevices: []
    }
    const content = Buffer.from(JSON.stringify(meta, null, 2), 'utf8')
    await this.putFileSafe('meta.json', content, 'sync: init meta')
    return meta
  }

  /**
   * PUT 文件。远端目录可能被别的设备删过（移除设备/换密码），缓存里的 sha 就失效了；
   * 冲突或找不到时丢掉 sha 重建一次（新建文件不需要 sha）。
   */
  private async putFileSafe(path: string, content: Buffer, message: string): Promise<string> {
    const cached = cacheGet(path)
    try {
      const { sha } = await this.client.putFile(path, content, message, cached?.sha ?? null)
      cachePut(path, sha, null)
      return sha
    } catch (error) {
      const retry =
        cached?.sha &&
        error instanceof SyncApiError &&
        (error.code === 'conflict' || error.code === 'not_found')
      if (!retry) throw error
      const { sha } = await this.client.putFile(path, content, message, null)
      cachePut(path, sha, null)
      return sha
    }
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
    await this.putFileSafe(path, file, `sync: ${state.deviceId.slice(0, 6)} info`)
  }

  /**
   * 一次完整同步。任何一步失败都会抛出（网络错误是 `SyncApiError`，口令/仓库问题是
   * `SyncSetupError`）；已经成功的推送/拉取保持已提交状态，下次可以接着来。
   */
  async syncNow(): Promise<SyncResult> {
    const startedAt = localIso()
    if (!this.meta) await this.connect()
    else {
      this.meta = await this.refreshMeta()
      this.assertNotRevoked(this.meta)
    }
    // 仓库体积：拿不到不影响同步，S4 只用来提醒
    try {
      this.repoSizeKb = (await this.client.getRepo()).sizeKb
    } catch {
      /* ignore */
    }
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

    const hasPending = pendingSyncOps(1).length > 0
    await this.push(state.deviceId, result)
    await this.pull(state.deviceId, result)

    // 设备信息只在「真的有东西推上去」或还没有 info 时更新：否则每次空同步都会多一个 commit
    const infoPath = `devices/${state.deviceId}/info.json.age`
    if (hasPending || result.pushedCheckpoint || !cacheGet(infoPath)?.sha) {
      try {
        await this.pushInfo()
      } catch {
        /* 设备信息推不上去不影响同步结果，设备列表有本地表兜底 */
      }
    }

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
    // 远端目录可能被移除设备/换密码删掉：先确认自己的 checkpoint 还在，
    // 不在就整份重推（否则只推 op 分片会丢历史）
    const checkpointExists = await this.remoteExists(checkpointPath)
    const needCheckpoint =
      !checkpointExists ||
      pending.length >= CHECKPOINT_EVERY_OPS ||
      (rows.length > 0 && Date.now() - lastCheckpoint > CHECKPOINT_MAX_AGE_MS)

    if (needCheckpoint && (rows.length > 0 || pending.length > 0 || !checkpointExists)) {
      await this.pushCheckpoint(deviceId, checkpointPath)
      getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE origin = 'local'").run()
      result.pushedCheckpoint = true
      result.pushedOps = pending.length
      // 压缩（S3）：checkpoint 已经覆盖全部历史，本机旧的 op 分片可以删掉
      await this.pruneOwnOps(deviceId)
      return
    }

    // 没有待推的就不写：否则每次同步都会用新 nonce 重传一遍当天分片（白多一个 commit）
    if (!pending.length) return

    // 今天的分片 + 还没推上去的（断网跨天时，前一天的 op 也要一起带上）
    const seen = new Set<number>()
    const sendRows: { seq: number; op: RemoteSyncOp }[] = []
    for (const row of [...rows, ...pending]) {
      if (seen.has(row.seq)) continue
      seen.add(row.seq)
      sendRows.push({
        seq: row.seq,
        op: {
          entity: row.entity as RemoteSyncOp['entity'],
          uid: row.uid,
          op: row.op as RemoteSyncOp['op'],
          fields:
            typeof row.fields === 'string'
              ? (JSON.parse(row.fields || '{}') as Record<string, unknown>)
              : row.fields,
          tsUtc: toInt('ts_utc' in row ? row.ts_utc : row.tsUtc)
        }
      })
    }
    const path = `devices/${deviceId}/ops/${dayRange().day}.jsonl.age`
    const ops: RemoteSyncOp[] = sendRows.map((row) => row.op)
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
    await this.putFileSafe(path, file, `sync: ${deviceId.slice(0, 6)} ops`)
    const maxSeq = Math.max(...sendRows.map((row) => row.seq))
    getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE origin = 'local' AND seq <= ?").run(maxSeq)
    result.pushedOps = pending.length
  }

  /** 远端某个文件是否还在（304 也算在；拿不到 etag 时会读一次内容） */
  private async remoteExists(path: string): Promise<boolean> {
    const cached = cacheGet(path)
    try {
      await this.client.getFile(path, cached?.etag ?? null)
      return true
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return false
      throw error
    }
  }

  private async pushCheckpoint(deviceId: string, path: string): Promise<void> {
    const checkpoint: SyncCheckpoint = exportCheckpoint('checkpoint')
    const seal = (target: string): Promise<Buffer> =>
      encryptEnvelope(
        {
          formatVersion: SYNC_FORMAT_VERSION,
          kind: 'checkpoint',
          path: target,
          deviceId,
          createdAt: checkpoint.createdAt
        },
        checkpoint,
        this.settings.passphrase,
        this.workFactor
      )
    const file = await seal(path)
    await this.putFileSafe(path, file, `sync: ${deviceId.slice(0, 6)} checkpoint`)
    // D-01：规范路径每次都写（旧客户端只认它），另外每月留一份归档、只保留最近 2 份。
    // 本月已经归档过就不再加密一遍（scrypt 不便宜），归档失败也不影响这次同步。
    const archivePath = `devices/${deviceId}/checkpoint-${monthStamp(new Date())}.json.age`
    if (!cacheGet(archivePath)?.sha) {
      try {
        const archive = await seal(archivePath)
        await this.putFileSafe(archivePath, archive, `sync: ${deviceId.slice(0, 6)} checkpoint archive`)
        await this.pruneCheckpointArchives(deviceId)
      } catch {
        /* 归档只是额外保险：失败不拖累本次同步 */
      }
    }
  }

  /** 只保留最近 2 份月度归档（D-01） */
  private async pruneCheckpointArchives(deviceId: string): Promise<void> {
    let entries: { name: string; type: string; path: string; sha: string }[] = []
    try {
      entries = (await this.client.listDir(`devices/${deviceId}`)) as unknown as {
        name: string
        type: string
        path: string
        sha: string
      }[]
    } catch (error) {
      if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
      return
    }
    const obsolete = pickObsoleteArchives(entries.filter((e) => e.type === 'file').map((e) => e.name))
    for (const name of obsolete) {
      const target = entries.find((e) => e.name === name)
      if (!target) continue
      try {
        await this.client.deleteFile(target.path, target.sha, `sync: prune ${deviceId.slice(0, 6)}`)
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
      }
      getDb().prepare('DELETE FROM sync_files WHERE path = ?').run(target.path)
      cacheDrop(target.path)
    }
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

    const peers = devices.filter(
      (entry) =>
        entry.type === 'dir' &&
        entry.name !== deviceId &&
        !(this.meta?.revokedDevices ?? []).includes(entry.name)
    )
    result.peers = peers.length
    for (const peer of peers) {
      await this.pullCheckpoint(peer.name, result)
      await this.pullOps(peer.name, result)
    }
  }

  /**
   * 拉一个加密文件并解密。
   *
   * 远端偶尔会返回「不是我们的文件」的内容（中转缓存/连接被重置时见过），这类响应不是
   * 落盘的损坏，直接让整个同步失败太亏：绕过本地 ETag 重拿一次，两次都不对才报错。
   */
  private async readRemoteEnvelope<T>(
    path: string,
    etag: string | null,
    kind: 'ops' | 'checkpoint'
  ): Promise<{ payload: T; sha: string | null; etag: string | null } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remote = await this.client.getFile(path, attempt === 0 ? etag : null)
      if (remote.status === 304 || !remote.content) return null
      try {
        const envelope = await decryptEnvelope<T>(remote.content, this.settings.passphrase, {
          kind,
          path
        })
        return { payload: envelope.payload, sha: remote.sha, etag: remote.etag }
      } catch (error) {
        const notOurs =
          error instanceof Error && error.message === '这不是 WordMemo 的同步文件'
        if (!notOurs) throw error
        if (attempt === 1) {
          throw new SyncApiError('unknown', 0, '远端同步文件不完整，稍后会再试一次')
        }
        console.warn(`[sync] 远端文件内容不是同步文件，重拿一次：${path}`)
      }
    }
    return null
  }

  private async pullCheckpoint(peer: string, result: SyncResult): Promise<void> {
    const path = `devices/${peer}/checkpoint.json.age`
    const cached = cacheGet(path)
    let read: { payload: unknown; sha: string | null; etag: string | null } | null
    try {
      read = await this.readRemoteEnvelope<unknown>(path, cached?.etag ?? null, 'checkpoint')
    } catch (error) {
      if (error instanceof SyncApiError && error.code === 'not_found') return
      throw error
    }
    if (!read) return
    const checkpoint = validateCheckpoint(read.payload)
    result.merged.push(mergeCheckpoint(checkpoint))
    result.pulledCheckpoints++
    cachePut(path, read.sha, read.etag)
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
      let read: { payload: { ops?: RemoteSyncOp[] }; sha: string | null; etag: string | null } | null
      try {
        read = await this.readRemoteEnvelope<{ ops?: RemoteSyncOp[] }>(
          file.path,
          cached?.etag ?? null,
          'ops'
        )
      } catch (error) {
        if (error instanceof SyncApiError && error.code === 'not_found') continue
        throw error
      }
      if (!read) continue
      const ops = Array.isArray(read.payload.ops) ? read.payload.ops : []
      result.appliedOps += applyRemoteOps(ops, `remote:${peer}`)
      result.pulledOpsFiles++
      cachePut(file.path, read.sha, read.etag)
      getDb()
        .prepare(
          `INSERT INTO sync_devices (device_id, name, last_seen_at) VALUES (?, NULL, ?)
           ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
        )
        .run(peer, localIso())
    }
  }

  /* ------------------------------ 设备管理（S3） ------------------------------ */

  /** 更新 meta.json（先把新内容推上去，再更新本地缓存/内存） */
  private async putMeta(meta: MetaFile, message: string): Promise<void> {
    const content = Buffer.from(JSON.stringify(meta, null, 2), 'utf8')
    await this.putFileSafe('meta.json', content, message)
    this.meta = meta
  }

  /** 设备列表：本机 + 远端 devices/ 下的设备（名称来自 info.json.age，解密失败退回本地表） */
  async listDevices(): Promise<SyncDeviceInfo[]> {
    if (!this.meta) await this.connect()
    const meta = this.meta ?? (await this.refreshMeta())
    const revoked = new Set(meta.revokedDevices ?? [])
    const state = getSyncState()
    const out: SyncDeviceInfo[] = [
      {
        id: state.deviceId,
        name: state.deviceName,
        lastSeenAt: localIso(),
        isCurrent: true,
        revoked: false
      }
    ]

    let dirs: { name: string; type: string }[] = []
    try {
      dirs = await this.client.listDir('devices')
    } catch (error) {
      if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
    }
    for (const dir of dirs) {
      if (dir.type !== 'dir' || dir.name === state.deviceId) continue
      let name: string | null = null
      let lastSeenAt: string | null = null
      const infoPath = `devices/${dir.name}/info.json.age`
      try {
        const file = await this.client.getFile(infoPath)
        if (file.content) {
          const envelope = await decryptEnvelope<{ name?: string; lastSeenAt?: string }>(
            file.content,
            this.settings.passphrase,
            { kind: 'info', path: infoPath }
          )
          name = envelope.payload.name ?? null
          lastSeenAt = envelope.payload.lastSeenAt ?? null
        }
      } catch {
        /* 没 info 或解不开：退回本地表 */
      }
      if (!name || !lastSeenAt) {
        const row = getDb()
          .prepare('SELECT name, last_seen_at FROM sync_devices WHERE device_id = ?')
          .get(dir.name) as { name: string | null; last_seen_at: string | null } | undefined
        name = name ?? row?.name ?? null
        lastSeenAt = lastSeenAt ?? row?.last_seen_at ?? null
      }
      out.push({ id: dir.name, name, lastSeenAt, isCurrent: false, revoked: revoked.has(dir.name) })
    }
    // 已移除、远端目录也删掉的设备也列出来（标成「已移除」）
    for (const id of revoked) {
      if (!out.some((device) => device.id === id)) {
        out.push({ id, name: null, lastSeenAt: null, isCurrent: false, revoked: true })
      }
    }
    return out
  }

  /** 移除其它设备：远端目录删除 + 写进 meta.revokedDevices（它自己下次同步会被拒绝） */
  async removeDevice(deviceId: string): Promise<void> {
    const state = getSyncState()
    if (!deviceId || deviceId === state.deviceId) {
      throw new SyncSetupError('bad_input', '不能移除本机')
    }
    if (!this.meta) await this.connect()
    const meta = this.meta ?? (await this.refreshMeta())
    const revoked = [...new Set([...(meta.revokedDevices ?? []), deviceId])]
    await this.putMeta({ ...meta, revokedDevices: revoked }, `sync: remove ${deviceId.slice(0, 6)}`)
    await this.deleteDeviceFiles(deviceId)
    getDb().prepare('DELETE FROM sync_files WHERE path LIKE ?').run(`devices/${deviceId}/%`)
    getDb().prepare('DELETE FROM sync_devices WHERE device_id = ?').run(deviceId)
  }

  /** 删掉一个设备在远端的所有文件（checkpoint / info / ops/*） */
  private async deleteDeviceFiles(deviceId: string): Promise<void> {
    const root = `devices/${deviceId}`
    const files: { path: string; sha: string }[] = []
    let entries: { name: string; path: string; sha: string; type: string }[] = []
    try {
      entries = await this.client.listDir(root)
    } catch (error) {
      if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
    }
    for (const entry of entries) {
      if (entry.type === 'file') {
        files.push({ path: entry.path, sha: entry.sha })
        continue
      }
      if (entry.type !== 'dir') continue
      try {
        const children = await this.client.listDir(entry.path)
        for (const child of children) {
          if (child.type === 'file') files.push({ path: child.path, sha: child.sha })
        }
      } catch {
        /* ignore */
      }
    }
    for (const file of files) {
      try {
        await this.client.deleteFile(file.path, file.sha, `sync: remove ${deviceId.slice(0, 6)}`)
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
      }
      getDb().prepare('DELETE FROM sync_files WHERE path = ?').run(file.path)
    }
  }

  /**
   * 换密码（危险操作）：用新口令重写本机 checkpoint → 更新 meta → 删掉其它设备目录。
   * 其它设备下次同步会因为 meta 校验不通过而报「密码不对」，需要用户输入新密码重新连接。
   */
  async changePassphrase(newPassphrase: string): Promise<void> {
    if (!newPassphrase) throw new SyncSetupError('bad_input', '同步密码不能为空')
    if (!this.meta) await this.connect()
    const meta = this.meta ?? (await this.refreshMeta())
    const state = getSyncState()

    const checkpointPath = `devices/${state.deviceId}/checkpoint.json.age`
    const checkpoint = exportCheckpoint('checkpoint')
    const file = await encryptEnvelope(
      {
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'checkpoint',
        path: checkpointPath,
        deviceId: state.deviceId,
        createdAt: checkpoint.createdAt
      },
      checkpoint,
      newPassphrase,
      this.workFactor
    )
    await this.putFileSafe(checkpointPath, file, `sync: ${state.deviceId.slice(0, 6)} checkpoint`)
    getDb().prepare("UPDATE sync_ops SET pushed = 1 WHERE origin = 'local'").run()
    await this.pruneOwnOps(state.deviceId)

    const salt = makeSalt()
    const next: MetaFile = {
      ...meta,
      salt,
      kdfVerifier: kdfVerifier(newPassphrase, salt),
      revokedDevices: meta.revokedDevices ?? []
    }
    await this.putMeta(next, 'sync: change passphrase')

    // 其它设备的数据是旧口令加密的，换完后谁也读不了：直接删掉，让它们重新连接后重推
    let dirs: { name: string; type: string }[] = []
    try {
      dirs = await this.client.listDir('devices')
    } catch {
      /* ignore */
    }
    for (const dir of dirs) {
      if (dir.type === 'dir' && dir.name !== state.deviceId) await this.deleteDeviceFiles(dir.name)
    }
  }

  /** checkpoint 覆盖全部历史之后，本机的 op 分片就是冗余的（S3 压缩） */
  private async pruneOwnOps(deviceId: string): Promise<void> {
    const root = `devices/${deviceId}/ops`
    let files: { path: string; sha: string }[] = []
    try {
      files = (await this.client.listDir(root)) as unknown as { path: string; sha: string }[]
    } catch (error) {
      if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
      return
    }
    for (const file of files) {
      try {
        await this.client.deleteFile(file.path, file.sha, `sync: compact ${deviceId.slice(0, 6)}`)
      } catch (error) {
        if (!(error instanceof SyncApiError) || error.code !== 'not_found') throw error
      }
      getDb().prepare('DELETE FROM sync_files WHERE path = ?').run(file.path)
    }
  }
}
