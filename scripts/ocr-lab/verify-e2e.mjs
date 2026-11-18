// 端到端：真实 OCR 结果（带栏号）→ normalizeOcrText → heuristicExtract → 对照真值打分
import path from 'node:path'
import fs from 'node:fs'
import { register } from 'node:module'
import { normalizeOcrText } from '../../src/shared/ocrLayout.ts'
import { evaluate } from './eval.mjs'

register('./ts-alias-loader.mjs', import.meta.url)
const { heuristicExtract } = await import('../../src/main/importers/extract.ts')

const [rawFile, gtFile] = process.argv.slice(2)
const raw = fs.readFileSync(path.resolve(rawFile), 'utf8')
const laid = normalizeOcrText(raw)
const items = heuristicExtract(laid.text)

const rendered = items.map((i) => `${i.headword} ${i.pos ?? ''} ${i.meanings.join('；')}`).join('\n')
const out = path.resolve(rawFile).replace(/\.md$/, '.items.md')
fs.writeFileSync(out, rendered)

const ev = evaluate(path.resolve(gtFile), out)
console.log(
  JSON.stringify(
    {
      栏数: laid.columns,
      词条数: items.length,
      词条召回: ev['词条召回'],
      释义准确率: ev['释义准确率'],
      缺失: ev['缺失'],
      释义不符: ev['释义不符']
    },
    null,
    2
  )
)
