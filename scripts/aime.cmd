@echo off
rem Aime CLI launcher: `aime [folder]` opens Aime (dev) at the folder (default: current dir).
rem If the dev server is already up, only a new app process is started against it;
rem otherwise the full dev stack (Vite + cargo) is launched in its own window.
setlocal
set "REPO=%~dp0.."

if "%~1"=="" (set "TARGET=%CD%") else (set "TARGET=%~f1")
if not exist "%TARGET%\" (
    echo [aime] Folder not found: %TARGET%
    exit /b 1
)

rem Rust installs per-user; Explorer may not have refreshed PATH yet after install.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem Dev server already listening? Then the debug exe can attach to it directly.
netstat -ano | findstr ":1420" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    if not exist "%REPO%\src-tauri\target\debug\ai-mini-editor.exe" (
        echo [aime] Dev server is up but the debug build is missing - run run-aime.bat first.
        exit /b 1
    )
    start "" "%REPO%\src-tauri\target\debug\ai-mini-editor.exe" "%TARGET%"
    exit /b 0
)

echo [aime] Starting Aime at "%TARGET%"... the window appears in 15-30 seconds.
start "Aime dev server" cmd /c "cd /d "%REPO%" && npm run tauri dev -- -- "%TARGET%" || pause"
exit /b 0
