import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  DEFAULT_LATEST_URL,
  MAX_BACKOFF_MS,
  MAX_SKIPPED_VERSIONS,
  checkDueAt,
  checkIntervalMs,
  compareVersions,
  decideUpdate,
  disabledUpdateStatus,
  initialUpdaterState,
  isCheckDue,
  isNewerVersion,
  isVersionSkipped,
  parseLatestInfo,
  parseVersion,
  readAppVersion,
  readUpdateStateFile,
  reduceUpdaterState,
  resolveLatestUrl,
  verifyAppDir,
  writeUpdateStateFile,
  type LatestInfo,
  type UpdaterState
} from '../src/main/updater'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const HOUR = 60 * 60 * 1000
const dirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-updater-'))
  dirs.push(dir)
  return dir
}

function latest(overrides: Partial<LatestInfo> = {}): LatestInfo {
  return {
    version: '0.4.1',
    zip: 'WordMemo-0.4.1-portable.zip',
    sha256: 'a'.repeat(64),
    notes: null,
    url: 'https://github.com/DepthRecur/wordmemo/releases/latest/download/WordMemo-0.4.1-portable.zip',
    ...overrides
  }
}

const BASE = 'https://github.com/DepthRecur/wordmemo/releases/latest/download/latest.json'

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
})

describe('版本比较', () => {
  it('解析常见写法；坏版本号返回 null', () => {
    expect(parseVersion('0.4.0')).toEqual({ major: 0, minor: 4, patch: 0, prerelease: [] })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-rc.1').prerelease).toEqual(['rc', 1])
    expect(parseVersion('1.2.3+build.7')?.prerelease).toEqual([])
    for (const bad of ['', 'abc', '1.2', '1.2.3.4', 'v', null, undefined, 123]) {
      expect(parseVersion(bad as unknown)).toBeNull()
    }
  })

  it('按数字比而不是字符串比（0.1.10 > 0.1.9）', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('v0.4.0', '0.4')).toBe(1) // 0.4 无效，排在有效版本前面
    expect(isNewerVersion('0.4.1', '0.4.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '0.4.0')).toBe(false)
    expect(isNewerVersion('0.3.9', '0.4.0')).toBe(false)
  })

  it('预发布号小于同版本正式版；数字段按数字比', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('2.0.0-alpha', '1.9.9')).toBe(1)
  })
})

describe('latest.json 解析', () => {
  it('正常：字段齐全、notes 去空白、zip 相对路径解析成同源地址', () => {
    const info = parseLatestInfo(
      {
        version: 'v0.4.1',
        zip: 'WordMemo-0.4.1-portable.zip',
        sha256: 'ABCDEF'.repeat(10) + 'ABCD',
        notes: '  修复若干问题  '
      },
      BASE
    )
    expect(info).not.toBeNull()
    expect(info!.version).toBe('0.4.1')
    expect(info!.sha256).toBe(('ABCDEF'.repeat(10) + 'ABCD').toLowerCase())
    expect(info!.notes).toBe('修复若干问题')
    expect(info!.url).toBe(
      'https://github.com/DepthRecur/wordmemo/releases/latest/download/WordMemo-0.4.1-portable.zip'
    )
  })

  it('缺字段 / sha 长度不对 / 不是 .zip 都拒绝', () => {
    const good = { version: '0.4.1', zip: 'a.zip', sha256: 'b'.repeat(64) }
    expect(parseLatestInfo(null, BASE)).toBeNull()
    expect(parseLatestInfo({}, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, version: 'nope' }, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, sha256: 'b'.repeat(63) }, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, zip: 'a.exe' }, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, zip: '' }, BASE)).toBeNull()
  })

  it('zip 只允许纯文件名，不能带目录（防止写到 update/ 外面）', () => {
    const good = { version: '0.4.1', zip: 'a.zip', sha256: 'b'.repeat(64) }
    expect(parseLatestInfo({ ...good, zip: '../evil.zip' }, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, zip: 'sub/a.zip' }, BASE)).toBeNull()
    expect(parseLatestInfo({ ...good, zip: 'C:\\evil.zip' }, BASE)).toBeNull()
  })

  it('notes 太长会截断', () => {
    const info = parseLatestInfo(
      { version: '0.4.1', zip: 'a.zip', sha256: 'b'.repeat(64), notes: 'x'.repeat(1000) },
      BASE
    )
    expect(info!.notes!.length).toBe(400)
  })
})

