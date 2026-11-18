// 验证 JUDGE_EN_SYSTEM 的判定质量：直接用真实 API 跑一组中→英的写法差异样例。
// 用法: node scripts/ocr-lab/judge-en.mjs [--json]
import fs from 'node:fs'
import path from 'node:path'

const key = process.env.DEEPSEEK_KEY
if (!key) throw new Error('缺少 DEEPSEEK_KEY')
const settings = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '.data', 'settings.json'), 'utf8')
)
const system = fs
  .readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src/main/ai/prompts.ts'), 'utf8')
  .match(/export const JUDGE_EN_SYSTEM = `([\s\S]*?)`\n/)[1]

const cases = [
  // 拼写错误必须判错（这次线上判错的就是第一条）
  ['contemporary', 'contemprary', 'different'],
  ['assessment', 'assesment', 'different'],
  ['environment', 'enviroment', 'different'],
  ['necessary', 'neccessary', 'different'],
  ['receive', 'recieve', 'different'],
  ['abandon', 'abandan', 'different'],
  // 允许的表达差异
  ['be (fully) bathed in', 'be bathed in', 'same'],
  ['be (fully) bathed in', 'be fully bathed in', 'same'],
  ['fall victim to ...', 'fall victim to sth.', 'same'],
  ['fall victim to ...', 'fall victim to', 'same'],
  ['make it possible for sb. to do sth.', 'make it possible to do', 'same'],
  ["I'd like to", 'I would like to', 'same'],
  ['colour', 'color', 'same'],
  ['organise', 'organize', 'same'],
  // 不是同一个表达
  ['fall victim to ...', 'fall victim', 'different'],
  ['abandon', 'give up', 'different'],
  ['resemble', 'imitate', 'different'],
  ['give up', 'give in', 'different'],
  ['put up with', 'put up', 'different'],
  ['depend on', 'depend of', 'different']
]

const results = []
for (const [headword, answer, expect] of cases) {
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 200,
      temperature: 0,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `词条：${headword}\n词性：phrase\n释义：\n学生答案：${answer}`
        }
      ]
    })
  })
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  let parsed = {}
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { relation: 'PARSE_FAIL', confidence: 0, reason: text.slice(0, 80) }
  }
  const ok = parsed.relation === expect
  results.push({ headword, answer, expect, got: parsed.relation, confidence: parsed.confidence, ok })
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${headword}  <-  "${answer}"   期望 ${expect} 得到 ${parsed.relation} (${parsed.confidence}) ${parsed.reason ?? ''}`
  )
}
const bad = results.filter((r) => !r.ok).length
console.log(`\n${results.length - bad}/${results.length} 符合预期`)
if (bad) process.exitCode = 1
