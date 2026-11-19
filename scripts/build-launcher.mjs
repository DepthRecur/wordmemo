// 编译便携版启动器：scripts/Launcher.cs → build/WordMemo.exe（或指定输出路径）。
// 用 Windows 自带的 .NET Framework 4.x 编译器，不引入新依赖，也不需要 SDK。
//
// 用法：
//   node scripts/build-launcher.mjs [输出路径]
//   npm run launcher

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'scripts', 'Launcher.cs')
const icon = path.join(root, 'build', 'icon.ico')
const out = path.resolve(process.argv[2] || path.join(root, 'build', 'WordMemo.exe'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** 找一个能用的 C# 编译器（.NET Framework 4.x 自带） */
function findCsc() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    process.env.CSC_PATH,
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ].filter(Boolean)
  return candidates.find((file) => fs.existsSync(file)) || null
}

const csc = findCsc()
if (!csc) {
  console.error('[launcher] 找不到 csc.exe（.NET Framework 4.x）。')
  console.error('[launcher] Windows 10/11 默认自带；若确实没有，可以用 CSC_PATH 指定绝对路径。')
  process.exit(1)
}

if (!fs.existsSync(source)) {
  console.error('[launcher] 找不到源文件：' + source)
  process.exit(1)
}

fs.mkdirSync(path.dirname(out), { recursive: true })

// 版本/描述写进 exe 属性（资源管理器 → 属性 里能看到），版本来自 package.json
const versionParts = pkg.version
  .split('-')[0]
  .split('.')
  .map((part) => Number.parseInt(part, 10))
  .filter((part) => Number.isFinite(part))
while (versionParts.length < 4) versionParts.push(0)
const assemblyVersion = versionParts.slice(0, 4).join('.')

const assemblyInfo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-launcher-')), 'AssemblyInfo.cs')
fs.writeFileSync(
  assemblyInfo,
  [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("WordMemo 便携版")]',
    '[assembly: AssemblyDescription("WordMemo - 英语笔记背诵工具")]',
    '[assembly: AssemblyCompany("ymh")]',
    '[assembly: AssemblyProduct("WordMemo")]',
    `[assembly: AssemblyFileVersion("${pkg.version}")]`,
    `[assembly: AssemblyInformationalVersion("${pkg.version}")]`,
    `[assembly: AssemblyVersion("${assemblyVersion}")]`,
    ''
  ].join('\n'),
  'utf8'
)

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  // 源码是 UTF-8 无 BOM，不指定代码页会把中文提示编译成乱码
  '/codepage:65001',
  '/out:' + out,
  source,
  assemblyInfo,
  '/r:System.Windows.Forms.dll'
]
if (fs.existsSync(icon)) args.push('/win32icon:' + icon)

try {
  execFileSync(csc, args, { stdio: 'inherit', cwd: root })
} catch {
  console.error('[launcher] 编译失败')
  process.exit(1)
} finally {
  fs.rmSync(path.dirname(assemblyInfo), { recursive: true, force: true })
}

const size = fs.statSync(out).size
console.log(`[launcher] ${path.relative(root, out)} (${(size / 1024).toFixed(1)} KB)`)