describe('检查节流与退避', () => {
  it('成功一次 24h；失败 1h → 2h → 4h → 6h 封顶', () => {
    expect(checkIntervalMs(0)).toBe(CHECK_INTERVAL_MS)
    expect(checkIntervalMs(1)).toBe(HOUR)
    expect(checkIntervalMs(2)).toBe(2 * HOUR)
    expect(checkIntervalMs(3)).toBe(4 * HOUR)
    expect(checkIntervalMs(4)).toBe(MAX_BACKOFF_MS)
    expect(checkIntervalMs(9)).toBe(MAX_BACKOFF_MS)
    expect(checkIntervalMs(-1)).toBe(CHECK_INTERVAL_MS)
  })

  it('没有上次记录 = 立刻可查；24h 内不重复', () => {
    const last = '2026-11-21T00:00:00.000Z'
    const lastMs = Date.parse(last)
    expect(checkDueAt(null, 0, lastMs)).toBe(0)
    expect(checkDueAt(last, 0, lastMs + 23 * HOUR)).toBe(lastMs + 24 * HOUR)
    expect(checkDueAt(last, 0, lastMs + 24 * HOUR)).toBe(lastMs + 24 * HOUR)
    expect(isCheckDue({ autoCheck: true, lastCheckAt: last, failStreak: 0 }, lastMs + 23 * HOUR)).toBe(false)
    expect(isCheckDue({ autoCheck: true, lastCheckAt: last, failStreak: 0 }, lastMs + 24 * HOUR)).toBe(true)
  })

  it('自动检查关掉就不查；手动检查永远放行', () => {
    const last = '2026-11-21T00:00:00.000Z'
    const now = Date.parse(last) + HOUR
    expect(isCheckDue({ autoCheck: false, lastCheckAt: null, failStreak: 0 }, now)).toBe(false)
    expect(isCheckDue({ autoCheck: true, lastCheckAt: last, failStreak: 0 }, now, true)).toBe(true)
  })

  it('时钟回拨：上次检查时间在未来 → 现在就能查，不会永久停摆', () => {
    const now = Date.parse('2026-11-21T00:00:00.000Z')
    const future = new Date(now + 3 * HOUR).toISOString()
    expect(checkDueAt(future, 0, now)).toBe(now)
    expect(isCheckDue({ autoCheck: true, lastCheckAt: future, failStreak: 0 }, now)).toBe(true)
  })
})

describe('跳过版本与更新决策', () => {
  it('跳过列表按规范化版本号匹配（带不带 v 都一样）', () => {
    expect(isVersionSkipped('0.4.1', ['0.4.1'])).toBe(true)
    expect(isVersionSkipped('0.4.1', ['v0.4.1'])).toBe(true)
    expect(isVersionSkipped('v0.4.1', ['0.4.1'])).toBe(true)
    expect(isVersionSkipped('0.4.1', ['0.4.0'])).toBe(false)
    expect(isVersionSkipped('0.4.1', [])).toBe(false)
  })

  it('已是最新 → none；自动检查尊重跳过；手动检查穿透跳过', () => {
    expect(decideUpdate(latest({ version: '0.4.0' }), { currentVersion: '0.4.0', skipped: [], manual: false })).toEqual({
      action: 'none',
      reason: 'up-to-date'
    })
    expect(
      decideUpdate(latest(), { currentVersion: '0.4.0', skipped: ['0.4.1'], manual: false })
    ).toEqual({ action: 'none', reason: 'skipped' })
    expect(decideUpdate(latest(), { currentVersion: '0.4.0', skipped: ['0.4.1'], manual: true })).toMatchObject({
      action: 'download'
    })
    expect(decideUpdate(latest(), { currentVersion: '0.4.0', skipped: [], manual: false })).toMatchObject({
      action: 'download'
    })
  })
})

