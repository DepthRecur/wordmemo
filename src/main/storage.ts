import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 原始文件统一放在 <userData>/files/<sha256>.<ext>，相同内容只存一份 */
function filesDir(): string {
  const dir = path.join(app.getPath('userData'), 'files')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function sha256OfFile(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

export interface StoredFile {
  /** 相对 userData 的路径，直接存进数据库 */
  relPath: string
  sha256: string
  bytes: number
}

/**
 * 把上传文件复制进本地缓存目录。
 * 解析阶段就调用，保证「识别了但没入库」的文件也有副本，
 * 原文件被移动/删除后依然能继续编辑和入库。
 */
export function storeUploadedFile(filePath: string, knownSha?: string): StoredFile | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null
    const buf = fs.readFileSync(filePath)
    const sha = knownSha ?? crypto.createHash('sha256').update(buf).digest('hex')
    const ext = path.extname(filePath).toLowerCase()
    const target = path.join(filesDir(), `${sha}${ext}`)
    if (!fs.existsSync(target)) fs.writeFileSync(target, buf)
    return {
      relPath: path.relative(app.getPath('userData'), target),
      sha256: sha,
      bytes: buf.length
    }
  } catch {
    return null
  }
}

/** 把数据库里的相对路径还原成绝对路径；越界路径一律拒绝 */
export function storedFileAbs(relPath: string | null | undefined): string | null {
  if (!relPath) return null
  if (path.isAbsolute(relPath)) return fs.existsSync(relPath) ? relPath : null
  const root = app.getPath('userData')
  const abs = path.resolve(root, relPath)
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return fs.existsSync(abs) ? abs : null
}

export function storedFileExists(relPath: string | null | undefined): boolean {
  return storedFileAbs(relPath) !== null
}

export function storedFileBytes(relPath: string | null | undefined): number {
  const abs = storedFileAbs(relPath)
  if (!abs) return 0
  try {
    return fs.statSync(abs).size
  } catch {
    return 0
  }
}

/** 只有确认没有任何 notes 引用时才删副本，避免删掉别处还在用的文件 */
export function deleteStoredFileIfUnused(relPath: string | null | undefined, referenced: boolean): void {
  if (!relPath || referenced) return
  const abs = storedFileAbs(relPath)
  if (!abs) return
  try {
    fs.unlinkSync(abs)
  } catch {
    /* ignore */
  }
}
