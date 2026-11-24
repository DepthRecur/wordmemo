# 组装测试包：把说明、清单、脚本、测试指南和便携版 zip 放进 release/ 下的一个 zip。
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File test-package\build-package.ps1
param(
  [string]$Repo = 'D:\ymh\Code\tools\wordmemo',
  [string]$Version = '0.6.0'
)

$ErrorActionPreference = 'Stop'
$release = Join-Path $Repo 'release'
$portable = Join-Path $release "WordMemo-$Version-portable.zip"
if (-not (Test-Path $portable)) {
  throw "缺少便携版：$portable（先运行 npm run dist）"
}

$stage = Join-Path $release "WordMemo-sync-test-package-$Version"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$files = @(
  'README.md',
  'checklist.md',
  'report-template.md',
  'launch-device.ps1',
  'start-two-devices.ps1',
  'run-checks.ps1',
  'reset-local-test-data.ps1'
)
foreach ($file in $files) {
  Copy-Item (Join-Path $PSScriptRoot $file) $stage
}
Copy-Item (Join-Path $Repo 'docs\TEST-SYNC.md') $stage
Copy-Item $portable $stage

$zip = Join-Path $release "WordMemo-sync-test-package-$Version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Fastest

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output "测试包：$zip（$size MB）"
Write-Output "目录：$stage"
