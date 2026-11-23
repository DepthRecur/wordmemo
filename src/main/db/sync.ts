import { getDb, parseJson, toInt, tx } from './connection'

/**
 * 本地变更队列（PLAN-SYNC §3.4）。
 *
 * 「不靠触发器，靠写入口」：SQLite 的 session 扩展在 `node:sqlite` 里没有暴露，
 * 触发器里也拿不到足够的上下文（谁改的、改了哪些字段）。所以每个写入口在
 * **自己那条事务里**顺带追加一条 `sync_ops`。推送端只认这张表，不回头对比数据行。
 */

export type SyncEntity = 'note' | 'item' | 'review' | 'exam' | 'cardFlag'
export type SyncOpKind = 'upsert' | 'delete'

export interface SyncMeta {
  entity: SyncEntity
  /** 稳定 id：note/item/review/exam 用各自 uid；cardFlag 用 `<item uid>:<direction>` */
  uid: string
  op?: SyncOpKind
  /** 只放变更字段，键用数据库列名；跨设备的引用一律换成 uid（见各写入口） */
  fields?: Record<string, unknown>
  /** 默认 'local'；合并远端 op 时写 'remote:<device>'，这类 op 不参与推送（防回声） */
  origin?: string
  /** 事件时间（epoch ms）；复习/卡片标志用复习发生的时刻，不传取当前时间 */
  tsUtc?: number
}

export interface SyncOpRow {
  seq: number
  uid: string
  entity: SyncEntity
  op: SyncOpKind
  fields: Record<string, unknown>
  origin: string
  tsUtc: number
  pushed: boolean
}

/**
 * 执行一次写操作，并在**同一条事务**里记下它。
 *
 * `meta = null` 表示这次写没法描述成 op（不该发生，但同步层不该因此挡住用户）：
 * 照样开事务，只是不记队列。
 */
export function withSync<T>(meta: SyncMeta | null, fn: () => T): T {
  return tx(() => {
    const result = fn()
    if (meta) recordSyncOp(meta)
    return result
  })
}

/**
 * 追加一条 op。调用方必须已经在事务里（`withSync` 或外层 `tx`），
 * 这样「写入 + 队列」要么都成功、要么都回滚。
 */
export function recordSyncOp(meta: SyncMeta): void {
  // uid 由迁移与写入口保证；真缺了就跳过队列记录，但绝不挡住本地写入
  if (!meta.uid) return
  const op = meta.op ?? 'upsert'
  const fields = meta.fields ?? {}
  // 一个字段都没变的 upsert 是噪声：位置移动、重复入库都会走到这里
  if (op === 'upsert' && Object.keys(fields).length === 0) return
  getDb()
    .prepare(
      `INSERT INTO sync_ops (uid, entity, op, fields, origin, ts_utc, pushed)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      meta.uid,
      meta.entity,
      op,
      JSON.stringify(fields),
      meta.origin ?? 'local',
      Math.trunc(meta.tsUtc ?? Date.now())
    )
}

/** 待推送的本地 op（S1 的推送队列从这里读；S0 只有测试在用它） */
export function pendingSyncOps(limit = 500): SyncOpRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sync_ops WHERE origin = 'local' AND pushed = 0 ORDER BY seq ASC LIMIT ?`
    )
    .all(limit) as unknown as {
    seq: number
    uid: string
    entity: string
    op: string
    fields: string
    origin: string
    ts_utc: number
    pushed: number
  }[]
  return rows.map((row) => ({
    seq: toInt(row.seq),
    uid: row.uid,
    entity: row.entity as SyncEntity,
    op: row.op as SyncOpKind,
    fields: parseJson<Record<string, unknown>>(row.fields, {}),
    origin: row.origin,
    tsUtc: toInt(row.ts_utc),
    pushed: toInt(row.pushed) === 1
  }))
}

/** 某张表的本地 id → 同步 uid；行不存在返回 null */
function rowUid(table: 'notes' | 'items' | 'exams' | 'decks', id: number): string | null {
  if (!id) return null
  const row = getDb().prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(id) as
    | { uid?: string | null }
    | undefined
  return row?.uid || null
}

export function noteUid(noteId: number): string | null {
  return rowUid('notes', noteId)
}

export function itemUid(itemId: number): string | null {
  return rowUid('items', itemId)
}

export function examUid(examId: number): string | null {
  return rowUid('exams', examId)
}

/** 库的 uid；库 id 为 0/null（未归类/全部库）时没有 uid */
export function deckUid(deckId?: number | null): string | null {
  if (!deckId) return null
  return rowUid('decks', deckId)
}

/**
 * cardFlag 的稳定 id。卡片没有自己的 uid（`cards` 不参与同步），
 * 所以用「词条 uid + 方向」——它在两台设备上是同一个字符串。
 */
export function cardFlagUid(itemUidValue: string, direction: string): string {
  return `${itemUidValue}:${direction}`
}
