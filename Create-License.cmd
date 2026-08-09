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
echo   1. Trial     - everything, short expiry  (default 15 days)
echo   2. Standard  - diagnostics + fixes, no software deployment
echo   3. Pro       - everything including deployment
echo   4. Full      - Pro + consented PowerShell (IT admin must also enable)
echo.
set /p PLANNO="Plan [1/2/3/4]           : "
if "%PLANNO%"=="1" set PLAN=trial
if "%PLANNO%"=="2" set PLAN=standard
if "%PLANNO%"=="3" set PLAN=pro
if "%PLANNO%"=="4" set PLAN=full
if "%PLAN%"=="" ( echo Pick 1, 2, 3 or 4. & pause & exit /b 1 )

set /p SEATS="Number of PCs (seats)    : "
if "%SEATS%"=="" set SEATS=1

set /p DAYS="Valid for how many days  : "
if "%DAYS%"=="" ( if "%PLAN%"=="trial" ( set DAYS=15 ) else ( set DAYS=365 ) )

echo.
node tools\licgen.js --customer "%CUST%" --plan %PLAN% --seats %SEATS% --days %DAYS%
if errorlevel 1 ( echo FAILED - tell Claude Code. & pause & exit /b 1 )

echo Give the customer the key above. They paste it into "licenseKey"
echo in config.json next to the installed app, then restart Resolve.
echo.
echo Tip: add --customer-id your-org-slug when issuing so PCs map to that
echo organisation's Approved Software Library for IT-admin installs.
echo.
pause
endlocal
