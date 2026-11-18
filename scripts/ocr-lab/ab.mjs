// A/B：同一张图，多组 system/user 提示词，各跑 N 次，输出评估表。
// 用法: node ab.mjs <runDir> <gt.tsv> --runs=3
import fs from 'node:fs'
import path from 'node:path'
import { evaluate } from './eval.mjs'

const argv = process.argv.slice(2)
const runDir = path.resolve(argv[0])
const gt = path.resolve(argv[1])
const runs = Number((argv.find((a) => a.startsWith('--runs=')) || '--runs=3').split('=')[1])
const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))

const LAYOUT = `版面规则（最重要）：
1. 先判断图片里有几栏文字。只有一栏时，从上到下逐行转录。
2. 如果同时出现左右两栏，必须先把左栏从上到下全部写完，再写右栏。左右两栏处于同一高度的两行，绝对不能拼成一行。
3. 图片可能是同一页笔记裁下的一块（会告诉你它是第几栏第几段）：只转录这一块里看得见的内容，不要推测块外内容。

转录规则：
- 每一行按图中原样写出：英文 + 词性 + 中文释义，各部分之间用一个空格分开。
- 英文照图转写，中文照抄；不要翻译、不要改写、不要纠错、不要合并两行、不要总结、不要加标题或解释。
- 词性写成 v. / n. / adj. / adv. / prep. 等；老师写的 = 、→、/ 等符号原样保留。
- 完全看不清的单个字符写成 ⟦?⟧，不要凭猜测编造单词。
- 只输出转录正文，不要代码块围栏。`

const CASES = [
  {
    id: 'u1',
    system: `你是英语课堂笔记的转录员。请把图片里的内容逐行、按阅读顺序转录为纯文本。

${LAYOUT}`,
    user: '这是左右两栏的英语笔记。请先写完左栏，再写右栏，每一行一个词条。'
  },
  {
    id: 'u2',
    system: `你是英语课堂笔记的转录员。请把图片里的内容逐行、按阅读顺序转录为纯文本。

${LAYOUT}`,
    user: '整页\n请转录。'
  },
  {
    id: 'u3',
    system: `你是英语课堂笔记的转录员。请把图片里的内容逐行、按阅读顺序转录为纯文本。

先在心里确认三件事，再动笔：① 这页有几栏；② 左栏第一行到哪一行结束；③ 右栏第一行从哪一行开始。
确认后，按「左栏全部 → 右栏全部」的顺序输出，同一行里绝不允许同时出现左栏和右栏的内容。

${LAYOUT}`,
    user: '请先判断有几栏，再按栏顺序转录：左栏写完再写右栏，每行一个词条。'
  }
]

async function call(system, user) {
  const content = [{ type: 'text', text: user }]
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
  return JSON.parse(text).choices?.[0]?.message?.content ?? ''
}

for (const c of CASES) {
  for (let i = 0; i < runs; i++) {
    const out = await call(c.system, c.user)
    const file = path.join(runDir, `ab-${c.id}-${i + 1}.md`)
    fs.writeFileSync(file, out)
    const ev = evaluate(gt, file)
    console.log(
      `${c.id}-${i + 1}  recall=${ev['词条召回']}  meaning=${ev['释义准确率']}  out=${ev['输出词条数']}  missing=${(ev['缺失'] || []).slice(0, 6).join(',')}`
    )
  }
}
