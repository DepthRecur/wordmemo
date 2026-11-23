import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { applyRemoteOp, applyRemoteOps, type RemoteSyncOp } from '../src/main/db/checkpoint'
import { listTombstones } from '../src/main/db/sync'

// S2 的逐条 op 合并：远端分片里的每一行就是一条 op，规则与快照合并一致
// （字段级 LWW、数组并集、删除优先、只记真正变了的字段）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-remoteops-'))
const dbFile = path.join(dir, 'ops.db')
const ORIGIN = 'remote:dev2'
const T1 = Date.parse('2026-11-20T09:00:00')
const T2 = T1 + 3_600_000

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
  openDb(dbFile)
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[]
}

function op(entity: RemoteSyncOp['entity'], uid: string, fields: Record<string, unknown>, ts = T1): RemoteSyncOp {
  return { entity, uid, op: 'upsert', fields, tsUtc: ts }
}

const NOTE_UID = '01JNOTE0000000000000000001'
const ITEM_UID = '01JITEM0000000000000000001'

describe('逐条 op 合并', () => {
  it('note → item → noteItem → review → cardFlag 依次落地', () => {
    expect(
      applyRemoteOp(
        op('note', NOTE_UID, {
          title: '远端笔记',
          note_date: '2026-11-20',
          tags: ['同步'],
          raw_markdown: '# 远端笔记',
          status: 'validated',
          deck_uid: null,
          created_at: '2026-11-20T09:00:00',
          updated_at: '2026-11-20T09:00:00'
        }),
        ORIGIN
      )
    ).toBe(true)
    const note = q<{ id: number; title: string }>('SELECT id, title FROM notes WHERE uid = ?', NOTE_UID)[0]
    expect(note.title).toBe('远端笔记')

    applyRemoteOp(
      op('item', ITEM_UID, {
        kind: 'word',
        headword: 'remote',
        pos: null,
        phonetic: null,
        meanings: ['远端的'],
        collocations: [],
        examples: [],
        extra: null,
        accepted_zh: [],
        learned_at: null,
        created_at: '2026-11-20T09:00:00'
      }),
      ORIGIN
    )
    const item = q<{ id: number }>('SELECT id FROM items WHERE uid = ?', ITEM_UID)[0]
    expect(item.id).toBeTruthy()
    // 词条落地时补了卡片
    expect(q('SELECT 1 AS ok FROM cards WHERE item_id = ?', item.id).length).toBeGreaterThan(0)

    applyRemoteOp(
      op('noteItem', `${NOTE_UID}:${ITEM_UID}`, {
        note_uid: NOTE_UID,
        item_uid: ITEM_UID,
        raw_line: 'remote /rɪˈməʊt/ 遥远的',
        position: 0
      }),
      ORIGIN
    )
    expect(
      q('SELECT 1 AS ok FROM note_items WHERE note_id = ? AND item_id = ?', note.id, item.id)
    ).toHaveLength(1)

    applyRemoteOp(
      op('review', '01JREVIEW000000000000000001', {
        card_uid: `${ITEM_UID}:en2zh`,
        reviewed_at: '2026-11-20T09:05:00',
        rating: 3,
        answer: 'remote',
        correct: 1,
        elapsed_ms: 800,
        mode: 'longterm',
        judge_by: 'self',
        exam_uid: null
      }),
      ORIGIN
    )
    const card = q<{ reps: number }>(
      `SELECT reps FROM cards WHERE item_id = ? AND direction = 'en2zh'`,
      item.id
    )[0]
    expect(card.reps).toBe(1)

    applyRemoteOp(op('cardFlag', `${ITEM_UID}:zh2en`, { suspended: 1 }), ORIGIN)
    const flag = q<{ suspended: number }>(
      `SELECT suspended FROM cards WHERE item_id = ? AND direction = 'zh2en'`,
      item.id
    )[0]
    expect(flag.suspended).toBe(1)
  })

  it('字段级 LWW：旧 op 不改，新 op 才改', () => {
    const old = op('note', NOTE_UID, { title: '旧标题' }, T1 - 60_000)
    expect(applyRemoteOp(old, ORIGIN)).toBe(false)
    const newer = op('note', NOTE_UID, { title: '新标题' }, T2)
    expect(applyRemoteOp(newer, ORIGIN)).toBe(true)
    expect(q<{ title: string }>('SELECT title FROM notes WHERE uid = ?', NOTE_UID)[0].title).toBe('新标题')
  })

  it('数组并集：远端补的义项不会覆盖本地', () => {
    applyRemoteOp(op('item', ITEM_UID, { meanings: ['另一个'] }, T2), ORIGIN)
    const row = q<{ meanings: string }>('SELECT meanings FROM items WHERE uid = ?', ITEM_UID)[0]
    expect(JSON.parse(row.meanings)).toEqual(['远端的', '另一个'])
  })

  it('同一条 op 应用两次：第二次不改动（幂等）', () => {
    const before = q('SELECT meanings FROM items WHERE uid = ?', ITEM_UID)
    expect(applyRemoteOp(op('item', ITEM_UID, { meanings: ['另一个'] }, T2), ORIGIN)).toBe(false)
    expect(q('SELECT meanings FROM items WHERE uid = ?', ITEM_UID)).toEqual(before)
  })

  it('删除优先；更晚的 upsert 可以复活', () => {
    const noteId = q<{ id: number }>('SELECT id FROM notes WHERE uid = ?', NOTE_UID)[0].id
    expect(q('SELECT 1 AS ok FROM note_items WHERE note_id = ?', noteId).length).toBe(1)

    expect(
      applyRemoteOp({ entity: 'note', uid: NOTE_UID, op: 'delete', fields: {}, tsUtc: T2 + 1000 }, ORIGIN)
    ).toBe(true)
    expect(q('SELECT 1 AS ok FROM notes WHERE uid = ?', NOTE_UID)).toHaveLength(0)
    // 关联跟着级联删掉
    expect(q('SELECT 1 AS ok FROM note_items WHERE note_id = ?', noteId)).toHaveLength(0)
    expect(listTombstones().some((row) => row.uid === NOTE_UID)).toBe(true)

    // 比删除更早的 upsert 不能把它复活
    expect(applyRemoteOp(op('note', NOTE_UID, { title: '旧数据' }, T2 + 500), ORIGIN)).toBe(false)
    expect(q('SELECT 1 AS ok FROM notes WHERE uid = ?', NOTE_UID)).toHaveLength(0)

    // 更晚的 upsert 可以复活
    expect(
      applyRemoteOp(
        op(
          'note',
          NOTE_UID,
          {
            title: '复活',
            deck_uid: null,
            tags: [],
            raw_markdown: '',
            status: 'validated',
            created_at: '2026-11-20T09:00:00',
            updated_at: '2026-11-20T09:00:00'
          },
          T2 + 5000
        ),
        ORIGIN
      )
    ).toBe(true)
    expect(q<{ title: string }>('SELECT title FROM notes WHERE uid = ?', NOTE_UID)[0].title).toBe('复活')
  })

  it('批量应用返回改动条数', () => {
    const applied = applyRemoteOps(
      [
        op(
          'deck',
          '01JDECK0000000000000000001',
          {
            name: '远端库',
            color: null,
            position: 9,
            new_per_day: 5,
            created_at: '2026-11-20T09:00:00'
          },
          T2 + 6000
        ),
        op('deck', '01JDECK0000000000000000001', { name: '远端库改名' }, T2 + 7000),
        op('deck', '01JDECK0000000000000000001', { name: '旧名' }, T2 + 100)
      ],
      ORIGIN
    )
    expect(applied).toBe(2)
    expect(q<{ name: string }>('SELECT name FROM decks WHERE uid = ?', '01JDECK0000000000000000001')[0].name).toBe(
      '远端库改名'
    )
  })
})
