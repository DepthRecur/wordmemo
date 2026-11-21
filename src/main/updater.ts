/**
 * U2 自更新（应用侧）。方案见 docs/PLAN-UPDATE.md §3.11 / §11.3。
 *
 * 职责切分（硬约束，别改）：
 * - 应用只做「检查 → 下载 → 流式 sha256 → 解压到 update/app-new → 写 update/state.json」；
 * - 应用**绝不**替换自己的 app/、不做 quitAndInstall、不静默重启；
 * - 真正换目录是便携版启动器（scripts/Launcher.cs）在下一次启动时做的事。
 *
 * 更新源只认 GitHub Releases 的静态资源 `releases/latest/download/latest.json`
 * （不吃 API 限额、不接受远程下发的配置/脚本）。唯一例外是本地验收用的
 * `WORDMEMO_UPDATE_URL`：只允许 https，或指向 localhost 的 http（见 resolveLatestUrl）。
 *
 * 这个文件故意不 import electron：所有目录、设置读写、网络都从 UpdaterOptions 注入，
 * 单测可以直接用临时目录构造（与 sandbox.ts 同一套做法）。
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { UpdateCheckResult, UpdatePhase, UpdateProgress, UpdateSettings, UpdateStatus } from '@shared/types'

export const DEFAULT_LATEST_URL =
  'https://github.com/DepthRecur/wordmemo/releases/latest/download/latest.json'

export const APP_FOLDER = 'app'
export const APP_NEW_FOLDER = 'app-new'
export const UPDATE_FOLDER = 'update'
export const UPDATE_STATE_FILE = 'state.json'
export const UPDATE_ERROR_LOG = 'error.log'
export const APP_EXE_NAME = 'WordMemo.exe'
export const APP_VERSION_FILE = 'version.json'
/**
 * 不在 Electron 主进程里 stat/read `app.asar`：
 * Electron 会给 `.asar` 路径打补丁——`fs.statSync('app.asar').size` 返回 0（虚拟目录），
 * 而且打开后会把归档锁住直到进程退出（会导致 update/app-new 删不掉）。
 * 启动器（C#）没有这层补丁，真正的 app.asar 大小检查放在 Launcher.cs 里做。
 */

/** 启动 60 秒后再检查，别和启动抢资源 */
export const START_DELAY_MS = 60_000
/** 成功一次后 24h 再查 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 失败退避：1h → 2h → 4h → 6h（封顶） */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
export const MIN_RETRY_DELAY_MS = 60_000
export const CHECK_TIMEOUT_MS = 45_000
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
/** 下载进度推给渲染层的最小间隔 */
export const PROGRESS_EMIT_MS = 250
export const MAX_SKIPPED_VERSIONS = 20

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// 版本号：semver 风格比较（0.1.10 > 0.1.9；预发布号小于同版本正式版）
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识：数字段按数字比，其余按字符串比 */
  prerelease: (string | number)[]
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > 64) return null
  const match = VERSION_RE.exec(text)
  if (!match) return null
  const prerelease = (match[4] ?? '')
    .split('.')
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

/** 规范写法（去掉前导 v / 构建号）；无效返回 null */
export function normalizeVersion(value: unknown): string | null {
  const parsed = parseVersion(value)
  if (!parsed) return null
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length ? `${core}-${parsed.prerelease.join('.')}` : core
}

/** -1 / 0 / 1；无效版本号排在所有有效版本之前（两个无效 = 0） */
export function compareVersions(a: unknown, b: unknown): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) {
    if (!left && !right) return 0
    return left ? 1 : -1
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const x = left.prerelease
  const y = right.prerelease
  if (!x.length && !y.length) return 0
  if (!x.length) return 1
  if (!y.length) return -1
  const size = Math.max(x.length, y.length)
  for (let i = 0; i < size; i++) {
    const l = x[i]
    const r = y[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = typeof l === 'number'
    const rn = typeof r === 'number'
    if (ln && rn) {
      if (l !== r) return (l as number) < (r as number) ? -1 : 1
      continue
    }
    if (ln) return -1
    if (rn) return 1
    if (l !== r) return String(l) < String(r) ? -1 : 1
  }
  return 0
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0
}

// ---------------------------------------------------------------------------
// latest.json
// ---------------------------------------------------------------------------

export interface LatestInfo {
  /** 规范化后的版本号 */
  version: string
  /** zip 文件名（只有名字，不允许路径） */
  zip: string
  /** 小写十六进制 sha256 */
  sha256: string
  notes: string | null
  /** 解析后的 zip 下载地址（同源相对路径） */
  url: string
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 更新源：默认 GitHub Releases 的静态资源。
 * 只有本地验收会通过 `WORDMEMO_UPDATE_URL` 指向本机 HTTP 服务；
 * 远程地址必须是 https（不接受「远程下发配置」，这里只换一个固定 URL）。
 */
export function resolveLatestUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.WORDMEMO_UPDATE_URL ?? '').trim()
  if (!override) return DEFAULT_LATEST_URL
  try {
    const url = new URL(override)
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.toString()
  } catch {
    /* 坏地址按默认值 */
  }
  return DEFAULT_LATEST_URL
}

