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
  /** 所属库；0 = 未归类（用户把库删光了），只在「全部」里出现 */
  deckId: number
  deckName: string
  title: string
  noteDate: string | null
  tags: string[]
  sourceKind: string | null
  status: string
  createdAt: string
  updatedAt: string
  itemCount: number
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
  /** 不传 = 当前库 */
  deckId?: number | null
}

export interface NoteQuery {
  search?: string
  tag?: string
  /** null / 不传 = 全部库 */
  deckId?: number | null
  sort?: 'noteDate' | 'createdAt' | 'title'
  order?: 'asc' | 'desc'
}

/** 笔记库（PLAN-DECKS 方案 A）：笔记容器 + 学习范围，进度仍跟单词走 */
export interface Deck {
  id: number
  uid: string
  name: string
  color: string | null
  position: number
  /** null = 用全局设置里的每日新词上限 */
  newPerDay: number | null
  noteCount: number
  itemCount: number
  /** 库内还没学过、且至少有一张卡的词条数 */
  unlearnedCount: number
  /** 今天已经在这个库学了多少新词 */
  learnedToday: number
  /** 今天还能从这个库学多少新词（剩余额度，不超过未学数） */
  todayNew: number
  /** 今天到期的卡片数（按词条去重） */
  dueCount: number
}

export interface DeckInput {
  name: string
  color?: string | null
  newPerDay?: number | null
}

