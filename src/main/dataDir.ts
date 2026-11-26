import path from 'node:path'

/**
 * 数据目录的解析（E-04）。
 *
 * 背景：打包版原来写死 `%APPDATA%\WordMemo`，而 `settings.ts` / `media/tts.ts` /
 * `sync/secretStore.ts` 又不带条件地读 `WORDMEMO_DATA_DIR`。于是「用临时数据目录冒烟」
 * 要么做不到（打包版忽略变量），要么更糟——设了变量之后设置/密钥挪走了、数据库留在原地，
 * **数据目录分裂**。2026-11-24 发版冒烟就因此把真实库迁移到了 v4。
 *
 * 现在只有一个入口：CLI `--data-dir=<绝对路径>`；解析结果由 index.ts 统一写回
 * `process.env.WORDMEMO_DATA_DIR`，所有模块读到的都是同一个目录。
 */

export const DATA_DIR_SWITCH = '--data-dir'

export type DataDirSource = 'cli' | 'env-dev' | 'dev-default' | 'appdata'

export interface DataDirInput {
  argv: string[]
  isPackaged: boolean
  /** `app.getPath('appData')`，即 %APPDATA% */
  appDataDir: string
  /** `app.getAppPath()`，开发模式下的项目根 */
  appPath: string
  /** 环境变量里的 `WORDMEMO_DATA_DIR`（只对开发模式生效） */
  envDir?: string
}

export interface DataDirResult {
  dir: string
  source: DataDirSource
}

/** 取 `--data-dir=<路径>` 或 `--data-dir <路径>`；没有返回 null */
export function parseDataDirArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === DATA_DIR_SWITCH) {
      const next = argv[i + 1]
      // 下一个参数是另一个开关就当没给，别把 `--no-sandbox` 当路径
      if (next && !next.startsWith('--')) return next.trim() || null
      return null
    }
    if (arg.startsWith(`${DATA_DIR_SWITCH}=`)) {
      const value = arg.slice(DATA_DIR_SWITCH.length + 1).trim()
      return value || null
    }
  }
  return null
}

export function resolveDataDir(input: DataDirInput): DataDirResult {
  const fromCli = parseDataDirArg(input.argv)
  // CLI 优先，打包版也认（冒烟/多实例测试就靠它和真实数据隔离）
  if (fromCli) return { dir: path.resolve(fromCli), source: 'cli' }
  if (!input.isPackaged) {
    const dev = input.envDir?.trim()
    if (dev) return { dir: path.resolve(dev), source: 'env-dev' }
    return { dir: path.join(input.appPath, '.data'), source: 'dev-default' }
  }
  return { dir: path.join(input.appDataDir, 'WordMemo'), source: 'appdata' }
}