/** latest.json → LatestInfo；任何字段不对都返回 null（宁可不更新，也不装坏包） */
export function parseLatestInfo(raw: unknown, baseUrl: string = DEFAULT_LATEST_URL): LatestInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const version = normalizeVersion(value.version)
  if (!version) return null
  const zip = typeof value.zip === 'string' ? value.zip.trim() : ''
  if (!zip || zip.length > 200 || !/\.zip$/i.test(zip)) return null
  // 只允许文件名：不能带目录、不能是 . / ..（防止 latest.json 把文件写到 update/ 外面）
  if (zip !== path.basename(zip) || zip === '.' || zip === '..') return null
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null
  const notes = typeof value.notes === 'string' ? value.notes.trim().slice(0, 400) || null : null
  let url: string
  try {
    url = new URL(zip, baseUrl).toString()
  } catch {
    return null
  }
  if (!isHttpUrl(url)) return null
  return { version, zip, sha256, notes, url }
}

// ---------------------------------------------------------------------------
// 节流 / 跳过 / 决策（纯函数，单测直接调）
// ---------------------------------------------------------------------------

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function checkIntervalMs(failStreak: number): number {
  const streak = Number.isFinite(failStreak) ? Math.max(0, Math.trunc(failStreak)) : 0
  if (streak === 0) return CHECK_INTERVAL_MS
  return Math.min(60 * 60 * 1000 * 2 ** Math.min(streak - 1, 8), MAX_BACKOFF_MS)
}

/** 下一次允许检查的时刻（时间戳）；0 = 立刻。时钟回拨时按「现在就能查」处理，不会永久停摆 */
export function checkDueAt(lastCheckAt: string | null, failStreak: number, now: number): number {
  const last = parseIso(lastCheckAt)
  if (last === null) return 0
  if (now < last) return now
  return last + checkIntervalMs(failStreak)
}

export function isCheckDue(
  updates: Pick<UpdateSettings, 'autoCheck' | 'lastCheckAt' | 'failStreak'>,
  now: number,
  manual = false
): boolean {
  if (manual) return true
  if (!updates.autoCheck) return false
  return now >= checkDueAt(updates.lastCheckAt, updates.failStreak, now)
}

export function isVersionSkipped(version: string, skipped: string[]): boolean {
  const target = normalizeVersion(version) ?? version.trim()
  if (!target) return false
  return skipped.some((entry) => (normalizeVersion(entry) ?? entry.trim()) === target)
}

export type UpdateDecision =
  | { action: 'none'; reason: 'up-to-date' | 'skipped' }
  | { action: 'download'; latest: LatestInfo }

/** 自动检查会尊重跳过列表；手动检查永远穿透（用户主动问就必须回答） */
export function decideUpdate(
  latest: LatestInfo,
  opts: { currentVersion: string; skipped: string[]; manual: boolean }
): UpdateDecision {
  if (!isNewerVersion(latest.version, opts.currentVersion)) return { action: 'none', reason: 'up-to-date' }
  if (!opts.manual && isVersionSkipped(latest.version, opts.skipped)) return { action: 'none', reason: 'skipped' }
  return { action: 'download', latest }
}

// ---------------------------------------------------------------------------
// 状态机（每次变化产出一份完整快照，避免多个细粒度事件乱序）
// ---------------------------------------------------------------------------

export interface UpdaterState {
  phase: UpdatePhase
  latestVersion: string | null
  pendingVersion: string | null
  notes: string | null
  progress: UpdateProgress | null
  message: string | null
  error: string | null
  lastCheckAt: string | null
}

export type UpdaterAction =
  | { type: 'boot'; pendingVersion: string | null; lastCheckAt?: string | null }
  | { type: 'check-start' }
  | {
      type: 'check-result'
      checkedAt: string
      latestVersion: string | null
      notes?: string | null
      message?: string | null
    }
  | { type: 'download-start'; version: string }
  | { type: 'download-progress'; received: number; total: number | null }
  | { type: 'download-ready'; version: string; checkedAt: string; notes?: string | null }
  | { type: 'fail'; error: string; message?: string | null; checkedAt?: string | null }
  | { type: 'skip'; version: string; message?: string | null }
  | { type: 'idle'; message?: string | null }

