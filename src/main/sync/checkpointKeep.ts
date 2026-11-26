/**
 * checkpoint 归档的保留策略（D-01）。
 *
 * PLAN-SYNC §7 写的是「月度 checkpoint，保留 2 份」；实现一直只覆盖写同一路径，
 * 某次写出坏快照就没有上一份可回退。这里只做「挑出该删的归档」的纯函数，方便单测。
 *
 * 规范路径 `devices/<id>/checkpoint.json.age` 仍然每次都写（旧客户端只认它），
 * 归档是额外的 `checkpoint-<YYYYMM>.json.age`。
 */

export const CHECKPOINT_ARCHIVE_KEEP = 2

const ARCHIVE_PATTERN = /^checkpoint-(\d{6})\.json\.age$/

export function isCheckpointArchive(name: string): boolean {
  return ARCHIVE_PATTERN.test(name)
}

/**
 * 从文件名列表里挑出「超过保留份数」的归档（按月份从新到旧）。
 * @returns 需要删除的文件名（不含路径）
 */
export function pickObsoleteArchives(names: string[], keep = CHECKPOINT_ARCHIVE_KEEP): string[] {
  const archives = names
    .filter((name) => isCheckpointArchive(name))
    .sort((a, b) => b.localeCompare(a)) // YYYYMM 字符串倒序 = 从新到旧
  return archives.slice(Math.max(0, keep))
}

/** 归档文件名用的月份戳（本地时间，和 checkpoint 的 createdAt 一致） */
export function monthStamp(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}${month}`
}
