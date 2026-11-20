import path from 'node:path'
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from 'electron'
import { openDb } from '../src/main/db/connection'
import { initSettings } from '../src/main/settings'
import { initFsrs } from '../src/main/fsrs'
import { heuristicExtract, analyzeFile } from '../src/main/importers/extract'
import { createNote } from '../src/main/db/notes'
import { upsertItem, getItem, findExistingItemId, updateItem } from '../src/main/db/items'
import { dueQueue, applyReview, countDue, dailyPlan, markItemLearned } from '../src/main/db/cards'
import { judgeAnswer } from '../src/main/judge'
import { createExam } from '../src/main/db/exams'
import { buildExamPlan } from '../src/main/planner'
import { dashboardStats } from '../src/main/db/stats'
import { addDays, dateKey, cleanSuggestion, displayPhonetic, isGiveUpAnswer } from '../src/shared/normalize'
import { normalizeOcrText } from '../src/shared/ocrLayout'

const dataDir = app.getPath('userData')

beforeAll(async () => {
  initSettings()
  openDb(path.join(dataDir, 'test.db'))
  await initFsrs({ longTermRetention: 0.9, examRetention: 0.95 })
})

describe('文本解析', () => {
  it('能从常见笔记行里抽出词条', () => {
    const text = [
      'Unit 3 词汇',
      'abandon v. 放弃；抛弃',
      'ability n. 能力',
      'look forward to 期待；盼望',
      '- take part in 参加',
      '1. pay attention to 注意',
      'Unit 4 语法点：虚拟语气',
      '这是一句中文说明，不应该变成词条',
      'We should never abandon our dreams.'
    ].join('\n')
    const items = heuristicExtract(text)
    const heads = items.map((i) => i.headword.toLowerCase())
    expect(heads).toContain('abandon')
    expect(heads).toContain('ability')
    expect(heads).toContain('look forward to')
    expect(heads).toContain('take part in')
    expect(heads).toContain('pay attention to')
    expect(heads).not.toContain('unit 3')
    expect(heads).not.toContain('unit 4')
    expect(heads).not.toContain('这是一句中文说明，不应该变成词条')
  })

  it('能解析多个词性', () => {
    const items = heuristicExtract('record n. / v. 记录；唱片')
    expect(items).toHaveLength(1)
    expect(items[0].pos).toBe('n. / v.')
    expect(items[0].meanings).toEqual(['记录', '唱片'])
  })

  it('一行里并排写两个词条时会拆成两条', () => {
    const items = heuristicExtract('1. assess v.评估 assessment n.评估')
    expect(items).toHaveLength(2)
    expect(items[0].headword).toBe('assess')
    expect(items[1].headword).toBe('assessment')
    expect(items[0].meanings).toEqual(['评估'])
    expect(items[1].meanings).toEqual(['评估'])
  })

  it('跨栏标注会按栏号重排，左右两栏的内容不会串行', () => {
    const raw = [
      '[2] 4. pave the way for 为…铺路',
      '[1] assess v. 评估',
      '[2] on the contrary 相反的是',
      '[1] evaluate v. 评估'
    ].join('\n')
    const laid = normalizeOcrText(raw)
    expect(laid.labeled).toBe(true)
    expect(laid.columns).toBe(2)
    expect(laid.text.split('\n')).toEqual([
      'assess v. 评估',
      'evaluate v. 评估',
      '4. pave the way for 为…铺路',
      'on the contrary 相反的是'
    ])
  })

  it('单栏笔记全部标 [1] 时顺序不变', () => {
    const raw = ['[1] compose v. 作文', '[1] composer n. 作者'].join('\n')
    const laid = normalizeOcrText(raw)
    expect(laid.columns).toBe(1)
    expect(laid.text).toBe('compose v. 作文\ncomposer n. 作者')
  })

  it('模型没给栏号时原样返回（回退到旧行为）', () => {
    const raw = 'assess v. 评估\nassessment n. 评估'
    const laid = normalizeOcrText(raw)
    expect(laid.labeled).toBe(false)
    expect(laid.text).toBe(raw)
  })

  it('漏标栏号的续行跟随上一行所属的栏', () => {
    const raw = ['[1] fall victim to', '成为…的受害者', '[2] frame n. 框架'].join('\n')
    expect(normalizeOcrText(raw).text).toBe('fall victim to\n成为…的受害者\nframe n. 框架')
  })

  it('同一份笔记里同词不同词性会合并', () => {
    const items = heuristicExtract('nudge v. 轻推\nnudge n. 微调')
    expect(items).toHaveLength(1)
    expect(items[0].pos).toBe('v. / n.')
    expect(items[0].meanings).toEqual(expect.arrayContaining(['轻推', '微调']))
  })

  it('清理 AI 建议里的前缀', () => {
    expect(cleanSuggestion('pos', '补充：v.')).toBe('v.')
    expect(cleanSuggestion('pos', '改为：n. / v.')).toBe('n. / v.')
    expect(cleanSuggestion('meaning', '改为：放弃；抛弃')).toBe('放弃；抛弃')
    expect(cleanSuggestion('headword', '补充：abandon')).toBe('abandon')
  })

  it('音标显示把 IPA 的 ɹ 换成更好认的 r', () => {
    expect(displayPhonetic('/ˈklæɹɪfaɪ/')).toBe('/ˈklærɪfaɪ/')
    expect(displayPhonetic(null)).toBe('')
  })

  it('能解析 txt 文件并给出校验结果', async () => {
    const file = path.resolve('samples/demo.txt')
    const preview = await analyzeFile(file)
    expect(preview.items.length).toBeGreaterThan(8)
    expect(preview.items.some((i) => i.headword === 'abandon')).toBe(true)
    expect(preview.rawText.length).toBeGreaterThan(0)
    // 未配置 AI Key 时给「解析提示」，但不计入待处理的校验问题（不影响无 Key 使用）
    expect(preview.warnings.some((w) => w.includes('API Key'))).toBe(true)
    expect(preview.issues.some((i) => i.message.includes('API Key'))).toBe(false)
  })
})

