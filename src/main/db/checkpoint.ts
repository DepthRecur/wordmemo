import fs from 'node:fs'
import type { ExamScope, Example } from '@shared/types'
import { normalizeEn } from '@shared/normalize'
import { getDb, localIso, parseJson, toInt, toNum, tx } from './connection'
import { log as logDiagnostic } from '../diagnostics'
import { ensureCards } from './items'
import { scopeForSync } from './exams'
import { newCardSnapshot, replayCard } from '../fsrs'
import { decryptEnvelope, encryptEnvelope, DEFAULT_SCRYPT_WORK_FACTOR } from '../sync/crypto'
import {
  getSyncState,
  noteItemUid,
  recordSyncOp,
  recordTombstone,
  SYNC_FORMAT_VERSION,
  type SyncEntity
} from './sync'

/**
 * 快照（checkpoint / `.wmsync`）与合并引擎（PLAN-SYNC S1）。
 *
 * 一份快照 = 全部同步实体的**全量状态**，整份共用一个 `createdAtMs` 作为合并时间。
 * 收到快照时按记录合并：
 * - 标量字段：字段级 LWW（每个字段的最后修改时间从 `sync_ops` 里推出来）；
 * - 数组字段（释义/搭配/例句/可接受答案）：**并集**，不按时间覆盖；
 * - `learned_at`：取最早的非空值；
 * - `reviews`：按 uid 并集（不可变）；
 * - 删除：靠 `tombstones`，删除比更早的 upsert 优先，更晚的 upsert 可以复活。
 *
 * 合并写回 `sync_ops` 时标 `origin: 'remote:<device>'`：不会被推送（防回声），
 * 但会成为下一次合并的「字段时钟」，所以重复导入同一份快照是幂等的。
 */

export interface DeckRecord {
  uid: string
  name: string
  color: string | null
  position: number
  newPerDay: number | null
  createdAt: string
}

export interface NoteRecord {
  uid: string
  title: string
  noteDate: string | null
  tags: string[]
  rawMarkdown: string
  status: string
  deckUid: string | null
  createdAt: string
  updatedAt: string
}

export interface ItemRecord {
  uid: string
  kind: string
  headword: string
  pos: string | null
  phonetic: string | null
  meanings: string[]
  collocations: string[]
  examples: Example[]
  extra: string | null
  acceptedZh: string[]
  learnedAt: string | null
  createdAt: string
}

export interface ReviewRecord {
  uid: string
  /** 卡片没有自己的 uid，用 `<item uid>:<direction>` */
  cardUid: string
  reviewedAt: string
  rating: number
  answer: string
  correct: number
  elapsedMs: number
  mode: string
  judgeBy: string | null
  examUid: string | null
}

export interface ExamRecord {
  uid: string
  title: string
  examDate: string
  /** 跨设备的形态：`deck_uid` 而不是本机 deckId */
  scope: Record<string, unknown>
  level: string
  targetRetention: number
  dailyMinutes: number
  status: string
  createdAt: string
}

export interface NoteItemRecord {
  uid: string
  noteUid: string
  itemUid: string
  rawLine: string | null
  position: number
}

export interface CardFlagRecord {
  uid: string
  itemUid: string
  direction: string
  suspended: number
  needsCheck: number
  learnMark: number
  buriedUntil: string | null
}

export interface SyncTombstoneRecord {
  entity: SyncEntity
  uid: string
  tsUtc: number
}

export interface SyncCheckpoint {
  formatVersion: number
  kind: 'checkpoint' | 'wmsync'
  createdAt: string
  createdAtMs: number
  deviceId: string
  deviceName: string | null
  counts: Record<string, number>
  tombstones: SyncTombstoneRecord[]
  decks: DeckRecord[]
  notes: NoteRecord[]
  items: ItemRecord[]
  reviews: ReviewRecord[]
  exams: ExamRecord[]
  noteItems: NoteItemRecord[]
  cardFlags: CardFlagRecord[]
}

export interface MergeStats {
  decks: number
  notes: number
  items: number
  reviews: number
  exams: number
  noteItems: number
  cardFlags: number
  tombstones: number
  skipped: number
}

function emptyStats(): MergeStats {
  return {
    decks: 0,
    notes: 0,
    items: 0,
    reviews: 0,
    exams: 0,
    noteItems: 0,
    cardFlags: 0,
    tombstones: 0,
    skipped: 0
  }
}

const DIRECTIONS = ['en2zh', 'zh2en', 'listen2en'] as const
type Direction = (typeof DIRECTIONS)[number]

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value)
}

/** 导出本机全量状态（不加密；age 在 S2 加在读写边界上） */
export function exportCheckpoint(kind: SyncCheckpoint['kind'] = 'checkpoint'): SyncCheckpoint {
  const d = getDb()
  const state = getSyncState()
  const createdAt = localIso()
  const createdAtMs = Date.now()

  const decks = (
    d.prepare('SELECT uid, name, color, position, new_per_day, created_at FROM decks ORDER BY id').all() as unknown as {
      uid: string | null
      name: string
      color: string | null
      position: number
      new_per_day: number | null
      created_at: string
    }[]
  )
    .filter((row) => row.uid)
    .map((row) => ({
      uid: row.uid as string,
      name: row.name,
      color: row.color,
      position: toInt(row.position),
      newPerDay: row.new_per_day === null ? null : toInt(row.new_per_day),
      createdAt: row.created_at
    }))

  const notes = (
    d
      .prepare(
        `SELECT n.uid, n.title, n.note_date, n.tags, n.raw_markdown, n.status, n.created_at, n.updated_at, d.uid AS deck_uid
         FROM notes n LEFT JOIN decks d ON d.id = n.deck_id ORDER BY n.id`
      )
      .all() as unknown as {
      uid: string | null
      title: string
      note_date: string | null
      tags: string
      raw_markdown: string
      status: string
      created_at: string
      updated_at: string
      deck_uid: string | null
    }[]
  )
    .filter((row) => row.uid)
    .map((row) => ({
      uid: row.uid as string,
      title: row.title,
      noteDate: row.note_date,
      tags: parseJson<string[]>(row.tags, []),
      rawMarkdown: row.raw_markdown,
      status: row.status,
      deckUid: row.deck_uid,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))

  const items = (
    d.prepare('SELECT * FROM items ORDER BY id').all() as unknown as {
      uid: string | null
      kind: string
      headword: string
      pos: string | null
      phonetic: string | null
      meanings: string
      collocations: string
      examples: string
      extra: string | null
      accepted_zh: string
      learned_at: string | null
      created_at: string
    }[]
  )
    .filter((row) => row.uid)
    .map((row) => ({
      uid: row.uid as string,
      kind: row.kind,
      headword: row.headword,
      pos: row.pos,
      phonetic: row.phonetic,
      meanings: parseJson<string[]>(row.meanings, []),
      collocations: parseJson<string[]>(row.collocations, []),
      examples: parseJson<Example[]>(row.examples, []),
      extra: row.extra,
      acceptedZh: parseJson<string[]>(row.accepted_zh, []),
      learnedAt: row.learned_at,
      createdAt: row.created_at
    }))

  const reviews = (
    d
      .prepare(
        `SELECT r.uid, r.reviewed_at, r.rating, r.answer, r.correct, r.elapsed_ms, r.mode, r.judge_by,
                i.uid AS item_uid, c.direction, e.uid AS exam_uid
         FROM reviews r
         JOIN cards c ON c.id = r.card_id
         JOIN items i ON i.id = c.item_id
         LEFT JOIN exams e ON e.id = r.exam_id
         ORDER BY r.id`
      )
      .all() as unknown as {
      uid: string | null
      reviewed_at: string
      rating: number
      answer: string | null
      correct: number | null
      elapsed_ms: number | null
      mode: string
      judge_by: string | null
      item_uid: string
      direction: string
      exam_uid: string | null
    }[]
  )
    .filter((row) => row.uid)
    .map((row) => ({
      uid: row.uid as string,
      cardUid: `${row.item_uid}:${row.direction}`,
      reviewedAt: row.reviewed_at,
      rating: toInt(row.rating),
      answer: row.answer ?? '',
      correct: toInt(row.correct),
      elapsedMs: toInt(row.elapsed_ms),
      mode: row.mode,
      judgeBy: row.judge_by,
      examUid: row.exam_uid
    }))

  const exams = (
    d.prepare('SELECT * FROM exams ORDER BY id').all() as unknown as {
      uid: string | null
      title: string
      exam_date: string
      scope: string
      level: string
      target_retention: number
      daily_minutes: number
      status: string
      created_at: string
    }[]
  )
    .filter((row) => row.uid)
    .map((row) => ({
      uid: row.uid as string,
      title: row.title,
      examDate: row.exam_date,
      scope: scopeForSync(parseJson<ExamScope>(row.scope, {})),
      level: row.level,
      targetRetention: toNum(row.target_retention, 0.95),
      dailyMinutes: toInt(row.daily_minutes, 20),
      status: row.status,
      createdAt: row.created_at
    }))

  const noteItems = (
    d
      .prepare(
        `SELECT n.uid AS note_uid, i.uid AS item_uid, ni.raw_line, ni.position
         FROM note_items ni
         JOIN notes n ON n.id = ni.note_id
         JOIN items i ON i.id = ni.item_id
         ORDER BY ni.note_id, ni.position`
      )
      .all() as unknown as {
      note_uid: string
      item_uid: string
      raw_line: string | null
      position: number
    }[]
  ).map((row) => ({
    uid: noteItemUid(row.note_uid, row.item_uid),
    noteUid: row.note_uid,
    itemUid: row.item_uid,
    rawLine: row.raw_line,
    position: toInt(row.position)
  }))

  const cardFlags = (
    d
      .prepare(
        `SELECT i.uid AS item_uid, c.direction, c.suspended, c.needs_check, c.learn_mark, c.buried_until
         FROM cards c JOIN items i ON i.id = c.item_id ORDER BY c.id`
      )
      .all() as unknown as {
      item_uid: string
      direction: string
      suspended: number
      needs_check: number
      learn_mark: number
      buried_until: string | null
    }[]
  ).map((row) => ({
    uid: `${row.item_uid}:${row.direction}`,
    itemUid: row.item_uid,
    direction: row.direction,
    suspended: toInt(row.suspended),
    needsCheck: toInt(row.needs_check),
    learnMark: toInt(row.learn_mark),
    buriedUntil: row.buried_until
  }))

  const tombstones = (
    d
      .prepare('SELECT entity, uid, ts_utc FROM sync_tombstones ORDER BY ts_utc ASC')
      .all() as unknown as { entity: string; uid: string; ts_utc: number }[]
  ).map((row) => ({ entity: row.entity as SyncEntity, uid: row.uid, tsUtc: toInt(row.ts_utc) }))

  return {
    formatVersion: SYNC_FORMAT_VERSION,
    kind,
    createdAt,
    createdAtMs,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    counts: {
      decks: decks.length,
      notes: notes.length,
      items: items.length,
      reviews: reviews.length,
      exams: exams.length,
      noteItems: noteItems.length,
      cardFlags: cardFlags.length,
      tombstones: tombstones.length
    },
    tombstones,
    decks,
    notes,
    items,
    reviews,
    exams,
    noteItems,
    cardFlags
  }
}

/** 导出到文件（S1 是明文 JSON；S2 的 age 密文加在同样的读写边界上） */
export function exportSnapshot(file: string): SyncCheckpoint {
  const checkpoint = exportCheckpoint('wmsync')
  fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2), 'utf8')
  return checkpoint
}

