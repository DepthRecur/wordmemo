#!/usr/bin/env node
/**
 * 真机冒烟：4 个调用点（结构化 / 校验 / 判分 / 音标）× 4 家供应商。
 * 没有 Key 的家输出 `SKIP（无 Key）`，不会失败。
 *
 * 为什么不是纯 node 脚本：Key 是用 Windows DPAPI（Electron safeStorage）加密存在
 * `%APPDATA%\WordMemo\secrets.v2.json` 的，只有 Electron 主进程能解。
 * 所以这里只是启动应用并带上 `--ai-smoke`。
 *
 * 用法：
 *   npm run ai-smoke          # 等价于 node scripts/ai-smoke.mjs
 *   打好的便携版：WordMemo.exe --ai-smoke
 *
 * 注意：会用真实 Key 真发 4 次（每家）很短的请求，会计入本月费用。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// electron 包的入口导出的就是可执行文件路径（字符串）
const electronPath = require('electron')

const env = { ...process.env }
// 这个环境变量会让 Electron 退化成 node（报 isPackaged undefined），必须去掉
delete env.ELECTRON_RUN_AS_NODE

const args = ['.', '--ai-smoke', '--no-sandbox']
const child = spawn(typeof electronPath === 'string' ? electronPath : String(electronPath), args, {
  stdio: 'inherit',
  env
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
child.on('error', (err) => {
  console.error(`启动 Electron 失败：${err.message}`)
  process.exit(1)
})
