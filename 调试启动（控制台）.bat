@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo 正在以调试模式启动 WordMemo...
echo 如果窗口没有出现，下面的输出会保留在这个窗口里。
"node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
echo exit=%errorlevel%
pause
