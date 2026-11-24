# 本机开两个 WordMemo 实例当「两台设备」（不需要 VM）。
# 两个实例各用 %TEMP%\wordmemo-test 下的独立数据目录，互不影响，也不碰真实数据。
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File test-package\start-two-devices.ps1
#   powershell -ExecutionPolicy Bypass -File test-package\start-two-devices.ps1 -Rebuild
param(
  [string]$Repo = 'D:\ymh\Code\tools\wordmemo',
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
Set-Location $Repo

if ($Rebuild) {
  Write-Output '重新构建...'
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
}
if (-not (Test-Path (Join-Path $Repo 'out\main\index.js'))) {
  throw '找不到 out\main\index.js：先运行 npm run build（或加 -Rebuild）'
}

$root = Join-Path $env:TEMP 'wordmemo-test'
$devices = @(
  @{ Name = 'A'; Dir = (Join-Path $root 'device-a') },
  @{ Name = 'B'; Dir = (Join-Path $root 'device-b') }
)
foreach ($device in $devices) {
  New-Item -ItemType Directory -Force -Path $device.Dir | Out-Null
}

$launcher = Join-Path $PSScriptRoot 'launch-device.ps1'
foreach ($device in $devices) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -DataDir `"$($device.Dir)`" -Repo `"$Repo`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments | Out-Null
  Write-Output "设备 $($device.Name) 已启动，数据目录：$($device.Dir)"
  Start-Sleep -Seconds 2
}

Write-Output ''
Write-Output '两个实例都连同一个测试仓库、同一个同步密码。'
Write-Output '测完运行 reset-local-test-data.ps1 清理。'
