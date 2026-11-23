import type {
  SyncActionResult,
  SyncConnectInput,
  SyncImportResult,
  SyncStatus
} from '@shared/types'
import { checkPassphrase } from '@shared/passphrase'
import { exportEncryptedSnapshot, importEncryptedSnapshot } from '../db/checkpoint'
import { countPendingOps, getSyncState, onSyncOpWritten } from '../db/sync'
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
let running = false
let lastError: { code: string; message: string } | null = null

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
  if (configured()) state = running ? 'syncing' : lastError ? 'error' : 'idle'
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
    lastErrorCode: lastError?.code ?? null,
    lastErrorMessage: lastError?.message ?? null,
    pendingOps: countPendingOps(),
    lastPushAt: syncState.lastPushAt,
    lastPullAt: syncState.lastPullAt,
    rateLimitRemaining: engine?.rateLimit.remaining ?? null
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

async function runSync(): Promise<boolean> {
  if (!engine || running) return true
  running = true
  emit()
  try {
    await engine.syncNow()
    lastError = null
    return true
  } catch (error) {
    lastError = describeError(error)
    return false
  } finally {
    running = false
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

/** 手动同步：永远可用（受「正在进行」保护） */
export async function syncNow(): Promise<SyncActionResult> {
  if (!configured() || !engine) return fail('not_configured', '还没有连接同步')
  if (scheduler) await scheduler.runNow()
  else await runSync()
  const failure = getLastError()
  return {
    ok: !failure,
    status: buildStatus(),
    errorCode: failure?.code,
    message: failure?.message
  }
}

export async function exportSnapshotTo(file: string): Promise<SyncActionResult & { path: string | null }> {
  const secrets = loadSyncSecrets()
  if (!secrets) {
    return { ...fail('no_secret', '没有找到本机保存的同步密码，请重新连接一次'), path: null }
  }
  try {
    await exportEncryptedSnapshot(file, secrets.passphrase)
    return { ok: true, status: buildStatus(), path: file }
  } catch (error) {
    const info = describeError(error)
    return { ok: false, status: buildStatus(), path: null, errorCode: info.code, message: info.message }
  }
}

export async function importSnapshotFrom(file: string): Promise<SyncImportResult> {
  const secrets = loadSyncSecrets()
  if (!secrets) return fail('no_secret', '没有找到本机保存的同步密码，请重新连接一次')
  try {
    const { stats } = await importEncryptedSnapshot(file, secrets.passphrase)
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
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  try {
    await Promise.race([runSync().then(() => undefined), deadline])
  } catch {
    /* 退出路径上不抛错 */
  }
}

/** 供测试/诊断：清掉内存状态（不删磁盘上的设置与密钥） */
export function resetSyncManagerForTests(): void {
  detachRuntime()
  running = false
  lastError = null
}

function getLastError(): { code: string; message: string } | null {
  return lastError
}

function fail(code: string, message: string): SyncActionResult {
  return { ok: false, status: buildStatus(), errorCode: code, message }
}
