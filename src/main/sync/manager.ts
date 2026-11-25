import type {
  SyncActionResult,
  SyncConnectInput,
  SyncDeviceInfo,
  SyncImportResult,
  SyncLogEntry,
  SyncStatus
} from '@shared/types'
import { checkPassphrase } from '@shared/passphrase'
import { exportEncryptedSnapshot, importEncryptedSnapshot } from '../db/checkpoint'
import { countPendingOps, getSyncState, onSyncOpWritten } from '../db/sync'
import { getDb, localIso } from '../db/connection'
import { getSettings, updateSettings } from '../settings'
import { SyncEngine, SyncSetupError } from './engine'
import { SyncApiError } from './github'
import { loadSyncSecrets, saveSyncSecrets, clearSyncSecrets, type SyncSecrets } from './secretStore'
import { SyncScheduler } from './scheduler'

/**
 * 同步管理器：设置页 / 托盘只跟它打交道。
 *
 * - 负责 engine 的生命周期、调度器、状态广播；
 * - PAT/口令只经过 `secretStore`，不写 settings.json；
 * - 所有失败都归一成 `{code, message}`，界面按 code 给中文。
 */

let statusSink: ((status: SyncStatus) => void) | null = null
let engine: SyncEngine | null = null
let scheduler: SyncScheduler | null = null
let unsubscribeOps: (() => void) | null = null
/**
 * 正在进行的同步（A-01）。以前只用一个 `running` 布尔值，第二次调用直接 `return true`
 * ——「正在同步」被当成了「同步成功」，界面会提示「已连接，并完成第一次同步」而其实一次没跑。
 * 现在保存的是那一次运行的 promise：后来者**加入并等待**它，拿到的就是真实结果。
 */
let inFlight: Promise<boolean> | null = null
let lastError: { code: string; message: string } | null = null
/** 上一次成功同步应用/合并的条数：界面据此决定要不要重读库和列表 */
let lastSyncChanges = 0

export function setSyncStatusSink(sink: (status: SyncStatus) => void): void {
  statusSink = sink
}

function emit(): void {
  try {
    statusSink?.(buildStatus())
  } catch {
    /* 渲染进程可能已经关了 */
  }
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof SyncSetupError) return { code: error.code, message: error.message }
  if (error instanceof SyncApiError) return { code: error.code, message: error.message }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error)
  }
}

function configured(): boolean {
  const sync = getSettings().sync
  return !!(sync.enabled && sync.owner && sync.repo)
}

export function buildStatus(): SyncStatus {
  const sync = getSettings().sync
  let state: SyncStatus['state'] = 'disconnected'
  if (configured()) state = inFlight ? 'syncing' : lastError ? 'error' : 'idle'
  const syncState = getSyncState()
  return {
    configured: configured(),
    enabled: sync.enabled,
    state,
    owner: sync.owner,
    repo: sync.repo,
    apiBase: sync.apiBase,
    intervalMin: sync.intervalMin,
    deviceId: syncState.deviceId,
    deviceName: syncState.deviceName,
    lastSuccessAt: syncState.lastPullAt ?? syncState.lastPushAt ?? null,
    lastSyncChanges,
    lastErrorCode: lastError?.code ?? null,
    lastErrorMessage: lastError?.message ?? null,
    pendingOps: countPendingOps(),
    lastPushAt: syncState.lastPushAt,
    lastPullAt: syncState.lastPullAt,
    rateLimitRemaining: engine?.rateLimit.remaining ?? null,
    repoSizeKb: engine?.repositorySizeKb ?? null
  }
}

function attach(secrets: SyncSecrets): void {
  const sync = getSettings().sync
  detachRuntime()
  engine = new SyncEngine({
    owner: sync.owner,
    repo: sync.repo,
    token: secrets.token,
    passphrase: secrets.passphrase,
    apiBase: sync.apiBase
  })
  scheduler = new SyncScheduler({
    intervalMin: sync.intervalMin,
    run: () => runSync(),
    onChange: emit
  })
  unsubscribeOps = onSyncOpWritten(() => scheduler?.markDirty())
  scheduler.start()
}

function detachRuntime(): void {
  scheduler?.dispose()
  scheduler = null
  unsubscribeOps?.()
  unsubscribeOps = null
  engine = null
}

