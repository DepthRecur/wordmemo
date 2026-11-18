// 端到端验证：把「带栏号的 OCR 原文」喂进真实的 extract.ts，检查最终词条。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { normalizeOcrText } from '../../src/shared/ocrLayout.ts'

register('./ts-alias-loader.mjs', import.meta.url)
const { heuristicExtract } = await import('../../src/main/importers/extract.ts')

const raw = [
  '[2] 4. pave the way for 为…铺路',
  '[1] 1. assess v.评估 assessment n.评估',
  '[1] evaluate v.评估 evaluation n.评估',
  '[2] on the contrary 相反的是',
  '[2] tune in 调频',
  '[1] assignment n.任务 assign v.指派'
].join('\n')

const laid = normalizeOcrText(raw)
const items = heuristicExtract(laid.text)
const heads = items.map((i) => i.headword)
console.log('重排后原文：')
console.log(laid.text)
console.log('\n词条：')
for (const it of items) console.log(` - ${it.headword} | ${it.pos ?? ''} | ${it.meanings.join('；')}`)

assert.deepEqual(heads, ['assess', 'assessment', 'evaluate', 'evaluation', 'assignment', 'assign', 'pave the way for', 'on the contrary', 'tune in'])
assert.deepEqual(items[0].meanings, ['评估'])
assert.deepEqual(items[1].meanings, ['评估'])
assert.deepEqual(items.find((i) => i.headword === 'pave the way for').meanings, ['为...铺路'])
console.log('\nOK: 左栏词条都在前，右栏词条都在后，一行双词条已拆开')
