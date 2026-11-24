# 启动一个测试实例（独立数据目录，不碰真实 %APPDATA%\WordMemo）。
# 由 start-two-devices.ps1 调用；也可以手动：
#   powershell -ExecutionPolicy Bypass -File launch-device.ps1 -DataDir "$env:TEMP\wordmemo-test\device-a"
param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$Repo = 'D:\ymh\Code\tools\wordmemo'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $Repo 'out\main\index.js'))) {
  throw "找不到构建产物：请先在 $Repo 运行 npm run build"
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$env:WORDMEMO_DATA_DIR = $DataDir
# DSH / 某些终端会把 Electron 当成 Node 跑，必须清掉
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location $Repo

& (Join-Path $Repo 'node_modules\electron\dist\electron.exe') . --no-sandbox
