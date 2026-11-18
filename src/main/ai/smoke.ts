/**
 * 真机冒烟：4 个调用点 × 4 家供应商（PLAN-PROVIDERS §9.1）。
 *
 * 没有 Key 的家直接 SKIP；跑起来的家会真的花掉几次极短调用的钱。
 * 入口在 `src/main/index.ts` 的 `--ai-smoke` 分支，Key 解密要发生在 Electron 主进程里。
 */
import { getApiKey } from '../settings'
import { PROVIDERS, PROVIDER_IDS } from './providers'
import { chatJson } from './client'
import { providerModel } from './client'
import { JUDGE_SYSTEM, PHONETIC_SYSTEM, STRUCT_SYSTEM, VALIDATE_SYSTEM } from './prompts'

interface SmokeCall {
  kind: string
  label: string
  messages: { role: string; content: string }[]
}

/** 四个调用点的提示词是真的，输入取最小样本 */
const CALLS: SmokeCall[] = [
  {
    kind: 'smoke-struct',
    label: '结构化',
    messages: [
      { role: 'system', content: STRUCT_SYSTEM },
      { role: 'user', content: 'abandon v. 放弃；抛弃' }
    ]
  },
  {
    kind: 'smoke-validate',
    label: '校验',
    messages: [
      { role: 'system', content: VALIDATE_SYSTEM },
      { role: 'user', content: '1 | abandon | v. | 放弃' }
    ]
  },
  {
    kind: 'smoke-judge',
    label: '判分',
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: '单词：abandon\n词性：v.\n标准释义：放弃\n学生答案：舍弃' }
    ]
  },
  {
    kind: 'smoke-phonetic',
    label: '音标',
    messages: [
      { role: 'system', content: PHONETIC_SYSTEM },
      { role: 'user', content: '1 | abandon | word' }
    ]
  }
]

export interface SmokeRow {
  provider: string
  model: string
  call: string
  ok: boolean
  ms: number
  note: string
}

export interface SmokeSummary {
  failed: number
  ran: number
  skipped: number
  rows: SmokeRow[]
}

export async function runAiSmoke(): Promise<SmokeSummary> {
  const rows: SmokeRow[] = []
  let ran = 0
  let skipped = 0

  for (const id of PROVIDER_IDS) {
    const spec = PROVIDERS[id]
    const model = providerModel(id)
    if (!getApiKey(id)) {
      skipped++
      rows.push({ provider: spec.label, model, call: '*', ok: true, ms: 0, note: 'SKIP（无 Key）' })
      continue
    }
    for (const call of CALLS) {
      ran++
      const started = Date.now()
      try {
        const result = await chatJson<unknown>({
          kind: call.kind,
          provider: id,
          messages: call.messages,
          maxTokens: 400,
          timeoutMs: 90_000
        })
        rows.push({
          provider: spec.label,
          model,
          call: call.label,
          ok: true,
          ms: Date.now() - started,
          note: JSON.stringify(result).slice(0, 70)
        })
      } catch (err) {
        rows.push({
          provider: spec.label,
          model,
          call: call.label,
          ok: false,
          ms: Date.now() - started,
          note: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  return { failed: rows.filter((r) => !r.ok).length, ran, skipped, rows }
}

/** 固定宽度的表格输出（中文宽度不完美，够看） */
export function printSmokeTable(summary: SmokeSummary, log: (line: string) => void = console.log): void {
  const pad = (text: string, width: number) => {
    let widthUsed = 0
    for (const ch of text) widthUsed += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1
    return text + ' '.repeat(Math.max(0, width - widthUsed))
  }

  log('')
  log(pad('供应商', 12) + pad('调用点', 10) + pad('结果', 8) + pad('耗时', 10) + '备注')
  log('-'.repeat(88))
  for (const row of summary.rows) {
    const result = row.note.startsWith('SKIP') ? 'SKIP' : row.ok ? '通过' : '失败'
    log(
      pad(row.provider, 12) +
        pad(row.call, 10) +
        pad(result, 8) +
        pad(row.ms ? `${row.ms}ms` : '—', 10) +
        row.note
    )
  }
  log('-'.repeat(88))
  log(
    `合计：${summary.ran} 次调用，失败 ${summary.failed} 次；跳过 ${summary.skipped} 家（没有 Key）。` +
      (summary.failed ? ' 失败的行请看「备注」里的错误文案。' : '')
  )
  log('')
}
