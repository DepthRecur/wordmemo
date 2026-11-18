# 用法: Invoke-Expression (Get-Content .\scripts\ocr-lab\env.ps1 -Raw)
# 解出本机 DeepSeek Key 放进 $env:DEEPSEEK_KEY，不打印明文。
Add-Type -AssemblyName System.Security
$__data = if ($env:WORDMEMO_DATA_DIR) { $env:WORDMEMO_DATA_DIR } else { Join-Path (Get-Location) '.data' }
$__ls = Get-Content (Join-Path $__data 'Local State') -Raw | ConvertFrom-Json
$__blob = [Convert]::FromBase64String($__ls.os_crypt.encrypted_key)
$__master = [System.Security.Cryptography.ProtectedData]::Unprotect($__blob[5..($__blob.Length - 1)], $null, 'CurrentUser')
$env:DSH_MASTER_KEY = (($__master | ForEach-Object { $_.ToString('x2') }) -join '')
$env:DEEPSEEK_KEY = (node (Join-Path (Get-Location) 'scripts\ocr-lab\getkey.mjs')).Trim()
Remove-Variable __data, __ls, __blob, __master -ErrorAction SilentlyContinue
