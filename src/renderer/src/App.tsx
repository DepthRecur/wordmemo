import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  Library,
  Settings as SettingsIcon,
  Upload,
  X
} from 'lucide-react'
import type { BuildInfo, DashboardStats, DraftIssueSummary, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import Review from './pages/Review'
import Notes from './pages/Notes'
import ImportPage from './pages/ImportPage'
import ExamPage from './pages/ExamPage'
import StatsPage from './pages/StatsPage'
import SettingsPage from './pages/SettingsPage'
import { Button, Modal } from './components/UI'
import { cls } from './lib/utils'

export type RouteName = 'review' | 'library' | 'import' | 'exam' | 'stats' | 'settings'
export interface NavTarget {
  route: RouteName
  examId?: number
  /** 从笔记库/托盘跳过来时，导入页要定位到的草稿 */
  draftId?: number
}

export type Notify = (message: string, type?: 'info' | 'ok' | 'err') => void
export type Navigate = (route: RouteName, examId?: number, draftId?: number) => void

type NoticeType = 'ok' | 'info' | 'err'

interface NoticeAction {
  label: string
  route: RouteName
}

interface Notice {
  id: string
  message: string
  type: NoticeType
  createdAt: number
  /** 失败类常驻，直到在铃铛里标记已处理；成功/提示 3 秒后消失 */
  persistent: boolean
  /** 只从右下角隐藏，仍然留在铃铛未处理列表里 */
  hidden?: boolean
  /** 系统类通知的稳定标识，用于自动消失与防重复弹出 */
  systemId?: string
  action?: NoticeAction
}

/** 右下角最多显示 3 条；多出来的失败消息隐藏到铃铛，瞬时提示直接丢弃 */
function trimVisible(list: Notice[]): Notice[] {
  const visible = list.filter((n) => !n.hidden)
  if (visible.length <= 3) return list
  const overflow = new Set(visible.slice(0, visible.length - 3).map((n) => n.id))
  const next: Notice[] = []
  for (const notice of list) {
    if (!overflow.has(notice.id)) {
      next.push(notice)
      continue
    }
    if (notice.persistent) next.push({ ...notice, hidden: true })
  }
  return next
}

function formatNoticeTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const NAV: { route: RouteName; label: string; icon: typeof BookOpen }[] = [
  { route: 'review', label: '今日任务', icon: BookOpen },
  { route: 'library', label: '笔记库', icon: Library },
  { route: 'import', label: '导入笔记', icon: Upload },
  { route: 'exam', label: '听写冲刺', icon: CalendarClock },
  { route: 'stats', label: '学习统计', icon: BarChart3 },
  { route: 'settings', label: '设置', icon: SettingsIcon }
]

export default function App() {
  const initialRoute = (() => {
    const page = new URLSearchParams(window.location.search).get('page')
    return NAV.some((n) => n.route === page) ? (page as RouteName) : 'review'
  })()
  const [nav, setNav] = useState<NavTarget>({ route: initialRoute })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [draftCount, setDraftCount] = useState(0)
  const [draftIssues, setDraftIssues] = useState<DraftIssueSummary>({
    drafts: 0,
    draftsWithIssues: 0,
    unresolved: 0
  })
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [bellOpen, setBellOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [libraryVersion, setLibraryVersion] = useState(0)
  const navRef = useRef(nav)
  navRef.current = nav
  const draftNotified = useRef(false)
  const dismissedSystem = useRef<Set<string>>(new Set())
  const noticeTimers = useRef<Map<string, number>>(new Map())

  const notify: Notify = useCallback((message, type = 'info') => {
    const persistent = type === 'err'
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setNotices((list) =>
      trimVisible([...list, { id, message, type, createdAt: Date.now(), persistent }])
    )
    if (!persistent) {
      const timer = window.setTimeout(() => {
        setNotices((list) => list.filter((n) => n.id !== id))
        noticeTimers.current.delete(id)
      }, 3000)
      noticeTimers.current.set(id, timer)
    }
  }, [])

  /** 右下角「叉掉」：只隐藏，不删除；仍在铃铛里等待处理 */
  const hideNotice = useCallback((id: string) => {
    setNotices((list) => list.map((n) => (n.id === id ? { ...n, hidden: true } : n)))
  }, [])

  /** 铃铛里「已处理」：真正移除；系统通知本次会话不再重复弹 */
  const resolveNotice = useCallback((id: string) => {
    setNotices((list) => {
      const target = list.find((n) => n.id === id)
      if (target?.systemId) dismissedSystem.current.add(target.systemId)
      return list.filter((n) => n.id !== id)
    })
    const timer = noticeTimers.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      noticeTimers.current.delete(id)
    }
  }, [])

  /** 系统类通知：条件成立时显示，条件消失时自动移除；手动叉掉后本次会话不再弹 */
  const syncSystemNotice = useCallback(
    (systemId: string, present: boolean, message: string, action?: NoticeAction) => {
      setNotices((list) => {
        if (!present) return list.filter((n) => n.systemId !== systemId)
        if (dismissedSystem.current.has(systemId)) return list
        const existing = list.find((n) => n.systemId === systemId)
        if (existing) {
          if (
            existing.message === message &&
            existing.action?.label === action?.label &&
            existing.action?.route === action?.route
          ) {
            return list
          }
          return list.map((n) =>
            n.systemId === systemId ? { ...n, message, action, createdAt: Date.now() } : n
          )
        }
        return trimVisible([
          ...list,
          {
            id: `sys-${systemId}`,
            message,
            type: 'err',
            createdAt: Date.now(),
            persistent: true,
            systemId,
            action
          }
        ])
      })
    },
    []
  )

  const clearAllNotices = useCallback(() => {
    setNotices((list) => {
      for (const n of list) if (n.systemId) dismissedSystem.current.add(n.systemId)
      return list.filter((n) => !n.persistent)
    })
  }, [])

  const navigate = useCallback((route: RouteName, examId?: number, draftId?: number) => {
    setNav({ route, examId, draftId })
  }, [])

  const refreshDraftCount = useCallback(async () => {
    try {
      const [count, issues] = await Promise.all([
        window.api.importer.draftCount(),
        window.api.importer.draftIssues()
      ])
      setDraftCount(count)
      setDraftIssues(issues)
    } catch {
      /* ignore */
    }
  }, [])

  const quitApp = useCallback(() => {
    if (window.confirm('退出 WordMemo？未入库的草稿已经自动保存，下次打开会恢复。')) {
      void window.api.system.quit()
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    const s = await window.api.settings.get()
    setSettings(s)
    return s
  }, [])

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.api.stats.dashboard())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const s = await window.api.settings.get()
        setSettings(s)
        await refreshStats()
        await refreshDraftCount()
      } finally {
        setReady(true)
      }
    })()
  }, [refreshStats, refreshDraftCount])

  useEffect(() => {
    const unsubscribe = window.api.events.onNavigate((route) => {
      if (['review', 'library', 'import', 'exam', 'stats', 'settings'].includes(route)) {
        setNav({ route: route as RouteName })
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshStats()
      void refreshDraftCount()
    }, 60_000)
    return () => clearInterval(timer)
  }, [refreshStats, refreshDraftCount])

  // 每次启动提醒一次：还有识别完没入库的笔记
  useEffect(() => {
    if (!ready || draftNotified.current || draftCount <= 0) return
    draftNotified.current = true
    notify(`还有 ${draftCount} 份笔记识别完成但未入库，点侧边栏「导入笔记」继续`, 'info')
  }, [ready, draftCount, notify])

  // 构建/启动/权限/托盘状态：托盘检测是延迟完成的，所以查两次
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const load = async () => {
      try {
        const info = await window.api.system.buildInfo()
        if (!cancelled) setBuildInfo(info)
      } catch {
        /* ignore */
      }
    }
    void load()
    const timer = setTimeout(() => void load(), 3200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ready])

  // 系统通知源：API Key、托盘/权限、草稿校验；条件消失时自动移除
  useEffect(() => {
    if (!ready) return
    syncSystemNotice(
      'api-key',
      !settings.apiKeySet,
      '尚未配置 API Key：图片识别、AI 校验和语义判分都不可用。在「设置 → AI 供应商」里填默认模型那家的 Key。',
      { label: '去设置', route: 'settings' }
    )
  }, [ready, settings.apiKeySet, syncSystemNotice])

  useEffect(() => {
    if (!buildInfo) return
    const broken = buildInfo.integrity === 'low' || buildInfo.tray.ok === false
    const message =
      buildInfo.integrity === 'low'
        ? '当前以低权限运行，Windows 不会显示托盘图标。请退出后从资源管理器双击 WordMemo.exe。'
        : '托盘图标没有创建成功，可能被 Windows 收进了隐藏区。'
    syncSystemNotice('tray', broken, message, { label: '查看诊断', route: 'settings' })
  }, [buildInfo, syncSystemNotice])

  useEffect(() => {
    if (!ready) return
    const present = draftIssues.unresolved > 0
    const message = `有 ${draftIssues.draftsWithIssues} 份草稿共 ${draftIssues.unresolved} 处校验提示待处理。`
    syncSystemNotice('drafts', present, message, { label: '去处理', route: 'import' })
  }, [ready, draftIssues, syncSystemNotice])

  const persistentNotices = useMemo(() => notices.filter((n) => n.persistent), [notices])
  const visibleNotices = notices.filter((n) => !n.hidden).slice(-3)

  const common = {
    notify,
    settings,
    refreshSettings,
    navigate,
    refreshStats
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: 'linear-gradient(135deg,#5b8def,#7c5cfc)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 19,
              fontWeight: 800,
              color: '#fff'
            }}
          >
            W
          </div>
          <div>
            <div className="brand-name">WordMemo</div>
            <div className="brand-sub">英语笔记背诵</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map(({ route, label, icon: Icon }) => (
            <button
              key={route}
              className={cls('nav-item', nav.route === route && 'active')}
              onClick={() => setNav({ route })}
            >
              <Icon size={17} />
              <span>{label}</span>
              {route === 'review' && (stats?.dueToday ?? 0) + (stats?.newToday ?? 0) > 0 && (
                <span className="count">
                  {(stats?.dueToday ?? 0) + (stats?.newToday ?? 0) > 99
                    ? '99+'
                    : (stats?.dueToday ?? 0) + (stats?.newToday ?? 0)}
                </span>
              )}
              {route === 'import' && draftCount > 0 && (
                <span className="count" title="识别完成但还没入库的草稿">
                  {draftCount > 99 ? '99+' : draftCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>连续复习 {stats?.streak ?? 0} 天</div>
          <div className="row-between" style={{ marginTop: 6 }}>
            <div className="row" style={{ gap: 2 }}>
              <span className="tiny">v{buildInfo?.version ?? '0.1.0'}</span>
              <button
                className="bell-btn"
                onClick={() => setBellOpen(true)}
                title={
                  persistentNotices.length
                    ? `未处理通知（${persistentNotices.length}）`
                    : '通知'
                }
              >
                <Bell size={14} />
                {persistentNotices.length > 0 && <span className="bell-dot" />}
              </button>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: '0 6px' }}
              onClick={quitApp}
              title="退出 WordMemo（草稿已自动保存）"
            >
              退出
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {!ready ? (
          <div className="empty">正在打开词库…</div>
        ) : nav.route === 'review' ? (
          <Review {...common} examId={nav.examId} onFinished={refreshStats} />
        ) : nav.route === 'library' ? (
          <Notes
            {...common}
            version={libraryVersion}
            draftCount={draftCount}
            onChanged={() => setLibraryVersion((v) => v + 1)}
          />
        ) : nav.route === 'import' ? (
          <ImportPage
            {...common}
            focusDraftId={nav.draftId}
            onDraftsChanged={refreshDraftCount}
            onImported={() => {
              setLibraryVersion((v) => v + 1)
              refreshStats()
            }}
          />
        ) : nav.route === 'exam' ? (
          <ExamPage {...common} />
        ) : nav.route === 'stats' ? (
          <StatsPage stats={stats} onRefresh={refreshStats} />
        ) : (
          <SettingsPage {...common} />
        )}
      </main>

      <div className="toast-wrap">
        {visibleNotices.map((notice) => (
          <div
            key={notice.id}
            className={cls('toast', notice.type === 'ok' && 'ok', notice.type === 'err' && 'err')}
          >
            <div className="toast-body">{notice.message}</div>
            {notice.persistent && (
              <button
                className="toast-x"
                onClick={() => hideNotice(notice.id)}
                title="暂时隐藏（仍在通知中心）"
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      <Modal
        open={bellOpen}
        title={`未处理通知${persistentNotices.length ? `（${persistentNotices.length}）` : ''}`}
        onClose={() => setBellOpen(false)}
        width={560}
        footer={
          <>
            {persistentNotices.length > 0 && (
              <Button variant="ghost" onClick={clearAllNotices}>
                全部标记已处理
              </Button>
            )}
            <span className="spacer" />
            <Button onClick={() => setBellOpen(false)}>关闭</Button>
          </>
        }
      >
        {persistentNotices.length === 0 ? (
          <div className="hint">没有未处理的通知。</div>
        ) : (
          <div className="notice-list">
            {persistentNotices.map((notice) => (
              <div key={notice.id} className="notice-item">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div>{notice.message}</div>
                  <div className="notice-time">{formatNoticeTime(notice.createdAt)}</div>
                </div>
                {notice.action && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setBellOpen(false)
                      navigate(notice.action!.route)
                    }}
                  >
                    {notice.action.label}
                  </Button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  title="标记为已处理并移除"
                  onClick={() => resolveNotice(notice.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}
