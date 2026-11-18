// 跑一次 OCR 实验：读取 manifest.json，逐块调用视觉模型，保存各块结果与合并结果。
// 用法: node ocr.mjs <runDir> --prompt v1 [--thinking]
import fs from 'node:fs'
import path from 'node:path'
import { PROMPTS } from './prompts.mjs'

const argv = process.argv.slice(2)
const runDir = path.resolve(argv[0])
const promptName = (argv.find((a) => a.startsWith('--prompt=')) || '--prompt=v1').split('=')[1]
const thinking = argv.includes('--thinking')
const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')

const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
const system = PROMPTS[promptName]
if (!system) throw new Error('未知 prompt: ' + promptName)

async function ocrTile(tile) {
  const buf = fs.readFileSync(path.join(runDir, 'tiles', tile.file))
  const body = {
    model: settings.model,
    max_tokens: 1500,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${tile.desc}\n请转录。` },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}`, detail: 'original' }
          }
        ]
      }
    ]
  }
  const t0 = Date.now()
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  const json = JSON.parse(text)
  const content = json.choices?.[0]?.message?.content ?? ''
  return {
    file: tile.file,
    desc: tile.desc,
    content,
    ms: Date.now() - t0,
    usage: json.usage
  }
}

const results = []
const concurrency = 3
let cursor = 0
async function worker() {
  while (cursor < manifest.tiles.length) {
    const tile = manifest.tiles[cursor++]
    try {
      results.push(await ocrTile(tile))
      process.stderr.write(`ok ${tile.file}\n`)
    } catch (e) {
      results.push({ file: tile.file, desc: tile.desc, content: '', error: String(e) })
      process.stderr.write(`fail ${tile.file} ${e}\n`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, manifest.tiles.length) }, worker))

results.sort((a, b) => a.file.localeCompare(b.file))
const merged = results.map((r) => r.content.trim()).join('\n')
fs.writeFileSync(path.join(runDir, `out-${promptName}${thinking ? '-think' : ''}.md`), merged)
fs.writeFileSync(
  path.join(runDir, `out-${promptName}${thinking ? '-think' : ''}.json`),
  JSON.stringify(results, null, 2)
)
const tokens = results.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0)
const out = results.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0)
console.log(JSON.stringify({ tiles: results.length, tokens, out, errors: results.filter((r) => r.error).length }))
