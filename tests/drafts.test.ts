import path from 'node:path'
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { closeDb, openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { ingestFile } from '../src/main/importers/ingest'
import {
  commitAllDrafts,
  commitDraft,
  countDrafts,
  discardDraft,
  draftBytes,
  draftIssueSummary,
  getDraft,
  listDraftMetas,
  saveDraft
} from '../src/main/db/importDrafts'
import { listNotes } from '../src/main/db/notes'
import { listItems } from '../src/main/db/items'

const dataDir = app.getPath('userData')
const dbFile = path.join(dataDir, 'drafts.db')
let fileSeq = 0

function writeNote(content: string, ext = '.txt'): string {
  fileSeq += 1
  const file = path.join(dataDir, `note-${fileSeq}-${Date.now()}${ext}`)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

beforeAll(async () => {
  initSettings()
  openDb(dbFile)
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

describe('解析后立即落盘草稿', () => {
  it('识别成功后马上能查到草稿，源文件有副本', async () => {
    const file = writeNote(['abandon v. 放弃；抛弃', 'ability n. 能力'].join('\n'))
    const result = await ingestFile(file)
    expect(result.ok).toBe(true)
    expect(result.resumed).toBe(false)
    expect(result.draftId).toBeGreaterThan(0)

    const metas = listDraftMetas()
    expect(metas).toHaveLength(1)
    expect(metas[0].fileName).toBe(path.basename(file))
    expect(metas[0].itemCount).toBe(2)
    expect(metas[0].hasFile).toBe(true)
    // 列表接口不能带 payload
    expect('items' in metas[0]).toBe(false)

    const draft = getDraft(result.draftId!)
    expect(draft?.items.map((i) => i.headword)).toEqual(expect.arrayContaining(['abandon', 'ability']))
    expect(draft?.storedPath).toBeTruthy()
    expect(fs.existsSync(path.join(dataDir, draft!.storedPath!))).toBe(true)
  })

  it('同一份文件再次导入时恢复旧草稿，不重新识别', async () => {
    const file = writeNote('resemble v. 类似\nnudge n. 轻推')
    const first = await ingestFile(file)
    const second = await ingestFile(file)
    expect(second.resumed).toBe(true)
    expect(second.draftId).toBe(first.draftId)
    expect(countDrafts()).toBe(2) // 上一轮那份 + 这份，同一份没有重复建
  })
})

describe('一条都没识别出来', () => {
  it('草稿照样留住，但结果是失败（不能报成「已识别」）', async () => {
    const file = writeNote('这节课只是讲语法，没有单词。')
    const result = await ingestFile(file)
    expect(result.ok).toBe(false)
    expect(result.draftId).toBeGreaterThan(0)
    expect(result.error).toContain('没有从这份文件里识别出词条')

    const draft = getDraft(result.draftId!)!
    expect(draft.items).toHaveLength(0)
    // 原文还在，用户可以在草稿里手动整理后再入库
    expect(draft.rawText).toContain('讲语法')
  })
})

describe('草稿编辑与持久化', () => {
  it('改过的标题/标签/词条在重开数据库后还在', async () => {
    const file = writeNote('record n. / v. 记录；唱片')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    const items = draft.items.map((it, idx) =>
      idx === 0 ? { ...it, headword: 'record', meanings: ['记录', '唱片', '档案'] } : it
    )
    saveDraft(draft.id, { title: 'Unit 7 词汇', tags: ['Unit 7'], noteDate: '2026-11-01', items })

    // 模拟重启应用
    closeDb()
    openDb(dbFile)

    const restored = getDraft(draft.id)!
    expect(restored.title).toBe('Unit 7 词汇')
    expect(restored.tags).toEqual(['Unit 7'])
    expect(restored.noteDate).toBe('2026-11-01')
    expect(restored.items[0].meanings).toContain('档案')
    expect(listDraftMetas().find((m) => m.id === draft.id)?.edited).toBe(true)
    expect(draftBytes()).toBeGreaterThan(0)
  })
})

describe('入库与丢弃', () => {
  it('入库后笔记、词条正确，草稿消失', async () => {
    const file = writeNote('pave v. 铺路\npave the way for 为…铺平道路')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    saveDraft(draft.id, { title: '铺路笔记' })

    const before = listNotes({}).length
    const result = commitDraft(draft.id)
    expect(result.itemCount).toBe(2)
    expect(getDraft(draft.id)).toBeNull()
    expect(listNotes({})).toHaveLength(before + 1)
    expect(listItems().some((i) => i.headword === 'pave')).toBe(true)
  })

  it('入库时可以写入预先补全的音标', async () => {
    const file = writeNote('lexicon n. 词典')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    const tempId = draft.items[0].tempId
    const result = commitDraft(draft.id, {
      [tempId]: '美 /ˈleksɪkən/ · 英 /ˈleksɪkən/'
    })
    expect(result.itemCount).toBe(1)
    const item = listItems('lexicon').find((it) => it.headword === 'lexicon')
    expect(item?.phonetic).toBe('美 /ˈleksɪkən/ · 英 /ˈleksɪkən/')
  })

  it('没有勾选任何词条时入库报错，草稿保留', async () => {
    const file = writeNote('permit v. 允许')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    saveDraft(draft.id, { items: draft.items.map((it) => ({ ...it, selected: false })) })
    expect(() => commitDraft(draft.id)).toThrow('至少选择一个词条')
    expect(getDraft(draft.id)).not.toBeNull()
  })

  it('用户取消后草稿和源文件副本一起清掉', async () => {
    const file = writeNote('conclude v. 得出结论')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    const stored = path.join(dataDir, draft.storedPath!)
    expect(fs.existsSync(stored)).toBe(true)
    const before = countDrafts()

    discardDraft(draft.id)
    expect(getDraft(draft.id)).toBeNull()
    expect(countDrafts()).toBe(before - 1)
    expect(fs.existsSync(stored)).toBe(false)
  })
})

describe('多文件草稿（一次拖多份的回归）', () => {
  it('入库其中一份，其余草稿和修改都还在', async () => {
    const first = await ingestFile(writeNote('fragile adj. 脆弱的'))
    const second = await ingestFile(writeNote('rigid adj. 僵硬的'))
    const kept = getDraft(second.draftId!)!
    saveDraft(kept.id, {
      title: '第二份笔记',
      items: kept.items.map((it) => ({ ...it, meanings: [...it.meanings, '死板的'] }))
    })

    commitDraft(first.draftId!)

    expect(getDraft(first.draftId!)).toBeNull()
    const meta = listDraftMetas().find((m) => m.id === second.draftId)
    expect(meta).toBeTruthy()
    expect(meta?.edited).toBe(true)
    const restored = getDraft(second.draftId!)!
    expect(restored.title).toBe('第二份笔记')
    expect(restored.items[0].meanings).toContain('死板的')
  })

  it('全部入库：勾选的入库，没勾选的失败并保留', async () => {
    const ready = await ingestFile(writeNote('latent adj. 潜在的'))
    const skipped = await ingestFile(writeNote('vivid adj. 生动的'))
    const skippedDraft = getDraft(skipped.draftId!)!
    saveDraft(skippedDraft.id, {
      items: skippedDraft.items.map((it) => ({ ...it, selected: false }))
    })

    const result = commitAllDrafts()
    expect(result.committed.some((c) => c.draftId === ready.draftId)).toBe(true)
    expect(result.failed.some((f) => f.draftId === skipped.draftId)).toBe(true)
    expect(getDraft(ready.draftId!)).toBeNull()
    expect(getDraft(skipped.draftId!)).not.toBeNull()
  })
})

describe('草稿校验统计（通知中心用）', () => {
  it('只统计未被忽略/采纳的提示', async () => {
    const file = writeNote('commute v. 通勤')
    const created = await ingestFile(file)
    const draft = getDraft(created.draftId!)!
    // 先清掉解析阶段产生的提示，避免受其它草稿的基线影响
    saveDraft(draft.id, { issues: [], resolved: [] })
    const base = draftIssueSummary()

    const issues = [
      { severity: 'warning' as const, message: '第一条' },
      { severity: 'error' as const, message: '第二条' }
    ]
    saveDraft(draft.id, { issues, resolved: [0] })
    const summary = draftIssueSummary()
    expect(summary.draftsWithIssues).toBe(base.draftsWithIssues + 1)
    expect(summary.unresolved).toBe(base.unresolved + 1)

    saveDraft(draft.id, { resolved: [0, 1] })
    const after = draftIssueSummary()
    expect(after.draftsWithIssues).toBe(base.draftsWithIssues)
    expect(after.unresolved).toBe(base.unresolved)
    discardDraft(draft.id)
  })
})
