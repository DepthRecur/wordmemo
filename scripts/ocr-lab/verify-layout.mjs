// 直接跑 src/shared/ocrLayout.ts（Node 24 原生剥离类型），验证版面重排与一行双词条拆分。
import assert from 'node:assert/strict'
import { normalizeOcrText, splitEntryLine } from '../../src/shared/ocrLayout.ts'

const cases = []
function test(name, fn) {
  try {
    fn()
    cases.push(['PASS', name])
  } catch (e) {
    cases.push(['FAIL', name, String(e.message)])
  }
}

test('两栏按栏号重排', () => {
  const laid = normalizeOcrText(
    ['[2] 4. pave the way for 为…铺路', '[1] assess v. 评估', '[2] on the contrary 相反的是', '[1] evaluate v. 评估'].join('\n')
  )
  assert.equal(laid.columns, 2)
  assert.equal(laid.text, 'assess v. 评估\nevaluate v. 评估\n4. pave the way for 为…铺路\non the contrary 相反的是')
})

test('单栏顺序不变', () => {
  const laid = normalizeOcrText(['[1] compose v. 作文', '[1] composer n. 作者'].join('\n'))
  assert.equal(laid.labeled, true)
  assert.equal(laid.columns, 1)
  assert.equal(laid.text, 'compose v. 作文\ncomposer n. 作者')
})

test('无栏号时原样返回', () => {
  const raw = 'assess v. 评估\nassessment n. 评估'
  const laid = normalizeOcrText(raw)
  assert.equal(laid.labeled, false)
  assert.equal(laid.text, raw)
})

test('漏标续行跟随上一栏', () => {
  const laid = normalizeOcrText(['[1] fall victim to', '成为…的受害者', '[2] frame n. 框架'].join('\n'))
  assert.equal(laid.text, 'fall victim to\n成为…的受害者\nframe n. 框架')
})

test('全角括号栏号也能识别', () => {
  const laid = normalizeOcrText(['【2】b n. 乙', '【1】a n. 甲'].join('\n'))
  assert.equal(laid.text, 'a n. 甲\nb n. 乙')
})

test('一行两个词条拆开', () => {
  assert.deepEqual(splitEntryLine('1. assess v.评估 assessment n.评估'), ['1. assess v.评估', 'assessment n.评估'])
  assert.deepEqual(splitEntryLine('consume v.消费 consumption n.消耗'), ['consume v.消费', 'consumption n.消耗'])
})

test('短语行不误拆', () => {
  assert.deepEqual(splitEntryLine('make it possible for sb. to do sth. 使某人可以做…'), [
    'make it possible for sb. to do sth. 使某人可以做…'
  ])
  assert.deepEqual(splitEntryLine('as + 句子 like + n.'), ['as + 句子 like + n.'])
  assert.deepEqual(splitEntryLine('| a | b |'), ['| a | b |'])
})

for (const [status, name, detail] of cases) console.log(status.padEnd(4), name, detail ?? '')
const failed = cases.filter((c) => c[0] === 'FAIL').length
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed) process.exitCode = 1
