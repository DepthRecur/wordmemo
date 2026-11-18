import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ExamInput,
  ImportDraftPatch,
  Item,
  NoteInput,
  NoteQuery,
  ReviewMode,
  SettingsPatch,
  SubmitReview,
  WordmemoApi
} from '@shared/types'

const api: WordmemoApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: SettingsPatch) => ipcRenderer.invoke('settings:update', patch),
    setApiKey: (key: string) => ipcRenderer.invoke('settings:setApiKey', key),
    clearApiKey: () => ipcRenderer.invoke('settings:clearApiKey'),
    testApiKey: () => ipcRenderer.invoke('settings:testApiKey')
  },
  notes: {
    list: (query?: NoteQuery) => ipcRenderer.invoke('notes:list', query),
    get: (id: number) => ipcRenderer.invoke('notes:get', id),
    create: (input: NoteInput) => ipcRenderer.invoke('notes:create', input),
    update: (id: number, patch: Partial<NoteInput>) => ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('notes:remove', id)
  },
  items: {
    list: (query?: { search?: string }) => ipcRenderer.invoke('items:list', query),
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
    parse: (paths: string[]) => ipcRenderer.invoke('importer:parse', paths),
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
    daily: () => ipcRenderer.invoke('review:daily'),
    learn: (itemId: number, known: boolean) => ipcRenderer.invoke('review:learn', itemId, known),
    queue: (mode?: ReviewMode, examId?: number) => ipcRenderer.invoke('review:queue', mode, examId),
    judge: (cardId: number, answer: string) => ipcRenderer.invoke('review:judge', cardId, answer),
    submit: (input: SubmitReview) => ipcRenderer.invoke('review:submit', input)
  },
  exams: {
    list: () => ipcRenderer.invoke('exams:list'),
    create: (input: ExamInput) => ipcRenderer.invoke('exams:create', input),
    update: (id: number, patch) => ipcRenderer.invoke('exams:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('exams:remove', id),
    plan: (id: number) => ipcRenderer.invoke('exams:plan', id)
  },
  stats: {
    dashboard: () => ipcRenderer.invoke('stats:dashboard')
  },
  search: {
    query: (query: string, sort?: NoteQuery['sort']) => ipcRenderer.invoke('search:query', query, sort)
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
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