export function initialUpdaterState(): UpdaterState {
  return {
    phase: 'idle',
    latestVersion: null,
    pendingVersion: null,
    notes: null,
    progress: null,
    message: null,
    error: null,
    lastCheckAt: null
  }
}

export function reduceUpdaterState(prev: UpdaterState, action: UpdaterAction): UpdaterState {
  switch (action.type) {
    case 'boot':
      return {
        ...prev,
        phase: action.pendingVersion ? 'ready' : 'idle',
        pendingVersion: action.pendingVersion,
        progress: null,
        message: null,
        error: null,
        lastCheckAt: action.lastCheckAt ?? prev.lastCheckAt
      }
    case 'check-start':
      return { ...prev, phase: 'checking', progress: null, message: null, error: null }
    case 'check-result':
      return {
        ...prev,
        phase: prev.pendingVersion ? 'ready' : 'idle',
        latestVersion: action.latestVersion,
        notes: action.notes ?? prev.notes,
        progress: null,
        message: action.message ?? null,
        error: null,
        lastCheckAt: action.checkedAt
      }
    case 'download-start':
      return {
        ...prev,
        phase: 'downloading',
        latestVersion: action.version,
        // 旧 app-new 马上要被替换/删除，pending 作废
        pendingVersion: null,
        progress: { received: 0, total: null },
        message: null,
        error: null
      }
    case 'download-progress':
      if (prev.phase !== 'downloading') return prev
      return { ...prev, progress: { received: action.received, total: action.total } }
    case 'download-ready':
      return {
        ...prev,
        phase: 'ready',
        latestVersion: action.version,
        pendingVersion: action.version,
        progress: null,
        message: `新版本 v${action.version} 已下载，退出后重新打开就会生效。`,
        error: null,
        lastCheckAt: action.checkedAt,
        notes: action.notes ?? prev.notes
      }
    case 'fail':
      return {
        ...prev,
        phase: 'error',
        progress: null,
        message: action.message ?? null,
        error: action.error,
        lastCheckAt: action.checkedAt ?? prev.lastCheckAt
      }
    case 'skip':
      return {
        ...prev,
        phase: 'idle',
        pendingVersion:
          prev.pendingVersion && compareVersions(prev.pendingVersion, action.version) === 0
            ? null
            : prev.pendingVersion,
        latestVersion:
          prev.latestVersion && compareVersions(prev.latestVersion, action.version) === 0
            ? null
            : prev.latestVersion,
        notes:
          prev.pendingVersion && compareVersions(prev.pendingVersion, action.version) === 0
            ? null
            : prev.notes,
        progress: null,
        message: action.message ?? null,
        error: null
      }
    case 'idle':
      return { ...prev, phase: 'idle', progress: null, message: action.message ?? null, error: null }
    default:
      return prev
  }
}

// ---------------------------------------------------------------------------
// 程序目录里的文件：app/version.json、update/state.json
// ---------------------------------------------------------------------------

export interface UpdateStateFile {
  ready: boolean
  version: string | null
  downloadedAt: string | null
  sha256: string | null
}

export function defaultUpdateStateFile(): UpdateStateFile {
  return { ready: false, version: null, downloadedAt: null, sha256: null }
}

export function updateStatePath(programDir: string): string {
  return path.join(programDir, UPDATE_FOLDER, UPDATE_STATE_FILE)
}

export function readUpdateStateFile(programDir: string): UpdateStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(updateStatePath(programDir), 'utf8')) as Record<string, unknown>
    return {
      ready: raw?.ready === true,
      version: typeof raw?.version === 'string' && raw.version.trim() ? raw.version.trim() : null,
      downloadedAt:
        typeof raw?.downloadedAt === 'string' && raw.downloadedAt.trim() ? raw.downloadedAt.trim() : null,
      sha256: typeof raw?.sha256 === 'string' && raw.sha256.trim() ? raw.sha256.trim() : null
    }
  } catch {
    return defaultUpdateStateFile()
  }
}

