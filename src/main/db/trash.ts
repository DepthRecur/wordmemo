import type { DeletedEntry, ExamScope, RestoreResult } from '@shared/types'
import { normalizeEn } from '@shared/normalize'
import { getDb, localIso, toInt, tx } from './connection'
import { ensureCards } from './items'
import { scopeForSync } from './exams'
import { listTombstones, noteItemUid, recordSyncOp, type SyncEntity } from './sync'

/**
 * 回收站（D-05 方案 A 的 4b）。
 *
 * 删除时 `recordSyncOp({ op: 'delete' })` 会把整行快照写进 `sync_tombstones.payload`；
 * 这里把它读出来、**用原来的 uid** 插回去，再记一条 upsert op（ts = now，必然大于
 * 那次删除的 ts），对端下次同步就会跟着复活。
 *
 * 两条边界，UI 必须照实说：
 * - **只恢复内容**：词条恢复会重建卡片（`ensureCards`），但复习记录已经在删除时
 *   级联删掉，恢复不回来；笔记恢复只重建「词条还在」的关联。
 * - **只恢复本机删除的**：远端 delete op 不带字段，那种影子没有 payload，
 *   只能显示成「无法恢复」，不给按钮。
 */

/** 会出现在回收站里的实体（noteItem / cardFlag 这类内部关联没有删除快照） */
export type RestoreEntity = 'note' | 'item' | 'deck' | 'exam'
const RESTORABLE: RestoreEntity[] = ['note', 'item', 'deck', 'exam']

/** 回收站的类型定义在 @shared/types（渲染进程也要用），这里只是借用 */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function labelOf(entity: RestoreEntity, payload: Record<string, unknown>): string {
  switch (entity) {
    case 'note':
      return asString(payload.title) || '未命名笔记'
    case 'item':
      return asString(payload.headword) || '（没有词形）'
    case 'deck':
      return asString(payload.name) || '（没有名字的库）'
    case 'exam':
      return asString(payload.title) || '（没有标题的考试）'
  }
}

/** 最近的删除（新的在前，最多 limit 条） */
export function listDeleted(limit = 50): DeletedEntry[] {
  return listTombstones()
    .filter((row) => RESTORABLE.includes(row.entity as RestoreEntity))
    .sort((a, b) => b.tsUtc - a.tsUtc)
    .slice(0, Math.max(0, limit))
    .map((row) => {
      const entity = row.entity as RestoreEntity
      return {
        entity,
        uid: row.uid,
        tsUtc: row.tsUtc,
        label: row.payload ? labelOf(entity, row.payload) : '（没有内容快照）',
        restorable: Boolean(row.payload),
        reason: row.payload ? null : '这条删除来自其它设备或升级前的版本，没有内容快照，恢复不出来'
      }
    })
}

/**
 * 按原始 uid 恢复一条删除。成功返回 true，失败给出给用户看的原因。
 * 失败时不动数据库（唯一索引冲突要提前查，不能靠抛异常回滚）。
 */
