import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Database, FolderOpen, Volume2 } from 'lucide-react'
import type {
  AiPriceInfo,
  AiProviderConfig,
  AiProviderId,
  AiProviderInfo,
  AiSettingsInfo,
  AiTestResult,
  BuildInfo,
  Deck,
  SandboxInfo,
  Settings,
  UpdateStatus
} from '@shared/types'
import { Badge, Button, Field, Modal, Progress, Toggle } from '../components/UI'
import { ModelPicker } from '../components/ModelPicker'
import { Select } from '../components/Select'
import { SyncPanel } from '../components/SyncPanel'
import type { Navigate, Notify } from '../App'
import { cls, formatBytes } from '../lib/utils'
import { ownedPatch } from '../lib/settingsPatch'

type SettingsSection = 'providers' | 'ai' | 'review' | 'decks' | 'sync' | 'reminder' | 'tts' | 'advanced'

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'providers', label: 'AI 供应商' },
  { key: 'ai', label: 'AI 角色与预算' },
  { key: 'review', label: '复习节奏' },
  { key: 'decks', label: '笔记库' },
  { key: 'sync', label: '同步' },
  { key: 'reminder', label: '提醒' },
  { key: 'tts', label: '发音源' },
  { key: 'advanced', label: '高级与诊断' }
]

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
  navigate: Navigate
  refreshStats: (deckId?: number | null) => Promise<void>
  decks: Deck[]
  deckId: number | null
  setDeck: (id: number) => Promise<void>
  refreshDecks: () => Promise<Deck[]>
  /** C-02：库变了（建/改名/删/移动）之后通知外层，让笔记库列表丢掉缓存、统计重读 */
  onLibraryChanged?: () => void
  /** 从别的页面跳进来时直接打开的分区（如「笔记库」） */
  initialSection?: string
}

const SOURCE_LABEL: Record<string, string> = {
  youdao: '有道词典',
  baidu: '百度翻译',
  freedict: 'Free Dictionary API'
}

/** Key 申请地址（只做提示，不预设任何账号信息） */
const KEY_HINT: Record<string, string> = {
  deepseek: '在 platform.deepseek.com 申请。只保存在本机。',
  openai: '在 platform.openai.com 申请；大陆地区可能要走代理才能测试成功。',
  gemini: '在 aistudio.google.com 申请；走官方 OpenAI 兼容层。',
  glm: '在 open.bigmodel.cn 申请，国内可直连。'
}