describe('词库与卡片', () => {
  let noteId = 0
  const ids: number[] = []

  it('创建笔记并为词条生成 3 张卡', () => {
    noteId = createNote({ title: '测试笔记', tags: ['Unit 3'], rawMarkdown: '# 测试' })
    const words = [
      { headword: 'abandon', pos: 'v.', meanings: ['放弃', '抛弃'] },
      { headword: 'ability', pos: 'n.', meanings: ['能力'] },
      { headword: 'look forward to', pos: 'phrase', meanings: ['期待'] }
    ]
    words.forEach((w, i) => {
      ids.push(
        upsertItem({
          kind: i === 2 ? 'phrase' : 'word',
          headword: w.headword,
          pos: w.pos,
          meanings: w.meanings,
          noteId,
          position: i,
          listenEnabled: true
        })
      )
    })
    expect(ids.every((id) => id > 0)).toBe(true)
    expect(getItem(ids[0])?.meanings).toEqual(['放弃', '抛弃'])
    expect(getItem(ids[0])?.directions.sort()).toEqual(['en2zh', 'listen2en', 'zh2en'])
  })

  it('词条去重：同词同词性不会重复建条', () => {
    const again = upsertItem({
      kind: 'word',
      headword: 'Abandon',
      pos: 'v.',
      meanings: ['遗弃'],
      noteId,
      position: 9,
      listenEnabled: true
    })
    expect(again).toBe(ids[0])
    expect(getItem(ids[0])?.meanings).toContain('遗弃')
    expect(findExistingItemId('abandon', 'v.', 'word')).toBe(ids[0])
  })

  it('同词不同词性/类型只合并成一个词条', () => {
    const dedupeNote = createNote({ title: '去重测试', tags: [], rawMarkdown: '' })
    const first = upsertItem({
      kind: 'word',
      headword: 'nudge',
      pos: 'v.',
      meanings: ['轻推'],
      noteId: dedupeNote,
      position: 0,
      listenEnabled: true
    })
    const second = upsertItem({
      kind: 'phrase',
      headword: 'Nudge',
      pos: 'n.',
      meanings: ['微调'],
      noteId: dedupeNote,
      position: 1,
      listenEnabled: true
    })
    expect(second).toBe(first)
    const merged = getItem(first)!
    expect(merged.pos).toBe('v. / n.')
    expect(merged.kind).toBe('word')
    expect(merged.meanings).toEqual(expect.arrayContaining(['轻推', '微调']))
  })

  it('支持多词性和固定搭配', () => {
    const noteId = createNote({ title: '搭配测试', tags: [], rawMarkdown: '' })
    const id = upsertItem({
      kind: 'word',
      headword: 'record',
      pos: 'n. / v.',
      meanings: ['记录', '唱片'],
      collocations: ['record a song'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    expect(getItem(id)?.pos).toBe('n. / v.')
    expect(getItem(id)?.collocations).toEqual(['record a song'])
    updateItem(id, { collocations: ['record a song', 'record holder'] })
    expect(getItem(id)?.collocations).toEqual(['record a song', 'record holder'])
  })

  it('词条所有字段都能编辑（类型/词性/音标/例句/备注）', () => {
    const noteId = createNote({ title: '编辑测试', tags: [], rawMarkdown: '' })
    const id = upsertItem({
      kind: 'word',
      headword: 'editableprobe',
      pos: 'n.',
      meanings: ['甲'],
      noteId,
      position: 0,
      listenEnabled: false
    })
    updateItem(id, {
      kind: 'phrase',
      pos: 'v. / n.',
      phonetic: '/ˈedɪtəbl/',
      meanings: ['乙', '丙'],
      collocations: ['a b'],
      examples: [{ en: 'A b.', zh: '甲。' }],
      extra: '备注'
    })
    const after = getItem(id)!
    expect(after.kind).toBe('phrase')
    expect(after.pos).toBe('v. / n.')
    expect(after.phonetic).toBe('/ˈedɪtəbl/')
    expect(after.meanings).toEqual(['乙', '丙'])
    expect(after.collocations).toEqual(['a b'])
    expect(after.examples).toEqual([{ en: 'A b.', zh: '甲。' }])
    expect(after.extra).toBe('备注')
  })

  it('新词先进入学习队列，学完后才进入复习队列', () => {
    const plan = dailyPlan()
    expect(plan.learnItems.length).toBeGreaterThanOrEqual(3)
    expect(dueQueue(100).length).toBe(0)

    const abandon = plan.learnItems.find((i) => i.headword === 'abandon')!
    markItemLearned(abandon.id, true)
    expect(getItem(abandon.id)?.learnedAt).not.toBeNull()

    const queue = dueQueue(100)
    expect(queue.length).toBe(3)
    expect(queue.every((c) => c.item.id === abandon.id)).toBe(true)
    expect(queue.map((c) => c.direction).sort()).toEqual(['en2zh', 'listen2en', 'zh2en'])

    // 今日复习队列对同一个词只随机抽一个方向
    const todayPlan = dailyPlan()
    expect(todayPlan.reviewCards).toHaveLength(1)
    expect(todayPlan.reviewCards[0].item.id).toBe(abandon.id)
    expect(countDue()).toBe(1)
  })
})

describe('判分', () => {
  it('中→英：精确算对，拼写错误直接判错、不再请求确认', async () => {
    const queue = dueQueue(100)
    const card = queue.find((c) => c.direction === 'zh2en' && c.item.headword === 'abandon')!
    expect((await judgeAnswer(card.id, 'Abandon')).correct).toBe(true)
    const typo = await judgeAnswer(card.id, 'abandan')
    expect(typo.correct).toBe(false)
    expect(typo.near).toBeFalsy()
    expect(typo.reason).toContain('拼写')
    const wrong = await judgeAnswer(card.id, 'ability')
    expect(wrong.correct).toBe(false)
  })

  it('英→中：本地义项命中时不调用 AI', async () => {
    const queue = dueQueue(100)
    const card = queue.find((c) => c.direction === 'en2zh' && c.item.headword === 'abandon')!
    const r = await judgeAnswer(card.id, '放弃')
    expect(r.correct).toBe(true)
    expect(r.source).toBe('local')
  })
})

describe('放弃作答', () => {
  it('只认「XXX」（含大小写/全角/结尾标点），「不知道」按正常答案处理', () => {
    for (const text of ['XXX', 'xxx', 'XxX', 'ＸＸＸ', 'xxx.', ' xxx ']) {
      expect(isGiveUpAnswer(text)).toBe(true)
    }
    for (const text of ['不知道', '不知道。', '不知道啊', '不知道是什么', 'xxx abandon', 'not sure', 'X', 'XX']) {
      expect(isGiveUpAnswer(text)).toBe(false)
    }
  })

  it('放弃作答不查词条、不调 AI，直接按错误处理', async () => {
    const queue = dueQueue(100)
    const card = queue.find((c) => c.direction === 'en2zh')!
    const result = await judgeAnswer(card.id, 'XXX')
    expect(result.correct).toBe(false)
    expect(result.source).toBe('giveup')
    expect(result.reason).toContain('放弃')
  })
})

describe('FSRS 复习', () => {
  it('复习后到期时间被推后，并写入记录', () => {
    const card = dueQueue(100).find((c) => c.direction === 'zh2en')!
    const before = card.dueAt
    const result = applyReview({
      cardId: card.id,
      rating: 3,
      answer: card.item.headword,
      correct: true,
      elapsedMs: 2500,
      mode: 'longterm',
      judgeBy: 'exact'
    })
    expect(result.state).toBeGreaterThanOrEqual(1)
    expect(result.dueAt).not.toBe(before)
    expect(countDue()).toBeGreaterThanOrEqual(0)
  })

  it('学习卡按 learn ahead 回到队列，同词条其他方向当天 bury', () => {
    const noteId = createNote({ title: 'bury 测试', tags: [], rawMarkdown: '' })
    const itemId = upsertItem({
      kind: 'word',
      headword: 'buryword',
      pos: 'v.',
      meanings: ['埋'],
      noteId,
      position: 0,
      listenEnabled: true
    })
    markItemLearned(itemId, true)
    const card = dueQueue(100).find((c) => c.item.id === itemId)!
    expect(card).toBeTruthy()

    const result = applyReview({
      cardId: card.id,
      rating: 1,
      answer: 'wrong',
      correct: false,
      elapsedMs: 3000,
      mode: 'longterm',
      judgeBy: 'exact'
    })
    expect(result.state).toBe(1)

    // 1 分钟后到期的学习卡在 learn ahead（默认 20 分钟）窗口内，仍然可以回到队列
    const remaining = dueQueue(100).filter((c) => c.item.id === itemId)
    expect(remaining.some((c) => c.id === card.id)).toBe(true)
    // 其他两个方向被 bury 到今天结束
    expect(remaining).toHaveLength(1)
  })
})

describe('听写计划器', () => {
  it('能按考试日期生成今日任务与每日分布', () => {
    const noteId = createNote({ title: '计划测试', tags: ['exam'], rawMarkdown: '' })
    for (let i = 0; i < 6; i++) {
      upsertItem({
        kind: 'word',
        headword: `examword${i}`,
        pos: 'n.',
        meanings: [`考试词${i}`],
        noteId,
        position: i,
        listenEnabled: true
      })
    }
    const examId = createExam({
      title: '下周听写',
      examDate: addDays(dateKey(), 7),
      scope: { noteIds: [noteId] },
      level: 'dictate',
      targetRetention: 0.95,
      dailyMinutes: 20
    })
    const plan = buildExamPlan(examId)
    expect(plan.daysLeft).toBe(7)
    expect(plan.totalCards).toBeGreaterThan(0)
    expect(plan.daily.length).toBe(7)
    expect(plan.queue.length).toBeGreaterThan(0)
    expect(plan.projectedRetention).toBeGreaterThan(0)
    expect(plan.projectedRetention).toBeLessThanOrEqual(1)
  })
})

describe('统计', () => {
  it('能汇总复习量与连续天数', () => {
    const stats = dashboardStats()
    expect(stats.totalNotes).toBeGreaterThan(0)
    expect(stats.totalItems).toBeGreaterThan(0)
    expect(stats.totalReviews).toBeGreaterThan(0)
    expect(stats.forecast.length).toBe(30)
    expect(stats.heatmap.length).toBe(84)
    // 热力图必须从周一开始、到周日结束，左侧星期标签才能对得上
    expect(new Date(`${stats.heatmap[0].date}T00:00:00`).getDay()).toBe(1)
    expect(new Date(`${stats.heatmap[83].date}T00:00:00`).getDay()).toBe(0)
  })
})
