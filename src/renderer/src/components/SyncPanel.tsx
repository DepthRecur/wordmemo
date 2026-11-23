import { useEffect, useState } from 'react'
import { CloudUpload, Download, KeyRound, RefreshCw, Upload, Unplug } from 'lucide-react'
import type { Settings, SyncActionResult, SyncStatus } from '@shared/types'
import { checkPassphrase, generatePassphrase } from '@shared/passphrase'
import type { Notify } from '../App'
import { Button, Field } from './UI'

/**
 * 设置页的「同步」面板（PLAN-SYNC §3.11）。
 *
 * 文案级别按 MESSAGES.md：PAT 失效、口令错、文件损坏、格式版本不符都是错误；
 * 「还没连接」「已取消」只是提示。这里不显示 token/口令。
 */

const STATE_TEXT: Record<SyncStatus['state'], string> = {
  disconnected: '未连接',
  idle: '已连接',
  syncing: '同步中…',
  error: '上次同步失败'
}

const INTERVALS = [
  { value: 0, label: '只手动' },
  { value: 5, label: '每 5 分钟' },
  { value: 10, label: '每 10 分钟' },
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每 60 分钟' }
]

function strengthText(passphrase: string): string {
  const strength = checkPassphrase(passphrase)
  if (strength.reason === 'too_short') return '至少 10 个字符'
  if (strength.reason === 'too_common') return '这个密码太常见了'
  return ['太弱', '偏弱', '够用', '不错', '很强'][strength.score] ?? ''
}

function timeText(value: string | null): string {
  if (!value) return '还没有成功同步过'
  return value.replace('T', ' ')
}

interface Props {
  notify: Notify
  settings: Settings
  refreshSettings: () => Promise<Settings>
}

