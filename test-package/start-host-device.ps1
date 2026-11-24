# 启动「本机这台」测试实例（数据目录固定为 %TEMP%\wordmemo-test\host，不碰真实数据）。
# VM 验收时本机只需要这一个窗口；关掉了就再跑一次，连接状态会保留。
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File test-package\start-host-device.ps1
param(
  [string]$Repo = 'D:\ymh\Code\tools\wordmemo'
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:TEMP 'wordmemo-test\host'
Write-Output "本机测试实例数据目录：$dataDir"
& (Join-Path $PSScriptRoot 'launch-device.ps1') -DataDir $dataDir -Repo $Repo