describe('更新状态机', () => {
  function run(actions: Parameters<typeof reduceUpdaterState>[1][]): UpdaterState {
    return actions.reduce(reduceUpdaterState, initialUpdaterState())
  }

  it('检查 → 下载 → 就绪', () => {
    const checked = run([{ type: 'check-start' }])
    expect(checked.phase).toBe('checking')

    const found = reduceUpdaterState(checked, {
      type: 'check-result',
      checkedAt: '2026-11-21T00:00:00.000Z',
      latestVersion: '0.4.1',
      notes: '修复'
    })
    expect(found.phase).toBe('idle')
    expect(found.latestVersion).toBe('0.4.1')
    expect(found.notes).toBe('修复')
    expect(found.lastCheckAt).toBe('2026-11-21T00:00:00.000Z')

    const downloading = reduceUpdaterState(found, { type: 'download-start', version: '0.4.1' })
    expect(downloading.phase).toBe('downloading')
    expect(downloading.progress).toEqual({ received: 0, total: null })

    const progress = reduceUpdaterState(downloading, {
      type: 'download-progress',
      received: 512,
      total: 1024
    })
    expect(progress.progress).toEqual({ received: 512, total: 1024 })

    const ready = reduceUpdaterState(progress, {
      type: 'download-ready',
      version: '0.4.1',
      checkedAt: '2026-11-21T00:01:00.000Z'
    })
    expect(ready.phase).toBe('ready')
    expect(ready.pendingVersion).toBe('0.4.1')
    expect(ready.progress).toBeNull()
    expect(ready.message).toContain('0.4.1')
  })

  it('已有待装版本时，检查结果仍是 ready；进度只在 downloading 阶段生效', () => {
    const pending = run([
      { type: 'boot', pendingVersion: '0.4.1' },
      { type: 'check-start' }
    ])
    expect(pending.phase).toBe('checking')
    const result = reduceUpdaterState(pending, {
      type: 'check-result',
      checkedAt: '2026-11-21T00:00:00.000Z',
      latestVersion: '0.4.1'
    })
    expect(result.phase).toBe('ready')
    expect(result.pendingVersion).toBe('0.4.1')
    expect(reduceUpdaterState(initialUpdaterState(), { type: 'download-progress', received: 1, total: 2 }).progress).toBeNull()
  })

  it('开始下载新版本会清掉旧的 pending（旧 app-new 马上要被替换）', () => {
    const ready = run([{ type: 'boot', pendingVersion: '0.4.1' }])
    expect(ready.phase).toBe('ready')
    const downloading = reduceUpdaterState(ready, { type: 'download-start', version: '0.4.2' })
    expect(downloading.phase).toBe('downloading')
    expect(downloading.pendingVersion).toBeNull()
    expect(downloading.latestVersion).toBe('0.4.2')
  })

  it('失败进入 error；跳过会清掉对应的 pending/latest/notes', () => {
    const failed = run([{ type: 'fail', error: 'ECONNRESET', message: '这次没检查到更新：网络不通' }])
    expect(failed.phase).toBe('error')
    expect(failed.error).toBe('ECONNRESET')
    expect(failed.message).toContain('网络不通')

    const ready = run([
      { type: 'download-ready', version: '0.4.1', checkedAt: '2026-11-21T00:01:00.000Z', notes: '修复' },
      { type: 'skip', version: '0.4.1' }
    ])
    expect(ready.phase).toBe('idle')
    expect(ready.pendingVersion).toBeNull()
    expect(ready.latestVersion).toBeNull()
    expect(ready.notes).toBeNull()
  })
})