export function SyncPanel({ notify, settings, refreshSettings }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [owner, setOwner] = useState(settings.sync.owner)
  const [repo, setRepo] = useState(settings.sync.repo)
  const [pat, setPat] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [intervalMin, setIntervalMin] = useState(settings.sync.intervalMin)
  const [showConnect, setShowConnect] = useState(!settings.sync.enabled)

  useEffect(() => {
    void window.api.sync.status().then(setStatus)
    return window.api.events.onSyncStatus(setStatus)
  }, [])

  async function connect(): Promise<void> {
    if (!owner.trim() || !repo.trim()) {
      notify('请填写 GitHub 仓库（owner/repo）', 'info')
      return
    }
    if (!pat.trim()) {
      notify('请填写 GitHub 的 PAT', 'info')
      return
    }
    const strength = checkPassphrase(passphrase)
    if (!strength.ok) {
      notify(strengthText(passphrase), 'info')
      return
    }
    setBusy('connect')
    try {
      const result = await window.api.sync.connect({
        owner: owner.trim(),
        repo: repo.trim(),
        pat: pat.trim(),
        passphrase,
        intervalMin
      })
      setStatus(result.status)
      if (result.ok) {
        setPat('')
        setPassphrase('')
        setShowConnect(false)
        notify('已连接，并完成第一次同步', 'ok')
        await refreshSettings()
      } else {
        notify(result.message ?? '连接失败', 'err')
      }
    } catch (error) {
      notify(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function runNow(): Promise<void> {
    setBusy('now')
    try {
      const result: SyncActionResult = await window.api.sync.now()
      setStatus(result.status)
      if (result.ok) notify('已同步', 'ok')
      else notify(result.message ?? '同步失败', 'err')
    } catch (error) {
      notify(`同步失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(): Promise<void> {
    if (
      !window.confirm(
        '断开同步？\n本机保存的 PAT 和同步密码会被删除；云上的数据不动，重新连接同一仓库同一密码就能接上。'
      )
    ) {
      return
    }
    setBusy('disconnect')
    try {
      const next = await window.api.sync.disconnect()
      setStatus(next)
      setShowConnect(true)
      notify('已断开同步', 'info')
      await refreshSettings()
    } finally {
      setBusy(null)
    }
  }

  async function exportSnapshot(): Promise<void> {
    setBusy('export')
    try {
      const result = await window.api.sync.export()
      setStatus(result.status)
      if (!result.ok) notify(result.message ?? '导出失败', 'err')
      else if (result.path) notify(`已导出到 ${result.path}`, 'ok')
      else notify('已取消', 'info')
    } catch (error) {
      notify(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function importSnapshot(): Promise<void> {
    if (!window.confirm('导入会与当前数据合并（不覆盖）。继续？')) return
    setBusy('import')
    try {
      const result = await window.api.sync.import()
      setStatus(result.status)
      if (result.errorCode === 'canceled') return
      if (!result.ok) {
        notify(result.message ?? '导入失败', 'err')
        return
      }
      notify(
        `已导入并合并：笔记 ${result.notes ?? 0}、词条 ${result.items ?? 0}、复习 ${result.reviews ?? 0}`,
        'ok'
      )
      await refreshSettings()
    } catch (error) {
      notify(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  const configured = !!status?.configured
  const strength = checkPassphrase(passphrase)

  return (
    <div className="panel">
      <div className="panel-title row">
        <CloudUpload size={16} /> 同步
      </div>
      <div className="col" style={{ gap: 10 }}>
        <div className="hint">
          只同步结构化数据（笔记、词条、复习记录、考试与库），图片和文件永远不上传。
          数据用你的同步密码加密后放进自己的私有 GitHub 仓库。
        </div>

        {configured && status ? (
          <>
            <div className="row-between">
              <span className="muted tiny">仓库</span>
              <span className="tiny">
                {status.owner}/{status.repo}
              </span>
            </div>
            <div className="row-between">
              <span className="muted tiny">状态</span>
              <span
                className="tiny"
                style={status.state === 'error' ? { color: 'var(--red)' } : undefined}
              >
                {STATE_TEXT[status.state]}
              </span>
            </div>
            <div className="row-between">
              <span className="muted tiny">上次成功</span>
              <span className="tiny">{timeText(status.lastSuccessAt)}</span>
            </div>
            <div className="row-between">
              <span className="muted tiny">待上传</span>
              <span className="tiny">{status.pendingOps} 条</span>
            </div>
            <div className="row-between">
              <span className="muted tiny">本机设备</span>
              <span className="tiny" title={status.deviceId}>
                {status.deviceName ?? '本机'} · {status.deviceId.slice(0, 8)}
              </span>
            </div>
            {status.state === 'error' && status.lastErrorMessage && (
              <div className="hint" style={{ color: 'var(--red)' }}>
                {status.lastErrorMessage}
              </div>
            )}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Button onClick={() => void runNow()} disabled={busy !== null || status.state === 'syncing'}>
                <RefreshCw size={15} /> {status.state === 'syncing' ? '同步中…' : '立即同步'}
              </Button>
              <Button onClick={() => void exportSnapshot()} disabled={busy !== null}>
                <Download size={15} /> 导出加密快照
              </Button>
              <Button onClick={() => void importSnapshot()} disabled={busy !== null}>
                <Upload size={15} /> 导入加密快照
              </Button>
              <Button onClick={() => void disconnect()} disabled={busy !== null}>
                <Unplug size={15} /> 断开连接
              </Button>
            </div>
            <div className="hint">
              「导出加密快照」是一个 .wmsync 文件，适合换机、备份或 GitHub 连不上时手动搬数据；
              导入是合并，不会覆盖现有内容。
            </div>
            <Button size="sm" onClick={() => setShowConnect((value) => !value)}>
              {showConnect ? '收起重新连接' : '重新连接 / 更换密码'}
            </Button>
          </>
        ) : (
          <div className="hint">还没有连接。按下面三步填好，点「测试并首次同步」。</div>
        )}

        {(!configured || showConnect) && (
          <div className="col" style={{ gap: 10 }}>
            <Field label="GitHub 仓库" hint="填 owner/repo，例如 DepthRecur/wordmemo-sync-test">
              <div className="row">
                <input
                  className="input"
                  value={owner}
                  placeholder="owner"
                  onChange={(e) => setOwner(e.target.value)}
                  style={{ maxWidth: 180 }}
                />
                <span className="muted">/</span>
                <input
                  className="input"
                  value={repo}
                  placeholder="repo"
                  onChange={(e) => setRepo(e.target.value)}
                />
              </div>
            </Field>
            <Field
              label="PAT（个人访问令牌）"
              hint="fine-grained token，只授权这一个仓库、Contents: Read and write。不要用 classic token。"
            >
              <div className="row">
                <KeyRound size={15} />
                <input
                  className="input"
                  type="password"
                  value={pat}
                  placeholder="github_pat_..."
                  onChange={(e) => setPat(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </Field>
            <Field
              label="同步密码"
              hint="至少 10 个字符。忘了这串密码，云上的数据谁也解不开；本机可以记住，但不会上传。"
            >
              <div className="row">
                <input
                  className="input"
                  type="password"
                  value={passphrase}
                  placeholder="至少 10 个字符"
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                />
                <Button size="sm" onClick={() => setPassphrase(generatePassphrase())}>
                  帮我生成
                </Button>
              </div>
              <span
                className="hint"
                style={!strength.ok && passphrase ? { color: 'var(--yellow)' } : undefined}
              >
                {passphrase ? strengthText(passphrase) : '建议用 4~5 个单词组成的一句话'}
              </span>
            </Field>
            <Field label="自动同步">
              <select
                className="input"
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
              >
                {INTERVALS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row">
              <Button onClick={() => void connect()} disabled={busy !== null}>
                {busy === 'connect' ? '正在连接…' : '测试并首次同步'}
              </Button>
            </div>
            <div className="hint">
              连接会检查：仓库存在且是私有的、PAT 有写权限、密码和仓库里已有的密码一致。
              第一次同步会把本机数据加密上传。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
