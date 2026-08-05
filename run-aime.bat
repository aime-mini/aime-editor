@echo off
rem Launches Aime in dev mode (always the latest build). Close this window to quit the app.
title Aime dev server
cd /d "%~dp0"

rem Rust installs per-user; Explorer may not have refreshed PATH yet after install.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem A busy port 1420 usually means Aime is already open - don't start a second one.
netstat -ano | findstr ":1420" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :port_busy

echo Starting Aime... the app window appears in 15-30 seconds. Keep this window open.
call npm run tauri dev
if %errorlevel% neq 0 (
    echo.
    echo Aime failed to start - see the error above.
    pause
)
exit /b 0

rem The port alone does not prove Aime is open: a bare dev server or the test
rem suite holds it too, and then "look for its window" sends people hunting for
rem a window that is not there.
:port_busy
tasklist /fi "imagename eq ai-mini-editor.exe" | findstr /i "ai-mini-editor" >nul 2>&1
if errorlevel 1 (
    echo Port 1420 is busy, but Aime is not running - something else is holding it.
    echo A leftover "npm run dev" or a test run does this. Close it, then start Aime again.
) else (
    echo Aime is already running - look for its window on your taskbar.
)
echo This window will close in 5 seconds...
timeout /t 5 >nul
exit /b 0
