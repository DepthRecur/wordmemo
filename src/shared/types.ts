export type ItemKind = 'word' | 'phrase' | 'sentence' | 'grammar'
export type CardDirection = 'en2zh' | 'zh2en' | 'listen2en'
export type JudgeSource = 'exact' | 'variant' | 'local' | 'ai' | 'manual' | 'giveup'
export type ReviewMode = 'longterm' | 'exam' | 'learn'
export type ExamLevel = 'recognize' | 'dictate' | 'mixed'

export interface Example {
  en: string
  zh?: string
}

export interface Item {
  id: number
  kind: ItemKind
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
  noteIds: number[]
  directions: CardDirection[]
}

export interface NoteSummary {
  id: number
  title: string
  noteDate: string | null
  tags: string[]
  sourceKind: string | null
  status: string
  createdAt: string
  updatedAt: string
  itemCount: number
  dueCount: number
  issueCount: number
}

export interface NoteDetail extends NoteSummary {
  rawMarkdown: string
  sourceName: string | null
  items: Item[]
}

export interface NoteInput {
  title: string
  noteDate?: string | null
  tags: string[]
  rawMarkdown: string
}

export interface NoteQuery {
  search?: string
  tag?: string
  sort?: 'noteDate' | 'createdAt' | 'title'
  order?: 'asc' | 'desc'
}

export interface SearchResult {
  notes: NoteSummary[]
  items: Item[]
  /** AI 把中文查询扩展出的英文对应词 */
  expandedTerms: string[]
  aiUsed: boolean
}

export interface ParsedItem {
  tempId: string
  kind: ItemKind
  headword: string
  pos?: string | null
  phonetic?: string | null
  meanings: string[]
  collocations?: string[]
  examples: Example[]
  extra?: string | null
  sourceLine?: string | null
  confidence?: number
  selected: boolean
  /** 已存在于词库时给出 id */
  existingItemId?: number | null
}

export interface ValidationIssue {
  tempId?: string | null
  line?: string | null
  field?: 'headword' | 'pos' | 'meaning' | 'example' | 'line' | 'general'
  severity: 'warning' | 'error'
  message: string
  suggestion?: string | null
  resolved?: boolean
}

export interface ImportPreview {
  fileName: string
  sourceKind: 'image' | 'txt' | 'md' | 'docx' | 'xlsx'
  rawText: string
  title: string
  noteDate?: string | null
  items: ParsedItem[]
  issues: ValidationIssue[]
  warnings: string[]
  aiUsed: boolean
}

export interface ImportResult {
  ok: boolean
  fileName: string
  filePath?: string
  error?: string
  /** 解析成功后落盘的草稿 id */
  draftId?: number
  /** 命中了以前未入库的同一文件，没有重新调用 AI */
  resumed?: boolean
}

/** 草稿列表项：只带摘要，避免把 OCR 原文和全部词条一次传回渲染层 */
export interface ImportDraftMeta {
  id: number
  fileName: string
  sourceKind: ImportPreview['sourceKind']
  itemCount: number
  selectedCount: number
  issueCount: number
  errorCount: number
  /** 解析之后被编辑过（含勾选/标题/日期/标签/校验处理） */
  edited: boolean
  /** 源文件副本还在 data/files 里 */
  hasFile: boolean
  /** 草稿占用的字节数（副本 + payload） */
  bytes: number
  createdAt: string
  updatedAt: string
}

/** 未入库草稿的完整工作副本（识别结果 + 校验阶段的全部修改） */
export interface ImportDraft {
  id: number
  fileName: string
  sourceKind: ImportPreview['sourceKind']
  originalPath: string | null
  storedPath: string | null
  rawText: string
  warnings: string[]
  aiUsed: boolean
  title: string
  noteDate: string | null
  tags: string[]
  items: ParsedItem[]
  issues: ValidationIssue[]
  resolved: number[]
  createdAt: string
  updatedAt: string
}

export type ImportDraftPatch = Partial<
  Pick<ImportDraft, 'title' | 'noteDate' | 'tags' | 'items' | 'issues' | 'resolved'>
>

export interface ImportCommitResult {
  noteId: number
  itemCount: number
}

export interface ImportCommitAllResult {
  committed: { draftId: number; fileName: string; noteId: number; itemCount: number }[]
  failed: { draftId: number; fileName: string; error: string }[]
}