/** tmp + rename：启动器要求 state.json 要么是旧的、要么是完整的 */
export function writeUpdateStateFile(programDir: string, state: UpdateStateFile): void {
  const file = updateStatePath(programDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** 读 app/version.json 的版本号（也可能是 app-new/version.json） */
export function readAppVersion(appDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDir, APP_VERSION_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    return typeof raw?.version === 'string' && raw.version.trim() ? raw.version.trim() : null
  } catch {
    return null
  }
}

/**
 * app-new 是不是完整的：WordMemo.exe 存在、resources 里有 app.asar、
 * 且 version.json 的版本与 latest.json 一致。
 * 注意：这里只用 readdir 判断 app.asar 是否存在，绝不对它 stat/read（见上面的注释）。
 * 真正的「asar 不是半截」检查由启动器用真实文件系统做。
 */
export function verifyAppDir(appDir: string, expectedVersion: string): boolean {
  if (!fs.existsSync(path.join(appDir, APP_EXE_NAME))) return false
  try {
    const entries = fs.readdirSync(path.join(appDir, 'resources'))
    if (!entries.includes('app.asar')) return false
  } catch {
    return false
  }
  const installed = readAppVersion(appDir)
  if (!installed || !parseVersion(installed)) return false
  return compareVersions(installed, expectedVersion) === 0
}

/** 刚解压完的目录带重试验证：杀软扫描新文件时会短暂拒绝 stat/read（见 §10 U2 记录） */
export async function verifyAppDirWithRetry(
  appDir: string,
  expectedVersion: string,
  attempts = 8,
  delayMs = 400
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (verifyAppDir(appDir, expectedVersion)) return true
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return verifyAppDir(appDir, expectedVersion)
}

// ---------------------------------------------------------------------------
// 下载 + 校验 + 解压（真实网络/磁盘，单测不覆盖，走手动验收）
// ---------------------------------------------------------------------------

/** 带「给人看的一句话」的错误：技术细节留在 cause 里，UI 只显示 userMessage */
export class UpdateError extends Error {
  readonly userMessage: string

  constructor(userMessage: string, cause?: unknown) {
    super(userMessage)
    this.name = 'UpdateError'
    this.userMessage = userMessage
    if (cause !== undefined) this.cause = cause
  }
}

export function describeUpdateError(err: unknown): string {
  if (err instanceof UpdateError) return err.userMessage
  return '网络不通或发布页暂时打不开'
}

function rawError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    const inner =
      cause instanceof Error ? ` ← ${cause.message}` : cause !== undefined ? ` ← ${String(cause)}` : ''
    return `${err.message}${inner}`
  }
  return String(err)
}

/** 下载响应体：兼容 web ReadableStream（Electron/Node fetch）与 Node 流 */
async function pumpBody(
  body: unknown,
  onChunk: (chunk: Uint8Array) => void | Promise<void>
): Promise<void> {
  const stream = body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) await onChunk(value)
    }
    return
  }
  const asyncIterable = body as AsyncIterable<Uint8Array | string> | null
  if (asyncIterable && typeof (asyncIterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    for await (const chunk of asyncIterable) {
      await onChunk(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    }
    return
  }
  throw new UpdateError('下载响应没有内容')
}

interface DownloadOptions {
  url: string
  destFile: string
  sha256: string
  fetchImpl: typeof fetch
  onProgress?: (received: number, total: number | null) => void
}

/** 流式下载到 .part，边下边算 sha256；校验不过 / 中途失败都删掉半截文件 */
export async function downloadZipFile(opts: DownloadOptions): Promise<void> {
  const tmp = `${opts.destFile}.part`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const hash = crypto.createHash('sha256')
  let handle: fs.promises.FileHandle | null = null
  let received = 0
  try {
    let response: Response
    try {
      response = await opts.fetchImpl(opts.url, { signal: controller.signal, redirect: 'follow' })
    } catch (err) {
      throw new UpdateError('下载失败：网络不通', err)
    }
    if (!response.ok) {
      throw new UpdateError(`下载失败：发布页返回 HTTP ${response.status}`, new Error(`HTTP ${response.status}`))
    }
    const length = Number(response.headers.get('content-length'))
    const total = Number.isFinite(length) && length > 0 ? length : null
    handle = await fs.promises.open(tmp, 'w')
    await pumpBody(response.body, async (chunk) => {
      const buffer = Buffer.from(chunk)
      received += buffer.length
      hash.update(buffer)
      await handle!.write(buffer)
      opts.onProgress?.(received, total)
    })
    await handle.close()
    handle = null
    const digest = hash.digest('hex')
    if (digest !== opts.sha256) {
      throw new UpdateError('更新包校验失败（sha256 不一致，可能下载不完整）')
    }
    fs.renameSync(tmp, opts.destFile)
  } catch (err) {
    try {
      await handle?.close()
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { force: true })
    if (err instanceof UpdateError) throw err
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new UpdateError('下载超时，可以稍后重试或手动下载新版', err)
    }
    throw new UpdateError('下载失败，可以稍后重试或手动下载新版', err)
  } finally {
    clearTimeout(timer)
  }
}

/** 解压：用 Windows 自带的 tar.exe（与 make-portable.mjs 同一个工具，零新依赖）。
 *  必须异步：解压 400 MB 要好几秒，同步调用会卡住主进程（托盘/IPC 全停）。 */
