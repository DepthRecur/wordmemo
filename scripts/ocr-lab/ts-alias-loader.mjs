// 让 Node 直接跑 src 下的 TS：解析 @shared/* 别名、补全省略的 .ts 后缀。
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

export async function resolve(specifier, context, next) {
  if (specifier === 'electron') {
    return { url: pathToFileURL(path.join(ROOT, 'tests/electron-mock.ts')).href, shortCircuit: true }
  }
  if (specifier.startsWith('@shared/')) {
    let p = path.join(ROOT, 'src/shared', specifier.slice('@shared/'.length))
    if (!path.extname(p) && fs.existsSync(p + '.ts')) p += '.ts'
    return { url: pathToFileURL(p).href, shortCircuit: true }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : ROOT
    const base = path.resolve(parent, specifier)
    for (const ext of ['.ts', '/index.ts', '.mjs', '.js']) {
      if (fs.existsSync(base + ext)) {
        return { url: pathToFileURL(base + ext).href, shortCircuit: true }
      }
    }
  }
  return next(specifier, context)
}