/** 未入库草稿里还没处理的校验提示统计（通知中心用） */
export interface DraftIssueSummary {
  drafts: number
  draftsWithIssues: number
  unresolved: number
}

export interface Card {
  id: number
  itemId: number
  direction: CardDirection
  dueAt: string
  stability: number | null
  difficulty: number | null
  reps: number
  lapses: number
  state: number
  suspended: boolean
  lastReview: string | null
  /** 学习阶段自评：0 = 还不熟，1 = 记住了 */
  learnMark?: number
}

export interface QueueCard extends Card {
  item: Item
  isNew: boolean
  examId?: number
}

export interface DailyPlan {
  learnItems: Item[]
  reviewCards: QueueCard[]
  dueCount: number
  learnedToday: number
  learnQuota: number
}

export interface JudgeResult {
  correct: boolean
  confidence: number
  source: JudgeSource
  normalized?: string
  reason?: string
  /**
   * 学生答案本身是这个词的正确义项，但不在本词条保存的释义里。
   * 这种情况不判错，用黄色提示“跳出舒适圈”，并按 Hard 继续。
   */
  alternative?: boolean
  uncertain?: boolean
}

/** 整份笔记重爬音标的结果 */
export interface PhoneticRefreshResult {
  total: number
  updated: number
  missing: number
}

export interface SubmitReview {
  cardId: number
  rating: 1 | 2 | 3 | 4
  answer: string
  correct: boolean
  elapsedMs: number
  mode: ReviewMode
  examId?: number | null
  judgeBy: JudgeSource
}

export interface ExamScope {
  noteIds?: number[]
  tags?: string[]
  itemIds?: number[]
}

export interface Exam {
  id: number
  title: string
  examDate: string
  scope: ExamScope
  level: ExamLevel
  targetRetention: number
  dailyMinutes: number
  status: 'active' | 'done'
  createdAt: string
}

export interface ExamInput {
  title: string
  examDate: string
  scope: ExamScope
  level: ExamLevel
  targetRetention: number
  dailyMinutes: number
}

export interface ExamDayPlan {
  date: string
  count: number
  done: number
  isToday: boolean
}

export interface ExamPlan {
  exam: Exam
  daysLeft: number
  totalCards: number
  coveredCards: number
  todayCount: number
  todayMinutes: number
  projectedRetention: number
  daily: ExamDayPlan[]
  warning: string | null
  queue: QueueCard[]
}

export interface ForecastPoint {
  date: string
  count: number
}

export interface HeatmapPoint {
  date: string
  count: number
}

export interface DashboardStats {
  dueToday: number
  newToday: number
  reviewedToday: number
  streak: number
  totalItems: number
  totalNotes: number
  totalReviews: number
  retention30d: number | null
  forecast: ForecastPoint[]
  heatmap: HeatmapPoint[]
  difficult: { id: number; headword: string; meanings: string[]; lapses: number }[]
  aiCostMonth: number
  aiCallsMonth: number
}

export type AiProviderId = 'deepseek' | 'openai' | 'gemini' | 'glm'

/**
 * 角色 → 用哪家（PLAN-PROVIDERS §3.1）。
 * `model` 留空就用该供应商卡片里配的模型；只有想给同一个角色单独挑模型时才填。
 */
export interface AiRoleConfig {
  provider: AiProviderId
  model?: string
}

/**
 * 每个供应商自己的端点与模型。字段全空 = 用内置官方端点；
 * DeepSeek 还会回落到旧的 `Settings.model` / `Settings.baseUrl`，老配置不用迁移。
 */
export interface AiProviderConfig {
  baseUrl?: string
  model?: string
}

export interface AiSettings {
  default: AiRoleConfig
  /** null = 图片识别跟随 default */
  vision: AiRoleConfig | null
  showCost: boolean
  providers: Partial<Record<AiProviderId, AiProviderConfig>>
}

export interface Settings {
  apiKeySet: boolean
  model: string
  baseUrl: string
  ai: AiSettings
  longTermRetention: number
  examRetention: number
  newPerDay: number
  dailyMinutes: number
  learnAheadMinutes: number
  listenCardEnabled: boolean
  autoPlayAudio: boolean
  accent: 'us' | 'uk'
  aiJudge: boolean
  aiValidate: boolean
  monthlyBudgetUsd: number
  reminders: string[]
  remindEnabled: boolean
  autoLaunch: boolean
  quietHours: { start: string; end: string }
  ttsSources: ('youdao' | 'baidu' | 'freedict')[]
}

