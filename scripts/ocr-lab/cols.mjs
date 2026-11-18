// 分栏/分半单请求实验：只发切片（不发整页），用图片顺序固定阅读顺序。
// 用法: node cols.mjs <runDir> <gt.tsv> --hint=cols|halves --runs=3
import fs from 'node:fs'
import path from 'node:path'
import { evaluate } from './eval.mjs'
import { PROMPTS, COLS_HINT, HALVES_HINT } from './prompts.mjs'

const argv = process.argv.slice(2)
const runDir = path.resolve(argv[0])
const gt = path.resolve(argv[1])
const runs = Number((argv.find((a) => a.startsWith('--runs=')) || '--runs=3').split('=')[1])
const hintName = (argv.find((a) => a.startsWith('--hint=')) || '--hint=cols').split('=')[1]
const promptName = (argv.find((a) => a.startsWith('--prompt=')) || '--prompt=v1').split('=')[1]
const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
const hint = hintName === 'halves' ? HALVES_HINT : COLS_HINT
const system = PROMPTS[promptName] + hint

async function call() {
  const content = [{ type: 'text', text: '请按顺序转录这几张图。' }]
  for (const t of manifest.tiles) {
    const buf = fs.readFileSync(path.join(runDir, 'tiles', t.file))
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}`, detail: 'original' }
    })
  }
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 3000,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ]
    })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  const json = JSON.parse(text)
  return { out: json.choices?.[0]?.message?.content ?? '', usage: json.usage }
}

for (let i = 0; i < runs; i++) {
  const { out, usage } = await call()
  const file = path.join(runDir, `${hintName}-${promptName}-${i + 1}.md`)
  fs.writeFileSync(file, out)
  const ev = evaluate(gt, file)
  console.log(
    `${hintName}-${i + 1}  recall=${ev['词条召回']}  meaning=${ev['释义准确率']}  out=${ev['输出词条数']}  tok=${usage?.prompt_tokens}  missing=${(ev['缺失'] || []).slice(0, 5).join(',')}`
  )
}
