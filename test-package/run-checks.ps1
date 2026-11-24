# 一键自检：typecheck / 全部测试 / 构建，并把输出写进本目录的 checks-<时间>.txt。
# 用法（仓库根目录或本目录）：
#   powershell -ExecutionPolicy Bypass -File test-package\run-checks.ps1
param(
  [string]$Repo = 'D:\ymh\Code\tools\wordmemo'
)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $PSScriptRoot "checks-$stamp.txt"
$summary = @()

"WordMemo 0.6.0 sync checks - $stamp" | Out-File -FilePath $log -Encoding utf8
Push-Location $Repo
try {
  foreach ($task in @('typecheck', 'test', 'build')) {
    "`n=== npm run $task ===" | Tee-Object -FilePath $log -Append
    & npm run $task 2>&1 | Tee-Object -FilePath $log -Append
    $code = $LASTEXITCODE
    "EXIT $task = $code" | Tee-Object -FilePath $log -Append
    $summary += "$task : exit $code"
  }
} finally {
  Pop-Location
}

Write-Output ''
Write-Output '=== 结果 ==='
$summary | ForEach-Object { Write-Output $_ }
Write-Output "详细输出：$log"
