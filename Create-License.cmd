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
echo   2. Incident  - paid 24-hour pass, FULLY loaded incl. deployment
echo   3. Standard  - diagnostics + fixes, no software deployment
echo   4. Pro       - everything including deployment
echo   5. Full      - Pro + consented PowerShell (IT admin must also enable)
echo.
echo   The pass is 24 hours of cover that starts the FIRST time the customer
echo   asks Resolve something - not when you issue it. Its "days" below is how
echo   long the key stays redeemable (default 90), not the length of cover.
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
rem  Subscription plans: days of cover. Incident: days to redeem the pass.

echo.
echo   The next three are optional - press Enter to skip any of them.
echo   They are shown to the customer in the Licence window of their app.
echo.
set /p HOLDER="Allocated to (person)    : "
set /p HEMAIL="Their email              : "
set /p BRAND="Their company display name (blank = customer name above) : "

rem Built up separately so a blank answer does not pass an empty flag through
rem to licgen, which would reject it rather than ignore it.
set EXTRA=
if not "%HOLDER%"=="" set EXTRA=!EXTRA! --licensed-to "%HOLDER%"
if not "%HEMAIL%"=="" set EXTRA=!EXTRA! --licensed-to-email "%HEMAIL%"
if not "%BRAND%"=="" set EXTRA=!EXTRA! --brand-name "%BRAND%"

echo.
if "%DAYS%"=="" (
    node tools\licgen.js --customer "%CUST%" --plan %PLAN% --seats %SEATS% !EXTRA!
) else (
    node tools\licgen.js --customer "%CUST%" --plan %PLAN% --seats %SEATS% --days %DAYS% !EXTRA!
)
if errorlevel 1 ( echo FAILED - tell Claude Code. & pause & exit /b 1 )

echo Give the customer the key above. They open AWI Resolve, paste it into
echo the box at the top of the window and click Activate. Nothing to edit,
echo nothing to restart. A renewed key goes in the same place, or in the
echo Licence window.
echo.
echo Tip: add --customer-id your-org-slug when issuing so PCs map to that
echo organisation's Approved Software Library for IT-admin installs.
echo.
echo The customer's own logo is NOT part of the key - bundle it with
echo packaging\make-customer-package.ps1 -LogoPath their-logo.png, or drop the
echo file into a "branding" folder next to config.json on the PC.
echo.
pause
endlocal