export function readCheckpoint(file: string): SyncCheckpoint {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('同步文件无法识别：不是 WordMemo 导出的快照')
  }
  return validateCheckpoint(raw)
}

export function validateCheckpoint(raw: unknown): SyncCheckpoint {
  if (!raw || typeof raw !== 'object') {
    throw new Error('同步文件无法识别：不是 WordMemo 导出的快照')
  }
  const checkpoint = raw as Partial<SyncCheckpoint>
  const version = toInt(checkpoint.formatVersion)
  if (version !== SYNC_FORMAT_VERSION) {
    throw new Error(
      `同步文件格式版本 ${version || '未知'} 与本机（${SYNC_FORMAT_VERSION}）不一致，请升级 WordMemo 后再导入`
    )
  }
  if (checkpoint.kind !== 'wmsync' && checkpoint.kind !== 'checkpoint') {
    throw new Error('同步文件无法识别：不是 WordMemo 导出的快照')
  }
  if (!Array.isArray(checkpoint.decks) || !Array.isArray(checkpoint.items)) {
    throw new Error('同步文件不完整：缺少必要的数据段')
  }
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
  return {
    formatVersion: version,
    kind: checkpoint.kind,
    createdAt: String(checkpoint.createdAt ?? ''),
    createdAtMs: toInt(checkpoint.createdAtMs),
    deviceId: String(checkpoint.deviceId ?? ''),
    deviceName: checkpoint.deviceName ? String(checkpoint.deviceName) : null,
    counts: (checkpoint.counts ?? {}) as Record<string, number>,
    tombstones: list<SyncTombstoneRecord>(checkpoint.tombstones),
    decks: list<DeckRecord>(checkpoint.decks),
    notes: list<NoteRecord>(checkpoint.notes),
    items: list<ItemRecord>(checkpoint.items),
    reviews: list<ReviewRecord>(checkpoint.reviews),
    exams: list<ExamRecord>(checkpoint.exams),
    noteItems: list<NoteItemRecord>(checkpoint.noteItems),
    cardFlags: list<CardFlagRecord>(checkpoint.cardFlags)
  }
}

/** 导入一个 `.wmsync` 文件：合并（不覆盖），整份在一个事务里 */
export function importSnapshot(file: string): { checkpoint: SyncCheckpoint; stats: MergeStats } {
  const checkpoint = readCheckpoint(file)
  const stats = mergeCheckpoint(checkpoint)
  return { checkpoint, stats }
}

/**
 * 加密的 `.wmsync`（S2）：文件和远端分片同格式——明文魔数 + age 密文，
 * 路径/类型/格式版本在解密后校验（见 sync/crypto.ts）。
 */
export async function exportEncryptedSnapshot(
  file: string,
  passphrase: string,
  workFactor: number = DEFAULT_SCRYPT_WORK_FACTOR
): Promise<SyncCheckpoint> {
  const checkpoint = exportCheckpoint('wmsync')
  const envelope = await encryptEnvelope(
    {
      formatVersion: SYNC_FORMAT_VERSION,
      kind: 'wmsync',
      path: 'wmsync',
      deviceId: checkpoint.deviceId,
      createdAt: checkpoint.createdAt
    },
    checkpoint,
    passphrase,
    workFactor
  )
  fs.writeFileSync(file, envelope)
  return checkpoint
}

