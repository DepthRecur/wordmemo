import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AiBudgetNotice,
  DeckInput,
  DeckPatch,
  ExamInput,
  ImportDraftPatch,
  Item,
  NoteInput,
  NoteQuery,
  ReviewMode,
  ReviewSession,
  SettingsPatch,
  SubmitReview,
  WordmemoApi
} from '@shared/types'

const api: WordmemoApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: SettingsPatch) => ipcRenderer.invoke('settings:update', patch),
    setApiKey: (provider, key) => ipcRenderer.invoke('settings:setApiKey', provider, key),
    clearApiKey: (provider) => ipcRenderer.invoke('settings:clearApiKey', provider),
    clearAllApiKeys: () => ipcRenderer.invoke('settings:clearAllApiKeys'),
    testApiKey: (provider, key) => ipcRenderer.invoke('settings:testApiKey', provider, key),
    aiProviders: () => ipcRenderer.invoke('settings:aiProviders'),
    refreshCatalog: (provider, force) =>
      ipcRenderer.invoke('settings:refreshCatalog', provider, force),
    refreshPricing: (force) => ipcRenderer.invoke('settings:refreshPricing', force),
    muteBudgetNotice: () => ipcRenderer.invoke('settings:muteBudgetNotice')
  },
  notes: {
    list: (query?: NoteQuery) => ipcRenderer.invoke('notes:list', query),
    get: (id: number) => ipcRenderer.invoke('notes:get', id),
    create: (input: NoteInput) => ipcRenderer.invoke('notes:create', input),
    update: (id: number, patch: Partial<NoteInput>) => ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('notes:remove', id),
    moveMany: (ids: number[], deckId: number) => ipcRenderer.invoke('notes:moveMany', ids, deckId),
    copyMany: (ids: number[], deckId: number) => ipcRenderer.invoke('notes:copyMany', ids, deckId),
    removeMany: (ids: number[]) => ipcRenderer.invoke('notes:removeMany', ids)
  },
  decks: {
    list: () => ipcRenderer.invoke('decks:list'),
    create: (input: DeckInput) => ipcRenderer.invoke('decks:create', input),
    update: (id: number, patch: DeckPatch) => ipcRenderer.invoke('decks:update', id, patch),
    remove: (id: number, moveTo: number | null) => ipcRenderer.invoke('decks:remove', id, moveTo)
  },
  items: {
    list: (query?: { search?: string; deckId?: number | null }) => ipcRenderer.invoke('items:list', query),
    update: (
      id: number,
      patch: Partial<
        Pick<
          Item,
          'kind' | 'headword' | 'pos' | 'meanings' | 'collocations' | 'examples' | 'extra' | 'phonetic'
        >
      >
    ) => ipcRenderer.invoke('items:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('items:remove', id),
    setDirection: (itemId: number, direction, enabled: boolean) =>
      ipcRenderer.invoke('items:setDirection', itemId, direction, enabled),
    enrichNote: (noteId: number) => ipcRenderer.invoke('items:enrichNote', noteId),
    refreshPhonetics: (noteId: number) => ipcRenderer.invoke('items:refreshPhonetics', noteId),
    ensurePhonetic: (itemId: number) => ipcRenderer.invoke('items:ensurePhonetic', itemId)
  },
  importer: {
    pickFiles: () => ipcRenderer.invoke('importer:pickFiles'),
    parse: (paths: string[], deckId?: number) => ipcRenderer.invoke('importer:parse', paths, deckId),
    listDrafts: () => ipcRenderer.invoke('importer:listDrafts'),
    getDraft: (id: number) => ipcRenderer.invoke('importer:getDraft', id),
    saveDraft: (id: number, patch: ImportDraftPatch) => ipcRenderer.invoke('importer:saveDraft', id, patch),
    commit: (draftId: number) => ipcRenderer.invoke('importer:commit', draftId),
    commitAll: () => ipcRenderer.invoke('importer:commitAll'),
    discardDraft: (id: number) => ipcRenderer.invoke('importer:discardDraft', id),
    revalidateDraft: (id: number) => ipcRenderer.invoke('importer:revalidateDraft', id),
    draftCount: () => ipcRenderer.invoke('importer:draftCount'),
    draftBytes: () => ipcRenderer.invoke('importer:draftBytes'),
    draftIssues: () => ipcRenderer.invoke('importer:draftIssues'),
    draftThumb: (id: number) => ipcRenderer.invoke('importer:draftThumb', id),
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  review: {
    daily: (deckId?: number | null) => ipcRenderer.invoke('review:daily', deckId),
    learn: (itemId: number, known: boolean) => ipcRenderer.invoke('review:learn', itemId, known),
    queue: (mode?: ReviewMode, examId?: number, deckId?: number | null) =>
      ipcRenderer.invoke('review:queue', mode, examId, deckId),
    judge: (cardId: number, answer: string) => ipcRenderer.invoke('review:judge', cardId, answer),
    submit: (input: SubmitReview) => ipcRenderer.invoke('review:submit', input),
    sessionGet: () => ipcRenderer.invoke('review:sessionGet'),
    sessionSave: (session: ReviewSession) => ipcRenderer.invoke('review:sessionSave', session),
    sessionClear: () => ipcRenderer.invoke('review:sessionClear')
  },
  exams: {
    list: () => ipcRenderer.invoke('exams:list'),
    create: (input: ExamInput) => ipcRenderer.invoke('exams:create', input),
    update: (id: number, patch) => ipcRenderer.invoke('exams:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('exams:remove', id),
    plan: (id: number) => ipcRenderer.invoke('exams:plan', id)
  },
  stats: {
    dashboard: (deckId?: number | null) => ipcRenderer.invoke('stats:dashboard', deckId)
  },
  search: {
    query: (query: string, sort?: NoteQuery['sort'], deckId?: number | null) =>
      ipcRenderer.invoke('search:query', query, sort, deckId)
  },
  tts: {
    get: (word: string, accent?: 'us' | 'uk') => ipcRenderer.invoke('tts:get', word, accent),
    cacheSize: () => ipcRenderer.invoke('tts:cacheSize'),
    clear: () => ipcRenderer.invoke('tts:clear')
  },
  system: {
    openDataDir: () => ipcRenderer.invoke('system:openDataDir'),
    backup: () => ipcRenderer.invoke('system:backup'),
    appVersion: () => ipcRenderer.invoke('system:appVersion'),
    buildInfo: () => ipcRenderer.invoke('system:buildInfo'),
    reloadWindow: () => ipcRenderer.invoke('system:reloadWindow'),
    restart: () => ipcRenderer.invoke('system:restart'),
    quit: () => ipcRenderer.invoke('system:quit')
  },
  events: {
    onNavigate: (cb: (route: string) => void) => {
      const listener = (_e: unknown, route: string) => cb(route)
      ipcRenderer.on('navigate', listener)
      return () => ipcRenderer.removeListener('navigate', listener)
    },
    onRefresh: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('refresh', listener)
      return () => ipcRenderer.removeListener('refresh', listener)
    },
    onBudgetExhausted: (cb: (info: AiBudgetNotice) => void) => {
      const listener = (_e: unknown, info: AiBudgetNotice) => cb(info)
      ipcRenderer.on('ai:budget', listener)
      return () => ipcRenderer.removeListener('ai:budget', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
