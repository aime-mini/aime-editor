@echo off
rem Launches Aime in dev mode (always the latest build). Close this window to quit the app.
title Aime dev server
cd /d "%~dp0"

rem Rust installs per-user; Explorer may not have refreshed PATH yet after install.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem If the dev server is already up, Aime is already open — don't start a second one.
netstat -ano | findstr ":1420" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Aime is already running - look for its window on your taskbar.
    echo This window will close in 5 seconds...
    timeout /t 5 >nul
    exit /b 0
)

echo Starting Aime... the app window appears in 15-30 seconds. Keep this window open.
call npm run tauri dev
if %errorlevel% neq 0 (
    echo.
    echo Aime failed to start - see the error above.
    pause
)
