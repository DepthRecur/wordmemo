#!/usr/bin/env node
/**
 * 生成随包快照 `src/main/ai/pricing-snapshot.json`：
 * 从 models.dev 的整包（约 6.7 MB、300+ 家）里只裁我们支持的 4 家，原始包不落盘。
 *
 * 用法：node scripts/gen-pricing.mjs
 * 需要联网；产物随仓库提交，所以平时不用跑，调价时重跑一次即可（PLAN-PROVIDERS §4.2）。
 */
import fs from 'node:fs'
import path from 'node:path'

const SOURCE = 'https://models.dev/api.json'
/** models.dev 的 provider key → 我们的 provider id */
const PROVIDERS = {
  deepseek: 'deepseek',
  openai: 'openai',
  google: 'gemini',
  zhipuai: 'glm'
}

const outFile = path.join(process.cwd(), 'src/main/ai/pricing-snapshot.json')

function toPrice(cost) {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null
  const price = { input: cost.input, output: cost.output }
  if (typeof cost.cache_read === 'number' && cost.cache_read > 0) price.cacheRead = cost.cache_read
  return price
}

const res = await fetch(SOURCE, { headers: { accept: 'application/json' } })
if (!res.ok) {
  console.error(`拉取 ${SOURCE} 失败：HTTP ${res.status}`)
  process.exit(1)
}
const all = await res.json()

const providers = {}
for (const [remote, local] of Object.entries(PROVIDERS)) {
  const entry = all[remote]
  if (!entry || !entry.models) {
    console.error(`models.dev 里没有 ${remote}，保持旧快照`)
    process.exit(1)
  }
  const models = {}
  for (const [id, model] of Object.entries(entry.models)) {
    const price = toPrice(model.cost)
    if (!price) continue
    models[id] = { name: typeof model.name === 'string' ? model.name : id, ...price }
  }
  providers[local] = { models }
  console.log(`${local.padEnd(9)} ← ${remote.padEnd(9)} ${Object.keys(models).length} 个模型`)
}

const snapshot = {
  source: 'models.dev',
  fetchedAt: new Date().toISOString().slice(0, 10),
  providers
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
const bytes = fs.statSync(outFile).size
console.log(`写出 ${path.relative(process.cwd(), outFile)}：${(bytes / 1024).toFixed(1)} KB，日期 ${snapshot.fetchedAt}`)
