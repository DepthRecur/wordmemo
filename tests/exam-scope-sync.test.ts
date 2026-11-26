import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { createDeck } from '../src/main/db/decks'
import { createNote } from '../src/main/db/notes'
import { createExam, listExams } from '../src/main/db/exams'
import { exportCheckpoint, mergeCheckpoint } from '../src/main/db/checkpoint'

// A-06：考试范围里的「指定笔记 / 指定词条」是本机整数 id。
// 以前只把 deckId 换成 deck_uid，noteIds/itemIds 原样同步到仓库 → 另一台设备
// 解析出来指向它自己的几个无关笔记，考试计划在那边就是错的。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-examscope-'))
const dbA = path.join(dir, 'a.db')
const dbB = path.join(dir, 'b.db')

function useDb(file: string): void {
  closeDb()
  openDb(file)
}

beforeAll(async () => {
  initSettings()
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

afterAll(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('考试范围跨设备（A-06）', () => {
  it('scope.noteIds 以 uid 出网，落地后指向本机自己的笔记', () => {
    // A：建库 + 两份笔记，考试只考其中一份
    useDb(dbA)
    const deckA = createDeck({ name: '课标词汇' })
    const keep = createNote({
      deckId: deckA,
      title: '要考的',
      rawMarkdown: 'abandon v. 放弃',
      items: [{ headword: 'abandon', meanings: ['放弃'] }]
    })
    const other = createNote({
      deckId: deckA,
      title: '不考的',
      rawMarkdown: 'banana n. 香蕉',
      items: [{ headword: 'banana', meanings: ['香蕉'] }]
    })
    const examA = createExam({
      title: '听写',
      examDate: '2026-12-01',
      scope: { deckId: deckA, noteIds: [keep] },
      level: 'dictate',
      targetRetention: 0.95,
      dailyMinutes: 20
    })
    expect(examA).toBeGreaterThan(0)
    expect(other).toBeGreaterThan(0)

    const checkpoint = exportCheckpoint('checkpoint')
    const scope = checkpoint.exams[0].scope as Record<string, unknown>
    // 出网形态：只有 uid，没有本机整数 id
    expect(Array.isArray(scope.note_uids)).toBe(true)
    expect((scope.note_uids as string[]).length).toBe(1)
    expect(scope.noteIds).toBeUndefined()
    expect(scope.deckId).toBeUndefined()
    expect(typeof scope.deck_uid).toBe('string')

    // B：空库，合并 A 的快照
    useDb(dbB)
    const stats = mergeCheckpoint(checkpoint)
    expect(stats.exams).toBe(1)
    const exams = listExams()
    expect(exams.length).toBe(1)
    // B 的笔记 id 与 A 不同（B 是后面插的），但 scope 必须落在 B 自己那条 uid 相同的笔记上
    const noteUid = getDb()
      .prepare("SELECT uid FROM notes WHERE title = '要考的'")
      .get() as { uid?: string }
    expect(noteUid.uid).toBeTruthy()
    const localId = (
      getDb().prepare('SELECT id FROM notes WHERE uid = ?').get(noteUid.uid) as { id: number }
    ).id
    expect(exams[0].scope.noteIds).toEqual([localId])
    // 而且不能是 A 的那条 id（除非碰巧相同——用标题反查已经保证这条断言有区分度）
    const otherLocal = getDb()
      .prepare("SELECT id FROM notes WHERE title = '不考的'")
      .get() as { id?: number }
    expect(otherLocal.id).toBeTruthy()
    expect(exams[0].scope.noteIds).not.toContain(otherLocal.id)
  })
})
