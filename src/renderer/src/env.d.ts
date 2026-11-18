import type { WordmemoApi } from '@shared/types'

declare global {
  interface Window {
    api: WordmemoApi
  }
}

export {}
