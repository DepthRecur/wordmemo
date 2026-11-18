@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
"%CSC%" /nologo /target:winexe /out:WordMemo.exe /win32icon:build\icon.ico /r:System.Windows.Forms.dll scripts\Launcher.cs
if errorlevel 1 pause
