import { createRequire } from 'node:module'

/**
 * Vite/Vitest 的 builtin 列表还没有包含实验性的 node:sqlite，
 * 用 createRequire 在运行时加载，避免被静态解析成裸模块 "sqlite"。
 */
const nodeRequire = createRequire(process.execPath)
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite')

export const DatabaseSync = sqlite.DatabaseSync
export type SqliteDatabase = InstanceType<typeof sqlite.DatabaseSync>