export function restoreDeleted(entity: string, uid: string): RestoreResult {
  if (!RESTORABLE.includes(entity as RestoreEntity)) {
    return { ok: false, message: '这种记录不支持恢复' }
  }
  const target = entity as RestoreEntity
  const row = listTombstones().find((item) => item.entity === target && item.uid === uid)
  if (!row) return { ok: false, message: '这条删除记录已经不在了（可能已被 30 天清理）' }
  if (!row.payload) {
    return { ok: false, message: '这条删除来自其它设备或升级前的版本，没有内容快照，恢复不出来' }
  }
  const payload = row.payload
  const ts = Date.now()
  try {
    // 一个事务：插入、重建关联/卡片、记 op、删影子要么全成要么全回滚。
    // 半成品状态比「恢复失败」更糟——影子还在、内容却插了一半，再点一次会撞唯一索引。
    return tx(() => {
      if (target === 'note') return restoreNote(uid, payload, ts)
      if (target === 'item') return restoreItem(uid, payload, ts)
      if (target === 'deck') return restoreDeck(uid, payload, ts)
      return restoreExam(uid, payload, ts)
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 恢复成功后把影子删掉，否则回收站里会一直挂着一条已经恢复的 */
function dropTombstone(entity: SyncEntity, uid: string): void {
  getDb().prepare('DELETE FROM sync_tombstones WHERE entity = ? AND uid = ?').run(entity, uid)
}

function deckIdForUid(deckUidValue: string | null): number {
  if (!deckUidValue) return 0
  const row = getDb().prepare('SELECT id FROM decks WHERE uid = ?').get(deckUidValue) as
    | { id?: number }
    | undefined
  return toInt(row?.id)
}

function restoreNote(uid: string, payload: Record<string, unknown>, ts: number): RestoreResult {
  const d = getDb()
  const now = localIso()
  const title = asString(payload.title) || '未命名笔记'
  const deckUidValue = typeof payload.deck_uid === 'string' ? payload.deck_uid : null
  const deckId = deckIdForUid(deckUidValue)
  const tags = asArray(payload.tags)
  const rawMarkdown = asString(payload.raw_markdown)
  const noteDate = typeof payload.note_date === 'string' ? payload.note_date : null
  const status = asString(payload.status, 'validated')

  const res = d
    .prepare(
      `INSERT INTO notes (uid, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(uid, deckId, title, noteDate, JSON.stringify(tags), rawMarkdown, status, now, now)
  const noteId = toInt(res.lastInsertRowid)
  recordSyncOp(
    {
      entity: 'note',
      uid,
      fields: {
        deck_uid: deckUidValue,
        title,
        note_date: noteDate,
        tags,
        raw_markdown: rawMarkdown,
        status,
        created_at: now,
        updated_at: now
      },
      tsUtc: ts
    }
  )
  // 关联：按原来的顺序插回去。词条如果也被删了（孤儿词条会跟着笔记一起删），
  // 用它的快照一起恢复——否则「恢复笔记」回来一条没有单词的空笔记，等于没恢复。
  const link = d.prepare(
    'INSERT OR IGNORE INTO note_items (note_id, item_id, raw_line, position) VALUES (?, ?, NULL, ?)'
  )
  let position = 0
  for (const value of asArray(payload.item_uids)) {
    if (typeof value !== 'string') continue
    let item = d.prepare('SELECT id FROM items WHERE uid = ?').get(value) as
      | { id?: number }
      | undefined
    if (!item?.id) {
      const itemTomb = listTombstones().find(
        (row) => row.entity === 'item' && row.uid === value && row.payload
      )
      if (!itemTomb?.payload) continue
      if (!restoreItem(value, itemTomb.payload, ts).ok) continue
      item = d.prepare('SELECT id FROM items WHERE uid = ?').get(value) as
        | { id?: number }
        | undefined
    }
    if (!item?.id) continue
    link.run(noteId, toInt(item.id), position)
    recordSyncOp({
      entity: 'noteItem',
      uid: noteItemUid(uid, value),
      fields: { note_uid: uid, item_uid: value, raw_line: null, position },
      tsUtc: ts
    })
    position += 1
  }
  dropTombstone('note', uid)
  return { ok: true, message: `已恢复笔记「${title}」` }
}

function restoreItem(uid: string, payload: Record<string, unknown>, ts: number): RestoreResult {
  const d = getDb()
  const headword = asString(payload.headword)
  if (!headword) return { ok: false, message: '快照里没有词形，恢复不出来' }
  const norm = normalizeEn(headword)
  const clash = d.prepare('SELECT id FROM items WHERE headword_norm = ?').get(norm) as
    | { id?: number }
    | undefined
  if (clash?.id) {
    return {
      ok: false,
      message: `现在已经有「${headword}」这个词条了。先改掉或删掉它，再恢复这一条。`
    }
  }
  const now = localIso()
  const kind = asString(payload.kind, 'word')
  const pos = typeof payload.pos === 'string' ? payload.pos : null
  const phonetic = typeof payload.phonetic === 'string' ? payload.phonetic : null
  const meanings = asArray(payload.meanings)
  const collocations = asArray(payload.collocations)
  const examples = asArray(payload.examples)
  const extra = typeof payload.extra === 'string' ? payload.extra : null
  const acceptedZh = asArray(payload.accepted_zh)
  const learnedAt = typeof payload.learned_at === 'string' ? payload.learned_at : null

  const res = d
    .prepare(
      `INSERT INTO items (uid, kind, headword, headword_norm, pos, phonetic, meanings,
                          collocations, examples, extra, accepted_zh, learned_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uid,
      kind,
      headword,
      norm,
      pos,
      phonetic,
      JSON.stringify(meanings),
      JSON.stringify(collocations),
      JSON.stringify(examples),
      extra,
      JSON.stringify(acceptedZh),
      learnedAt,
      now
    )
  const itemId = toInt(res.lastInsertRowid)
  // 卡片按当前设置重建：复习进度回不来（删除时已级联删掉）
  ensureCards(itemId, false)
  recordSyncOp(
    {
      entity: 'item',
      uid,
      fields: {
        kind,
        headword,
        pos,
        phonetic,
        meanings,
        collocations,
        examples,
        extra,
        accepted_zh: acceptedZh,
        learned_at: learnedAt
      },
      tsUtc: ts
    }
  )
  dropTombstone('item', uid)
  return { ok: true, message: `已恢复词条「${headword}」，复习进度不会回来` }
}

function restoreDeck(uid: string, payload: Record<string, unknown>, ts: number): RestoreResult {
  const d = getDb()
  const name = asString(payload.name).trim()
  if (!name) return { ok: false, message: '快照里没有库名，恢复不出来' }
  const clash = d.prepare('SELECT id FROM decks WHERE name = ? COLLATE NOCASE').get(name) as
    | { id?: number }
    | undefined
  if (clash?.id) {
    return { ok: false, message: `已经有叫「${name}」的库了。先改个名，再恢复这一个。` }
  }
  const now = localIso()
  const color = typeof payload.color === 'string' ? payload.color : null
  const newPerDay = typeof payload.new_per_day === 'number' ? payload.new_per_day : null
  const row = d.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM decks').get() as
    | { p?: number }
    | undefined
  const position = toInt(row?.p, -1) + 1
  d.prepare(
    'INSERT INTO decks (uid, name, color, position, new_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uid, name, color, position, newPerDay, now)
  recordSyncOp(
    {
      entity: 'deck',
      uid,
      fields: { name, color, position, new_per_day: newPerDay, created_at: now },
      tsUtc: ts
    }
  )
  dropTombstone('deck', uid)
  return { ok: true, message: `已恢复库「${name}」（里面的笔记当时已经移走，不会跟着回来）` }
}

function restoreExam(uid: string, payload: Record<string, unknown>, ts: number): RestoreResult {
  const d = getDb()
  const title = asString(payload.title).trim()
  if (!title) return { ok: false, message: '快照里没有考试标题，恢复不出来' }
  const examDate = asString(payload.exam_date)
  const scope = (payload.scope ?? {}) as Record<string, unknown>
  const level = asString(payload.level, 'dictate')
  const targetRetention =
    typeof payload.target_retention === 'number' ? payload.target_retention : 0.95
  const dailyMinutes = typeof payload.daily_minutes === 'number' ? payload.daily_minutes : 20
  const status = asString(payload.status, 'active')
  const now = localIso()
  d.prepare(
    `INSERT INTO exams (uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uid, title, examDate, JSON.stringify(scope), level, targetRetention, dailyMinutes, status, now)
  recordSyncOp(
    {
      entity: 'exam',
      uid,
      fields: {
        title,
        exam_date: examDate,
        scope: scopeForSync(scope as ExamScope),
        level,
        target_retention: targetRetention,
        daily_minutes: dailyMinutes,
        status
      },
      tsUtc: ts
    }
  )
  dropTombstone('exam', uid)
  return { ok: true, message: `已恢复考试「${title}」` }
}