export async function extractZipFile(zipFile: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  try {
    await execFileAsync('tar.exe', ['-xf', zipFile, '-C', destDir], {
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024
    })
  } catch (err) {
    throw new UpdateError('更新包解压失败', err)
  }
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
  } catch {
    /* 含着 app.asar 的目录在 Electron 里可能删不掉，留给启动器下次启动清 */
  }
}

/**
 * 把目录改名让路，再尽力删掉。
 *
 * **为什么不能直接 rm**：Electron 给 `.asar` 路径打了补丁——主进程里 rm 一个含
 * `resources/app.asar` 的目录会 EBUSY，而且会在这个进程里留下一个句柄，之后连
 * 改名都会被拒绝。所以顺序必须是「先改名、再删」；删不掉就留着，由启动器
 * （C#，没有这层补丁）在下一次启动时清掉 app-new-stale-* / staging-stale-*。
 */
function parkDir(dir: string, label: string): void {
  if (!fs.existsSync(dir)) return
  const stale = path.join(path.dirname(dir), `${label}-stale-${Date.now()}`)
  try {
    fs.renameSync(dir, stale)
  } catch {
    return
  }
  removeDir(stale)
}

/** 清掉 app-new：先改名让路（绝不在 Electron 里直接 rm 含 asar 的目录） */
function clearAppNew(programDir: string): void {
  parkDir(path.join(programDir, APP_NEW_FOLDER), APP_NEW_FOLDER)
}

/** 解压临时目录：同上，先改名再删 */
function clearStaging(updateDir: string): void {
  parkDir(path.join(updateDir, 'staging'), 'staging')
}

