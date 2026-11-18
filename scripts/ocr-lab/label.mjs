// 标签法实验：让模型给每一行标「所属栏号」，客户端按栏号稳定排序，从根上避免跨栏串行。
// 用法: node label.mjs <pageRunDir> <gt.tsv> --runs=3 [--eval]
import fs from 'node:fs'
import path from 'node:path'
import { evaluate } from './eval.mjs'

const argv = process.argv.slice(2)
const runDir = path.resolve(argv[0])
const gt = argv[1] && !argv[1].startsWith('--') ? path.resolve(argv[1]) : null
const runs = Number((argv.find((a) => a.startsWith('--runs=')) || '--runs=3').split('=')[1])
const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))

export const LABEL_SYSTEM = `你是英语课堂笔记的转录员。请把图片里的内容转录成带栏号的纯文本。

第一步，判断版面：这一页有几栏（或几块）文字，按什么顺序阅读（通常是先左栏后右栏；只有一栏时从上到下）。

第二步，逐行转录，每行开头写上它所属栏的编号，例如：
[1] assess v. 评估
[1] evaluate v. 评估
[2] pave the way for 为…铺路

规则：
1. 编号从 1 开始，按阅读顺序排列（左栏 = 1，右栏 = 2，三栏依次类推）。只有一栏的笔记，所有行都写 [1]。
2. 一行只写一个词条，绝对不能把左右两栏处于同一高度的内容写在同一行。
3. 同一个词条在图中折行时（英文一行没写完、中文释义另起一行），要合并成一行，不要拆成两行。
4. 英文照图转写，中文照抄；不要翻译、不要改写、不要纠错、不要总结、不要加标题。
5. 词性写成 v. / n. / adj. / adv. 等；老师写的 =、→、/、* 等符号原样保留。
6. 完全看不清的单个字符写成 ⟦?⟧，不要凭猜测编造单词。
7. 只输出带编号的正文，不要代码块围栏，不要额外解释。`

/** 按栏号稳定排序，去掉编号；编号缺失的行按原顺序插在末尾 */
export function reorderLabeled(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const buckets = new Map()
  const rest = []
  for (const line of lines) {
    const m = line.match(/^\s*[[【(]\s*(\d{1,2})\s*[\]】)]\s*(.+?)\s*$/)
    if (m) {
      const n = Number(m[1])
      if (!buckets.has(n)) buckets.set(n, [])
      buckets.get(n).push(m[2])
    } else {
      rest.push(line.trim())
    }
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b)
  const out = []
  for (const k of keys) out.push(...buckets.get(k))
  out.push(...rest)
  return { text: out.join('\n'), columns: keys.length, total: out.length }
}

async function call() {
  const userText = argv.includes('--app-user') ? '请先判断这一页有几栏，再按栏顺序逐行转录，每行标注所属栏号。' : '请按规则转录，并给每一行标注栏号。'
  const content = [{ type: 'text', text: userText }]
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
        { role: 'system', content: LABEL_SYSTEM },
        { role: 'user', content }
      ]
    })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

for (let i = 0; i < runs; i++) {
  const json = await call()
  const raw = json.choices?.[0]?.message?.content ?? ''
  const sorted = reorderLabeled(raw)
  const tag = path.basename(runDir)
  const rawFile = path.join(runDir, `label-raw-${i + 1}.md`)
  const outFile = path.join(runDir, `label-${i + 1}.md`)
  fs.writeFileSync(rawFile, raw)
  fs.writeFileSync(outFile, sorted.text)
  let msg = `run${i + 1} cols=${sorted.columns} lines=${sorted.total} tok=${json.usage?.prompt_tokens}`
  if (gt) {
    const ev = evaluate(gt, outFile)
    msg += `  recall=${ev['词条召回']}  meaning=${ev['释义准确率']}  missing=${(ev['缺失'] || []).slice(0, 5).join(',')}`
  }
  console.log(msg)
}
