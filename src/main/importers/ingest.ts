import path from 'node:path'
import type { ImportResult } from '@shared/types'
import { analyzeFile } from './extract'
import { sha256OfFile, storeUploadedFile } from '../storage'
import { createDraft, findDraftBySha } from '../db/importDrafts'

/**
 * 解析一个文件并立刻落盘成草稿。
 *
 * 顺序很重要：先识别拿到结果，再复制源文件、写草稿，
 * 这样「识别完但没入库」的状态不会只活在渲染层内存里。
 * 同一份文件如果已有未入库草稿，直接恢复，不再调用 AI。
 */
export async function ingestFile(filePath: string, deckId?: number | null): Promise<ImportResult> {
  const fileName = path.basename(filePath)
  const sha = sha256OfFile(filePath)

  const existing = findDraftBySha(sha)
  if (existing) {
    return { ok: true, fileName, filePath, draftId: existing.id, resumed: true }
  }

  const preview = await analyzeFile(filePath)
  const stored = storeUploadedFile(filePath, sha ?? undefined)

  const draftId = createDraft({
    sha256: stored?.sha256 ?? sha,
    storedPath: stored?.relPath ?? null,
    fileName,
    sourceKind: preview.sourceKind,
    originalPath: filePath,
    deckId,
    preview
  })

  // 一条都没识别出来 = 这次导入没有任何产出（docs/MESSAGES.md：功能结果为空算错误，
  // 不能因为「没抛异常」就报成功）。草稿照样留着，用户可以在原文里手动整理。
  if (!preview.items.length) {
    return {
      ok: false,
      fileName,
      filePath,
      draftId,
      error: '没有从这份文件里识别出词条（已存为草稿，可以打开原文手动整理）'
    }
  }

  return { ok: true, fileName, filePath, draftId, resumed: false }
}