describe('程序目录文件', () => {
  it('update/state.json 往返；坏文件/缺失按默认值', () => {
    const root = tmpDir()
    expect(readUpdateStateFile(root)).toEqual({
      ready: false,
      version: null,
      downloadedAt: null,
      sha256: null
    })
    writeUpdateStateFile(root, {
      ready: true,
      version: '0.4.1',
      downloadedAt: '2026-11-21T00:00:00.000Z',
      sha256: 'c'.repeat(64)
    })
    expect(readUpdateStateFile(root)).toEqual({
      ready: true,
      version: '0.4.1',
      downloadedAt: '2026-11-21T00:00:00.000Z',
      sha256: 'c'.repeat(64)
    })
    fs.writeFileSync(path.join(root, 'update', 'state.json'), '{ broken', 'utf8')
    expect(readUpdateStateFile(root).ready).toBe(false)
  })

  it('app-new 校验：exe + resources/app.asar + version.json 版本一致才算完整', () => {
    const root = tmpDir()
    const app = path.join(root, 'app-new')
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(app, 'WordMemo.exe'), '', 'utf8')
    fs.writeFileSync(path.join(app, 'resources', 'app.asar'), 'x', 'utf8')
    fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version: '0.4.1' }), 'utf8')
    expect(readAppVersion(app)).toBe('0.4.1')
    expect(verifyAppDir(app, '0.4.1')).toBe(true)
    expect(verifyAppDir(app, '0.4.2')).toBe(false)

    const noExe = path.join(root, 'app-noexe')
    fs.mkdirSync(path.join(noExe, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(noExe, 'resources', 'app.asar'), 'x', 'utf8')
    fs.writeFileSync(path.join(noExe, 'version.json'), JSON.stringify({ version: '0.4.1' }), 'utf8')
    expect(verifyAppDir(noExe, '0.4.1')).toBe(false)

    const badVersion = path.join(root, 'app-bad')
    fs.mkdirSync(path.join(badVersion, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(badVersion, 'WordMemo.exe'), '', 'utf8')
    fs.writeFileSync(path.join(badVersion, 'resources', 'app.asar'), 'x', 'utf8')
    fs.writeFileSync(path.join(badVersion, 'version.json'), '{ bad', 'utf8')
    expect(verifyAppDir(badVersion, '0.4.1')).toBe(false)

    // 半截解压：exe 与 version.json 都在，但 app.asar 没解出来
    // （大小是否半截交给启动器用真实文件系统查，Electron 里 stat .asar 会返回 0）
    const half = path.join(root, 'app-half')
    fs.mkdirSync(path.join(half, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(half, 'WordMemo.exe'), '', 'utf8')
    fs.writeFileSync(path.join(half, 'version.json'), JSON.stringify({ version: '0.4.1' }), 'utf8')
    expect(verifyAppDir(half, '0.4.1')).toBe(false)
  })
})

describe('更新源与开关', () => {
  it('默认 GitHub 静态资源；https 可以覆盖；http 只允许本机', () => {
    expect(resolveLatestUrl({})).toBe(DEFAULT_LATEST_URL)
    expect(resolveLatestUrl({ WORDMEMO_UPDATE_URL: 'https://example.com/latest.json' })).toBe(
      'https://example.com/latest.json'
    )
    expect(resolveLatestUrl({ WORDMEMO_UPDATE_URL: 'http://127.0.0.1:8080/latest.json' })).toBe(
      'http://127.0.0.1:8080/latest.json'
    )
    expect(resolveLatestUrl({ WORDMEMO_UPDATE_URL: 'http://localhost:8080/latest.json' })).toBe(
      'http://localhost:8080/latest.json'
    )
    expect(resolveLatestUrl({ WORDMEMO_UPDATE_URL: 'http://example.com/latest.json' })).toBe(DEFAULT_LATEST_URL)
    expect(resolveLatestUrl({ WORDMEMO_UPDATE_URL: 'not a url' })).toBe(DEFAULT_LATEST_URL)
  })

  it('开发模式状态：enabled=false，但带上设置里的开关与跳过列表', () => {
    const status = disabledUpdateStatus('0.4.0', {
      ...DEFAULT_SETTINGS.updates,
      autoCheck: false,
      skippedVersions: ['0.4.1']
    })
    expect(status.enabled).toBe(false)
    expect(status.phase).toBe('idle')
    expect(status.currentVersion).toBe('0.4.0')
    expect(status.autoCheck).toBe(false)
    expect(status.skippedVersions).toEqual(['0.4.1'])
  })

  it('跳过版本最多留 20 条（由设置合并裁剪）', () => {
    const many = Array.from({ length: 30 }, (_, i) => `0.${i}.0`)
    const status = disabledUpdateStatus('0.4.0', { ...DEFAULT_SETTINGS.updates, skippedVersions: many.slice(-MAX_SKIPPED_VERSIONS) })
    expect(status.skippedVersions).toHaveLength(MAX_SKIPPED_VERSIONS)
  })
})
