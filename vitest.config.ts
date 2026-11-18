import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      electron: resolve('tests/electron-mock.ts')
    }
  },
  ssr: {
    external: ['node:sqlite']
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    server: {
      deps: {
        external: ['node:sqlite']
      }
    }
  }
})
