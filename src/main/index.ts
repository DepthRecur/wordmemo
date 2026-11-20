import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { backupBeforeMigrate, openDb } from './db/connection'
import { getSettings, initSettings, updateSettings } from './settings'
import { initFsrs } from './fsrs'
import { registerIpc } from './ipc'
import { APP_ICON, TRAY_ICON } from './icon-data'
import { countDue } from './db/cards'
import { currentDeckId, getDeck } from './db/decks'
import { countDrafts } from './db/importDrafts'
import { getDb } from './db/connection'
import { localDate } from './db/connection'
import { getDiagnostics, getIntegrity, log, setTrayState } from './diagnostics'
import { setTrayRefresher } from './tray-bridge'
import { scheduleCatalogRefresh } from './ai/catalog'
import { onBudgetExhausted } from './ai/budget'
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
} else {
  // 便携版：数据固定放 %APPDATA%\WordMemo，绝不跟着程序目录走（PLAN-UPDATE §3.11）。
  // 显式指定而不依赖 app.getName()，避免以后改 productName 时把用户数据搬家。
  app.setPath('userData', path.join(app.getPath('appData'), 'WordMemo'))
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

function notifyDue(due: number, deckName: string | null): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'WordMemo · 该复习了',
    body: deckName
      ? `「${deckName}」今天还有 ${due} 张卡片到期，花 10 分钟过一遍吧。`
      : `今天还有 ${due} 张卡片到期，花 10 分钟过一遍吧。`,
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
      const deckId = currentDeckId()
      const due = countDue(deckId)
      if (due > 0) notifyDue(due, getDeck(deckId)?.name ?? null)
    } catch {
      /* ignore */
    }
  }
  setInterval(tick, 30_000)
  setTimeout(tick, 5_000)
}

function trayMenu(due: number, drafts: number, deckName: string | null): Menu {
  return Menu.buildFromTemplate([
    { label: '打开 WordMemo', click: () => showWindow() },
    // 托盘只统计当前库（PLAN-DECKS §7）；全部库的总数只在 tooltip 里给
    { label: `当前库：${deckName ?? '全部'}`, enabled: false },
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
    const deckId = currentDeckId()
    const deck = getDeck(deckId)
    const due = countDue(deckId)
    // 全部库的总数只在 tooltip 里给（托盘图标/菜单只跟当前库走）
    const allDue = countDue()
    const drafts = countDrafts()
    const parts = [due > 0 ? `今天还有 ${due} 张卡` : '今天已完成']
    if (allDue !== due) parts.push(`全部库 ${allDue} 张`)
    if (drafts > 0) parts.push(`${drafts} 份草稿待入库`)
    tray.setToolTip(`WordMemo · ${deck?.name ?? ''} · ${parts.join(' · ')}`.replace(' ·  ·', ' · '))
    tray.setContextMenu(trayMenu(due, drafts, deck?.name ?? null))
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
  // 切库、导入、复习后立刻刷新托盘计数，不必等下一次定时刷新
  setTrayRefresher(refreshTray)
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
  const dbFile = path.join(dataDir, 'wordmemo.db')
  // 坑 1（PLAN-NEXT §7）：迁移在 openDb() 里跑，必须先复制一份旧库再打开
  try {
    const backup = backupBeforeMigrate(dbFile, path.join(dataDir, 'backups'))
    if (backup) log('pre-migrate-backup', { file: backup })
  } catch (err) {
    log('pre-migrate-backup-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  openDb(dbFile)
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
  // 预算用完只提醒一次，不拦调用（P-02）；提醒由渲染进程右下角通知条展示
  onBudgetExhausted((info) => {
    mainWindow?.webContents.send('ai:budget', info)
  })

  createWindow()
  buildTray()
  startReminderLoop()
  dailyBackup()
  // 模型目录 / 价格：启动 30 秒后后台刷新（过期才真的联网，见 PLAN-PROVIDERS §4.1/§4.2）。
  // 没有 Key 时 AI 功能整体不用，价格目录也没有意义，不要发这个请求。
  scheduleCatalogRefresh()
  if (getSettings().apiKeySet) schedulePricingRefresh()

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
