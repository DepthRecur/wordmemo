import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Database, FolderOpen, Power, Volume2 } from 'lucide-react'
import type {
  AiPriceInfo,
  AiProviderConfig,
  AiProviderId,
  AiProviderInfo,
  AiSettingsInfo,
  AiTestResult,
  BuildInfo,
  Settings
} from '@shared/types'
import { Badge, Button, Field, Toggle } from '../components/UI'
import type { Navigate, Notify } from '../App'
import { formatBytes } from '../lib/utils'

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
  navigate: Navigate
  refreshStats: () => Promise<void>
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

export default function SettingsPage({ notify, settings, refreshSettings }: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [cache, setCache] = useState({ files: 0, bytes: 0 })
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState<BuildInfo | null>(null)

  // 四张供应商卡片：卡片数据只读，Key 只回显"已配置"
  const [info, setInfo] = useState<AiSettingsInfo | null>(null)
  const [expanded, setExpanded] = useState<AiProviderId | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<Record<string, AiTestResult | undefined>>({})
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [pricingBusy, setPricingBusy] = useState(false)

  const providers = info?.providers ?? []

  const loadInfo = async () => {
    try {
      setInfo(await window.api.settings.aiProviders())
    } catch {
      /* 读不到就当没有配置 */
    }
  }

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    void window.api.tts.cacheSize().then(setCache)
    void window.api.system.appVersion().then(setVersion)
    void window.api.system.buildInfo().then(setBuild)
    void loadInfo()
  }, [])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const providerCfg = (id: AiProviderId): AiProviderConfig => draft.ai.providers[id] ?? {}

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

  const save = async () => {
    setSaving(true)
    try {
      const s = await window.api.settings.update({
        model: draft.model,
        baseUrl: draft.baseUrl,
        ai: draft.ai,
        longTermRetention: draft.longTermRetention,
        examRetention: draft.examRetention,
        newPerDay: draft.newPerDay,
        dailyMinutes: draft.dailyMinutes,
        learnAheadMinutes: draft.learnAheadMinutes,
        listenCardEnabled: draft.listenCardEnabled,
        autoPlayAudio: draft.autoPlayAudio,
        accent: draft.accent,
        aiJudge: draft.aiJudge,
        aiValidate: draft.aiValidate,
        monthlyBudgetUsd: draft.monthlyBudgetUsd,
        reminders: draft.reminders,
        remindEnabled: draft.remindEnabled,
        autoLaunch: draft.autoLaunch,
        quietHours: draft.quietHours,
        ttsSources: draft.ttsSources
      })
      await refreshSettings()
      setDraft(s)
      notify('设置已保存（保留率修改后下次启动生效）', 'ok')
    } catch (err) {
      notify(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const saveProviderKey = async (p: AiProviderInfo) => {
    const key = (keyDrafts[p.id] ?? '').trim()
    if (!key) {
      notify('请先粘贴 API Key', 'err')
      return
    }
    setBusy((b) => ({ ...b, [p.id]: true }))
    try {
      const saved = await window.api.settings.setApiKey(p.id, key)
      if (!saved) {
        notify('Key 保存失败：数据目录不可写', 'err')
        return
      }
      const res = await window.api.settings.testApiKey(p.id)
      setResults((r) => ({ ...r, [p.id]: res }))
      if (res.ok) {
        notify(`${p.label} 的 Key 已保存并验证通过`, 'ok')
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
      notify(res.ok ? `${p.label}：${res.message}` : `${p.label}：${res.message}`, res.ok ? 'ok' : 'err')
    } catch (err) {
      notify(`刷新目录失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setRefreshing((r) => ({ ...r, [p.id]: false }))
    }
  }

  const refreshPricingNow = async () => {
    setPricingBusy(true)
    try {
      const res = await window.api.settings.refreshPricing(true)
      setInfo(res.info)
      notify(res.message, res.ok ? 'ok' : 'err')
    } catch (err) {
      notify(`刷新价格失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setPricingBusy(false)
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

  const backup = async () => {
    try {
      const p = await window.api.system.backup()
      notify(`已备份到 ${p}`, 'ok')
    } catch (err) {
      notify(`备份失败：${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const quitApp = () => {
    if (window.confirm('退出 WordMemo？未入库的草稿已经自动保存，下次打开会恢复。')) {
      void window.api.system.quit()
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
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>

      <div className="page-scroll">
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-title row">
            <span>AI 供应商</span>
            <span style={{ flex: 1 }} />
            <Badge tone={providers.some((p) => p.keySet) ? 'green' : 'yellow'}>
              {providers.filter((p) => p.keySet).length} / {providers.length || 4} 家已配置
            </Badge>
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
            Key 只保存在本机（Windows DPAPI 加密，secrets.v2.json），不会上传。「保存并测试」会发一条
            「回复 ok」的极短请求；模型与 Base URL 改完要点右上角「保存设置」。价格是估算，不是账单。
          </div>
          <div className="col" style={{ gap: 8 }}>
            {providers.map((p) => {
              const cfg = providerCfg(p.id)
              const isOpen = expanded === p.id
              const result = results[p.id]
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
                    <span className="muted tiny">{p.model || '未填模型'}</span>
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
                          disabled={busy[p.id]}
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
                      </div>
                      <div className="grid grid-2">
                        <Field
                          label="模型"
                          hint={
                            p.models.length
                              ? `目录里 ${p.models.length} 个，可直接输入过滤；也可以手填`
                              : p.id === 'deepseek'
                                ? '默认 deepseek-flash'
                                : '这家要自己填（如 gpt-4o-mini / gemini-2.0-flash）'
                          }
                        >
                          <input
                            className="input"
                            list={`wm-models-${p.id}`}
                            value={cfg.model ?? ''}
                            placeholder={p.id === 'deepseek' ? 'deepseek-flash' : '模型名'}
                            onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                          />
                          <datalist id={`wm-models-${p.id}`}>
                            {p.models.map((id) => (
                              <option key={id} value={id} />
                            ))}
                          </datalist>
                        </Field>
                        <Field label="Base URL" hint="留空 = 官方端点；只有代理/中转才需要改">
                          <input
                            className="input"
                            value={cfg.baseUrl ?? ''}
                            placeholder={p.baseUrl}
                            onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                        <span className="hint">
                          目录：{p.models.length ? `${p.models.length} 个模型 · ${formatAgo(p.modelsFetchedAt)}` : '还没拉取'}
                          {p.catalogError ? ` · ${p.catalogError}` : ''}
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
                      <div className="hint">
                        {p.vision
                          ? '这家支持图片识别（视觉）'
                          : '这家不支持图片识别，OCR 会落到默认那家'}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            DeepSeek 已真机验证；OpenAI / Gemini / GLM 标「未验证」——参数按官方文档写，第一次用如果报错，
            把提示发出来即可，改配置就能修，不用等发版。
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">AI 角色与预算</div>
          <div className="col">
            <Field label="默认模型" hint="导入、判分、音标、补搭配都走这家">
              <select
                className="select"
                value={draft.ai.default.provider}
                onChange={(e) => setDefaultRole(e.target.value as AiProviderId)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.model ? ` · ${p.model}` : '（未填模型）'}
                    {p.unverified ? '（未验证）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Toggle
              checked={!!draft.ai.vision}
              onChange={setVisionEnabled}
              label="图片识别单独指定供应商"
              hint="关闭时跟随默认模型；导入图片时会走这里选的这家。"
            />
            {draft.ai.vision && (
              <Field label="图片识别用哪家">
                <select
                  className="select"
                  value={draft.ai.vision.provider}
                  onChange={(e) => setVisionRole(e.target.value as AiProviderId)}
                >
                  {providers
                    .filter((p) => p.vision || p.id === draft.ai.vision?.provider)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {p.unverified ? '（未验证）' : ''}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="每月 AI 预算（美元，0 表示不限）">
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
            <Toggle
              checked={draft.ai.showCost}
              onChange={(v) => setDraft((d) => ({ ...d, ai: { ...d.ai, showCost: v } }))}
              label="显示 AI 费用估算"
              hint="按内置价格估算（不是账单）；未知模型会显示「费用未知」。"
            />
          </div>
        </div>

        <div className="panel">
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
            <div className="hint">
              对应 Anki 的 learn ahead：本轮复习快结束时，提前学掉这段时间内到期的学习卡，避免过几分钟又出现“第二批”。
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
              <select className="select" value={draft.accent} onChange={(e) => set('accent', e.target.value as 'us' | 'uk')}>
                <option value="us">美式发音</option>
                <option value="uk">英式发音</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="panel">
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

        <div className="panel">
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
            有道 / 百度是网页接口，免费但非官方，可能限流；下载过的音频会缓存到本地，断网也能播。全部失败时会退回系统语音。
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

        <div className="panel">
          <div className="panel-title row">
            <Database size={16} /> 数据
          </div>
          <div className="col">
            <div className="hint">
              数据库、原始上传文件和发音缓存都在本机用户目录。建议每周备份一次。
            </div>
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
          </div>
        </div>

        <div className="panel">
          <div className="panel-title row">
            <Power size={16} /> 后台与退出
          </div>
          <div className="col">
            <div className="hint">
              关闭窗口只是收进托盘，应用仍在后台运行（到期提醒依赖它）。Windows 11 的新托盘图标可能收在任务栏右下角的「^」里，
              找不到图标时可以直接从这里退出或重启。
            </div>
            <div className="row-between" style={{ marginTop: 4 }}>
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
            <div className="row" style={{ marginTop: 6 }}>
              <Button size="sm" onClick={() => void window.api.system.reloadWindow()}>
                重新加载界面
              </Button>
              <Button size="sm" onClick={() => void window.api.system.restart()}>
                重启应用
              </Button>
              <Button size="sm" variant="danger" onClick={quitApp}>
                退出应用
              </Button>
              <Button size="sm" onClick={() => void refreshBuild()}>
                重新检测
              </Button>
            </div>
            <div className="hint">
              改完代码后必须点「重启应用」才会加载新构建；只刷新界面不会更新主进程。
              如果显示「低权限」，Windows 不允许注册托盘图标，请退出后从资源管理器双击 WordMemo.exe。
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="hint">
          关于音标：复习界面永远不会显示音标，笔记详情里默认也隐藏；这是为了避免你通过音标反推拼写。需要时可以在上方打开「显示音标」。
        </div>
      </div>
      </div>
    </div>
  )
}
