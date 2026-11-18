// 多图单请求实验：第 1 张整页（定版面），后面几张是放大切片（定细节）。
// 用法: node multi.mjs <runDir> [--thinking]
import fs from 'node:fs'
import path from 'node:path'
import { PROMPTS, MULTI_HINT } from './prompts.mjs'

const argv = process.argv.slice(2)
const runDir = path.resolve(argv[0])
const thinking = argv.includes('--thinking')
const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))

const promptName = (argv.find((a) => a.startsWith('--prompt=')) || '--prompt=v1').split('=')[1]
const SYSTEM = manifest.tiles.length > 1 ? PROMPTS[promptName] + MULTI_HINT : PROMPTS[promptName]

const content = [{ type: 'text', text: '请按规则转录这页笔记。' }]
for (const t of manifest.tiles) {
  const buf = fs.readFileSync(path.join(runDir, 'tiles', t.file))
  content.push({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}`, detail: 'original' }
  })
}

const body = {
  model: settings.model,
  max_tokens: 3000,
  thinking: { type: thinking ? 'enabled' : 'disabled' },
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content }
  ]
}
const tempArg = argv.find((a) => a.startsWith('--temp='))
if (tempArg) body.temperature = Number(tempArg.split('=')[1])
const tempSuffix = tempArg ? '-t' + String(body.temperature).replace('.', 'p') : ''
const t0 = Date.now()
const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(body)
})
const text = await res.text()
if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
const json = JSON.parse(text)
const out = json.choices?.[0]?.message?.content ?? ''
const tag = `${promptName}${thinking ? '-think' : ''}${tempSuffix}`
const name = `out-multi-${tag}.md`
fs.writeFileSync(path.join(runDir, name), out)
fs.writeFileSync(path.join(runDir, name.replace('.md', '.json')), JSON.stringify(json, null, 2))
console.log(
  JSON.stringify({ ms: Date.now() - t0, usage: json.usage, chars: out.length, images: content.length - 1 })
)