function formatBuild(iso: string | null | undefined): string {
  if (!iso) return '构建时间未知'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '构建时间未知'
  const p = (n: number) => String(n).padStart(2, '0')
  return `构建 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const INTEGRITY_LABEL: Record<string, string> = {
  low: '低权限（Low）',
  medium: '正常权限（Medium）',
  high: '管理员权限（High）',
  system: '系统权限',
  unknown: '未知'
}

function formatAgo(iso: string | null): string {
  if (!iso) return '还没拉过'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '时间未知'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function priceText(price: AiPriceInfo): string {
  if (!price.priced) return '费用未知（只统计 token）'
  const source = price.source === 'catalog' ? 'models.dev' : '随包快照'
  const suffix = price.asOf ? ` · ${source} ${price.asOf}` : ''
  return `≈$${price.input}/M 入 · $${price.output}/M 出${suffix}`
}

/** 更新状态的一句话（设置页「版本」下面那行） */
function updateStateText(status: UpdateStatus | null): string {
  if (!status) return '读取中…'
  switch (status.phase) {
    case 'checking':
      return '正在检查…'
    case 'downloading': {
      const total = status.progress?.total
      const pct = total ? Math.min(100, Math.floor((status.progress!.received / total) * 100)) : null
      return `正在下载 v${status.latestVersion ?? ''}${pct === null ? '' : ` · ${pct}%`}`
    }
    case 'ready':
      return `v${status.pendingVersion ?? status.latestVersion ?? ''} 已下载，退出后重新打开生效`
    case 'error':
      return '上次检查没成功（不影响使用）'
    default:
      return status.lastCheckAt ? '已经是最新版本' : '还没检查过'
  }
}

/** 打字停顿这么久才落盘，避免每个按键都写一次 settings.json */
const AUTO_SAVE_MS = 500

export default function SettingsPage({
  notify,
  settings,
  refreshSettings,
  refreshStats,
  decks,
  deckId,
  setDeck,
  refreshDecks,
  onLibraryChanged,
  initialSection
}: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [section, setSection] = useState<SettingsSection>('providers')
  const [saving, setSaving] = useState(false)
  const [cache, setCache] = useState({ files: 0, bytes: 0 })
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null)
  const [sandboxBusy, setSandboxBusy] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  // 四张供应商卡片：卡片数据只读，Key 只回显"已配置"
  const [info, setInfo] = useState<AiSettingsInfo | null>(null)
  const [expanded, setExpanded] = useState<AiProviderId | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, AiTestResult | undefined>>({})
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [pricingBusy, setPricingBusy] = useState(false)

  // 库管理：每行一个本地草稿（改名 / 单独额度），改动 500ms 后自动写库（不再有「保存」按钮）
  const [deckDrafts, setDeckDrafts] = useState<Record<number, { name: string; quota: string }>>({})
  const [deckSaving, setDeckSaving] = useState(false)
  const [newDeckName, setNewDeckName] = useState('')
  const [deckBusy, setDeckBusy] = useState(false)
  const [deleteDeck, setDeleteDeck] = useState<Deck | null>(null)
  const [deleteMoveTo, setDeleteMoveTo] = useState<number | null>(null)

  const providers = info?.providers ?? []
  const lastSaved = useRef(JSON.stringify(ownedPatch(settings)))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const deckDraftsRef = useRef(deckDrafts)
  deckDraftsRef.current = deckDrafts
  const decksRef = useRef(decks)
  decksRef.current = decks

  const loadInfo = async () => {
    try {
      setInfo(await window.api.settings.aiProviders())
    } catch {
      /* 读不到就当没有配置 */
    }
  }

  // 外面改了设置（保存/清除 Key 后 refreshSettings 会带回新值）：本地没有未保存
  // 的输入时才跟随，避免把正在打字的内容冲掉
  useEffect(() => {
    if (JSON.stringify(ownedPatch(draftRef.current)) !== lastSaved.current) return
    setDraft(settings)
  }, [settings])

  // 自动保存（P-05）：改动 500ms 后写盘，不再需要「保存设置」按钮
  useEffect(() => {
    const payload = ownedPatch(draft)
    const json = JSON.stringify(payload)
    if (json === lastSaved.current) return
    const timer = window.setTimeout(() => {
      setSaving(true)
      void (async () => {
        try {
          await window.api.settings.update(payload)
          lastSaved.current = json
          await refreshSettings()
          await loadInfo()
        } catch (err) {
          notify(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'err')
        } finally {
          setSaving(false)
        }
      })()
    }, AUTO_SAVE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, notify, refreshSettings])

  useEffect(() => {
    if (initialSection && SECTIONS.some((s) => s.key === initialSection)) {
      setSection(initialSection as SettingsSection)
    }
  }, [initialSection])

  useEffect(() => {
    void window.api.tts.cacheSize().then(setCache)
    void window.api.system.appVersion().then(setVersion)
    void window.api.system.buildInfo().then(setBuild)
    void window.api.sandbox.get().then(setSandbox).catch(() => undefined)
    void window.api.updates.status().then(setUpdate).catch(() => undefined)
    const offUpdates = window.api.events.onUpdateStatus(setUpdate)
    void loadInfo()
    return () => offUpdates()
  }, [])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const providerCfg = (id: AiProviderId): AiProviderConfig => draft.ai.providers[id] ?? {}

  /** 把当前草稿立刻写盘（测试连接前先存，保证测的就是屏幕上的配置） */
  const persistNow = async () => {
    const payload = ownedPatch(draftRef.current)
    const json = JSON.stringify(payload)
    if (json === lastSaved.current) return
    await window.api.settings.update(payload)
    lastSaved.current = json
    await refreshSettings()
    await loadInfo()
  }

  /** 卡片上显示公开名（拿不到目录名就退回 id） */
  const modelLabel = (p: AiProviderInfo): string => {
    if (!p.model) return '未填模型'
    return p.models.find((m) => m.id === p.model)?.name ?? p.model
  }

  const patchProvider = (id: AiProviderId, patch: AiProviderConfig) => {
    setDraft((d) => ({
      ...d,
      ai: {
        ...d.ai,
        providers: { ...d.ai.providers, [id]: { ...(d.ai.providers[id] ?? {}), ...patch } }
      }
    }))
  }

  const setDefaultRole = (id: AiProviderId) => {
    setDraft((d) => ({ ...d, ai: { ...d.ai, default: { ...d.ai.default, provider: id } } }))
  }

  const setVisionEnabled = (on: boolean) => {
    setDraft((d) => ({
      ...d,
      ai: { ...d.ai, vision: on ? { provider: d.ai.vision?.provider ?? d.ai.default.provider } : null }
    }))
  }

  const setVisionRole = (id: AiProviderId) => {
    setDraft((d) => ({
      ...d,
      ai: { ...d.ai, vision: { provider: id, model: d.ai.vision?.model } }
    }))
  }

  const saveProviderKey = async (p: AiProviderInfo) => {
    const key = (keyDrafts[p.id] ?? '').trim()
    if (!key && !p.keySet) return
    setBusy((b) => ({ ...b, [p.id]: true }))
    try {
      // 先落盘模型/Base URL，再测——测的就是输入框里的配置（P-05）
      await persistNow()
      if (key) {
        const saved = await window.api.settings.setApiKey(p.id, key)
        if (!saved) {
          notify('Key 保存失败：数据目录不可写', 'err')
          return
        }
      }
      const res = await window.api.settings.testApiKey(p.id)
      setResults((r) => ({ ...r, [p.id]: res }))
      if (res.ok) {
        notify(key ? `${p.label} 的 Key 已保存并验证通过` : `${p.label} 连接正常`, 'ok')
        setKeyDrafts((k) => ({ ...k, [p.id]: '' }))
        await refreshSettings()
        await loadInfo()
      } else {
        notify(`${p.label}：${res.message}`, 'err')
      }
    } catch (err) {
      notify(`验证失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy((b) => ({ ...b, [p.id]: false }))
    }
  }

  const clearProviderKey = async (p: AiProviderInfo) => {
    await window.api.settings.clearApiKey(p.id)
    setResults((r) => ({ ...r, [p.id]: undefined }))
    await refreshSettings()
    await loadInfo()
    notify(`已清除 ${p.label} 的 Key`, 'ok')
  }

  const clearAllKeys = async () => {
    if (!window.confirm('清除所有供应商的 API Key（含旧版 secrets.bin）？清除后 AI 功能需要重新配置。')) return
    await window.api.settings.clearAllApiKeys()
    setResults({})
    await refreshSettings()
    await loadInfo()
    notify('已清除全部 API Key', 'ok')
  }

  const refreshCatalogFor = async (p: AiProviderInfo) => {
    setRefreshing((r) => ({ ...r, [p.id]: true }))
    try {
      const res = await window.api.settings.refreshCatalog(p.id, true)
      setInfo(res.info)
      // 只读刷新失败：旧列表还在、模型也能手填，功能没坏 → 警告（docs/MESSAGES.md）
      notify(
        res.ok
          ? `${p.label}：${res.message}`
          : `这次没刷新到 ${p.label} 的模型列表：${res.message}（旧列表还能用，也可以手填）`,
        res.ok ? 'ok' : 'warn'
      )
    } catch {
      notify(`这次没刷新到 ${p.label} 的模型列表（旧列表还能用，也可以手填）`, 'warn')
    } finally {
      setRefreshing((r) => ({ ...r, [p.id]: false }))
    }
  }

  const clearAnswerCache = async () => {
    if (
      !window.confirm(
        '清空 AI 回答缓存？\n清空后同样的内容会重新请求 AI（会消耗 token）。\n\n' +
          '提示：缓存键不含模型，所以换了模型也可能会复用旧答案；想拿到新答案就清一次。'
      )
    ) {
      return
    }
    try {
      const removed = await window.api.settings.clearAiCache()
      notify(`已清空 ${removed} 条 AI 缓存`, 'ok')
      await loadInfo()
    } catch (error) {
      notify(`清空缓存失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    }
  }

  const refreshPricingNow = async () => {
    setPricingBusy(true)
    try {
      const res = await window.api.settings.refreshPricing(true)
      setInfo(res.info)
      // 价格刷不到就用随包快照估算，不影响任何功能 → 警告
      notify(
        res.ok ? res.message : `这次没刷新到价格：${res.message}（仍按随包快照估算）`,
        res.ok ? 'ok' : 'warn'
      )
    } catch {
      notify('这次没刷新到价格（仍按随包快照估算）', 'warn')
    } finally {
      setPricingBusy(false)
    }
  }

  /** 测试失败时给一段可以贴出来的诊断信息（脱敏：不含 Key） */
  const copyDiagnostic = async (p: AiProviderInfo) => {
    const res = results[p.id]
    const lines = [
      `provider: ${res?.provider ?? p.id}`,
      `baseUrl: ${p.baseUrl}`,
      `model: ${res?.model ?? (p.model || '(未填)')}`,
      `ok: ${res?.ok ?? false}`,
      `message: ${res?.message ?? ''}`,
      `latencyMs: ${typeof res?.latencyMs === 'number' ? res.latencyMs : 'n/a'}`,
      `at: ${new Date().toISOString()}`
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      notify('诊断信息已复制（不含 Key），可以直接贴出来', 'ok')
    } catch {
      // 剪贴板不可用：信息还在屏幕上，用户可以截图 → 警告，不是错误
      notify('没能复制，请手动截图上面那一行提示', 'warn')
    }
  }

  const testResultText = (res: AiTestResult): string => {
    const bits = [res.message]
    if (res.model) bits.push(res.model)
    if (typeof res.latencyMs === 'number') bits.push(`${res.latencyMs} ms`)
    return bits.join(' · ')
  }

  const moveSource = (index: number, dir: -1 | 1) => {
    const next = [...draft.ttsSources]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    set('ttsSources', next)
  }

  /** 库行编辑：改动停顿 500ms 后自动写库（与「改动会自动保存」一致，没有保存按钮） */
  const deckDraftOf = (deck: Deck) =>
    deckDrafts[deck.id] ?? {
      name: deck.name,
      quota: deck.newPerDay === null ? '' : String(deck.newPerDay)
    }

  const patchDeckDraft = (deck: Deck, patch: Partial<{ name: string; quota: string }>) =>
    setDeckDrafts((prev) => ({ ...prev, [deck.id]: { ...deckDraftOf(deck), ...patch } }))

  const flushDeckDrafts = async () => {
    const entries = Object.entries(deckDraftsRef.current)
    if (!entries.length) return
    const handled: number[] = []
    setDeckSaving(true)
    try {
      for (const [key, local] of entries) {
        const id = Number(key)
        const deck = decksRef.current.find((d) => d.id === id)
        if (!deck) {
          // 库已经删掉了，草稿跟着丢
          handled.push(id)
          continue
        }
        const name = local.name.trim()
        // 名字被清空时先不写：用户可能正在重打，写空名只会报「库名不能为空」
        if (!name) continue
        const quota = local.quota.trim()
        const newPerDay = quota === '' ? null : Math.max(0, Math.trunc(Number(quota)) || 0)
        if (name !== deck.name || newPerDay !== deck.newPerDay) {
          await window.api.decks.update(id, { name, newPerDay })
        }
        handled.push(id)
      }
      if (!handled.length) return
      // 先刷新拿到新值，再清草稿：否则输入框会闪一下旧值
      await refreshDecks()
      // 改名/改额度之后，笔记库列表里的库名与「待学」也要跟着变（C-02）
      onLibraryChanged?.()
      setDeckDrafts((prev) => {
        const next = { ...prev }
        for (const id of handled) delete next[id]
        return next
      })
    } catch (err) {
      notify(`更新库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setDeckSaving(false)
    }
  }

  // 改动停 500ms 后自动写库；草稿为空时什么都不做
  useEffect(() => {
    if (!Object.keys(deckDrafts).length) return
    const timer = window.setTimeout(() => void flushDeckDrafts(), AUTO_SAVE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckDrafts])

  const createDeckRow = async () => {
    const name = newDeckName.trim()
    if (!name) {
      notify('先给新库起个名字', 'info')
      return
    }
    const wasEmpty = decks.length === 0
    setDeckBusy(true)
    try {
      const id = await window.api.decks.create({ name })
      setNewDeckName('')
      await refreshDecks()
      onLibraryChanged?.()
      // 从「一个库都没有」建起来的：顺手设为当前库，别让托盘/导入还在 0 上
      if (wasEmpty) await setDeck(id)
      notify(`已创建「${name}」`, 'ok')
    } catch (err) {
      notify(`创建库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setDeckBusy(false)
    }
  }

  const moveDeckRow = async (deck: Deck, dir: -1 | 1) => {
    const list = [...decks]
    const i = list.findIndex((d) => d.id === deck.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    setDeckBusy(true)
    try {
      // 重新编号：position 有重复时单纯交换不会改变顺序
      for (let index = 0; index < list.length; index++) {
        if (list[index].position !== index) {
          await window.api.decks.update(list[index].id, { position: index })
        }
      }
      await refreshDecks()
      onLibraryChanged?.()
    } catch (err) {
      notify(`调整顺序失败：${err instanceof Error ? err.message : String(err)}`, 'err')    } finally {
      setDeckBusy(false)
    }
  }

  const removeDeckRow = async () => {
    if (!deleteDeck) return
    // 最后一个库：没有别的库可以接收，笔记变成「未归类」（允许一个库都没有）
    const isLast = decks.filter((d) => d.id !== deleteDeck.id).length === 0
    const target = isLast ? null : (deleteMoveTo ?? decks.find((d) => d.id !== deleteDeck.id)?.id ?? null)
    if (!isLast && target === null) {
      notify('先选一个库来接收这些笔记', 'info')
      return
    }
    setDeckBusy(true)
    try {
      const removedCurrent = deckId === deleteDeck.id
      const res = await window.api.decks.remove(deleteDeck.id, target)
      const next = await refreshDecks()
      // 删库/合并之后：笔记库列表可能还缓存着旧行与旧库名，这里强制失效（C-02）
      onLibraryChanged?.()
      // 统计按删除后的当前库刷新（D-07）；删的是当前库时目标库由主进程决定，可能为 null
      void refreshStats(removedCurrent ? target : undefined)
      if (removedCurrent) {
        // 主进程已经把 currentDeckId 写成 moveTo（或 0 = 没有库），这里只同步本地设置；
        // 不要自己挑「第一个库」覆盖它（D-05）
        await refreshSettings()
      }
      const targetName = target === null ? '' : (next.find((d) => d.id === target)?.name ?? '')
      // 这一行的本地草稿也跟着删掉，别让自动保存再往已删的库里写
      setDeckDrafts((prev) => {
        const rest = { ...prev }
        delete rest[deleteDeck.id]
        return rest
      })
      notify(
        target === null
          ? `已删除最后一个库「${deleteDeck.name}」，${res.unassigned} 份笔记变成「未归类」（在笔记库的「全部」里，可以再移进新库）`
          : `已删除「${deleteDeck.name}」，${res.moved} 份笔记移到了「${targetName}」`,
        'ok'
      )
      setDeleteDeck(null)
    } catch (err) {
      notify(`删除库失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setDeckBusy(false)
    }
  }

  const backup = async () => {
    try {
      const p = await window.api.system.backup()
      notify(`已备份到 ${p}`, 'ok')
    } catch (err) {
      notify(`备份失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const setSandboxCompat = async (enabled: boolean) => {
    setSandboxBusy(true)
    try {
      const next = await window.api.sandbox.setCompat(enabled)
      setSandbox(next)
      notify(
        enabled
          ? '已开启兼容模式，下次启动生效'
          : '已关闭兼容模式，下次启动会按正常模式重新检测',
        'ok'
      )
    } catch (err) {
      notify(`设置兼容模式失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setSandboxBusy(false)
    }
  }

  const resetSandbox = async () => {
    setSandboxBusy(true)
    try {
      const next = await window.api.sandbox.setCompat(false)
      setSandbox(next)
      notify('已清除失败计数，下次启动会按正常模式尝试', 'ok')
    } catch (err) {
      notify(`重置失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setSandboxBusy(false)
    }
  }

  const quitApp = () => {
    if (window.confirm('退出 WordMemo？未入库的草稿已经自动保存，下次打开会恢复。')) {
      void window.api.system.quit()
    }
  }

  /** U2：检查更新（手动检查无视 24h 节流和「跳过这个版本」） */
  const checkForUpdates = async () => {
    setUpdateBusy(true)
    try {
      const result = await window.api.updates.check()
      setUpdate(result.status)
      if (!result.ok) {
        // 只读操作失败、旧版照常能用 → 警告，不是错误
        notify(result.message || '这次没检查到更新，旧的照常用', 'warn')
      } else if (result.status.phase === 'ready') {
        notify(result.message, 'ok')
        // pendingVersion 落在 settings 里，重读一次，别让设置页的草稿带着旧值
        await refreshSettings()
      } else {
        notify(result.message || '已经是最新版本', 'info')
      }
    } catch (err) {
      notify(`检查更新失败：${err instanceof Error ? err.message : String(err)}`, 'warn')
    } finally {
      setUpdateBusy(false)
    }
  }

  const skipUpdateVersion = async () => {
    setUpdateBusy(true)
    try {
      setUpdate(await window.api.updates.skipVersion())
      await refreshSettings()
      notify('已跳过这个版本，之后不会再自动提示；想更新可以再点「检查更新」', 'info')
    } catch (err) {
      notify(`跳过版本失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setUpdateBusy(false)
    }
  }

  const setAutoCheckUpdate = async (enabled: boolean) => {
    try {
      setUpdate(await window.api.updates.setAutoCheck(enabled))
      await refreshSettings()
    } catch (err) {
      notify(`保存自动检查设置失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const refreshBuild = async () => {
    try {
      const info = await window.api.system.buildInfo()
      setBuild(info)
      setVersion(info.version)
      notify('已重新检测构建、权限与托盘状态', 'ok')
    } catch (err) {
      notify(`检测失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">API、复习节奏、发音与数据备份。所有数据只保存在本机。</div>
        </div>
        <span className="hint">{saving ? '保存中…' : '改动会自动保存'}</span>
      </div>

      <div className="page-scroll">
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={cls('nav-item', section === s.key && 'active')}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
        <div className="panel" hidden={section !== 'providers'}>
          <div className="panel-title row">
            <span>AI 供应商</span>
            <span style={{ flex: 1 }} />
            <Badge tone={providers.some((p) => p.keySet) ? 'green' : 'yellow'}>
              {providers.filter((p) => p.keySet).length} / {providers.length || 4} 家已配置
            </Badge>
            <Button size="sm" variant="ghost" onClick={() => void clearAnswerCache()}>
              清空回答缓存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clearAllKeys()}>
              清除全部 Key
            </Button>
          </div>
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="hint">
              价格：{info?.pricing.source ?? 'models.dev'} {info?.pricing.asOf ?? ''} · 本月 ≈$
              {(info?.usage.cost ?? 0).toFixed(4)} · {info?.usage.calls ?? 0} 次调用
              {info && info.usage.unpricedCalls > 0
                ? ` · 另有 ${info.usage.unpricedCalls} 次调用没有价格（只算 token）`
                : ''}
            </span>
            <span style={{ flex: 1 }} />
            <Button size="sm" disabled={pricingBusy} onClick={() => void refreshPricingNow()}>
              {pricingBusy ? '刷新中…' : '刷新价格'}
            </Button>
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>
            Key 只保存在本机，不会上传。价格按公开价估算，可能和账单有出入；未知模型只统计 token。
          </div>
          <div className="col" style={{ gap: 8 }}>
            {providers.map((p) => {
              const cfg = providerCfg(p.id)
              const isOpen = expanded === p.id
              const result = results[p.id]
              // 「保存并测试」：Key 和模型缺一个就点不了，悬浮说明缺什么（P-09）
              const missing: string[] = []
              if (!p.keySet && !(keyDrafts[p.id] ?? '').trim()) missing.push('API Key')
              if (!cfg.model?.trim() && p.id !== 'deepseek') missing.push('模型名')
              return (
                <div
                  key={p.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    background: 'var(--panel-2)'
                  }}
                >
                  <div className="row">
                    <span style={{ fontWeight: 600 }}>{p.label}</span>
                    {p.unverified && (
                      <Badge
                        tone="yellow"
                        title="作者没有该地区的账号/Key，参数按官方文档写；报错请把提示发出来"
                      >
                        未验证
                      </Badge>
                    )}
                    <Badge tone={p.keySet ? 'green' : 'default'}>
                      {p.keySet ? '已配置' : '未配置'}
                    </Badge>
                    <span className="muted tiny">{modelLabel(p)}</span>
                    <span style={{ flex: 1 }} />
                    <Button
                      size="sm"
                      variant={isOpen ? 'ghost' : 'default'}
                      onClick={() => setExpanded(isOpen ? null : p.id)}
                    >
                      {isOpen ? '收起' : '配置'}
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="col" style={{ marginTop: 8 }}>
                      <Field label="API Key" hint={KEY_HINT[p.id] ?? '只保存在本机。'}>
                        <input
                          className="input"
                          type="password"
                          placeholder={p.keySet ? '已保存，如需更换请重新粘贴' : '粘贴该家的 API Key'}
                          value={keyDrafts[p.id] ?? ''}
                          onChange={(e) =>
                            setKeyDrafts((k) => ({ ...k, [p.id]: e.target.value }))
                          }
                        />
                      </Field>
                      <div className="row">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy[p.id] || missing.length > 0}
                          title={missing.length ? `还需要填${missing.join('和')}` : undefined}
                          onClick={() => void saveProviderKey(p)}
                        >
                          {busy[p.id] ? '验证中…' : '保存并测试'}
                        </Button>
                        {p.keySet && (
                          <Button size="sm" variant="danger" onClick={() => void clearProviderKey(p)}>
                            清除
                          </Button>
                        )}
                        {result && <span className="hint">{testResultText(result)}</span>}
                        {result && !result.ok && (
                          <Button size="sm" variant="ghost" onClick={() => void copyDiagnostic(p)}>
                            复制诊断信息
                          </Button>
                        )}
                      </div>
                      <div className="grid grid-2">
                        <Field
                          label="模型"
                          hint={
                            p.models.length
                              ? `目录里 ${p.models.length} 个；按名字或 id 搜索，也可以手填`
                              : '还没有目录：配好 Key 后点「刷新目录」，或直接手填模型名'
                          }
                        >
                          <ModelPicker
                            value={cfg.model ?? ''}
                            models={p.models}
                            placeholder={p.id === 'deepseek' ? 'deepseek-flash' : '搜索或手填模型名'}
                            emptyHint="目录里还没有模型：配好 Key 后点上面的「刷新目录」，或直接手填。"
                            onChange={(id) => patchProvider(p.id, { model: id })}
                          />
                        </Field>
                        <Field
                          label="Base URL"
                          hint={
                            p.fixedCatalogUrl
                              ? '只影响聊天请求；模型目录固定从官方端点拉取'
                              : '留空 = 官方端点；只有代理/中转才需要改'
                          }
                        >
                          <input
                            className="input"
                            value={cfg.baseUrl ?? ''}
                            placeholder={p.baseUrl}
                            onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                        <span className="hint" title={p.catalogError ?? undefined}>
                          目录：{p.models.length ? `${p.models.length} 个模型 · ${formatAgo(p.modelsFetchedAt)}` : '还没拉取'}
                          {p.catalogError ? ' · 上次刷新失败' : ''}
                        </span>
                        {p.keySet && (
                          <Button
                            size="sm"
                            disabled={refreshing[p.id]}
                            onClick={() => void refreshCatalogFor(p)}
                          >
                            {refreshing[p.id] ? '刷新中…' : '刷新目录'}
                          </Button>
                        )}
                      </div>
                      <div className="hint">价格：{priceText(p.price)}</div>
                      <div className="hint">{p.vision ? '支持图片识别' : '不支持图片识别'}</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="panel" hidden={section !== 'ai'}>
          <div className="panel-title">AI 角色与预算</div>
          <div className="col">
            <Field label="默认模型" hint="导入、判分、音标、补搭配都走这家">
              <Select
                value={draft.ai.default.provider}
                options={providers.map((p) => ({
                  value: p.id,
                  label: `${p.label}${p.model ? ` · ${modelLabel(p)}` : '（未填模型）'}${p.unverified ? '（未验证）' : ''}`
                }))}
                onChange={(next) => setDefaultRole(next as AiProviderId)}
              />
            </Field>
            <Toggle
              checked={!!draft.ai.vision}
              onChange={setVisionEnabled}
              label="图片识别单独指定供应商"
              hint="关闭时跟随默认模型；导入图片时会走这里选的这家。"
            />
            {draft.ai.vision && (
              <Field label="图片识别用哪家">
                <Select
                  value={draft.ai.vision.provider}
                  options={providers
                    .filter((p) => p.vision || p.id === draft.ai.vision?.provider)
                    .map((p) => ({
                      value: p.id,
                      label: `${p.label}${p.unverified ? '（未验证）' : ''}`
                    }))}
                  onChange={(next) => setVisionRole(next as AiProviderId)}
                />
              </Field>
            )}
            <Field
              label="每月 AI 预算（美元，0 表示不限）"
              hint="按估算金额统计，实际出账可能略有出入"
            >
              <input
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={draft.monthlyBudgetUsd}
                onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))}
              />
            </Field>
            <Toggle
              checked={draft.aiValidate}
              onChange={(v) => set('aiValidate', v)}
              label="导入时用 AI 校验笔记"
              hint="关闭后只做本地解析，不再检查拼写和释义错误。"
            />
            <Toggle
              checked={draft.aiJudge}
              onChange={(v) => set('aiJudge', v)}
              label="中文答案用 AI 判断语义"
              hint="能本地命中时不会调用 AI；关闭后不同表述需要你手动确认。"
            />
          </div>
        </div>

        <div className="panel" hidden={section !== 'review'}>
          <div className="panel-title">复习节奏</div>
          <div className="col">
            <div className="grid grid-2">
              <Field label="长期记忆目标保留率" hint="0.85~0.95，越高复习越频繁">
                <input
                  className="input"
                  type="number"
                  min={0.8}
                  max={0.97}
                  step={0.01}
                  value={draft.longTermRetention}
                  onChange={(e) => set('longTermRetention', Number(e.target.value))}
                />
              </Field>
              <Field label="听写冲刺目标保留率" hint="建议 0.93~0.97">
                <input
                  className="input"
                  type="number"
                  min={0.85}
                  max={0.99}
                  step={0.01}
                  value={draft.examRetention}
                  onChange={(e) => set('examRetention', Number(e.target.value))}
                />
              </Field>
              <Field label="每天新词上限">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={200}
                  value={draft.newPerDay}
                  onChange={(e) => set('newPerDay', Number(e.target.value))}
                />
              </Field>
              <Field label="每天复习预算（分钟）">
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={180}
                  value={draft.dailyMinutes}
                  onChange={(e) => set('dailyMinutes', Number(e.target.value))}
                />
              </Field>
              <Field label="学习卡提前量（分钟）">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={120}
                  value={draft.learnAheadMinutes}
                  onChange={(e) => set('learnAheadMinutes', Number(e.target.value))}
                />
              </Field>
            </div>

            <Toggle
              checked={draft.listenCardEnabled}
              onChange={(v) => set('listenCardEnabled', v)}
              label="默认创建「听→写」卡片"
              hint="英→中、中→英始终保留；这个开关只影响新导入的词条，已存在的词可在笔记库里单独开关。"
            />
            <Toggle
              checked={draft.autoPlayAudio}
              onChange={(v) => set('autoPlayAudio', v)}
              label="翻到卡片时自动播放读音"
            />

            <Field label="口音">
              <Select
                value={draft.accent}
                options={[
                  { value: 'us', label: '美式发音' },
                  { value: 'uk', label: '英式发音' }
                ]}
                onChange={(next) => set('accent', next as 'us' | 'uk')}
              />
            </Field>
            <div className="hint">复习时不显示音标（避免通过音标反推拼写），需要时在词条详情里看。</div>
          </div>
        </div>

        <div className="panel" hidden={section !== 'decks'}>
          <div className="panel-title row">
            <span>笔记库</span>
            <span style={{ flex: 1 }} />
            <span className="hint">同一个词在两个库只学一次；库只决定从哪个范围抽卡</span>
          </div>
          <div className="col" style={{ gap: 10 }}>
            {decks.map((deck, index) => {
              const local = deckDraftOf(deck)
              const isCurrent = deck.id === deckId
              return (
                <div
                  key={deck.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    background: 'var(--panel-2)'
                  }}
                >
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      style={{ width: 180 }}
                      value={local.name}
                      onChange={(e) => patchDeckDraft(deck, { name: e.target.value })}
                    />
                    <span className="hint">每天新词</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={999}
                      style={{ width: 90 }}
                      placeholder={`全局 ${settings.newPerDay}`}
                      value={local.quota}
                      onChange={(e) => patchDeckDraft(deck, { quota: e.target.value })}
                    />
                    <span className="hint">个（留空 = 用全局 {settings.newPerDay}）</span>
                  </div>
                  <div className="row-between" style={{ marginTop: 8 }}>
                    <span className="tiny muted">
                      {deck.noteCount} 份笔记 · {deck.itemCount} 个词条 · 待学 {deck.todayNew} · 到期{' '}
                      {deck.dueCount}
                      {deck.learnedToday > 0 ? ` · 今天已学 ${deck.learnedToday}` : ''}
                    </span>
                    <div className="row">
                      {isCurrent ? (
                        <Badge tone="accent">当前库</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => void setDeck(deck.id)}>
                          设为当前库
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title="上移"
                        disabled={index === 0 || deckBusy}
                        onClick={() => void moveDeckRow(deck, -1)}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="下移"
                        disabled={index === decks.length - 1 || deckBusy}
                        onClick={() => void moveDeckRow(deck, 1)}
                      >
                        <ArrowDown size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deckBusy}
                        onClick={() => {
                          setDeleteDeck(deck)
                          setDeleteMoveTo(decks.find((d) => d.id !== deck.id)?.id ?? null)
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {decks.length === 0 && (
            <div className="hint" style={{ marginTop: 4 }}>
              现在一个库都没有。笔记会记成「未归类」，在笔记库的「全部」里能看到；建一个库以后可以把它们移过去。
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <input
              className="input"
              style={{ width: 220 }}
              placeholder="新库名称，如「课标词汇」"
              value={newDeckName}
              onChange={(e) => setNewDeckName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createDeckRow()
              }}
            />
            <Button onClick={() => void createDeckRow()} disabled={deckBusy}>
              新建库
            </Button>
            <span className="hint">{deckSaving ? '正在保存…' : '改名和每日新词改动后自动保存'}</span>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            删除库时，库里的笔记会先移到你选的目标库，不会连笔记一起删。合并 = 全选移到目标库再删空库。
            删到最后一个库也可以：那些笔记会变成「未归类」，不会丢。
          </div>
        </div>

        <div className="panel" hidden={section !== 'reminder'}>
          <div className="panel-title">提醒</div>
          <div className="col">
            <Toggle
              checked={draft.remindEnabled}
              onChange={(v) => set('remindEnabled', v)}
              label="开启到期提醒"
              hint="应用需要保持运行（可以最小化到托盘）。"
            />
            <Field label="提醒时间（24 小时制，逗号分隔）">
              <input
                className="input"
                value={draft.reminders.join(', ')}
                onChange={(e) => set('reminders', e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
            <div className="grid grid-2">
              <Field label="免打扰开始">
                <input
                  className="input"
                  type="time"
                  value={draft.quietHours.start}
                  onChange={(e) => set('quietHours', { ...draft.quietHours, start: e.target.value })}
                />
              </Field>
              <Field label="免打扰结束">
                <input
                  className="input"
                  type="time"
                  value={draft.quietHours.end}
                  onChange={(e) => set('quietHours', { ...draft.quietHours, end: e.target.value })}
                />
              </Field>
            </div>
            <Toggle
              checked={draft.autoLaunch}
              onChange={(v) => set('autoLaunch', v)}
              label="开机自动启动"
              hint="保存后立即生效；建议同时保持托盘运行，才能按时提醒。"
            />
          </div>
        </div>

        <div className="panel" hidden={section !== 'tts'}>
          <div className="panel-title row">
            <Volume2 size={16} /> 发音源（按顺序尝试）
          </div>
          <div className="col" style={{ gap: 6 }}>
            {draft.ttsSources.map((s, i) => (
              <div
                key={s}
                className="row"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '7px 10px',
                  background: 'var(--panel-2)'
                }}
              >
                <span style={{ width: 22 }} className="muted tiny">
                  {i + 1}
                </span>
                <span style={{ flex: 1 }}>{SOURCE_LABEL[s] ?? s}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => moveSource(i, -1)} disabled={i === 0} title="上移">
                  <ArrowUp size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => moveSource(i, 1)}
                  disabled={i === draft.ttsSources.length - 1}
                  title="下移"
                >
                  <ArrowDown size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            可能是非官方接口，限流时会自动换下一个；音频会缓存到本地，断网也能播。
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted tiny">
              缓存：{cache.files} 个文件 · {formatBytes(cache.bytes)}
            </span>
            <Button
              size="sm"
              onClick={async () => {
                await window.api.tts.clear()
                setCache(await window.api.tts.cacheSize())
                notify('发音缓存已清空', 'ok')
              }}
            >
              清空缓存
            </Button>
          </div>
        </div>

        {section === 'sync' && (
          <SyncPanel notify={notify} settings={settings} refreshSettings={refreshSettings} />
        )}

        <div className="panel" hidden={section !== 'advanced'}>
          <div className="panel-title row">
            <Database size={16} /> 高级与诊断
          </div>
          <div className="col">
            <div className="hint">数据库、原始上传文件和发音缓存都在本机。建议每周备份一次。</div>
            <div className="row">
              <Button onClick={() => void backup()}>立即备份</Button>
              <Button onClick={() => void window.api.system.openDataDir()}>
                <FolderOpen size={15} /> 打开数据目录
              </Button>
            </div>
            <div className="row-between" style={{ marginTop: 8 }}>
              <span className="muted tiny">版本</span>
              <span className="tiny">
                v{build?.version ?? version ?? '0.1.0'} · {formatBuild(build?.buildTime)}
              </span>
            </div>
            {/* U2 自更新：应用只下载，换目录靠启动器在下一次启动时做 */}
            <Toggle
              checked={update?.autoCheck ?? settings.updates.autoCheck}
              onChange={(v) => void setAutoCheckUpdate(v)}
              label="自动检查更新"
              hint="启动后每天检查一次；下载完不会自己重启，退出后重新双击 WordMemo.exe 才会换到新版。"
            />
            {update && !update.enabled ? (
              <div className="hint">开发模式（或不是便携版目录）：不检查更新。</div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                <div className="row-between">
                  <span className="muted tiny">更新</span>
                  <span className="tiny">{updateStateText(update)}</span>
                </div>
                {update?.phase === 'downloading' && (
                  <>
                    <Progress
                      value={
                        update.progress?.total
                          ? Math.min(1, update.progress.received / update.progress.total)
                          : 0
                      }
                    />
                    <span className="muted tiny">
                      已下载 {formatBytes(update.progress?.received ?? 0)}
                      {update.progress?.total ? ` / ${formatBytes(update.progress.total)}` : ''}
                    </span>
                  </>
                )}
                <div className="row">
                  <Button
                    size="sm"
                    onClick={() => void checkForUpdates()}
                    disabled={
                      updateBusy ||
                      update?.phase === 'checking' ||
                      update?.phase === 'downloading'
                    }
                  >
                    {update?.phase === 'checking'
                      ? '正在检查…'
                      : update?.phase === 'downloading'
                        ? '正在下载…'
                        : '检查更新'}
                  </Button>
                  {update?.pendingVersion && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void skipUpdateVersion()}
                      disabled={updateBusy}
                    >
                      跳过 v{update.pendingVersion}
                    </Button>
                  )}
                  <span className="muted tiny">
                    下载好之后，退出程序再重新双击 WordMemo.exe 才会换成新版。
                  </span>
                </div>
                {update?.notes && (
                  <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                    {update.notes}
                  </div>
                )}
                {update?.lastCheckAt && (
                  <div className="muted tiny">上次检查：{formatAgo(update.lastCheckAt)}</div>
                )}
                {update?.phase === 'error' && update.message && (
                  <div className="hint">{update.message}</div>
                )}
              </div>
            )}
            <div className="row-between">
              <span className="muted tiny">后台运行</span>
              <span className="tiny">关闭窗口只是收进托盘，到期提醒仍然生效</span>
            </div>
            <Toggle
              checked={sandbox?.compatMode ?? false}
              onChange={(v) => void setSandboxCompat(v)}
              label="兼容模式（关闭 Chromium 沙箱）"
              hint="仅在应用打不开时开启；功能不变，安全性略降。改完下次启动生效。"
            />
            {sandbox?.compatMode && sandbox.autoEnabled && (
              <div className="hint">当前是自动探测开启的（连续启动失败后切换）。</div>
            )}
            {sandbox && sandbox.failStreak > 0 && (
              <div className="hint">
                已连续启动失败 {sandbox.failStreak} 次；满 {sandbox.maxFailStreak} 次会自动开启兼容模式。
              </div>
            )}
            <div className="row">
              <Button size="sm" variant="ghost" onClick={() => void resetSandbox()} disabled={sandboxBusy || !sandbox}>
                重新检测
              </Button>
              <span className="muted tiny">清掉失败计数，下次启动按正常模式试</span>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => void window.api.system.restart()}>
                重启应用
              </Button>
              <Button size="sm" variant="danger" onClick={quitApp}>
                退出应用
              </Button>
            </div>
            <details className="diag">
              <summary>诊断信息</summary>
              <div className="col" style={{ marginTop: 8 }}>
                <div className="row-between">
                  <span className="muted tiny">构建 / 启动</span>
                  <span className="tiny">
                    {formatBuild(build?.buildTime)} · 启动 {formatClock(build?.startedAt)}
                  </span>
                </div>
                <div className="row-between">
                  <span className="muted tiny">权限级别</span>
                  <span className="tiny">{INTEGRITY_LABEL[build?.integrity ?? 'unknown'] ?? '未知'}</span>
                </div>
                <div className="row-between">
                  <span className="muted tiny">托盘图标</span>
                  <span className="tiny">
                    {build?.tray.ok === true
                      ? '已创建'
                      : build?.tray.ok === false
                        ? `未创建（${build.tray.reason ?? '未知原因'}）`
                        : '检测中…'}
                  </span>
                </div>
                <div className="row">
                  <Button size="sm" variant="ghost" onClick={() => void window.api.system.reloadWindow()}>
                    重新加载界面
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void refreshBuild()}>
                    重新检测
                  </Button>
                </div>
                <div className="hint">
                  改过代码后要用「重启应用」才会加载新构建。权限显示「低权限」时托盘图标不会出现，需要从资源管理器重新启动
                  WordMemo.exe；Windows 11 也可能把托盘图标收进任务栏右下角的「^」。
                </div>
              </div>
            </details>
          </div>
        </div>
        </div>
      </div>
      </div>

      <Modal
        open={!!deleteDeck}
        title="删除笔记库"
        onClose={() => setDeleteDeck(null)}
        width={480}
        footer={
          <>
            <Button onClick={() => setDeleteDeck(null)}>取消</Button>
            <Button variant="danger" onClick={() => void removeDeckRow()} disabled={deckBusy}>
              {decks.filter((d) => d.id !== deleteDeck?.id).length === 0
                ? '删除这个库'
                : '移动笔记并删除'}
            </Button>
          </>
        }
      >
        <div className="col">
          {decks.filter((d) => d.id !== deleteDeck?.id).length === 0 ? (
            <>
              <div>
                「{deleteDeck?.name}」是最后一个笔记库，里面有 {deleteDeck?.noteCount ?? 0} 份笔记。
                删掉之后就没有任何库了。
              </div>
              <div className="hint">
                笔记不会删：它们会变成「未归类」，只在笔记库的「全部」里显示；新建库以后可以在那里批量移到新库。
                词条、卡片和复习进度都不受影响。
              </div>
            </>
          ) : (
            <>
              <div>
                「{deleteDeck?.name}」里有 {deleteDeck?.noteCount ?? 0} 份笔记。删除前先把它们移到：
              </div>
              <Select
                value={deleteMoveTo === null ? '' : String(deleteMoveTo)}
                options={decks
                  .filter((d) => d.id !== deleteDeck?.id)
                  .map((d) => ({
                    value: String(d.id),
                    label: d.name,
                    hint: `${d.noteCount} 份笔记 · 待学 ${d.todayNew}`
                  }))}
                onChange={(next) => setDeleteMoveTo(Number(next))}
              />
              <div className="hint">
                只移动笔记的归属；词条、卡片和复习进度都不变。
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}
