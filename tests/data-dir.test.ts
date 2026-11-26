import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDataDirArg, resolveDataDir } from '../src/main/dataDir'

// E-04：数据目录只有一个入口。
// 改之前：打包版写死 %APPDATA%\WordMemo，而 settings/tts/secretStore 又无条件读
// WORDMEMO_DATA_DIR —— 设了变量会「分裂」（设置挪走、数据库留下），所以冒烟只能碰真库。

const base = {
  isPackaged: true,
  appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
  appPath: 'D:\\app'
}

describe('--data-dir 解析', () => {
  it('支持 = 与空格两种写法，路径按绝对化处理', () => {
    expect(parseDataDirArg(['electron', '.', '--data-dir=C:\\tmp\\wm'])).toBe('C:\\tmp\\wm')
    expect(parseDataDirArg(['electron', '.', '--data-dir', 'C:\\tmp\\wm'])).toBe('C:\\tmp\\wm')
    expect(resolveDataDir({ ...base, argv: ['x', '--data-dir=tmp\\wm'] }).source).toBe('cli')
    expect(resolveDataDir({ ...base, argv: ['x', '--data-dir=tmp\\wm'] }).dir).toBe(
      path.resolve('tmp\\wm')
    )
  })

  it('没有值、或下一个参数是另一个开关，就当没给', () => {
    expect(parseDataDirArg(['x', '--data-dir'])).toBeNull()
    expect(parseDataDirArg(['x', '--data-dir', '--no-sandbox'])).toBeNull()
    expect(parseDataDirArg(['x', '--data-dir='])).toBeNull()
    expect(parseDataDirArg(['x'])).toBeNull()
  })
})

describe('数据目录优先级', () => {
  it('CLI 最优先，打包版也认（冒烟与真实数据隔离）', () => {
    const result = resolveDataDir({
      ...base,
      argv: ['x', '--data-dir=C:\\tmp\\smoke'],
      envDir: 'C:\\tmp\\ignored'
    })
    expect(result).toEqual({ dir: path.resolve('C:\\tmp\\smoke'), source: 'cli' })
  })

  it('打包版默认 %APPDATA%\\WordMemo，且忽略环境变量（避免目录分裂）', () => {
    const result = resolveDataDir({ ...base, argv: ['x'], envDir: 'C:\\tmp\\env' })
    expect(result).toEqual({ dir: path.join(base.appDataDir, 'WordMemo'), source: 'appdata' })
  })

  it('开发模式：环境变量 > 项目 .data', () => {
    expect(resolveDataDir({ ...base, isPackaged: false, argv: ['x'], envDir: 'C:\\tmp\\env' })).toEqual({
      dir: path.resolve('C:\\tmp\\env'),
      source: 'env-dev'
    })
    expect(resolveDataDir({ ...base, isPackaged: false, argv: ['x'] })).toEqual({
      dir: path.join(base.appPath, '.data'),
      source: 'dev-default'
    })
  })
})
