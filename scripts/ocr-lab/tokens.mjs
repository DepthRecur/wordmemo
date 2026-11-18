// token 探针：同一张图在不同尺寸下消耗多少视觉 token，验证「单图 ~1024 token 上限」。
import fs from 'node:fs'
import path from 'node:path'

const key = process.env.DEEPSEEK_KEY
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const dir = process.argv[2]
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).sort()

for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f))
  const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg'
  const body = {
    model: settings.model,
    max_tokens: 8,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么？一个字回答。' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}`, detail: 'original' } }
        ]
      }
    ]
  }
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  })
  const json = await res.json()
  console.log(f, 'HTTP', res.status, 'prompt_tokens', json.usage?.prompt_tokens, json.choices?.[0]?.message?.content)
}