export interface SettingsPatch extends Partial<Omit<Settings, 'apiKeySet'>> {}

export interface TtsResult {
  dataUrl: string | null
  source: string | null
  cached: boolean
}

export interface AiTestResult {
  ok: boolean
  message: string
  model?: string
  provider?: AiProviderId
  latencyMs?: number
}

/** 价格来源：远程目录 / 随包快照 / 没有（只统计 token） */
export type AiPriceSource = 'catalog' | 'snapshot' | 'none'

export interface AiPriceInfo {
  /** false = 这个模型没有价格 */
  priced: boolean
  /** 美元 / 百万 token */
  input: number
  output: number
  cacheRead: number
  source: AiPriceSource
  /** 价格数据的日期（YYYY-MM-DD） */
  asOf: string | null
}

/** 设置页的供应商卡片：配置只读视图，不包含 Key 本身 */
export interface AiProviderInfo {
  id: AiProviderId
  label: string
  baseUrl: string
  /** 实际会用的模型名（可能为空：还没填） */
  model: string
  keySet: boolean
  vision: boolean
  /** 作者没有真机验证过这一家（PLAN-PROVIDERS §9.1），UI 上要标「未验证」 */
  unverified: boolean
  /** /models 目录（可能为空：还没拉过） */
  models: string[]
  modelsFetchedAt: string | null
  /** 目录超过 TTL 或上次拉取失败 */
  stale: boolean
  catalogError: string | null
  /** 当前模型的价格 */
  price: AiPriceInfo
}

export interface AiSettingsInfo {
  providers: AiProviderInfo[]
  pricing: { source: string; asOf: string }
  /** 本月用量（有价部分 + 未定价次数） */
  usage: { cost: number; calls: number; unpricedCalls: number }
}

export interface AiRefreshResult {
  ok: boolean
  message: string
  info: AiSettingsInfo
}

export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'unknown'

export interface TrayDiagnostics {
  /** null = 还在检测；false = 确认没有挂到任务栏 */
  ok: boolean | null
  reason: string | null
  bounds: { width: number; height: number } | null
}

/** 用来确认「现在跑的到底是哪次构建、什么权限、托盘是否正常」 */
export interface BuildInfo {
  version: string
  /** 主进程 bundle 的修改时间（ISO），即构建时间 */
  buildTime: string | null
  /** 主进程启动时间（ISO），与构建时间不同 */
  startedAt: string
  integrity: IntegrityLevel
  tray: TrayDiagnostics
  session: string | null
}

