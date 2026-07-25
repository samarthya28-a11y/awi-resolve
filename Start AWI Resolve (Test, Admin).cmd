@echo off
REM ===================================================================
REM  AWI Resolve - local test launcher (ADMINISTRATOR)
REM  Same as the normal test launcher, but runs with admin rights so
REM  the AI can also apply system-level fixes (restart a Windows
REM  service, clear the print queue, repair the clock, etc.).
REM
REM  Double-click this file and click "Yes" on the Windows prompt.
REM  Two small windows open (the AI service + the support agent) - leave
REM  them open while testing. Your browser opens the support window.
REM  To STOP: close the two windows.
REM ===================================================================

REM --- self-elevate: relaunch this script as administrator if needed ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC. Use this launcher on the machine
  echo where the project lives, or use the packaged app in dist\AWI-Resolve.
  pause
  exit /b 1
)

echo Starting the AI service (connector) as administrator...
start "AWI Resolve - AI service (admin)" cmd /k node orchestrator\server.js
timeout /t 3 >nul

echo Starting the support agent as administrator...
start "AWI Resolve - Support agent (admin)" cmd /k node agent\agent.js
timeout /t 4 >nul

echo Opening the support window...
start "" "http://127.0.0.1:8790"

echo.
echo Running with admin rights - system-level fixes are now available.
echo Keep the two windows open while testing; close them to stop.
timeout /t 6 >nul