interface RunRecord {
  durationMs: number
  pushedOps: number
  pushedCheckpoint: boolean
  peers: number
  pulledCheckpoints: number
  pulledOpsFiles: number
  appliedOps: number
}

/** 记录一次同步（最近 20 条；不含任何内容明文） */
function recordRun(record: RunRecord, ok: boolean, errorCode: string | null): void {
  try {
    const db = getDb()
    db.prepare(
      `INSERT INTO sync_runs
        (at, duration_ms, pushed_ops, pushed_checkpoint, peers, pulled_checkpoints, pulled_ops_files, applied_ops, ok, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      localIso(),
      Math.max(0, Math.trunc(record.durationMs)),
      record.pushedOps,
      record.pushedCheckpoint ? 1 : 0,
      record.peers,
      record.pulledCheckpoints,
      record.pulledOpsFiles,
      record.appliedOps,
      ok ? 1 : 0,
      errorCode
    )
    db.prepare(
      'DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 20)'
    ).run()
  } catch {
    /* 日志失败不影响同步 */
  }
}

/**
 * 跑一次同步。
 * - 同一时刻只有一轮在跑：后来者**加入并等待那一轮**，拿到的是真实结果（不再假装成功）；
 * - 没有引擎（没连接）时返回 false —— 以前这里返回 true，等于「没同步也算成功」。
 */
function runSync(): Promise<boolean> {
  const target = engine
  if (!target) return Promise.resolve(false)
  if (inFlight) return inFlight
  const run: Promise<boolean> = doRunSync(target).finally(() => {
    if (inFlight === run) inFlight = null
  })
  inFlight = run
  return run
}

async function doRunSync(target: SyncEngine): Promise<boolean> {
  emit()
  const started = Date.now()
  const empty: RunRecord = {
    durationMs: 0,
    pushedOps: 0,
    pushedCheckpoint: false,
    peers: 0,
    pulledCheckpoints: 0,
    pulledOpsFiles: 0,
    appliedOps: 0
  }
  try {
    const result = await target.syncNow()
    lastError = null
    lastSyncChanges =
      result.appliedOps +
      result.merged.reduce((sum, stats) => {
        let total = 0
        for (const value of Object.values(stats)) if (typeof value === 'number') total += value
        return sum + total
      }, 0)
    recordRun(
      {
        durationMs: Date.now() - started,
        pushedOps: result.pushedOps,
        pushedCheckpoint: result.pushedCheckpoint,
        peers: result.peers,
        pulledCheckpoints: result.pulledCheckpoints,
        pulledOpsFiles: result.pulledOpsFiles,
        appliedOps: result.appliedOps
      },
      true,
      null
    )
    return true
  } catch (error) {
    lastError = describeError(error)
    lastSyncChanges = 0
    recordRun({ ...empty, durationMs: Date.now() - started }, false, lastError.code)
    return false
  } finally {
    emit()
  }
}

/** 启动时调用：settings 里已连接且本机有密钥才初始化；否则什么都不做 */
export function initSyncManager(): void {
  if (!configured()) {
    emit()
    return
  }
  const secrets = loadSyncSecrets()
  if (!secrets) {
    lastError = { code: 'no_secret', message: '没有找到本机保存的同步密码，请重新连接一次' }
    emit()
    return
  }
  attach(secrets)
  emit()
}

/**
 * 连接：先校验 PAT/仓库/口令，成功后才落盘设置与密钥，然后立刻同步一次。
 * 首次同步失败（比如断网）不会回滚连接——设置和密码已经存好，稍后可以重试。
 */
export async function connectSync(input: SyncConnectInput): Promise<SyncActionResult> {
  const owner = input.owner.trim()
  const repo = input.repo.trim()
  const pat = input.pat.trim()
  if (!owner || !repo) return fail('bad_input', '请填写仓库（owner/repo）')
  if (!pat) return fail('bad_input', '请填写 GitHub 的 PAT')
  const strength = checkPassphrase(input.passphrase)
  if (!strength.ok) {
    return fail(
      'weak_passphrase',
      strength.reason === 'too_common' ? '这个密码太常见了，换一个' : '同步密码至少 10 个字符'
    )
  }

  const previous = getSettings().sync
  const candidate = new SyncEngine({
    owner,
    repo,
    token: pat,
    passphrase: input.passphrase,
    apiBase: (input.apiBase || previous.apiBase || 'https://api.github.com').replace(/\/+$/, '')
  })
  try {
    await candidate.connect()
  } catch (error) {
    const info = describeError(error)
    return fail(info.code, info.message)
  }

  if (!saveSyncSecrets({ token: pat, passphrase: input.passphrase })) {
    return fail('secret_store', '本机保存同步密码失败，无法记住连接')
  }
  lastError = null
  updateSettings({
    sync: {
      enabled: true,
      owner,
      repo,
      apiBase: (input.apiBase || previous.apiBase || 'https://api.github.com').replace(/\/+$/, ''),
      intervalMin: input.intervalMin ?? previous.intervalMin
    }
  })
  attach({ token: pat, passphrase: input.passphrase })
  // 旧引擎那一轮可能还在跑：先等它结束，否则新的这轮会被并进旧运行、等于没同步
  if (inFlight) await inFlight.catch(() => undefined)
  await runSync()
  const failure = getLastError()
  return {
    ok: !failure,
    status: buildStatus(),
    errorCode: failure?.code,
    message: failure?.message
  }
}

/** 断开：只删本机的连接与密钥，远端数据不动 */
export function disconnectSync(): SyncStatus {
  detachRuntime()
  clearSyncSecrets()
  lastError = null
  updateSettings({ sync: { ...getSettings().sync, enabled: false } })
  emit()
  return buildStatus()
}

/** 手动同步：永远可用（已经在跑时如实告诉用户，不假装成功） */
export async function syncNow(): Promise<SyncActionResult> {
  if (!configured() || !engine) return fail('not_configured', '还没有连接同步')
  // 进去之前先看有没有一轮在跑：跑完之后的 lastError 是那一轮的结果，不能当成本次的
  const joined = inFlight !== null
  if (scheduler) await scheduler.runNow()
  else await runSync()
  const failure = getLastError()
  if (!failure && joined) {
    return { ok: true, status: buildStatus(), message: '正在同步，完成后会自动刷新' }
  }
  return {
    ok: !failure,
    status: buildStatus(),
    errorCode: failure?.code,
    message: failure?.message
  }
}

export async function exportSnapshotTo(
  file: string,
  passphrase?: string
): Promise<SyncActionResult & { path: string | null }> {
  // 没连接时允许现场输一次密码：换机、离线搬数据不该强迫先连仓库
  const secret = passphrase || loadSyncSecrets()?.passphrase
  if (!secret) {
    return { ...fail('no_secret', '请输入同步密码：本机还没有保存过'), path: null }
  }
  try {
    await exportEncryptedSnapshot(file, secret)
    return { ok: true, status: buildStatus(), path: file }
  } catch (error) {
    const info = describeError(error)
    return { ok: false, status: buildStatus(), path: null, errorCode: info.code, message: info.message }
  }
}

export async function importSnapshotFrom(
  file: string,
  passphrase?: string
): Promise<SyncImportResult> {
  const secret = passphrase || loadSyncSecrets()?.passphrase
  if (!secret) return fail('no_secret', '请输入同步密码：本机还没有保存过')
  try {
    const { stats } = await importEncryptedSnapshot(file, secret)
    // 导入的数据也是本地变更：尽快推上去（没有连接时 markDirty 什么都不做）
    scheduler?.markDirty()
    const applied =
      stats.decks +
      stats.notes +
      stats.items +
      stats.reviews +
      stats.exams +
      stats.noteItems +
      stats.cardFlags
    return {
      ok: true,
      status: buildStatus(),
      applied,
      notes: stats.notes,
      items: stats.items,
      reviews: stats.reviews
    }
  } catch (error) {
    const info = describeError(error)
    return { ok: false, status: buildStatus(), errorCode: info.code, message: info.message }
  }
}

/** 退出前尽力推一次；最多等 timeoutMs（PLAN-SYNC §3.8） */
export async function flushBeforeQuit(timeoutMs = 3000): Promise<void> {
  if (!engine) return
  const startedAt = Date.now()
  const budget = (): number => Math.max(0, timeoutMs - (Date.now() - startedAt))
  /** 在剩余预算内等一个 promise；超时就放弃（不抛错、不留定时器） */
  const waitWithin = async (work: Promise<unknown>): Promise<void> => {
    const left = budget()
    if (left <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work.then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  // 已经有一轮在跑：等它，而不是原来那样立刻返回、把这次的推送丢掉
  await waitWithin(runSync())
  // 那一轮跑完还有没推上去的，再抢一次（同一个预算）
  if (engine && countPendingOps() > 0 && budget() > 250) await waitWithin(runSync())
}

/** 供测试/诊断：清掉内存状态（不删磁盘上的设置与密钥） */
export function resetSyncManagerForTests(): void {
  detachRuntime()
  inFlight = null
  lastError = null
}

/**
 * 仅供测试：注入引擎替身，避免连真 GitHub。
 * 传 `null` 清掉（同时会把调度器一起摘掉，测试里不要用它去模拟「已连接且有定时器」）。
 */
export function __setSyncEngineForTests(fake: unknown): void {
  detachRuntime()
  engine = (fake ?? null) as unknown as SyncEngine | null
}

function getLastError(): { code: string; message: string } | null {
  return lastError
}

/** 设备列表：未连接时只显示本机；拉取失败也退回本机，不打扰用户 */
export async function listSyncDevices(): Promise<SyncDeviceInfo[]> {
  const state = getSyncState()
  const local: SyncDeviceInfo = {
    id: state.deviceId,
    name: state.deviceName,
    lastSeenAt: localIso(),
    isCurrent: true,
    revoked: false
  }
  if (!configured() || !engine) return [local]
  try {
    return await engine.listDevices()
  } catch {
    return [local]
  }
}

/** 移除其它设备（S3）：远端目录删掉并写进 meta.revokedDevices，它自己下次同步会被拒绝 */
export async function removeSyncDevice(deviceId: string): Promise<SyncActionResult> {
  if (!configured() || !engine) return fail('not_configured', '还没有连接同步')
  try {
    await engine.removeDevice(deviceId)
    return { ok: true, status: buildStatus() }
  } catch (error) {
    const info = describeError(error)
    return { ok: false, status: buildStatus(), errorCode: info.code, message: info.message }
  }
}

/** 更换同步密码（危险操作）：本机重加密重推，其它设备需要重新输入新密码 */
export async function changeSyncPassphrase(passphrase: string): Promise<SyncActionResult> {
  if (!configured() || !engine) return fail('not_configured', '还没有连接同步')
  const strength = checkPassphrase(passphrase)
  if (!strength.ok) {
    return fail(
      'weak_passphrase',
      strength.reason === 'too_common' ? '这个密码太常见了，换一个' : '同步密码至少 10 个字符'
    )
  }
  const secrets = loadSyncSecrets()
  if (!secrets) return fail('no_secret', '没有找到本机保存的同步密码，请重新连接一次')
  try {
    await engine.changePassphrase(passphrase)
  } catch (error) {
    const info = describeError(error)
    return { ok: false, status: buildStatus(), errorCode: info.code, message: info.message }
  }
  if (!saveSyncSecrets({ token: secrets.token, passphrase })) {
    return fail('secret_store', '本机保存新密码失败；远端已经换成新密码，请重新连接')
  }
  lastError = null
  attach({ token: secrets.token, passphrase })
  emit()
  return { ok: true, status: buildStatus() }
}

/** 最近 20 次同步记录（设置页的同步日志） */
export function getSyncLog(): SyncLogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20')
    .all() as unknown as {
    at: string
    duration_ms: number
    pushed_ops: number
    pushed_checkpoint: number
    peers: number
    pulled_checkpoints: number
    pulled_ops_files: number
    applied_ops: number
    ok: number
    error_code: string | null
  }[]
  return rows.map((row) => ({
    at: row.at,
    durationMs: Number(row.duration_ms) || 0,
    pushedOps: Number(row.pushed_ops) || 0,
    pushedCheckpoint: row.pushed_checkpoint === 1,
    peers: Number(row.peers) || 0,
    pulledCheckpoints: Number(row.pulled_checkpoints) || 0,
    pulledOpsFiles: Number(row.pulled_ops_files) || 0,
    appliedOps: Number(row.applied_ops) || 0,
    ok: row.ok === 1,
    errorCode: row.error_code
  }))
}

function fail(code: string, message: string): SyncActionResult {
  return { ok: false, status: buildStatus(), errorCode: code, message }
}