/** 目录改名也可能被刚解压完的杀软扫描挡住，重试几次 */
async function renameWithRetry(from: string, to: string, attempts = 5, delayMs = 300): Promise<void> {
  let lastError: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      lastError = err
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 启动时顺手清掉上次没删掉的「让路」目录（app-new-stale-* / staging-stale-*） */
function sweepStaleDirs(programDir: string): void {
  try {
    const updateDir = path.join(programDir, UPDATE_FOLDER)
    for (const entry of fs.readdirSync(programDir)) {
      if (entry.startsWith(`${APP_NEW_FOLDER}-stale-`)) {
        removeDir(path.join(programDir, entry))
      }
    }
    for (const entry of fs.readdirSync(updateDir)) {
      if (entry.startsWith('staging-stale-')) {
        removeDir(path.join(updateDir, entry))
      }
    }
  } catch {
    /* ignore */
  }
}
/** 先探一下 update/ 能不能写：便携版可能被解压到只读位置 */
function ensureWritable(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.write-test')
  fs.writeFileSync(probe, 'ok', 'utf8')
  fs.rmSync(probe, { force: true })
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

export interface UpdaterOptions {
  /** 便携版根目录（app/ 的上一级）；只有这种目录才启用更新 */
  programDir: string
  currentVersion: string
  /** 读 settings.updates */
  readUpdates: () => UpdateSettings
  /** 合并写 settings.updates（主进程落盘） */
  patchUpdates: (patch: Partial<UpdateSettings>) => void
  /** 每次状态变化推一份快照 */
  onStatus?: (status: UpdateStatus) => void
  log?: (event: string, data?: Record<string, unknown>) => void
  /** 默认 net.fetch（走系统代理）；单测可换成假实现 */
  fetchImpl?: typeof fetch
  now?: () => number
  startDelayMs?: number
}

export class Updater {
  private state: UpdaterState = initialUpdaterState()
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private started = false
  private disposed = false

  constructor(private readonly opts: UpdaterOptions) {}

  get programDir(): string {
    return this.opts.programDir
  }

  status(): UpdateStatus {
    const updates = this.opts.readUpdates()
    const lastCheckAt = this.state.lastCheckAt ?? updates.lastCheckAt ?? null
    const due = updates.autoCheck ? checkDueAt(lastCheckAt, updates.failStreak, this.now()) : 0
    return {
      enabled: true,
      phase: this.state.phase,
      currentVersion: this.opts.currentVersion,
      latestVersion: this.state.latestVersion,
      pendingVersion: this.state.pendingVersion,
      skippedVersions: [...updates.skippedVersions],
      autoCheck: updates.autoCheck,
      lastCheckAt,
      nextCheckAt: updates.autoCheck && due > this.now() ? new Date(due).toISOString() : null,
      notes: this.state.notes,
      progress: this.state.progress,
      message: this.state.message,
      error: this.state.error
    }
  }

  /** 启动：清掉不该留的 app-new，恢复「已就绪」状态，并安排第一次检查 */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    // 清扫放到后台：删几百 MB 的 stale 目录会卡住窗口显示（启动器已经在启动前清过一轮）
    const sweep = setTimeout(() => sweepStaleDirs(this.opts.programDir), 5_000)
    ;(sweep as { unref?: () => void }).unref?.()
    const updates = this.opts.readUpdates()
    const file = readUpdateStateFile(this.opts.programDir)
    let pending: string | null = null
    if (file.ready && file.version && isNewerVersion(file.version, this.opts.currentVersion)) {
      pending = verifyAppDir(path.join(this.opts.programDir, APP_NEW_FOLDER), file.version)
        ? file.version
        : null
    }
    if (file.ready && !pending) {
      // 半截 app-new / 版本并不更新（换目录后重启）/ version.json 对不上：清掉
      clearAppNew(this.opts.programDir)
      this.safeWriteStateFile(defaultUpdateStateFile())
    } else if (!file.ready) {
      // 用户跳过或上次下载失败的残留：新进程里没人占着，顺手清掉（删不掉也不影响）
      clearAppNew(this.opts.programDir)
    }
    if (updates.pendingVersion !== pending) {
      this.safePatch({ pendingVersion: pending })
    }
    this.replaceState(reduceUpdaterState(this.state, { type: 'boot', pendingVersion: pending }))
    this.log('update-boot', {
      currentVersion: this.opts.currentVersion,
      pendingVersion: pending,
      lastCheckAt: updates.lastCheckAt
    })
    this.emit()
    this.schedule(true)
  }

  async checkNow(manual = true): Promise<UpdateCheckResult> {
    if (this.disposed) {
      return { ok: false, message: '更新模块没有启用', status: this.status() }
    }
    if (this.busy) {
      return { ok: true, message: '正在检查更新，请稍候', status: this.status() }
    }
    this.busy = true
    this.clearTimer()
    this.replaceState(reduceUpdaterState(this.state, { type: 'check-start' }))
    this.emit()
    const startedAt = this.now()
    const checkedIso = new Date(startedAt).toISOString()
    try {
      let latest: LatestInfo
      try {
        latest = await this.fetchLatestInfo(resolveLatestUrl())
      } catch (err) {
        const failStreak = Math.min((this.opts.readUpdates().failStreak || 0) + 1, 10)
        this.safePatch({ lastCheckAt: checkedIso, failStreak })
        this.replaceState(
          reduceUpdaterState(this.state, {
            type: 'fail',
            error: rawError(err),
            message: manual ? `这次没检查到更新：${describeUpdateError(err)}` : null,
            checkedAt: checkedIso
          })
        )
        this.log('update-check-failed', { manual, failStreak, error: rawError(err) })
        return { ok: false, message: manual ? this.state.message ?? '' : '', status: this.status() }
      }

      const updates = this.opts.readUpdates()
      const decision = decideUpdate(latest, {
        currentVersion: this.opts.currentVersion,
        skipped: updates.skippedVersions,
        manual
      })
      if (decision.action === 'none') {
        this.safePatch({ lastCheckAt: checkedIso, failStreak: 0 })
        const message = manual
          ? decision.reason === 'skipped'
            ? `v${latest.version} 已经被你跳过；想安装的话再点一次「检查更新」。`
            : `已经是最新版本（v${this.opts.currentVersion}）。`
          : null
        this.replaceState(
          reduceUpdaterState(this.state, {
            type: 'check-result',
            checkedAt: checkedIso,
            latestVersion: latest.version,
            notes: latest.notes,
            message
          })
        )
        this.emit()
        return { ok: true, message: message ?? '', status: this.status() }
      }

      if (this.state.pendingVersion && compareVersions(this.state.pendingVersion, latest.version) === 0) {
        const message = manual
          ? `新版本 v${latest.version} 已经下载好，退出后重新打开就会生效。`
          : null
        this.safePatch({ lastCheckAt: checkedIso, failStreak: 0 })
        this.replaceState(
          reduceUpdaterState(this.state, {
            type: 'check-result',
            checkedAt: checkedIso,
            latestVersion: latest.version,
            notes: latest.notes,
            message
          })
        )
        this.emit()
        return { ok: true, message: message ?? '', status: this.status() }
      }

      this.replaceState(
        reduceUpdaterState(this.state, { type: 'download-start', version: latest.version })
      )
      // 旧 pending 作废：app-new 马上要被替换，先把 state.json 回落成 ready=false，
      // 免得下载中途退出后启动器按旧 state 去找一个已经不存在的 app-new。
      this.safePatch({ pendingVersion: null })
      this.safeWriteStateFile(defaultUpdateStateFile())
      this.emit()
      try {
        await this.downloadAndStage(latest, checkedIso)
      } catch (err) {
        const failStreak = Math.min((this.opts.readUpdates().failStreak || 0) + 1, 10)
        this.safePatch({ lastCheckAt: checkedIso, failStreak })
        this.replaceState(
          reduceUpdaterState(this.state, {
            type: 'fail',
            error: rawError(err),
            message: manual ? `这次没更新成功：${describeUpdateError(err)}` : null,
            checkedAt: checkedIso
          })
        )
        this.log('update-download-failed', { manual, version: latest.version, error: rawError(err) })
        this.emit()
        return { ok: false, message: manual ? this.state.message ?? '' : '', status: this.status() }
      }
      this.safePatch({
        pendingVersion: latest.version,
        lastCheckAt: checkedIso,
        failStreak: 0
      })
      this.replaceState(
        reduceUpdaterState(this.state, {
          type: 'download-ready',
          version: latest.version,
          checkedAt: checkedIso,
          notes: latest.notes
        })
      )
      this.log('update-ready', { version: latest.version, file: latest.zip })
      this.emit()
      return {
        ok: true,
        message: `已下载 v${latest.version}，退出后重新双击 WordMemo.exe 生效。`,
        status: this.status()
      }
    } finally {
      this.busy = false
      this.emit()
      this.schedule(false)
    }
  }

  /** 跳过版本：如果已经下载好，就删掉 app-new 并让启动器不再换目录 */
  skipVersion(version?: string): UpdateStatus {
    const target =
      normalizeVersion(version) ?? this.state.pendingVersion ?? this.state.latestVersion
    if (!target) return this.status()
    const updates = this.opts.readUpdates()
    const skipped = [
      ...updates.skippedVersions.filter((entry) => normalizeVersion(entry) !== target),
      target
    ].slice(-MAX_SKIPPED_VERSIONS)
    const pending = this.state.pendingVersion
    if (pending && compareVersions(pending, target) === 0) {
      clearAppNew(this.opts.programDir)
      try {
        writeUpdateStateFile(this.opts.programDir, defaultUpdateStateFile())
      } catch (err) {
        this.log('update-skip-state-failed', { error: rawError(err) })
      }
      if (this.opts.readUpdates().pendingVersion !== null) this.safePatch({ pendingVersion: null })
    }
    this.safePatch({ skippedVersions: skipped })
    this.replaceState(
      reduceUpdaterState(this.state, {
        type: 'skip',
        version: target,
        message: `已跳过 v${target}，之后不会再自动提示；想更新可以点「检查更新」。`
      })
    )
    this.log('update-skip', { version: target })
    this.emit()
    return this.status()
  }

  setAutoCheck(enabled: boolean): UpdateStatus {
    this.safePatch({ autoCheck: enabled === true })
    if (enabled) this.schedule(false)
    else this.clearTimer()
    this.emit()
    return this.status()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private async fetchLatestInfo(url: string): Promise<LatestInfo> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch
    const attempt = async (): Promise<LatestInfo> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
      try {
        let response: Response
        try {
          response = await fetchImpl(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { accept: 'application/json', 'cache-control': 'no-cache' }
          })
        } catch (err) {
          throw new UpdateError('网络不通，或暂时打不开 GitHub', err)
        }
        if (!response.ok) {
          throw new UpdateError(
            response.status === 404 ? '发布页还没有更新信息' : `发布页返回 HTTP ${response.status}`,
            new Error(`HTTP ${response.status}`)
          )
        }
        let raw: unknown
        try {
          raw = JSON.parse(await response.text())
        } catch (err) {
          throw new UpdateError('更新信息格式不对', err)
        }
        const info = parseLatestInfo(raw, url)
        if (!info) throw new UpdateError('更新信息缺字段或格式不对')
        return info
      } finally {
        clearTimeout(timer)
      }
    }
    // GitHub 偶发空 body / 连接重置：只重试一次（计划 §3.2）
    try {
      return await attempt()
    } catch (first) {
      this.log('update-check-retry', { error: rawError(first) })
      return await attempt()
    }
  }

  private async downloadAndStage(latest: LatestInfo, checkedIso: string): Promise<void> {
    const updateDir = path.join(this.opts.programDir, UPDATE_FOLDER)
    try {
      ensureWritable(updateDir)
    } catch (err) {
      throw new UpdateError('程序目录不能写，可以到发布页手动下载新版', err)
    }
    const zipPath = path.join(updateDir, latest.zip)
    const appNew = path.join(this.opts.programDir, APP_NEW_FOLDER)
    const staging = path.join(updateDir, 'staging')
    // 先清旧暂存；清不掉就别下 140 MB——否则最后 rename 一定失败（杀软常占着刚解压的 asar）
    clearAppNew(this.opts.programDir)
    clearStaging(updateDir)
    if (fs.existsSync(appNew) || fs.existsSync(staging)) {
      throw new UpdateError('上一次的更新包暂时删不掉（杀毒软件可能在扫描），稍后再试或手动下载新版')
    }
    let lastEmit = 0
    await downloadZipFile({
      url: latest.url,
      destFile: zipPath,
      sha256: latest.sha256,
      fetchImpl: this.opts.fetchImpl ?? globalThis.fetch,
      onProgress: (received, total) => {
        const now = this.now()
        // 进度太密会刷爆 IPC；首包、末包和每 250ms 各推一次
        if (now - lastEmit < PROGRESS_EMIT_MS && (total === null || received < total)) return
        lastEmit = now
        this.replaceState(
          reduceUpdaterState(this.state, { type: 'download-progress', received, total })
        )
        this.emit()
      }
    })
    try {
      await extractZipFile(zipPath, staging)
      const stagedApp = path.join(staging, APP_FOLDER)
      if (!(await verifyAppDirWithRetry(stagedApp, latest.version))) {
        this.log('update-verify-failed', {
          version: latest.version,
          exe: fs.existsSync(path.join(stagedApp, APP_EXE_NAME)),
          versionFile: readAppVersion(stagedApp),
          hasAsar: (() => {
            try {
              return fs.readdirSync(path.join(stagedApp, 'resources')).includes('app.asar')
            } catch {
              return false
            }
          })()
        })
        throw new UpdateError('更新包内容不完整（缺 WordMemo.exe 或 version.json 版本对不上）')
      }
      clearAppNew(this.opts.programDir)
      if (fs.existsSync(appNew)) {
        throw new UpdateError('上一次的更新包暂时删不掉（杀毒软件可能在扫描），稍后再试或手动下载新版')
      }
      await renameWithRetry(stagedApp, appNew)
    } finally {
      clearStaging(updateDir)
      try {
        fs.rmSync(zipPath, { force: true })
      } catch {
        /* zip 删不掉不影响更新（下次下载前会清） */
      }
    }
    try {
      writeUpdateStateFile(this.opts.programDir, {
        ready: true,
        version: latest.version,
        downloadedAt: checkedIso,
        sha256: latest.sha256
      })
    } catch (err) {
      clearAppNew(this.opts.programDir)
      throw new UpdateError('写更新状态失败，可以到发布页手动下载新版', err)
    }
    this.log('update-staged', { version: latest.version, dir: appNew })
  }

  private schedule(initial: boolean): void {
    this.clearTimer()
    if (this.disposed || !this.started) return
    const updates = this.opts.readUpdates()
    if (!updates.autoCheck) return
    const now = this.now()
    const due = checkDueAt(updates.lastCheckAt, updates.failStreak, now)
    const floor = initial ? this.opts.startDelayMs ?? START_DELAY_MS : MIN_RETRY_DELAY_MS
    const delay = Math.min(Math.max(due - now, floor), CHECK_INTERVAL_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.checkNow(false)
    }, delay)
    // 定时器不该拖住进程退出（Electron 主进程本来就不会因为定时器退出，这里只是明确意图）
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private replaceState(next: UpdaterState): void {
    this.state = next
  }

  private emit(): void {
    try {
      this.opts.onStatus?.(this.status())
    } catch {
      /* 渲染层不在也不影响更新 */
    }
  }

  private safePatch(patch: Partial<UpdateSettings>): void {
    try {
      this.opts.patchUpdates(patch)
    } catch (err) {
      this.log('update-settings-write-failed', { error: rawError(err) })
    }
  }

  private safeWriteStateFile(state: UpdateStateFile): void {
    try {
      writeUpdateStateFile(this.opts.programDir, state)
    } catch (err) {
      this.log('update-state-write-failed', { error: rawError(err) })
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private log(event: string, data?: Record<string, unknown>): void {
    try {
      this.opts.log?.(event, data)
    } catch {
      /* ignore */
    }
  }
}

/** 开发模式 / 非便携版目录：状态仍然可查，但不能更新 */
export function disabledUpdateStatus(currentVersion: string, updates: UpdateSettings): UpdateStatus {
  return {
    enabled: false,
    phase: 'idle',
    currentVersion,
    latestVersion: null,
    pendingVersion: updates.pendingVersion,
    skippedVersions: [...updates.skippedVersions],
    autoCheck: updates.autoCheck,
    lastCheckAt: updates.lastCheckAt,
    nextCheckAt: null,
    notes: null,
    progress: null,
    message: null,
    error: null
  }
}

let current: Updater | null = null

export function initUpdater(opts: UpdaterOptions): Updater {
  current?.dispose()
  current = new Updater(opts)
  return current
}

export function getUpdater(): Updater | null {
  return current
}

export function disposeUpdater(): void {
  current?.dispose()
  current = null
}
