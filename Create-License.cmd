@echo off
rem === AWI Resolve License Manager (Alpha Web INTERNAL - never give to clients) ===
rem Issues a signed licence key to paste into a customer's Resolve config.
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "tools\licensing-key.pem" (
    echo No signing key found. Creating one now - this happens once.
    node tools\licgen.js --init
    if errorlevel 1 ( echo FAILED - tell Claude Code. & pause & exit /b 1 )
    echo.
)

echo ============================================
echo   AWI Resolve - issue a customer licence
echo ============================================
echo.
set /p CUST="Customer name            : "
if "%CUST%"=="" ( echo A customer name is required. & pause & exit /b 1 )

echo.
echo   1. Trial     - everything except consented PowerShell (default 15 days)
echo   2. Incident  - paid 24-hour pass, Standard capabilities (default 1 day)
echo   3. Standard  - diagnostics + fixes, no software deployment
echo   4. Pro       - everything including deployment
echo   5. Full      - Pro + consented PowerShell (IT admin must also enable)
echo.
set /p PLANNO="Plan [1/2/3/4/5]         : "
if "%PLANNO%"=="1" set PLAN=trial
if "%PLANNO%"=="2" set PLAN=incident
if "%PLANNO%"=="3" set PLAN=standard
if "%PLANNO%"=="4" set PLAN=pro
if "%PLANNO%"=="5" set PLAN=full
if "%PLAN%"=="" ( echo Pick 1, 2, 3, 4 or 5. & pause & exit /b 1 )

set /p SEATS="Number of PCs (seats)    : "
if "%SEATS%"=="" set SEATS=1

rem Blank = let licgen apply the per-plan default (trial 15, incident 1, else 365).
set /p DAYS="Valid for how many days  : "

echo.
if "%DAYS%"=="" (
    node tools\licgen.js --customer "%CUST%" --plan %PLAN% --seats %SEATS%
) else (
    node tools\licgen.js --customer "%CUST%" --plan %PLAN% --seats %SEATS% --days %DAYS%
)
if errorlevel 1 ( echo FAILED - tell Claude Code. & pause & exit /b 1 )

echo Give the customer the key above. They paste it into "licenseKey"
echo in config.json next to the installed app, then restart Resolve.
echo.
echo Tip: add --customer-id your-org-slug when issuing so PCs map to that
echo organisation's Approved Software Library for IT-admin installs.
echo.
pause
endlocal
