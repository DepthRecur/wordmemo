import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from './db/connection'
import { getSettings, initSettings, updateSettings } from './settings'
import { initFsrs } from './fsrs'
import { registerIpc } from './ipc'
import { APP_ICON, TRAY_ICON } from './icon-data'
import { countDue } from './db/cards'
import { countDrafts } from './db/importDrafts'
import { getDb } from './db/connection'
import { localDate } from './db/connection'
import { getDiagnostics, getIntegrity, log, setTrayState } from './diagnostics'
import { scheduleCatalogRefresh } from './ai/catalog'
import { schedulePricingRefresh } from './ai/pricing'
import { printSmokeTable, runAiSmoke } from './ai/smoke'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let lastFired = ''
let trayHintShown = false

// 开发时把数据放在项目内，避免污染真实用户目录，也方便沙箱运行
if (!app.isPackaged) {
  const devData = process.env.WORDMEMO_DATA_DIR || path.join(app.getAppPath(), '.data')
  fs.mkdirSync(devData, { recursive: true })
  app.setPath('userData', devData)
}

function userDataDir(): string {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1117',
    icon: nativeImage.createFromDataURL(APP_ICON),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
      // 第一次收进托盘时明确告诉用户「还在后台跑」，避免以为已经退出
      if (!trayHintShown) {
        trayHintShown = true
        try {
          if (Notification.isSupported()) {
            const n = new Notification({
              title: 'WordMemo 仍在后台运行',
              body: '窗口已收进托盘，图标可能位于任务栏右下角的 ^ 里。右键图标可以重启或退出；也可以在设置页直接退出。',
              icon: nativeImage.createFromDataURL(APP_ICON)
            })
            n.on('click', () => showWindow())
            n.show()
          }
        } catch {
          /* ignore */
        }
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function navigate(route: string): void {
  showWindow()
  mainWindow?.webContents.send('navigate', route)
}

/** 加载新构建：重启进程，窗口会重新从 out/ 读取代码 */
function restartApp(): void {
  quitting = true
  app.relaunch()
  app.exit(0)
}

function notifyDue(due: number): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'WordMemo · 该复习了',
    body: `今天还有 ${due} 张卡片到期，花 10 分钟过一遍吧。`,
    icon: nativeImage.createFromDataURL(APP_ICON)
  })
  n.on('click', () => navigate('review'))
  n.show()
}

function inQuietHours(now: Date, quiet: { start: string; end: string }): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes()
  const parse = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const start = parse(quiet.start)
  const end = parse(quiet.end)
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

function startReminderLoop(): void {
  const tick = () => {
    const settings = getSettings()
    if (!settings.remindEnabled) return
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (!settings.reminders.includes(hhmm)) return
    if (inQuietHours(now, settings.quietHours)) return
    const key = `${localDate(now)} ${hhmm}`
    if (lastFired === key) return
    lastFired = key
    try {
      const due = countDue()
      if (due > 0) notifyDue(due)
    } catch {
      /* ignore */
    }
  }
  setInterval(tick, 30_000)
  setTimeout(tick, 5_000)
}

function trayMenu(due: number, drafts: number): Menu {
  return Menu.buildFromTemplate([
    { label: '打开 WordMemo', click: () => showWindow() },
    { label: `今日复习（${due}）`, click: () => navigate('review') },
    { label: '听写冲刺', click: () => navigate('exam') },
    { label: '导入笔记', click: () => navigate('import') },
    ...(drafts > 0
      ? [{ label: `待入库草稿（${drafts}）`, click: () => navigate('import') }]
      : []),
    { type: 'separator' },
    { label: '设置', click: () => navigate('settings') },
    { label: '重启应用（加载新版本）', click: () => restartApp() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

function createTray(): Tray {
  const next = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
  next.on('click', () => showWindow())
  next.on('double-click', () => showWindow())
  return next
}

function refreshTray(): void {
  if (!tray) return
  try {
    const due = countDue()
    const drafts = countDrafts()
    const parts = [due > 0 ? `今天还有 ${due} 张卡` : '今天已完成']
    if (drafts > 0) parts.push(`${drafts} 份草稿待入库`)
    tray.setToolTip(`WordMemo · ${parts.join(' · ')}`)
    tray.setContextMenu(trayMenu(due, drafts))
  } catch {
    /* ignore */
  }
}

/**
 * 托盘图标是否真的挂到任务栏上了。
 * Electron 的 Tray 创建失败不会抛异常，但 getBounds() 会是空矩形，
 * 所以延迟一会儿再查一次；失败时重建一次，仍失败就记录原因。
 */
function verifyTray(attempt: number): void {
  setTimeout(() => {
    if (!tray) return
    let bounds: { width: number; height: number } | null = null
    try {
      const rect = tray.getBounds()
      bounds = { width: rect.width, height: rect.height }
    } catch {
      bounds = null
    }
    const ok = Boolean(bounds && bounds.width > 0 && bounds.height > 0)

    if (!ok && attempt < 1) {
      try {
        tray.destroy()
      } catch {
        /* ignore */
      }
      try {
        tray = createTray()
        refreshTray()
        verifyTray(attempt + 1)
        return
      } catch {
        /* fall through */
      }
    }

    const level = getIntegrity()
    setTrayState({
      ok,
      reason: ok ? null : level === 'low' ? 'low-integrity' : 'shell-rejected',
      bounds
    })
    log('tray-check', { ok, attempt, bounds, integrity: level })
  }, attempt === 0 ? 1500 : 2000)
}

function buildTray(): void {
  try {
    tray = createTray()
  } catch (err) {
    setTrayState({ ok: false, reason: 'create-failed', bounds: null })
    log('tray-create-failed', { error: err instanceof Error ? err.message : String(err) })
    return
  }
  refreshTray()
  setInterval(refreshTray, 60_000)
  verifyTray(0)
}

function dailyBackup(): void {
  try {
    const dir = path.join(userDataDir(), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const today = localDate()
    const target = path.join(dir, `wordmemo-${today}.db`)
    if (fs.existsSync(target)) return
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)')
    fs.copyFileSync(path.join(userDataDir(), 'wordmemo.db'), target)
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('wordmemo-') && f.endsWith('.db'))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - 7))) {
      try {
        fs.unlinkSync(path.join(dir, old))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.ymh.wordmemo')
  Menu.setApplicationMenu(null)

  const dataDir = userDataDir()
  openDb(path.join(dataDir, 'wordmemo.db'))
  initSettings()
  log('app-start', { ...getDiagnostics() })
  const settings = getSettings()

  // 真机冒烟入口（scripts/ai-smoke.mjs）：跑完直接退出，不建窗口、不起托盘
  if (process.argv.includes('--ai-smoke')) {
    const summary = await runAiSmoke()
    printSmokeTable(summary)
    app.exit(summary.failed ? 1 : 0)
    return
  }

  await initFsrs({
    longTermRetention: settings.longTermRetention,
    examRetention: settings.examRetention
  })
  registerIpc()

  createWindow()
  buildTray()
  startReminderLoop()
  dailyBackup()
  // 模型目录 / 价格：启动 30 秒后后台刷新（过期才真的联网，见 PLAN-PROVIDERS §4.1/§4.2）
  scheduleCatalogRefresh()
  schedulePricingRefresh()

  try {
    app.setLoginItemSettings({ openAtLogin: settings.autoLaunch })
  } catch {
    /* ignore */
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox('WordMemo 启动失败', err instanceof Error ? err.message : String(err))
    app.quit()
  })
  app.on('activate', () => showWindow())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('window-all-closed', () => {
    // 保留托盘，不退出
  })
}