export interface WordmemoApi {
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    /** 每家一把 Key；provider 省略 = deepseek（旧签名兼容） */
    setApiKey(provider: AiProviderId | undefined, key: string): Promise<boolean>
    clearApiKey(provider?: AiProviderId): Promise<void>
    /** 清掉全部 Key（含旧的 secrets.bin） */
    clearAllApiKeys(): Promise<void>
    testApiKey(provider?: AiProviderId, key?: string): Promise<AiTestResult>
    /** 设置页四张卡片的只读视图（不含 Key） */
    aiProviders(): Promise<AiSettingsInfo>
    /** 拉某一家的 /models；force = 忽略 24h TTL */
    refreshCatalog(provider: AiProviderId, force?: boolean): Promise<AiRefreshResult>
    /** 刷新 models.dev 价格目录；force = 忽略 7 天 TTL */
    refreshPricing(force?: boolean): Promise<AiRefreshResult>
  }
  notes: {
    list(query?: NoteQuery): Promise<NoteSummary[]>
    get(id: number): Promise<NoteDetail | null>
    create(input: NoteInput): Promise<number>
    update(id: number, patch: Partial<NoteInput>): Promise<void>
    remove(id: number): Promise<void>
  }
  items: {
    list(query?: { search?: string }): Promise<Item[]>
    update(
      id: number,
      patch: Partial<
        Pick<
          Item,
          'kind' | 'headword' | 'pos' | 'meanings' | 'collocations' | 'examples' | 'extra' | 'phonetic'
        >
      >
    ): Promise<void>
    remove(id: number): Promise<void>
    setDirection(itemId: number, direction: CardDirection, enabled: boolean): Promise<void>
    enrichNote(noteId: number): Promise<number>
    /** 整份笔记重爬音标并覆盖已有值，返回更新统计 */
    refreshPhonetics(noteId: number): Promise<PhoneticRefreshResult>
    ensurePhonetic(itemId: number): Promise<string | null>
  }
  importer: {
    pickFiles(): Promise<string[]>
    /** 传入本地绝对路径：解析 + AI 校验后立刻落盘成草稿，返回草稿 id */
    parse(paths: string[]): Promise<ImportResult[]>
    /** 未入库草稿摘要列表（不含 payload，可以放心一次拉全） */
    listDrafts(): Promise<ImportDraftMeta[]>
    /** 打开某份草稿的完整内容（含识别结果与全部修改） */
    getDraft(id: number): Promise<ImportDraft | null>
    /** 自动保存编辑内容 */
    saveDraft(id: number, patch: ImportDraftPatch): Promise<void>
    /** 入库一份草稿（以数据库里的草稿为准，不信任渲染层传参） */
    commit(draftId: number): Promise<ImportCommitResult>
    /** 把所有未入库草稿逐份入库 */
    commitAll(): Promise<ImportCommitAllResult>
    /** 用户主动取消这份草稿；只有这时才会删除识别结果 */
    discardDraft(id: number): Promise<void>
    /** 用当前（可能已修改的）词条重新跑一次 AI 校验，会消耗 token */
    revalidateDraft(id: number): Promise<ImportDraft>
    draftCount(): Promise<number>
    draftBytes(): Promise<number>
    /** 草稿校验提示统计（未处理数），用于通知中心 */
    draftIssues(): Promise<DraftIssueSummary>
    /** 图片草稿的缩略图 data URL */
    draftThumb(id: number): Promise<string | null>
    /** 拖拽文件时由 preload 解析本地路径 */
    pathForFile(file: File): string
  }
  review: {
    daily(): Promise<DailyPlan>
    learn(itemId: number, known: boolean): Promise<void>
    queue(mode?: ReviewMode, examId?: number): Promise<QueueCard[]>
    judge(cardId: number, answer: string): Promise<JudgeResult>
    submit(input: SubmitReview): Promise<{ dueAt: string; state: number }>
  }
  exams: {
    list(): Promise<Exam[]>
    create(input: ExamInput): Promise<number>
    update(id: number, patch: Partial<ExamInput> & { status?: 'active' | 'done' }): Promise<void>
    remove(id: number): Promise<void>
    plan(id: number): Promise<ExamPlan>
  }
  stats: {
    dashboard(): Promise<DashboardStats>
  }
  search: {
    query(query: string, sort?: NoteQuery['sort']): Promise<SearchResult>
  }
  tts: {
    get(word: string, accent?: 'us' | 'uk'): Promise<TtsResult>
    cacheSize(): Promise<{ files: number; bytes: number }>
    clear(): Promise<void>
  }
  system: {
    openDataDir(): Promise<void>
    backup(): Promise<string>
    appVersion(): Promise<string>
    buildInfo(): Promise<BuildInfo>
    /** 只刷新渲染层（主进程不重启） */
    reloadWindow(): Promise<void>
    /** 重启整个应用，用来加载新构建 */
    restart(): Promise<void>
    quit(): Promise<void>
  }
  events: {
    onNavigate(cb: (route: string) => void): () => void
    onRefresh(cb: () => void): () => void
  }
}

export const DEFAULT_SETTINGS: Settings = {
  apiKeySet: false,
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  ai: {
    default: { provider: 'deepseek' },
    vision: null,
    showCost: true,
    providers: {}
  },
  longTermRetention: 0.9,
  examRetention: 0.95,
  newPerDay: 20,
  dailyMinutes: 20,
  learnAheadMinutes: 20,
  listenCardEnabled: true,
  autoPlayAudio: true,
  accent: 'us',
  aiJudge: true,
  aiValidate: true,
  monthlyBudgetUsd: 3,
  reminders: ['12:30', '19:30'],
  remindEnabled: true,
  autoLaunch: false,
  quietHours: { start: '23:00', end: '07:00' },
  ttsSources: ['youdao', 'baidu', 'freedict']
}

export const DIRECTION_LABEL: Record<CardDirection, string> = {
  en2zh: '英 → 中',
  zh2en: '中 → 英',
  listen2en: '听 → 写'
}

export const KIND_LABEL: Record<ItemKind, string> = {
  word: '单词',
  phrase: '短语',
  sentence: '句子',
  grammar: '语法'
}
