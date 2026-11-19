// 组装 Windows 便携版：打包 app → 编译启动器 → 写 version.json → zip + sha256。
//
// 产物（都在 release/，已被 gitignore）：
//   release/WordMemo-Portable/            可直接运行的目录（调试用）
//   release/WordMemo-<version>-portable.zip
//   release/WordMemo-<version>-portable.zip.sha256
//
// 用法：npm run dist
//
// 约定见 docs/PLAN-UPDATE.md §3.11：
//   zip 解压后 = WordMemo.exe（启动器）+ app/（electron-builder --dir 产物）+ update/ + README.txt

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDir = path.join(root, 'release')
const unpackedDir = path.join(releaseDir, 'win-unpacked')
const stageDir = path.join(releaseDir, 'WordMemo-Portable')
const zipName = `WordMemo-${version}-portable.zip`
const zipPath = path.join(releaseDir, zipName)
const shaPath = zipPath + '.sha256'

/** 子进程统一用干净的环境：不能把 ELECTRON_RUN_AS_NODE 带进去 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    env: childEnv(options.env)
  })
}

function step(message) {
  console.log('\n=== ' + message + ' ===')
}

// electron-builder 的下载缓存默认在 %LOCALAPPDATA%，本机曾出现无权创建；
// 放进仓库的 .cache/ 后重复打包也更快。注意：.cache 不进 git。
const builderCache = path.join(root, '.cache', 'electron-builder')
fs.mkdirSync(builderCache, { recursive: true })
const env = { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || builderCache }

step(`WordMemo ${version} 便携版`)

step('构建 out/（main / preload / renderer）')
run(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'])

step('打包 app（electron-builder --dir）')
run(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--x64', '--dir'], { env })

if (!fs.existsSync(path.join(unpackedDir, 'WordMemo.exe'))) {
  throw new Error('打包失败：release/win-unpacked/WordMemo.exe 不存在')
}

step('组装便携版目录')
fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(path.join(stageDir, 'app'), { recursive: true })
fs.cpSync(unpackedDir, path.join(stageDir, 'app'), { recursive: true })
fs.mkdirSync(path.join(stageDir, 'update'), { recursive: true })

// PLAN-UPDATE §3.11：构建时写 app/version.json，启动器（U2）据此判断新旧
fs.writeFileSync(
  path.join(stageDir, 'app', 'version.json'),
  JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2) + '\n',
  'utf8'
)

step('编译启动器')
run(process.execPath, [path.join(root, 'scripts', 'build-launcher.mjs'), path.join(stageDir, 'WordMemo.exe')])

step('写 README.txt')
const readmeTemplate = fs.readFileSync(path.join(root, 'scripts', 'portable-README.txt'), 'utf8')
fs.writeFileSync(path.join(stageDir, 'README.txt'), readmeTemplate.replaceAll('{{VERSION}}', version), 'utf8')

for (const required of ['WordMemo.exe', path.join('app', 'WordMemo.exe'), path.join('app', 'version.json'), 'README.txt']) {
  if (!fs.existsSync(path.join(stageDir, required))) throw new Error('便携版缺文件：' + required)
}

step('打 zip')
fs.rmSync(zipPath, { force: true })
// Windows 10/11 自带 bsdtar：用 `-a` 按扩展名选 zip 格式，不依赖 7zip-bin
run('tar.exe', ['-a', '-c', '-f', zipPath, '-C', stageDir, '.'])
const zipEntries = execFileSync('tar.exe', ['-tf', zipPath], { encoding: 'utf8' })
for (const required of ['./WordMemo.exe', './app/version.json', './README.txt']) {
  if (!zipEntries.includes(required)) throw new Error('zip 缺条目：' + required)
}

step('算 sha256')
const hash = await new Promise((resolve, reject) => {
  const sha = crypto.createHash('sha256')
  createReadStream(zipPath)
    .on('data', (chunk) => sha.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(sha.digest('hex')))
})
fs.writeFileSync(shaPath, `${hash}  ${zipName}\n`, 'utf8')

const zipSize = fs.statSync(zipPath).size
console.log('\n完成：')
console.log('  目录  ' + path.relative(root, stageDir))
console.log('  zip   ' + path.relative(root, zipPath) + `  (${(zipSize / 1024 / 1024).toFixed(1)} MB)`)
console.log('  sha   ' + hash)
