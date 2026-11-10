@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\android-build.ps1" -Task :app:assembleRelease
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)
explorer.exe "%~dp0app\build\outputs\apk\release"
pause
