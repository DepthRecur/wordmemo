# 清掉本机两个测试实例的数据（%TEMP%\wordmemo-test）。不可恢复，需要输入 yes。
$target = Join-Path $env:TEMP 'wordmemo-test'
if (-not (Test-Path $target)) {
  Write-Output "没有本地测试数据：$target"
  exit 0
}
Write-Output "将删除：$target"
$answer = Read-Host '确认删除？输入 yes 继续'
if ($answer -ne 'yes') {
  Write-Output '已取消'
  exit 0
}
Remove-Item $target -Recurse -Force
Write-Output '已删除。'