export async function importEncryptedSnapshot(
  file: string,
  passphrase: string
): Promise<{ checkpoint: SyncCheckpoint; stats: MergeStats }> {
  const envelope = await decryptEnvelope<unknown>(fs.readFileSync(file), passphrase, {
    kind: 'wmsync',
    path: 'wmsync'
  })
  const checkpoint = validateCheckpoint(envelope.payload)
  const stats = mergeCheckpoint(checkpoint)
  return { checkpoint, stats }
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

interface Clock {
  /** 某个字段最后一次被写的时间；没有记录时退回行的创建/更新时间 */
  field(name: string): number
  /** 这条记录最后一次被写的时间（含插入） */
  last: number
  deletedAt: number
}

const clockCache = new Map<string, Clock>()

function baseTsOf(entity: SyncEntity, row: Record<string, unknown> | undefined): number {
  if (!row) return 0
  const raw =
    entity === 'note'
      ? (row.updated_at ?? row.created_at)
      : entity === 'item' || entity === 'exam' || entity === 'deck'
        ? row.created_at
        : null
  if (!raw) return 0
  const ts = Date.parse(String(raw))
  return Number.isFinite(ts) ? ts : 0
}

function clockFor(entity: SyncEntity, uid: string, baseTs: number): Clock {
  const key = `${entity}|${uid}`
  const cached = clockCache.get(key)
  if (cached) return cached
  const clock = buildClock(entity, uid, baseTs)
  clockCache.set(key, clock)
  return clock
}

/** 不走缓存：逐条应用远端 op 时，时钟刚被自己改过，缓存会读到旧值 */
function buildClock(entity: SyncEntity, uid: string, baseTs: number): Clock {
  const rows = getDb()
    .prepare('SELECT op, fields, ts_utc FROM sync_ops WHERE entity = ? AND uid = ? ORDER BY seq ASC')
    .all(entity, uid) as unknown as { op: string; fields: string; ts_utc: number }[]
  const perField = new Map<string, number>()
  let last = baseTs
  for (const row of rows) {
    const ts = toInt(row.ts_utc)
    if (ts > last) last = ts
    if (row.op !== 'upsert') continue
    for (const name of Object.keys(parseJson<Record<string, unknown>>(row.fields, {}))) {
      const current = perField.get(name) ?? 0
      if (ts > current) perField.set(name, ts)
    }
  }
  const tomb = getDb()
    .prepare('SELECT ts_utc FROM sync_tombstones WHERE entity = ? AND uid = ?')
    .get(entity, uid) as { ts_utc?: number } | undefined
  return {
    field: (name) => Math.max(perField.get(name) ?? 0, baseTs),
    last,
    deletedAt: toInt(tomb?.ts_utc)
  }
}

function unionStrings(local: string[], remote: unknown): string[] {
  const out = [...local]
  const seen = new Set(local.map((value) => value.trim()))
  for (const raw of Array.isArray(remote) ? remote : []) {
    const value = String(raw ?? '').trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

function unionExamples(local: Example[], remote: unknown): Example[] {
  const out = [...local]
  const seen = new Set(local.map((example) => normalizeEn(example.en)))
  for (const raw of Array.isArray(remote) ? remote : []) {
    const example = raw as Example
    const en = String(example?.en ?? '').trim()
    if (!en || seen.has(normalizeEn(en))) continue
    seen.add(normalizeEn(en))
    out.push({ en, zh: example.zh ? String(example.zh).trim() : undefined })
  }
  return out
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 远端 uid 在本机可能对应另一条记录（同名库/同词不同 uid），查别名表 */
function resolveAlias(entity: SyncEntity, uid: string): string {
  const row = getDb()
    .prepare('SELECT local_uid FROM sync_aliases WHERE entity = ? AND remote_uid = ?')
    .get(entity, uid) as { local_uid?: string } | undefined
  return row?.local_uid || uid
}

function rememberAlias(entity: SyncEntity, remoteUid: string, localUid: string): void {
  if (!remoteUid || !localUid || remoteUid === localUid) return
  getDb()
    .prepare(
      `INSERT INTO sync_aliases (entity, remote_uid, local_uid) VALUES (?, ?, ?)
       ON CONFLICT(entity, remote_uid) DO UPDATE SET local_uid = excluded.local_uid`
    )
    .run(entity, remoteUid, localUid)
}

function deckIdByUid(uid: string | null | undefined): number {
  if (!uid) return 0
  const row = getDb().prepare('SELECT id FROM decks WHERE uid = ?').get(resolveAlias('deck', uid)) as
    | { id?: number }
    | undefined
  return toInt(row?.id)
}

function noteIdByUid(uid: string): number {
  const row = getDb()
    .prepare('SELECT id FROM notes WHERE uid = ?')
    .get(resolveAlias('note', uid)) as { id?: number } | undefined
  return toInt(row?.id)
}

function itemIdByUid(uid: string): number {
  const row = getDb()
    .prepare('SELECT id FROM items WHERE uid = ?')
    .get(resolveAlias('item', uid)) as { id?: number } | undefined
  return toInt(row?.id)
}

function examIdByUid(uid: string | null): number {
  if (!uid) return 0
  const row = getDb()
    .prepare('SELECT id FROM exams WHERE uid = ?')
    .get(resolveAlias('exam', uid)) as { id?: number } | undefined
  return toInt(row?.id)
}

function itemUidById(itemId: number): string {
  const row = getDb().prepare('SELECT uid FROM items WHERE id = ?').get(itemId) as
    | { uid?: string | null }
    | undefined
  return row?.uid ?? ''
}

function noteUidById(noteId: number): string {
  const row = getDb().prepare('SELECT uid FROM notes WHERE id = ?').get(noteId) as
    | { uid?: string | null }
    | undefined
  return row?.uid ?? ''
}

function cardIdFor(itemId: number, direction: Direction): number {
  const select = () =>
    getDb()
      .prepare('SELECT id FROM cards WHERE item_id = ? AND direction = ?')
      .get(itemId, direction) as { id?: number } | undefined
  const existing = select()
  if (existing?.id) return toInt(existing.id)
  const snap = newCardSnapshot(new Date())
  const res = getDb()
    .prepare(
      `INSERT INTO cards (item_id, direction, due_at, stability, difficulty, reps, lapses, state, last_review, suspended, fsrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
    )
    .run(itemId, direction, snap.dueAt, snap.stability, snap.difficulty, snap.reps, snap.lapses, snap.state, snap.fsrsJson)
  return toInt(res.lastInsertRowid)
}

/** 把库里的复习记录重放回卡片（合并 reviews 之后调用；标志位不动） */
function replayLocalCard(cardId: number): void {
  const card = getDb().prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as
    | { fsrs_json: string }
    | undefined
  if (!card) return
  const reviews = getDb()
    .prepare('SELECT reviewed_at, rating FROM reviews WHERE card_id = ? ORDER BY reviewed_at ASC, id ASC')
    .all(cardId) as unknown as { reviewed_at: string; rating: number }[]
  if (!reviews.length) return
  const cardIdText = parseJson<{ cardId?: string }>(card.fsrs_json, {}).cardId
  const snap = replayCard(
    reviews.map((row) => ({
      reviewedAt: new Date(row.reviewed_at),
      rating: toInt(row.rating) as 1 | 2 | 3 | 4
    })),
    cardIdText
  )
  getDb()
    .prepare(
      `UPDATE cards SET due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ?, fsrs_json = ?
       WHERE id = ?`
    )
    .run(
      snap.dueAt,
      snap.stability,
      snap.difficulty,
      snap.reps,
      snap.lapses,
      snap.state,
      reviews[reviews.length - 1].reviewed_at,
      snap.fsrsJson,
      cardId
    )
}

/**
 * 把一份快照合并进本机库。整份一个事务：中途失败全部回滚，不会留下半合并状态。
 * 重复导入同一份快照不会产生任何变化（字段时钟挡住，见文件顶部说明）。
 */
/** 远端时间戳最多可以领先本机多久（PLAN-SYNC §7 的「时钟夹取 ±5 分钟」） */
const CLOCK_SKEW_LIMIT_MS = 5 * 60_000
let lastSkewLoggedAt = 0

/**
 * 夹取远端时间戳（A-03）。
 *
 * 一台系统时间快几小时的机器，写下的字段会**永久**赢掉字段级 LWW，另一台的真实修改被静默覆盖。
 * 夹到「本机 now + 5 分钟」= 它只赢这一轮；等它把时钟改回来，后续修改照常按时间先后合并。
 * 代价（有意接受）：那台设备领先期间，本机对**同一个字段**的修改最多 5 分钟内可能被它再压过一次。
 *
 * **必须夹在 ts 的推导点**（`op.tsUtc` / `checkpoint.createdAtMs`），不能只在比较时夹：
 * 合并写回会把这个 ts 记进 `sync_ops`，字段时钟就跟着留在未来，本机之后的修改会一直输给它。
 */
function clampRemoteTs(ts: number): number {
  const now = Date.now()
  const limit = now + CLOCK_SKEW_LIMIT_MS
  if (ts <= limit) return ts
  // 一份快照/一批 op 会连着走很多次，这里限流，一分钟最多记一条
  if (now - lastSkewLoggedAt > 60_000) {
    lastSkewLoggedAt = now
    logDiagnostic('sync-clock-skew', { remoteTs: ts, clampedTo: limit, aheadMs: ts - now })
  }
  return limit
}

export function mergeCheckpoint(checkpoint: SyncCheckpoint): MergeStats {
  const ts = clampRemoteTs(toInt(checkpoint.createdAtMs) || Date.now())
  const origin = `remote:${checkpoint.deviceId || 'unknown'}`
  const stats = emptyStats()
  clockCache.clear()
  const replayCards = new Set<number>()

  tx(() => {
    applyTombstones(checkpoint, ts, origin, stats)
    mergeDecks(checkpoint, ts, origin, stats)
    mergeItems(checkpoint, ts, origin, stats)
    mergeNotes(checkpoint, ts, origin, stats)
    mergeExams(checkpoint, ts, origin, stats)
    mergeReviews(checkpoint, ts, origin, stats, replayCards)
    mergeNoteItems(checkpoint, ts, origin, stats)
    mergeCardFlags(checkpoint, ts, origin, stats)
    for (const cardId of replayCards) replayLocalCard(cardId)
  })

  return stats
}

function applyTombstones(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const present = new Map<SyncEntity, Set<string>>()
  const mark = (entity: SyncEntity, uid: string) => {
    const set = present.get(entity) ?? new Set<string>()
    set.add(uid)
    present.set(entity, set)
  }
  for (const record of checkpoint.notes) mark('note', record.uid)
  for (const record of checkpoint.items) mark('item', record.uid)
  for (const record of checkpoint.exams) mark('exam', record.uid)
  for (const record of checkpoint.decks) mark('deck', record.uid)

  for (const tombstone of checkpoint.tombstones) {
    const entity = tombstone.entity
    const remoteUid = tombstone.uid
    if (!remoteUid) continue
    const tombTs = toInt(tombstone.tsUtc)
    if (!tombTs) continue
    // 快照里同一条记录比删除更新 = 复活，交给后面的合并
    if (present.get(entity)?.has(remoteUid) && ts > tombTs) continue
    const uid = resolveAlias(entity, remoteUid)
    const row = findLocalRow(entity, remoteUid)
    const localLast = row ? clockFor(entity, uid, baseTsOf(entity, row)).last : 0
    if (row && tombTs > localLast) {
      deleteLocalRow(entity, row)
      stats.tombstones++
    }
    recordTombstone(entity, uid, tombTs)
  }
}

function findLocalRow(
  entity: SyncEntity,
  uid: string
): Record<string, unknown> | undefined {
  const table = localTableFor(entity)
  if (!table) return undefined
  const resolved = resolveAlias(entity, uid)
  if (entity === 'deck') {
    return getDb().prepare('SELECT * FROM decks WHERE uid = ?').get(resolved) as
      | Record<string, unknown>
      | undefined
  }
  return getDb().prepare(`SELECT * FROM ${table} WHERE uid = ?`).get(resolved) as
    | Record<string, unknown>
    | undefined
}

function deleteLocalRow(entity: SyncEntity, row: Record<string, unknown>): void {
  const id = toInt(row.id)
  if (entity === 'deck') {
    // 库没了，里面的笔记退回「未归类」，和本地删库的行为一致
    getDb().prepare('UPDATE notes SET deck_id = 0 WHERE deck_id = ?').run(id)
    getDb().prepare('DELETE FROM decks WHERE id = ?').run(id)
    return
  }
  const table = localTableFor(entity)
  if (table) getDb().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

function localTableFor(entity: SyncEntity): string | null {
  switch (entity) {
    case 'note':
      return 'notes'
    case 'item':
      return 'items'
    case 'exam':
      return 'exams'
    case 'review':
      return 'reviews'
    case 'deck':
      return 'decks'
    default:
      return null
  }
}

function mergeDecks(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.decks) {
    if (!record.uid) continue
    let local = d.prepare('SELECT * FROM decks WHERE uid = ?').get(record.uid) as
      | Record<string, unknown>
      | undefined
    // 不同 uid 同名库：唯一键只允许一个，合并到本机这条（S3 再做 uid 映射）
    if (!local) {
      local = d.prepare('SELECT * FROM decks WHERE name = ? COLLATE NOCASE').get(record.name) as
        | Record<string, unknown>
        | undefined
      // 同名不同 uid：记住远端 uid → 本机 uid，笔记/考试的 deck_uid 才解析得到
      if (local) rememberAlias('deck', record.uid, String(local.uid ?? ''))
    }
    if (!local) {
      d.prepare(
        'INSERT INTO decks (uid, name, color, position, new_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(record.uid, record.name, record.color, toInt(record.position), record.newPerDay, record.createdAt)
      recordSyncOp({
        entity: 'deck',
        uid: record.uid,
        origin,
        tsUtc: ts,
        fields: {
          name: record.name,
          color: record.color,
          position: toInt(record.position),
          new_per_day: record.newPerDay,
          created_at: record.createdAt
        }
      })
      stats.decks++
      continue
    }
    const uid = String(local.uid ?? record.uid)
    const clock = clockFor('deck', uid, baseTsOf('deck', local))
    if (clock.deletedAt > ts) continue
    const fields: Record<string, unknown> = {}
    const name = String(local.name)
    const color = local.color === null ? null : String(local.color)
    const position = toInt(local.position)
    const newPerDay = local.new_per_day === null ? null : toInt(local.new_per_day)
    let nextName = name
    let nextColor = color
    let nextPosition = position
    let nextNewPerDay = newPerDay
    if (record.name !== name && ts > clock.field('name')) {
      nextName = record.name
      fields.name = record.name
    }
    if (record.color !== color && ts > clock.field('color')) {
      nextColor = record.color
      fields.color = record.color
    }
    if (toInt(record.position) !== position && ts > clock.field('position')) {
      nextPosition = toInt(record.position)
      fields.position = nextPosition
    }
    if (record.newPerDay !== newPerDay && ts > clock.field('new_per_day')) {
      nextNewPerDay = record.newPerDay
      fields.new_per_day = record.newPerDay
    }
    if (!Object.keys(fields).length) continue
    try {
      d.prepare('UPDATE decks SET name = ?, color = ?, position = ?, new_per_day = ? WHERE id = ?').run(
        nextName,
        nextColor,
        nextPosition,
        nextNewPerDay,
        toInt(local.id)
      )
    } catch {
      // 改名撞上本机另一个同名库：这次跳过改名，别把整份导入拖垮
      stats.skipped++
      continue
    }
    recordSyncOp({ entity: 'deck', uid, origin, tsUtc: ts, fields })
    stats.decks++
  }
}

function mergeNotes(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.notes) {
    if (!record.uid) continue
    const local = d.prepare('SELECT * FROM notes WHERE uid = ?').get(record.uid) as
      | Record<string, unknown>
      | undefined
    if (!local) {
      d.prepare(
        `INSERT INTO notes (uid, source_id, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.uid,
        deckIdByUid(record.deckUid),
        record.title,
        record.noteDate,
        JSON.stringify(record.tags ?? []),
        record.rawMarkdown,
        record.status,
        record.createdAt,
        record.updatedAt
      )
      recordSyncOp({
        entity: 'note',
        uid: record.uid,
        origin,
        tsUtc: ts,
        fields: {
          deck_uid: record.deckUid ?? null,
          title: record.title,
          note_date: record.noteDate,
          tags: record.tags ?? [],
          raw_markdown: record.rawMarkdown,
          status: record.status,
          created_at: record.createdAt,
          updated_at: record.updatedAt
        }
      })
      stats.notes++
      continue
    }
    const clock = clockFor('note', record.uid, baseTsOf('note', local))
    if (clock.deletedAt > ts) continue
    const fields: Record<string, unknown> = {}
    let title = String(local.title)
    let noteDate = local.note_date === null ? null : String(local.note_date)
    let tags = parseJson<string[]>(String(local.tags), [])
    let rawMarkdown = String(local.raw_markdown)
    let status = String(local.status)
    let deckId = toInt(local.deck_id)
    if (record.title !== title && ts > clock.field('title')) {
      title = record.title
      fields.title = record.title
    }
    if (record.noteDate !== noteDate && ts > clock.field('note_date')) {
      noteDate = record.noteDate
      fields.note_date = record.noteDate
    }
    const remoteTags = record.tags ?? []
    if (JSON.stringify(remoteTags) !== JSON.stringify(tags) && ts > clock.field('tags')) {
      tags = remoteTags
      fields.tags = remoteTags
    }
    if (record.rawMarkdown !== rawMarkdown && ts > clock.field('raw_markdown')) {
      rawMarkdown = record.rawMarkdown
      fields.raw_markdown = record.rawMarkdown
    }
    if (record.status !== status && ts > clock.field('status')) {
      status = record.status
      fields.status = record.status
    }
    const remoteDeckId = deckIdByUid(record.deckUid)
    if (remoteDeckId !== deckId && ts > clock.field('deck_uid')) {
      deckId = remoteDeckId
      fields.deck_uid = record.deckUid ?? null
    }
    if (!Object.keys(fields).length) continue
    d.prepare(
      `UPDATE notes SET title = ?, note_date = ?, tags = ?, raw_markdown = ?, status = ?, deck_id = ?, updated_at = ? WHERE id = ?`
    ).run(
      title,
      noteDate,
      JSON.stringify(tags),
      rawMarkdown,
      status,
      deckId,
      localIso(new Date(ts)),
      toInt(local.id)
    )
    recordSyncOp({ entity: 'note', uid: record.uid, origin, tsUtc: ts, fields })
    stats.notes++
  }
}

function mergeItems(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.items) {
    if (!record.uid) continue
    let local = d.prepare('SELECT * FROM items WHERE uid = ?').get(record.uid) as
      | Record<string, unknown>
      | undefined
    const norm = normalizeEn(record.headword)
    if (!local) {
      // 同词不同 uid：唯一键只允许一条，合并进本机这条（S3 用 dedupe 规则 + uid 映射）
      local = d.prepare('SELECT * FROM items WHERE headword_norm = ?').get(norm) as
        | Record<string, unknown>
        | undefined
      // 记住远端 uid → 本机 uid：复习/关联里引用的是远端 uid
      if (local) rememberAlias('item', record.uid, String(local.uid ?? ''))
    }
    if (!local) {
      const res = d
        .prepare(
          `INSERT INTO items (uid, kind, headword, headword_norm, pos, phonetic, meanings, collocations, examples, extra, accepted_zh, learned_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.uid,
          record.kind,
          record.headword,
          norm,
          record.pos,
          record.phonetic,
          JSON.stringify(record.meanings ?? []),
          JSON.stringify(record.collocations ?? []),
          JSON.stringify(record.examples ?? []),
          record.extra,
          JSON.stringify(record.acceptedZh ?? []),
          record.learnedAt,
          record.createdAt
        )
      ensureCards(toInt(res.lastInsertRowid), false)
      recordSyncOp({
        entity: 'item',
        uid: record.uid,
        origin,
        tsUtc: ts,
        fields: {
          kind: record.kind,
          headword: record.headword,
          pos: record.pos,
          phonetic: record.phonetic,
          meanings: record.meanings ?? [],
          collocations: record.collocations ?? [],
          examples: record.examples ?? [],
          extra: record.extra,
          accepted_zh: record.acceptedZh ?? [],
          learned_at: record.learnedAt,
          created_at: record.createdAt
        }
      })
      stats.items++
      continue
    }
    const uid = String(local.uid ?? record.uid)
    const clock = clockFor('item', uid, baseTsOf('item', local))
    if (clock.deletedAt > ts) continue
    const fields: Record<string, unknown> = {}
    let kind = String(local.kind)
    let headword = String(local.headword)
    let pos = local.pos === null ? null : String(local.pos)
    let phonetic = local.phonetic === null ? null : String(local.phonetic)
    let extra = local.extra === null ? null : String(local.extra)
    let meanings = parseJson<string[]>(String(local.meanings), [])
    let collocations = parseJson<string[]>(String(local.collocations), [])
    let examples = parseJson<Example[]>(String(local.examples), [])
    let acceptedZh = parseJson<string[]>(String(local.accepted_zh), [])
    let learnedAt = local.learned_at === null ? null : String(local.learned_at)

    if (record.kind !== kind && ts > clock.field('kind')) {
      kind = record.kind
      fields.kind = record.kind
    }
    if (record.pos !== pos && ts > clock.field('pos')) {
      pos = record.pos
      fields.pos = record.pos
    }
    if (record.phonetic !== phonetic && ts > clock.field('phonetic')) {
      phonetic = record.phonetic
      fields.phonetic = record.phonetic
    }
    if (record.extra !== extra && ts > clock.field('extra')) {
      extra = record.extra
      fields.extra = record.extra
    }
    // 数组一律并集（§3.9）：不按时间覆盖，各设备补的义项都留着
    const nextMeanings = unionStrings(meanings, record.meanings)
    if (!sameJson(nextMeanings, meanings)) {
      meanings = nextMeanings
      fields.meanings = nextMeanings
    }
    const nextCollocations = unionStrings(collocations, record.collocations)
    if (!sameJson(nextCollocations, collocations)) {
      collocations = nextCollocations
      fields.collocations = nextCollocations
    }
    const nextExamples = unionExamples(examples, record.examples)
    if (!sameJson(nextExamples, examples)) {
      examples = nextExamples
      fields.examples = nextExamples
    }
    const nextAccepted = unionStrings(acceptedZh, record.acceptedZh)
    if (!sameJson(nextAccepted, acceptedZh)) {
      acceptedZh = nextAccepted
      fields.accepted_zh = nextAccepted
    }
    // 学过了就是学过了：取最早的非空
    if (record.learnedAt && (!learnedAt || record.learnedAt < learnedAt)) {
      learnedAt = record.learnedAt
      fields.learned_at = record.learnedAt
    }

    const headwordChanged = record.headword !== headword && ts > clock.field('headword')
    if (headwordChanged) fields.headword = record.headword
    if (!Object.keys(fields).length) continue

    const update = (withHeadword: boolean): void => {
      d.prepare(
        `UPDATE items SET kind = ?, headword = ?, headword_norm = ?, pos = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?, extra = ?, accepted_zh = ?, learned_at = ?
         WHERE id = ?`
      ).run(
        kind,
        withHeadword ? record.headword : headword,
        withHeadword ? normalizeEn(record.headword) : normalizeEn(headword),
        pos,
        phonetic,
        JSON.stringify(meanings),
        JSON.stringify(collocations),
        JSON.stringify(examples),
        extra,
        JSON.stringify(acceptedZh),
        learnedAt,
        toInt(local.id)
      )
    }
    try {
      update(headwordChanged)
      if (headwordChanged) headword = record.headword
    } catch {
      // 改单词撞上另一条同名词条：保留本机拼写，其余字段照常
      if (!headwordChanged) throw new Error('合并词条失败')
      delete fields.headword
      try {
        update(false)
      } catch {
        stats.skipped++
        continue
      }
    }
    recordSyncOp({ entity: 'item', uid, origin, tsUtc: ts, fields })
    stats.items++
  }
}

function mergeExams(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.exams) {
    if (!record.uid) continue
    const local = d.prepare('SELECT * FROM exams WHERE uid = ?').get(record.uid) as
      | Record<string, unknown>
      | undefined
    const remoteScope = scopeFromSync(record.scope)
    if (!local) {
      d.prepare(
        `INSERT INTO exams (uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.uid,
        record.title,
        record.examDate,
        JSON.stringify(remoteScope.scope),
        record.level,
        toNum(record.targetRetention, 0.95),
        toInt(record.dailyMinutes, 20),
        record.status,
        record.createdAt
      )
      recordSyncOp({
        entity: 'exam',
        uid: record.uid,
        origin,
        tsUtc: ts,
        fields: {
          title: record.title,
          exam_date: record.examDate,
          scope: record.scope,
          level: record.level,
          target_retention: toNum(record.targetRetention, 0.95),
          daily_minutes: toInt(record.dailyMinutes, 20),
          status: record.status,
          created_at: record.createdAt
        }
      })
      stats.exams++
      continue
    }
    const clock = clockFor('exam', record.uid, baseTsOf('exam', local))
    if (clock.deletedAt > ts) continue
    const fields: Record<string, unknown> = {}
    let title = String(local.title)
    let examDate = String(local.exam_date)
    let scope = parseJson<ExamScope>(String(local.scope), {})
    let level = String(local.level)
    let targetRetention = toNum(local.target_retention, 0.95)
    let dailyMinutes = toInt(local.daily_minutes, 20)
    let status = String(local.status)
    if (record.title !== title && ts > clock.field('title')) {
      title = record.title
      fields.title = record.title
    }
    if (record.examDate !== examDate && ts > clock.field('exam_date')) {
      examDate = record.examDate
      fields.exam_date = record.examDate
    }
    if (!sameJson(record.scope, scopeForSync(scope)) && ts > clock.field('scope')) {
      scope = remoteScope.scope
      fields.scope = record.scope
    }
    if (record.level !== level && ts > clock.field('level')) {
      level = record.level
      fields.level = record.level
    }
    if (toNum(record.targetRetention, 0.95) !== targetRetention && ts > clock.field('target_retention')) {
      targetRetention = toNum(record.targetRetention, 0.95)
      fields.target_retention = targetRetention
    }
    if (toInt(record.dailyMinutes, 20) !== dailyMinutes && ts > clock.field('daily_minutes')) {
      dailyMinutes = toInt(record.dailyMinutes, 20)
      fields.daily_minutes = dailyMinutes
    }
    if (record.status !== status && ts > clock.field('status')) {
      status = record.status
      fields.status = record.status
    }
    if (!Object.keys(fields).length) continue
    d.prepare(
      `UPDATE exams SET title = ?, exam_date = ?, scope = ?, level = ?, target_retention = ?, daily_minutes = ?, status = ? WHERE id = ?`
    ).run(
      title,
      examDate,
      JSON.stringify(scope),
      level,
      targetRetention,
      dailyMinutes,
      status,
      toInt(local.id)
    )
    recordSyncOp({ entity: 'exam', uid: record.uid, origin, tsUtc: ts, fields })
    stats.exams++
  }
}

function scopeFromSync(scope: Record<string, unknown> | undefined): {
  scope: ExamScope
  deckUidValue: string | null
} {
  const raw = (scope ?? {}) as Record<string, unknown>
  const deckUidValue = typeof raw.deck_uid === 'string' ? raw.deck_uid : null
  const {
    deck_uid: _ignoredDeck,
    note_uids: rawNoteUids,
    item_uids: rawItemUids,
    noteIds: _ignoredNoteIds,
    itemIds: _ignoredItemIds,
    ...rest
  } = raw
  // A-06：远端带来的是 uid；旧版发过来的 noteIds/itemIds 是**对方机器的整数 id**，
  // 直接用会指到本机的无关笔记，这里一律丢掉（等对方升级后重写 scope 就会自愈）。
  const out: ExamScope = { ...(rest as ExamScope) }
  const deckId = deckIdByUid(deckUidValue)
  if (deckId) out.deckId = deckId
  const noteIds = (Array.isArray(rawNoteUids) ? rawNoteUids : [])
    .map((uid) => noteIdByUid(String(uid)))
    .filter((id): id is number => !!id)
  if (noteIds.length) out.noteIds = noteIds
  const itemIds = (Array.isArray(rawItemUids) ? rawItemUids : [])
    .map((uid) => itemIdByUid(String(uid)))
    .filter((id): id is number => !!id)
  if (itemIds.length) out.itemIds = itemIds
  return { scope: out, deckUidValue }
}

function mergeReviews(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats,
  replayCards: Set<number>
): void {
  const d = getDb()
  for (const record of checkpoint.reviews) {
    if (!record.uid) continue
    const exists = d.prepare('SELECT id FROM reviews WHERE uid = ?').get(record.uid)
    if (exists) continue
    const splitAt = record.cardUid.lastIndexOf(':')
    if (splitAt <= 0) {
      stats.skipped++
      continue
    }
    const itemUidValue = record.cardUid.slice(0, splitAt)
    const direction = record.cardUid.slice(splitAt + 1)
    if (!isDirection(direction)) {
      stats.skipped++
      continue
    }
    const itemId = itemIdByUid(itemUidValue)
    if (!itemId) {
      stats.skipped++
      continue
    }
    const cardId = cardIdFor(itemId, direction)
    const localCardUid = `${itemUidById(itemId) || itemUidValue}:${direction}`
    d.prepare(
      `INSERT INTO reviews (uid, card_id, reviewed_at, rating, answer, correct, elapsed_ms, mode, judge_by, exam_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.uid,
      cardId,
      record.reviewedAt,
      toInt(record.rating),
      record.answer ?? '',
      toInt(record.correct),
      toInt(record.elapsedMs),
      record.mode,
      record.judgeBy,
      examIdByUid(record.examUid)
    )
    replayCards.add(cardId)
    recordSyncOp({
      entity: 'review',
      uid: record.uid,
      origin,
      tsUtc: ts,
      fields: {
        card_uid: localCardUid,
        reviewed_at: record.reviewedAt,
        rating: toInt(record.rating),
        answer: record.answer ?? '',
        correct: toInt(record.correct),
        elapsed_ms: toInt(record.elapsedMs),
        mode: record.mode,
        judge_by: record.judgeBy,
        exam_uid: record.examUid
      }
    })
    stats.reviews++
  }
}

function mergeNoteItems(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.noteItems) {
    const noteId = noteIdByUid(record.noteUid)
    const itemId = itemIdByUid(record.itemUid)
    if (!noteId || !itemId) {
      stats.skipped++
      continue
    }
    const uid = noteItemUid(record.noteUid, record.itemUid)
    const local = d
      .prepare('SELECT raw_line, position FROM note_items WHERE note_id = ? AND item_id = ?')
      .get(noteId, itemId) as { raw_line: string | null; position: number } | undefined
    const clock = clockFor('noteItem', uid, 0)
    if (clock.deletedAt > ts) continue
    if (local) {
      if (ts <= clock.last) continue
      d.prepare('UPDATE note_items SET raw_line = ?, position = ? WHERE note_id = ? AND item_id = ?').run(
        record.rawLine,
        toInt(record.position),
        noteId,
        itemId
      )
    } else {
      d.prepare('INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (?, ?, ?, ?)').run(
        noteId,
        itemId,
        record.rawLine,
        toInt(record.position)
      )
    }
    recordSyncOp({
      entity: 'noteItem',
      uid,
      origin,
      tsUtc: ts,
      fields: {
        note_uid: record.noteUid,
        item_uid: record.itemUid,
        raw_line: record.rawLine,
        position: toInt(record.position)
      }
    })
    stats.noteItems++
  }
}

function mergeCardFlags(
  checkpoint: SyncCheckpoint,
  ts: number,
  origin: string,
  stats: MergeStats
): void {
  const d = getDb()
  for (const record of checkpoint.cardFlags) {
    if (!record.itemUid || !isDirection(record.direction)) {
      stats.skipped++
      continue
    }
    const itemId = itemIdByUid(record.itemUid)
    if (!itemId) {
      stats.skipped++
      continue
    }
    // 用本机的词条 uid 记时钟：别名（同名不同 uid）不能把时钟记到另一个 uid 上
    const uid = `${itemUidById(itemId) || record.itemUid}:${record.direction}`
    const clock = clockFor('cardFlag', uid, 0)
    if (clock.deletedAt > ts) continue
    const card = d
      .prepare('SELECT * FROM cards WHERE item_id = ? AND direction = ?')
      .get(itemId, record.direction) as Record<string, unknown> | undefined
    const fields: Record<string, unknown> = {}
    const current = card
      ? {
          suspended: toInt(card.suspended),
          needs_check: toInt(card.needs_check),
          learn_mark: toInt(card.learn_mark),
          buried_until: card.buried_until === null ? null : String(card.buried_until)
        }
      : null
    if (current) {
      // 字段时钟为 0 = 这个标志是 S0 之前设的、之后没再动过（没有 op 记录）。
      // 这时本地非默认值优先：一次导入不该把用户以前挂起的卡片悄悄解开。
      const canApply = (field: string, currentValue: unknown, defaultValue: unknown): boolean => {
        const fieldTs = clock.field(field)
        if (fieldTs > 0) return ts > fieldTs
        return sameJson(currentValue, defaultValue)
      }
      if (
        toInt(record.suspended) !== current.suspended &&
        canApply('suspended', current.suspended, 0)
      ) {
        fields.suspended = toInt(record.suspended)
      }
      if (
        toInt(record.needsCheck) !== current.needs_check &&
        canApply('needs_check', current.needs_check, 0)
      ) {
        fields.needs_check = toInt(record.needsCheck)
      }
      if (
        toInt(record.learnMark) !== current.learn_mark &&
        canApply('learn_mark', current.learn_mark, 0)
      ) {
        fields.learn_mark = toInt(record.learnMark)
      }
      if (
        record.buriedUntil !== current.buried_until &&
        canApply('buried_until', current.buried_until, null)
      ) {
        fields.buried_until = record.buriedUntil
      }
      if (!Object.keys(fields).length) continue
    } else {
      // 本机没有这张卡（例如听写方向）：建卡后把四个标志一起落下
      fields.suspended = toInt(record.suspended)
      fields.needs_check = toInt(record.needsCheck)
      fields.learn_mark = toInt(record.learnMark)
      fields.buried_until = record.buriedUntil
    }
    const cardId = cardIdFor(itemId, record.direction)
    d.prepare(
      'UPDATE cards SET suspended = ?, needs_check = ?, learn_mark = ?, buried_until = ? WHERE id = ?'
    ).run(
      (fields.suspended ?? current?.suspended ?? 0) as number,
      (fields.needs_check ?? current?.needs_check ?? 0) as number,
      (fields.learn_mark ?? current?.learn_mark ?? 0) as number,
      (fields.buried_until ?? current?.buried_until ?? null) as string | null,
      cardId
    )
    recordSyncOp({ entity: 'cardFlag', uid, origin, tsUtc: ts, fields })
    stats.cardFlags++
  }
}

/* ------------------------------------------------------------------ */
/* 逐条 op 合并（S2 的远端增量）                                        */
/* ------------------------------------------------------------------ */

/** 远端分片里的一行（`ops/*.jsonl.age` 的每一行） */
export interface RemoteSyncOp {
  entity: SyncEntity
  uid: string
  op: 'upsert' | 'delete'
  fields: Record<string, unknown>
  tsUtc: number
}

/**
 * 应用一条远端 op。规则与快照合并一致（字段级 LWW、数组并集、删除优先），
 * 只是粒度是「这条 op 带着的字段」。返回是否真的改动了本机数据。
 */
export function applyRemoteOp(op: RemoteSyncOp, origin: string): boolean {
  const rawTs = toInt(op.tsUtc)
  if (!op.uid || !rawTs) return false
  // 夹取必须在推导点做（见 clampRemoteTs 的说明）：后面 recordSyncOp 会把同一个 ts 记进 sync_ops
  const ts = clampRemoteTs(rawTs)
  const f = op.fields ?? {}

  if (op.op === 'delete') {
    const resolved = resolveAlias(op.entity, op.uid)
    const row = findLocalRow(op.entity, op.uid)
    let changed = false
    if (row) {
      const clock = buildClock(op.entity, resolved, baseTsOf(op.entity, row))
      if (ts > clock.last) {
        deleteLocalRow(op.entity, row)
        changed = true
      }
    }
    recordTombstone(op.entity, resolved, ts)
    return changed
  }

  // 比删除更早的 upsert 不能把记录复活（快照合并里有同样的规则）
  const resolvedUid = resolveAlias(op.entity, op.uid)
  const tomb = getDb()
    .prepare('SELECT ts_utc FROM sync_tombstones WHERE entity = ? AND uid = ?')
    .get(op.entity, resolvedUid) as { ts_utc?: number } | undefined
  if (tomb && ts <= toInt(tomb.ts_utc)) return false

  switch (op.entity) {
    case 'deck':
      return applyDeckOp(op.uid, f, ts, origin)
    case 'note':
      return applyNoteOp(op.uid, f, ts, origin)
    case 'item':
      return applyItemOp(op.uid, f, ts, origin)
    case 'exam':
      return applyExamOp(op.uid, f, ts, origin)
    case 'noteItem':
      return applyNoteItemOp(f, ts, origin)
    case 'review':
      return applyReviewOp(op.uid, f, ts, origin)
    case 'cardFlag':
      return applyCardFlagOp(f, op.uid, ts, origin)
    default:
      return false
  }
}

function applyDeckOp(uidValue: string, f: Record<string, unknown>, ts: number, origin: string): boolean {
  let resolved = resolveAlias('deck', uidValue)
  let row = findLocalRow('deck', uidValue)
  // 两台设备各自建了同名库：decks.name 有唯一索引，不能直接 INSERT。
  // 和 mergeDecks 一样合并到本机这条，记住远端 uid → 本机 uid，笔记的 deck_uid 才解析得到。
  if (!row && typeof f.name === 'string' && f.name) {
    row = getDb()
      .prepare('SELECT * FROM decks WHERE name = ? COLLATE NOCASE')
      .get(f.name) as Record<string, unknown> | undefined
    if (row) {
      rememberAlias('deck', uidValue, String(row.uid ?? ''))
      if (row.uid) resolved = String(row.uid)
    }
  }
  if (!row) {
    if (typeof f.name !== 'string' || !f.name) return false
    getDb()
      .prepare(
        'INSERT INTO decks (uid, name, color, position, new_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        resolved,
        f.name,
        (f.color as string | null) ?? null,
        toInt(f.position),
        f.new_per_day === null || f.new_per_day === undefined ? null : toInt(f.new_per_day),
        String(f.created_at ?? localIso())
      )
    recordSyncOp({ entity: 'deck', uid: resolved, origin, tsUtc: ts, fields: f })
    return true
  }
  const clock = buildClock('deck', resolved, baseTsOf('deck', row))
  if (clock.deletedAt > ts) return false
  const fields: Record<string, unknown> = {}
  let name = String(row.name)
  let color = row.color === null ? null : String(row.color)
  let position = toInt(row.position)
  let newPerDay = row.new_per_day === null ? null : toInt(row.new_per_day)
  if ('name' in f && typeof f.name === 'string' && f.name !== name && ts > clock.field('name')) {
    name = f.name
    fields.name = f.name
  }
  if ('color' in f) {
    const next = (f.color as string | null) ?? null
    if (next !== color && ts > clock.field('color')) {
      color = next
      fields.color = next
    }
  }
  if ('position' in f && toInt(f.position) !== position && ts > clock.field('position')) {
    position = toInt(f.position)
    fields.position = position
  }
  if ('new_per_day' in f) {
    const next = f.new_per_day === null || f.new_per_day === undefined ? null : toInt(f.new_per_day)
    if (next !== newPerDay && ts > clock.field('new_per_day')) {
      newPerDay = next
      fields.new_per_day = next
    }
  }
  if (!Object.keys(fields).length) return false
  try {
    getDb()
      .prepare('UPDATE decks SET name = ?, color = ?, position = ?, new_per_day = ? WHERE id = ?')
      .run(name, color, position, newPerDay, toInt(row.id))
  } catch {
    return false
  }
  recordSyncOp({ entity: 'deck', uid: resolved, origin, tsUtc: ts, fields })
  return true
}

function applyNoteOp(uidValue: string, f: Record<string, unknown>, ts: number, origin: string): boolean {
  const row = findLocalRow('note', uidValue)
  if (!row) {
    if (typeof f.title !== 'string' || !f.title) return false
    const at = localIso(new Date(ts))
    getDb()
      .prepare(
        `INSERT INTO notes (uid, source_id, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uidValue,
        deckIdByUid(typeof f.deck_uid === 'string' ? f.deck_uid : null),
        f.title,
        (f.note_date as string | null) ?? null,
        JSON.stringify(f.tags ?? []),
        String(f.raw_markdown ?? ''),
        String(f.status ?? 'validated'),
        String(f.created_at ?? at),
        String(f.updated_at ?? at)
      )
    recordSyncOp({ entity: 'note', uid: uidValue, origin, tsUtc: ts, fields: f })
    return true
  }
  const clock = buildClock('note', uidValue, baseTsOf('note', row))
  if (clock.deletedAt > ts) return false
  const fields: Record<string, unknown> = {}
  let title = String(row.title)
  let noteDate = row.note_date === null ? null : String(row.note_date)
  let tags = parseJson<string[]>(String(row.tags), [])
  let rawMarkdown = String(row.raw_markdown)
  let status = String(row.status)
  let deckId = toInt(row.deck_id)
  if ('title' in f && typeof f.title === 'string' && f.title !== title && ts > clock.field('title')) {
    title = f.title
    fields.title = f.title
  }
  if ('note_date' in f) {
    const next = (f.note_date as string | null) ?? null
    if (next !== noteDate && ts > clock.field('note_date')) {
      noteDate = next
      fields.note_date = next
    }
  }
  if ('tags' in f) {
    const next = Array.isArray(f.tags) ? f.tags.map(String) : tags
    if (!sameJson(next, tags) && ts > clock.field('tags')) {
      tags = next
      fields.tags = next
    }
  }
  if ('raw_markdown' in f && typeof f.raw_markdown === 'string' && f.raw_markdown !== rawMarkdown && ts > clock.field('raw_markdown')) {
    rawMarkdown = f.raw_markdown
    fields.raw_markdown = f.raw_markdown
  }
  if ('status' in f && typeof f.status === 'string' && f.status !== status && ts > clock.field('status')) {
    status = f.status
    fields.status = f.status
  }
  if ('deck_uid' in f) {
    const next = deckIdByUid(typeof f.deck_uid === 'string' ? f.deck_uid : null)
    if (next !== deckId && ts > clock.field('deck_uid')) {
      deckId = next
      fields.deck_uid = f.deck_uid ?? null
    }
  }
  if (!Object.keys(fields).length) return false
  getDb()
    .prepare(
      `UPDATE notes SET title = ?, note_date = ?, tags = ?, raw_markdown = ?, status = ?, deck_id = ?, updated_at = ? WHERE id = ?`
    )
    .run(title, noteDate, JSON.stringify(tags), rawMarkdown, status, deckId, localIso(new Date(ts)), toInt(row.id))
  recordSyncOp({ entity: 'note', uid: uidValue, origin, tsUtc: ts, fields })
  return true
}

function applyItemOp(uidValue: string, f: Record<string, unknown>, ts: number, origin: string): boolean {
  let row = findLocalRow('item', uidValue)
  if (!row && typeof f.headword === 'string') {
    row = getDb()
      .prepare('SELECT * FROM items WHERE headword_norm = ?')
      .get(normalizeEn(f.headword)) as Record<string, unknown> | undefined
    if (row) rememberAlias('item', uidValue, String(row.uid ?? ''))
  }
  if (!row) {
    if (typeof f.headword !== 'string' || !f.headword) return false
    const res = getDb()
      .prepare(
        `INSERT INTO items (uid, kind, headword, headword_norm, pos, phonetic, meanings, collocations, examples, extra, accepted_zh, learned_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uidValue,
        String(f.kind ?? 'word'),
        f.headword,
        normalizeEn(f.headword),
        (f.pos as string | null) ?? null,
        (f.phonetic as string | null) ?? null,
        JSON.stringify(f.meanings ?? []),
        JSON.stringify(f.collocations ?? []),
        JSON.stringify(f.examples ?? []),
        (f.extra as string | null) ?? null,
        JSON.stringify(f.accepted_zh ?? []),
        (f.learned_at as string | null) ?? null,
        String(f.created_at ?? localIso(new Date(ts)))
      )
    ensureCards(toInt(res.lastInsertRowid), false)
    recordSyncOp({ entity: 'item', uid: uidValue, origin, tsUtc: ts, fields: f })
    return true
  }
  const localUid = String(row.uid ?? uidValue)
  const clock = buildClock('item', localUid, baseTsOf('item', row))
  if (clock.deletedAt > ts) return false
  const fields: Record<string, unknown> = {}
  let kind = String(row.kind)
  let headword = String(row.headword)
  let pos = row.pos === null ? null : String(row.pos)
  let phonetic = row.phonetic === null ? null : String(row.phonetic)
  let extra = row.extra === null ? null : String(row.extra)
  let meanings = parseJson<string[]>(String(row.meanings), [])
  let collocations = parseJson<string[]>(String(row.collocations), [])
  let examples = parseJson<Example[]>(String(row.examples), [])
  let acceptedZh = parseJson<string[]>(String(row.accepted_zh), [])
  let learnedAt = row.learned_at === null ? null : String(row.learned_at)
  for (const key of ['kind', 'pos', 'phonetic', 'extra'] as const) {
    if (!(key in f)) continue
    const current = key === 'kind' ? kind : key === 'pos' ? pos : key === 'phonetic' ? phonetic : extra
    const next = f[key] === null || f[key] === undefined ? null : String(f[key])
    if (next !== current && ts > clock.field(key)) {
      if (key === 'kind') kind = next ?? 'word'
      if (key === 'pos') pos = next
      if (key === 'phonetic') phonetic = next
      if (key === 'extra') extra = next
      fields[key] = next
    }
  }
  if ('meanings' in f) {
    const next = unionStrings(meanings, f.meanings)
    if (!sameJson(next, meanings)) {
      meanings = next
      fields.meanings = next
    }
  }
  if ('collocations' in f) {
    const next = unionStrings(collocations, f.collocations)
    if (!sameJson(next, collocations)) {
      collocations = next
      fields.collocations = next
    }
  }
  if ('examples' in f) {
    const next = unionExamples(examples, f.examples)
    if (!sameJson(next, examples)) {
      examples = next
      fields.examples = next
    }
  }
  if ('accepted_zh' in f) {
    const next = unionStrings(acceptedZh, f.accepted_zh)
    if (!sameJson(next, acceptedZh)) {
      acceptedZh = next
      fields.accepted_zh = next
    }
  }
  if (typeof f.learned_at === 'string' && f.learned_at && (!learnedAt || f.learned_at < learnedAt)) {
    learnedAt = f.learned_at
    fields.learned_at = f.learned_at
  }
  const headwordChanged =
    typeof f.headword === 'string' && f.headword !== headword && ts > clock.field('headword')
  if (headwordChanged) fields.headword = f.headword
  if (!Object.keys(fields).length) return false

  const update = (withHeadword: boolean): void => {
    getDb()
      .prepare(
        `UPDATE items SET kind = ?, headword = ?, headword_norm = ?, pos = ?, phonetic = ?, meanings = ?, collocations = ?, examples = ?, extra = ?, accepted_zh = ?, learned_at = ?
         WHERE id = ?`
      )
      .run(
        kind,
        withHeadword ? String(f.headword) : headword,
        normalizeEn(withHeadword ? String(f.headword) : headword),
        pos,
        phonetic,
        JSON.stringify(meanings),
        JSON.stringify(collocations),
        JSON.stringify(examples),
        extra,
        JSON.stringify(acceptedZh),
        learnedAt,
        toInt(row.id)
      )
  }
  try {
    update(headwordChanged)
    if (headwordChanged) headword = String(f.headword)
  } catch {
    if (!headwordChanged) return false
    delete fields.headword
    try {
      update(false)
    } catch {
      return false
    }
  }
  recordSyncOp({ entity: 'item', uid: localUid, origin, tsUtc: ts, fields })
  return true
}

function applyExamOp(uidValue: string, f: Record<string, unknown>, ts: number, origin: string): boolean {
  let row = findLocalRow('exam', uidValue)
  if (!row) {
    if (typeof f.title !== 'string' || typeof f.exam_date !== 'string') return false
    const scope = scopeFromSync((f.scope ?? {}) as Record<string, unknown>)
    getDb()
      .prepare(
        `INSERT INTO exams (uid, title, exam_date, scope, level, target_retention, daily_minutes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uidValue,
        f.title,
        f.exam_date,
        JSON.stringify(scope.scope),
        String(f.level ?? 'dictate'),
        toNum(f.target_retention, 0.95),
        toInt(f.daily_minutes, 20),
        String(f.status ?? 'active'),
        String(f.created_at ?? localIso(new Date(ts)))
      )
    recordSyncOp({ entity: 'exam', uid: uidValue, origin, tsUtc: ts, fields: f })
    return true
  }
  const clock = buildClock('exam', uidValue, baseTsOf('exam', row))
  if (clock.deletedAt > ts) return false
  const fields: Record<string, unknown> = {}
  let title = String(row.title)
  let examDate = String(row.exam_date)
  let scope = parseJson<ExamScope>(String(row.scope), {})
  let level = String(row.level)
  let targetRetention = toNum(row.target_retention, 0.95)
  let dailyMinutes = toInt(row.daily_minutes, 20)
  let status = String(row.status)
  if ('title' in f && typeof f.title === 'string' && f.title !== title && ts > clock.field('title')) {
    title = f.title
    fields.title = f.title
  }
  if ('exam_date' in f && typeof f.exam_date === 'string' && f.exam_date !== examDate && ts > clock.field('exam_date')) {
    examDate = f.exam_date
    fields.exam_date = f.exam_date
  }
  if ('scope' in f) {
    const next = scopeFromSync((f.scope ?? {}) as Record<string, unknown>)
    if (!sameJson(f.scope, scopeForSync(scope)) && ts > clock.field('scope')) {
      scope = next.scope
      fields.scope = f.scope
    }
  }
  if ('level' in f && typeof f.level === 'string' && f.level !== level && ts > clock.field('level')) {
    level = f.level
    fields.level = f.level
  }
  if ('target_retention' in f) {
    const next = toNum(f.target_retention, 0.95)
    if (next !== targetRetention && ts > clock.field('target_retention')) {
      targetRetention = next
      fields.target_retention = next
    }
  }
  if ('daily_minutes' in f) {
    const next = toInt(f.daily_minutes, 20)
    if (next !== dailyMinutes && ts > clock.field('daily_minutes')) {
      dailyMinutes = next
      fields.daily_minutes = next
    }
  }
  if ('status' in f && typeof f.status === 'string' && f.status !== status && ts > clock.field('status')) {
    status = f.status
    fields.status = f.status
  }
  if (!Object.keys(fields).length) return false
  getDb()
    .prepare(
      `UPDATE exams SET title = ?, exam_date = ?, scope = ?, level = ?, target_retention = ?, daily_minutes = ?, status = ? WHERE id = ?`
    )
    .run(title, examDate, JSON.stringify(scope), level, targetRetention, dailyMinutes, status, toInt(row.id))
  recordSyncOp({ entity: 'exam', uid: uidValue, origin, tsUtc: ts, fields })
  return true
}

function applyNoteItemOp(f: Record<string, unknown>, ts: number, origin: string): boolean {
  const noteUidValue = String(f.note_uid ?? '')
  const itemUidValue = String(f.item_uid ?? '')
  const noteId = noteIdByUid(noteUidValue)
  const itemId = itemIdByUid(itemUidValue)
  if (!noteId || !itemId) return false
  const uid = noteItemUid(noteUidById(noteId), itemUidById(itemId))
  const clock = buildClock('noteItem', uid, 0)
  if (clock.deletedAt > ts || ts <= clock.last) return false
  const rawLine = (f.raw_line as string | null) ?? null
  const position = toInt(f.position)
  getDb()
    .prepare(
      `INSERT INTO note_items (note_id, item_id, raw_line, position) VALUES (?, ?, ?, ?)
       ON CONFLICT(note_id, item_id) DO UPDATE SET raw_line = excluded.raw_line, position = excluded.position`
    )
    .run(noteId, itemId, rawLine, position)
  recordSyncOp({
    entity: 'noteItem',
    uid,
    origin,
    tsUtc: ts,
    fields: {
      note_uid: noteUidById(noteId),
      item_uid: itemUidById(itemId),
      raw_line: rawLine,
      position
    }
  })
  return true
}

function applyReviewOp(uidValue: string, f: Record<string, unknown>, ts: number, origin: string): boolean {
  const exists = getDb().prepare('SELECT 1 AS ok FROM reviews WHERE uid = ?').get(uidValue)
  if (exists) return false
  const cardUid = String(f.card_uid ?? '')
  const splitAt = cardUid.lastIndexOf(':')
  if (splitAt <= 0) return false
  const itemId = itemIdByUid(cardUid.slice(0, splitAt))
  const direction = cardUid.slice(splitAt + 1)
  if (!itemId || !isDirection(direction)) return false
  const cardId = cardIdFor(itemId, direction)
  getDb()
    .prepare(
      `INSERT INTO reviews (uid, card_id, reviewed_at, rating, answer, correct, elapsed_ms, mode, judge_by, exam_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uidValue,
      cardId,
      String(f.reviewed_at ?? localIso(new Date(ts))),
      toInt(f.rating),
      String(f.answer ?? ''),
      toInt(f.correct),
      toInt(f.elapsed_ms),
      String(f.mode ?? 'longterm'),
      (f.judge_by as string | null) ?? null,
      examIdByUid(typeof f.exam_uid === 'string' ? f.exam_uid : null)
    )
  replayLocalCard(cardId)
  recordSyncOp({ entity: 'review', uid: uidValue, origin, tsUtc: ts, fields: f })
  return true
}

function applyCardFlagOp(
  f: Record<string, unknown>,
  uidValue: string,
  ts: number,
  origin: string
): boolean {
  const splitAt = uidValue.lastIndexOf(':')
  if (splitAt <= 0) return false
  const direction = uidValue.slice(splitAt + 1)
  const itemId = itemIdByUid(uidValue.slice(0, splitAt))
  if (!itemId || !isDirection(direction)) return false
  const uid = `${itemUidById(itemId)}:${direction}`
  const clock = buildClock('cardFlag', uid, 0)
  if (clock.deletedAt > ts) return false
  const card = getDb()
    .prepare('SELECT * FROM cards WHERE item_id = ? AND direction = ?')
    .get(itemId, direction) as Record<string, unknown> | undefined
  const current = card
    ? {
        suspended: toInt(card.suspended),
        needs_check: toInt(card.needs_check),
        learn_mark: toInt(card.learn_mark),
        buried_until: card.buried_until === null ? null : String(card.buried_until)
      }
    : null
  const fields: Record<string, unknown> = {}
  const canApply = (field: string, currentValue: unknown, defaultValue: unknown): boolean => {
    const fieldTs = clock.field(field)
    if (fieldTs > 0) return ts > fieldTs
    return sameJson(currentValue, defaultValue)
  }
  if (current) {
    if ('suspended' in f && toInt(f.suspended) !== current.suspended && canApply('suspended', current.suspended, 0)) {
      fields.suspended = toInt(f.suspended)
    }
    if ('needs_check' in f && toInt(f.needs_check) !== current.needs_check && canApply('needs_check', current.needs_check, 0)) {
      fields.needs_check = toInt(f.needs_check)
    }
    if ('learn_mark' in f && toInt(f.learn_mark) !== current.learn_mark && canApply('learn_mark', current.learn_mark, 0)) {
      fields.learn_mark = toInt(f.learn_mark)
    }
    if ('buried_until' in f) {
      const next = (f.buried_until as string | null) ?? null
      if (next !== current.buried_until && canApply('buried_until', current.buried_until, null)) {
        fields.buried_until = next
      }
    }
    if (!Object.keys(fields).length) return false
  } else {
    if ('suspended' in f) fields.suspended = toInt(f.suspended)
    if ('needs_check' in f) fields.needs_check = toInt(f.needs_check)
    if ('learn_mark' in f) fields.learn_mark = toInt(f.learn_mark)
    if ('buried_until' in f) fields.buried_until = (f.buried_until as string | null) ?? null
    if (!Object.keys(fields).length) return false
  }
  const cardId = cardIdFor(itemId, direction)
  getDb()
    .prepare(
      'UPDATE cards SET suspended = ?, needs_check = ?, learn_mark = ?, buried_until = ? WHERE id = ?'
    )
    .run(
      (fields.suspended ?? current?.suspended ?? 0) as number,
      (fields.needs_check ?? current?.needs_check ?? 0) as number,
      (fields.learn_mark ?? current?.learn_mark ?? 0) as number,
      (fields.buried_until ?? current?.buried_until ?? null) as string | null,
      cardId
    )
  recordSyncOp({ entity: 'cardFlag', uid, origin, tsUtc: ts, fields })
  return true
}

/** 批量应用（引擎按文件里的顺序调它）；返回实际改动的条数 */
export function applyRemoteOps(ops: RemoteSyncOp[], origin: string): number {
  let applied = 0
  for (const op of ops) {
    if (applyRemoteOp(op, origin)) applied++
  }
  return applied
}