export interface DeckPatch extends Partial<DeckInput> {
  position?: number
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
  /** 入库时进的库；null = 老草稿（入库时进当前库） */
  deckId: number | null
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
  deckId: number | null
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
> & {
  /** 改这份草稿入库的目标库（与 payload 字段分开处理） */
  deckId?: number
}

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

/**
 * 复习现场（2026-11-20）：在一张卡上「已经作答/已经判分、还没点下一张」时离开页面，
 * 回来要回到同一个位置，不能要求重新写一遍。
 *
 * 为什么整张卡一起存：今日任务的队列每次都会重新抽方向（`oneCardPerItem` 随机），
 * 回来说「按 id 去队列里找」经常找不到，那张卡就会重新出题。存下这张卡本身最稳。
 *
 * `scope` 用来区分范围（`deck:<id>` / `exam:<id>`）：换库/换考试就不恢复。
 */
export interface ReviewSession {
  scope: string
  /** 离开时的那张卡（含词条），回来直接照着它画 */
  card: QueueCard
  /** 已经输入、还没提交的内容（提交后也留着，判分界面要显示「你的答案」） */
  answer: string
  /** null = 还没提交 */
  result: JudgeResult | null
  /** 点提交那一刻冻结的用时；null = 还没提交 */
  answeredMs: number | null
  /** 这一轮已经交过的张数（恢复后「正确 N / M」仍然对） */
  stats: { total: number; correct: number }
  /** 显示用：这一轮的第几张 / 一共几张 */
  position: number
  total: number
  savedAt: string
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
  /** 只考这个库里的笔记；不传 = 全部库 */
  deckId?: number
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
  /** 本月钱花在哪家（按金额降序） */
  aiByProvider: { provider: string; label: string; calls: number; cost: number }[]
  /** 本月模型没有价格的调用次数（只统计了 token） */
  aiUnpricedCalls: number
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
  providers: Partial<Record<AiProviderId, AiProviderConfig>>
  /** 「本月不再提示预算」记的是 2026-11 这样的月份；换月自动失效（P-02） */
  budgetMutedMonth?: string
}

/** 超预算提醒（只提醒，不拦调用） */
export interface AiBudgetNotice {
  spent: number
  budget: number
  month: string
}

/** 同步配置（不含任何密钥：PAT/口令在加密的 secrets 文件里） */
export interface SyncSettings {
  /** false = 用户没连过（或已断开）；true 才有 owner/repo 的意义 */
  enabled: boolean
  owner: string
  repo: string
  /** 自建/代理用；默认 https://api.github.com */
  apiBase: string
  /** 定时同步间隔（分钟）；0 = 只手动 */
  intervalMin: number
}

export type SyncUiState = 'disconnected' | 'idle' | 'syncing' | 'error'

/** 设置页同步面板的一份完整状态（不含 token/口令） */
export interface SyncStatus {
  configured: boolean
  enabled: boolean
  state: SyncUiState
  owner: string
  repo: string
  apiBase: string
  intervalMin: number
  deviceId: string
  deviceName: string | null
  lastSuccessAt: string | null
  /** 上一次成功同步实际应用/合并的改动条数（>0 时界面要把库/笔记/统计重新读一遍） */
  lastSyncChanges: number
  /** 上一次同步里「解不开、找不到对应行」而跳过的记录数（>0 时界面给一条警告，MESSAGES 硬规则 2） */
  lastSyncSkipped: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  pendingOps: number
  lastPushAt: string | null
  lastPullAt: string | null
  rateLimitRemaining: number | null
  /** D-02：额度快用完时自动同步暂停（手动同步不受影响） */
  quotaPaused: boolean
  /** 额度重置时间（ISO）；null = 不知道 */
  quotaResumeAt: string | null
  /** 远端仓库体积（KB；GitHub 的 size 字段），超过 200 MB 时界面提醒 */
  repoSizeKb: number | null
}

/** 设备列表的一项（本机 + 远端见过的设备） */
export interface SyncDeviceInfo {
  id: string
  name: string | null
  lastSeenAt: string | null
  isCurrent: boolean
  /** 已被移除：不再拉取，它自己下次同步会被拒绝 */
  revoked: boolean
}

/** 同步日志一项（不含任何内容明文） */
export interface SyncLogEntry {
  at: string
  durationMs: number
  pushedOps: number
  pushedCheckpoint: boolean
  peers: number
  pulledCheckpoints: number
  pulledOpsFiles: number
  appliedOps: number
  ok: boolean
  errorCode: string | null
}

export interface SyncConnectInput {
  owner: string
  repo: string
  pat: string
  passphrase: string
  apiBase?: string
  intervalMin?: number
}

export interface SyncActionResult {
  ok: boolean
  status: SyncStatus
  errorCode?: string
  message?: string
}

export interface SyncImportResult extends SyncActionResult {
  applied?: number
  notes?: number
  items?: number
  reviews?: number
}

export interface Settings {
  /** 派生：默认角色那家是否已有 Key（不落盘） */
  apiKeySet: boolean
  /** 派生：默认角色是否解析出模型名（不落盘） */
  modelSet: boolean
  /** 派生：Key 和模型都齐了，AI 功能才可用（不落盘） */
  aiReady: boolean
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
  /** 当前库：今日任务、导入、托盘都跟着它（PLAN-DECKS §7）；没有库时相关视图退回「全部」 */
  currentDeckId: number
  /** 自更新（U2）：自动检查开关、跳过版本、节流记账 */
  updates: UpdateSettings
  /** 同步（S2）：仓库与节奏；PAT/口令不在这里 */
  sync: SyncSettings
}

export interface SettingsPatch extends Partial<Omit<Settings, 'apiKeySet' | 'modelSet' | 'aiReady'>> {}

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

/** 设置页模型下拉框的一行：目录里的模型 + 公开名 + 价格 */
export interface AiModelInfo {
  /** 调用时真正要写给 API 的模型名（如 deepseek-flash） */
  id: string
  /** 公开名（API 自报 → models.dev → id），如 DeepSeek-V4.1-Flash */
  name: string
  priced: boolean
  /** 美元 / 百万 token；priced=false 时为 null */
  input: number | null
  output: number | null
}

/** 设置页的供应商卡片：配置只读视图，不包含 Key 本身 */
export interface AiProviderInfo {
  id: AiProviderId
  label: string
  baseUrl: string
  /** 目录固定走的官方端点（Gemini）；null = 目录跟随 Base URL（P-08） */
  fixedCatalogUrl: string | null
  /** 实际会用的模型名（可能为空：还没填） */
  model: string
  keySet: boolean
  vision: boolean
  /** 作者没有真机验证过这一家（PLAN-PROVIDERS §9.1），UI 上要标「未验证」 */
  unverified: boolean
  /** /models 目录里的模型（**只来自目录**，没拉过就是空——不拿内置快照冒充） */
  models: AiModelInfo[]
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

/** 兼容模式（U1）：sandbox-state.json 的用户可见视图 */
export interface SandboxProbeInfo {
  pid: number
  /** ISO 时间；写入方是启动器或主进程 */
  startedAt: string
  ok: boolean
  source: 'app' | 'launcher'
}

export interface SandboxInfo {
  compatMode: boolean
  /** 连续「启动后没等到 ready」的次数；成功启动后归零 */
  failStreak: number
  maxFailStreak: number
  /** 自动切换到兼容模式，而不是用户在设置里手动打开 */
  autoEnabled: boolean
  probe: SandboxProbeInfo | null
  /** 自动降级后还没提示过用户 */
  noticePending: boolean
}

/**
 * 自更新（U2）的持久化设置。只在主进程里写：
 * - autoCheck / skippedVersions 与用户有关；
 * - lastCheckAt / failStreak / pendingVersion 是节流与「下次启动生效」的记账。
 * 渲染层改 autoCheck 走 `updates:setAutoCheck`，不要用 settings:update 整份覆盖。
 */
export interface UpdateSettings {
  /** 启动 60 秒后自动检查（24h 一次，失败退避） */
  autoCheck: boolean
  /** 用户点过「跳过这个版本」；自动检查无视它，手动检查穿透它 */
  skippedVersions: string[]
  /** 上次检查完成时间（成功或失败都算）；ISO */
  lastCheckAt: string | null
  /** 连续失败次数：0 → 24h，1 → 1h，2 → 2h，3 → 4h，4+ → 6h */
  failStreak: number
  /** 已下载、等下次启动换目录的版本；与程序目录 update/state.json 一致 */
  pendingVersion: string | null
}

/** 更新状态机（U2）：一次只可能在一个阶段 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateProgress {
  received: number
  /** null = 服务器没给 Content-Length */
  total: number | null
}

/** 推给渲染层的完整状态快照（每次变化推一份，避免三个事件乱序） */
export interface UpdateStatus {
  /** false = 开发模式 / 不是便携版目录，更新不可用 */
  enabled: boolean
  phase: UpdatePhase
  currentVersion: string
  /** 最近一次在 latest.json 里看到的版本（可能不新，也可能被跳过） */
  latestVersion: string | null
  /** 已下载、下次启动生效 */
  pendingVersion: string | null
  skippedVersions: string[]
  autoCheck: boolean
  lastCheckAt: string | null
  /** 下一次自动检查时间；null = 还没排（或已关闭自动检查） */
  nextCheckAt: string | null
  /** latest.json 里的发布说明（最多几行） */
  notes: string | null
  progress: UpdateProgress | null
  /** 给用户看的一句话；自动检查失败时保持 null（不打扰） */
  message: string | null
  /** 最近一次失败的技术原因（诊断用，给用户看的是 message） */
  error: string | null
}

export interface UpdateCheckResult {
  /** 检查本身有没有完成（不管有没有新版） */
  ok: boolean
  /** 给人看的一句话 */
  message: string
  status: UpdateStatus
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
    /** 清空 AI 回答缓存（换个模型后想拿到新答案时用）；返回删掉的条数 */
    clearAiCache(): Promise<number>
    testApiKey(provider?: AiProviderId, key?: string): Promise<AiTestResult>
    /** 设置页四张卡片的只读视图（不含 Key） */
    aiProviders(): Promise<AiSettingsInfo>
    /** 拉某一家的 /models；force = 忽略 24h TTL */
    refreshCatalog(provider: AiProviderId, force?: boolean): Promise<AiRefreshResult>
    /** 刷新 models.dev 价格目录；force = 忽略 7 天 TTL */
    refreshPricing(force?: boolean): Promise<AiRefreshResult>
    /** 预算用完提醒里点「本月不再提示」：静音到月底（P-02） */
    muteBudgetNotice(): Promise<string>
  }
  notes: {
    list(query?: NoteQuery): Promise<NoteSummary[]>
    get(id: number): Promise<NoteDetail | null>
    create(input: NoteInput): Promise<number>
    update(id: number, patch: Partial<NoteInput>): Promise<void>
    remove(id: number): Promise<void>
    /** 批量移动：只改归属，词条/卡片/进度都不动 */
    moveMany(ids: number[], deckId: number): Promise<{ moved: number }>
    /** 批量复制：复制笔记与词条关联，不复制进度（本来也只有一份） */
    copyMany(ids: number[], deckId: number): Promise<{ copied: number; noteIds: number[] }>
    /** 批量删除：只有在词不再被任何笔记引用时才删词条与卡片 */
    removeMany(ids: number[]): Promise<{ removed: number }>
  }
  decks: {
    list(): Promise<Deck[]>
    create(input: DeckInput): Promise<number>
    update(id: number, patch: DeckPatch): Promise<void>
    /**
     * 删库：moveTo = 把笔记移过去的库；null = 删掉最后一个库，笔记保留但变成未归类。
     * （2026-11-20 起允许没有任何库）
     */
    remove(id: number, moveTo: number | null): Promise<{ moved: number; unassigned: number }>
  }
  items: {
    list(query?: { search?: string; deckId?: number | null }): Promise<Item[]>
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
    /** 传入本地绝对路径：解析 + AI 校验后立刻落盘成草稿，返回草稿 id；deckId = 这份草稿入库时进的库 */
    parse(paths: string[], deckId?: number): Promise<ImportResult[]>
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
    /** deckId 省略 = 全部库（测试与旧调用兼容；界面总是传当前库） */
    daily(deckId?: number | null): Promise<DailyPlan>
    learn(itemId: number, known: boolean): Promise<void>
    queue(mode?: ReviewMode, examId?: number, deckId?: number | null): Promise<QueueCard[]>
    judge(cardId: number, answer: string): Promise<JudgeResult>
    submit(input: SubmitReview): Promise<{ dueAt: string; state: number }>
    /** 上次离开时的那张卡（没有就 null）；换了范围/过期都不恢复 */
    sessionGet(): Promise<ReviewSession | null>
    sessionSave(session: ReviewSession): Promise<void>
    sessionClear(): Promise<void>
  }
  exams: {
    list(): Promise<Exam[]>
    create(input: ExamInput): Promise<number>
    update(id: number, patch: Partial<ExamInput> & { status?: 'active' | 'done' }): Promise<void>
    remove(id: number): Promise<void>
    plan(id: number): Promise<ExamPlan>
  }
  stats: {
    /** deckId 省略 = 全部库；按库过滤只影响数量类指标，热力图/连续天数始终跨库 */
    dashboard(deckId?: number | null): Promise<DashboardStats>
  }
  search: {
    query(query: string, sort?: NoteQuery['sort'], deckId?: number | null): Promise<SearchResult>
  }
  tts: {
    get(word: string, accent?: 'us' | 'uk'): Promise<TtsResult>
    cacheSize(): Promise<{ files: number; bytes: number }>
    clear(): Promise<void>
  }
  sandbox: {
    /** 读 userData/sandbox-state.json 的用户视图（不含 lastReadyAt 等内部字段） */
    get(): Promise<SandboxInfo>
    /** 设置兼容模式；下次启动生效（本进程已经 append 的 switch 无法撤销） */
    setCompat(enabled: boolean): Promise<SandboxInfo>
    /** 「首次自动降级」提示已展示，之后不再提示 */
    ackNotice(): Promise<SandboxInfo>
  }
  updates: {
    /** 当前状态快照；开发模式下 enabled=false */
    status(): Promise<UpdateStatus>
    /** 手动检查：无视 24h 节流与「跳过版本」，失败会给人话原因 */
    check(): Promise<UpdateCheckResult>
    /** 跳过某个版本（默认 = 已下载/最新看到的那个）：删掉 app-new，不再提示 */
    skipVersion(version?: string): Promise<UpdateStatus>
    /** 自动检查开关；关掉后本次运行不再自动检查 */
    setAutoCheck(enabled: boolean): Promise<UpdateStatus>
  }
  sync: {
    status(): Promise<SyncStatus>
    /** 校验 PAT/仓库/口令并保存连接（成功后立即首次同步） */
    connect(input: SyncConnectInput): Promise<SyncActionResult>
    disconnect(): Promise<SyncStatus>
    /** 立即同步（手动永远可用） */
    now(): Promise<SyncActionResult>
    /** 导出加密快照到用户选的位置；取消返回 path=null */
    export(passphrase?: string): Promise<SyncActionResult & { path: string | null }>
    /** 导入加密快照（合并，不覆盖） */
    import(passphrase?: string): Promise<SyncImportResult>
    /** 设备列表（本机 + 远端见过的设备） */
    devices(): Promise<SyncDeviceInfo[]>
    /** 移除其它设备：远端目录删掉，并把它列进 meta.revokedDevices */
    removeDevice(deviceId: string): Promise<SyncActionResult>
    /** 更换同步密码：本机重新加密并重推，其它设备需要用新密码重新连接 */
    changePassphrase(passphrase: string): Promise<SyncActionResult>
    /** 最近 20 次同步记录 */
    log(): Promise<SyncLogEntry[]>
  }
  system: {
    openDataDir(): Promise<void>
    backup(): Promise<string>
    /** 把版本/沙箱状态/日志末尾打成 txt（取消时 path=null） */
    exportDiagnostics(): Promise<{ ok: boolean; path: string | null }>
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
    /** 本月 AI 预算用完：只提醒，调用照常继续（P-02） */
    onBudgetExhausted(cb: (info: AiBudgetNotice) => void): () => void
    /** 更新状态每次变化推一份完整快照（检查/下载进度/就绪/失败） */
    onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
    /** 同步状态每次变化推一份完整快照（不含 token/口令） */
    onSyncStatus(cb: (status: SyncStatus) => void): () => void
  }
}

export const DEFAULT_SETTINGS: Settings = {
  apiKeySet: false,
  modelSet: false,
  aiReady: false,
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  ai: {
    default: { provider: 'deepseek' },
    vision: null,
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
  ttsSources: ['youdao', 'baidu', 'freedict'],
  currentDeckId: 1,
  updates: {
    autoCheck: true,
    skippedVersions: [],
    lastCheckAt: null,
    failStreak: 0,
    pendingVersion: null
  },
  sync: {
    enabled: false,
    owner: '',
    repo: '',
    apiBase: 'https://api.github.com',
    intervalMin: 10
  }
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

