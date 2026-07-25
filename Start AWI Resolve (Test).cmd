@echo off
REM ===================================================================
REM  AWI Resolve - local test launcher (everything runs on THIS PC)
REM  Double-click this file. Two small black windows will open (the AI
REM  service and the support agent) - leave them open while testing.
REM  Your browser then opens the support window. Describe a problem and
REM  the AI technician will help, asking before it changes anything.
REM
REM  To STOP testing: close the two black windows.
REM ===================================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo This launcher is for the machine where the project lives (it has Node).
  echo On a different PC, use the packaged app in dist\AWI-Resolve instead.
  pause
  exit /b 1
)

echo Starting the AI service (connector)...
start "AWI Resolve - AI service" cmd /k node orchestrator\server.js

echo Waiting a moment...
timeout /t 3 >nul

echo Starting the support agent...
start "AWI Resolve - Support agent" cmd /k node agent\agent.js

echo Waiting for things to come up...
timeout /t 4 >nul

echo Opening the support window in your browser...
start "" "http://127.0.0.1:8790"

echo.
echo Done. Use the support window that just opened.
echo Keep the two black windows open while testing; close them to stop.
timeout /t 6 >nul
