import os from 'node:os'
import { SYNC_FORMAT_VERSION } from '@shared/sync'
import { getDb, parseJson, toInt, tx } from './connection'
import { newUid } from './uid'

/**
 * 本地变更队列（PLAN-SYNC §3.4）。
 *
 * 「不靠触发器，靠写入口」：SQLite 的 session 扩展在 `node:sqlite` 里没有暴露，
 * 触发器里也拿不到足够的上下文（谁改的、改了哪些字段）。所以每个写入口在
 * **自己那条事务里**顺带追加一条 `sync_ops`。推送端只认这张表，不回头对比数据行。
 */

export type SyncEntity = 'note' | 'item' | 'review' | 'exam' | 'deck' | 'noteItem' | 'cardFlag'
export type SyncOpKind = 'upsert' | 'delete'

/** 快照/op 的格式版本（定义在 @shared/sync，渲染进程也能读） */
export { SYNC_FORMAT_VERSION }

export interface SyncMeta {
  entity: SyncEntity
  /** 稳定 id：note/item/review/exam/deck 用各自 uid；noteItem 用 `<note uid>:<item uid>`；
   *  cardFlag 用 `<item uid>:<direction>` */
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
 * op 先写、再执行 `fn`：仍然是一个事务（`fn` 失败会连 op 一起回滚），但顺序上
 * 「主体」一定排在依赖它的 op（`noteItem` / `cardFlag`）前面——S2 按 seq 应用时
 * 不会先遇到指向还不存在的笔记/词条的关联。
 *
 * `meta = null` 表示这次写没法描述成 op（不该发生，但同步层不该因此挡住用户）：
 * 照样开事务，只是不记队列。
 */
export function withSync<T>(meta: SyncMeta | null, fn: () => T): T {
  return tx(() => {
    if (meta) recordSyncOp(meta)
    return fn()
  })
}

/** 写完一条本地 op 时通知（调度器用它 markDirty；合并写回的 remote op 不触发） */
type SyncOpListener = (entity: SyncEntity) => void
const opListeners = new Set<SyncOpListener>()

export function onSyncOpWritten(listener: SyncOpListener): () => void {
  opListeners.add(listener)
  return () => opListeners.delete(listener)
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
  // 只有本机产生的 op 才叫「有新东西要推」；合并写回的 remote op 不该触发同步
  if ((meta.origin ?? 'local') === 'local') {
    for (const listener of opListeners) {
      try {
        listener(meta.entity)
      } catch {
        /* 监听器出错不影响写入 */
      }
    }
  }
  if (op === 'delete') recordTombstone(meta.entity, meta.uid, meta.tsUtc ?? Date.now())
}

/**
 * 删除的影子（PLAN-SYNC §3.9）：合并时「删除比更早的 upsert 优先」要能比 ts，
 * 同一 uid 只保留最新的那次删除。合并远端快照时也用它落影子。
 */
export function recordTombstone(entity: SyncEntity, uid: string, tsUtc: number): void {
  getDb()
    .prepare(
      `INSERT INTO sync_tombstones (entity, uid, ts_utc) VALUES (?, ?, ?)
       ON CONFLICT(entity, uid) DO UPDATE SET ts_utc = excluded.ts_utc
       WHERE excluded.ts_utc > sync_tombstones.ts_utc`
    )
    .run(entity, uid, Math.trunc(tsUtc))
}

export interface SyncTombstone {
  entity: SyncEntity
  uid: string
  tsUtc: number
}

export function listTombstones(): SyncTombstone[] {
  const rows = getDb()
    .prepare('SELECT entity, uid, ts_utc FROM sync_tombstones ORDER BY ts_utc ASC')
    .all() as unknown as { entity: string; uid: string; ts_utc: number }[]
  return rows.map((row) => ({
    entity: row.entity as SyncEntity,
    uid: row.uid,
    tsUtc: toInt(row.ts_utc)
  }))
}

export interface SyncState {
  formatVersion: number
  deviceId: string
  deviceName: string | null
  lastPushAt: string | null
  lastPullAt: string | null
}

/**
 * 本机同步状态（单行）。第一次用时创建：设备 id 是本机随机 ULID，不上传（§3.9 白名单排除）。
 * 设备名只用于「设备管理」列表，S2 才会上远端。
 */
export function getSyncState(): SyncState {
  const d = getDb()
  const row = d.prepare('SELECT * FROM sync_state WHERE id = 1').get() as
    | {
        format_version: number
        device_id: string
        device_name: string | null
        last_push_at: string | null
        last_pull_at: string | null
      }
    | undefined
  if (row) {
    return {
      formatVersion: toInt(row.format_version, SYNC_FORMAT_VERSION),
      deviceId: row.device_id,
      deviceName: row.device_name,
      lastPushAt: row.last_push_at,
      lastPullAt: row.last_pull_at
    }
  }
  const deviceId = newUid()
  const deviceName = os.hostname() || null
  d.prepare(
    `INSERT INTO sync_state (id, format_version, device_id, device_name) VALUES (1, ?, ?, ?)`
  ).run(SYNC_FORMAT_VERSION, deviceId, deviceName)
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    deviceId,
    deviceName,
    lastPushAt: null,
    lastPullAt: null
  }
}

export function updateSyncState(patch: { lastPushAt?: string | null; lastPullAt?: string | null }): void {
  getSyncState()
  const sets: string[] = []
  const params: (string | null)[] = []
  if (patch.lastPushAt !== undefined) {
    sets.push('last_push_at = ?')
    params.push(patch.lastPushAt)
  }
  if (patch.lastPullAt !== undefined) {
    sets.push('last_pull_at = ?')
    params.push(patch.lastPullAt)
  }
  if (!sets.length) return
  getDb()
    .prepare(`UPDATE sync_state SET ${sets.join(', ')} WHERE id = 1`)
    .run(...params)
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

/** 待推送的本地 op 条数（设置页显示「有 N 条待上传」） */
export function countPendingOps(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM sync_ops WHERE origin = 'local' AND pushed = 0")
    .get() as { c?: number } | undefined
  return toInt(row?.c)
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

/**
 * noteItem 的稳定 id：一条「笔记 ↔ 词条」关联由两端 uid 唯一确定。
 * 关联本身没有业务字段（只有 raw_line / position），并集合并即可。
 */
export function noteItemUid(noteUidValue: string, itemUidValue: string): string {
  return `${noteUidValue}:${itemUidValue}`
}
