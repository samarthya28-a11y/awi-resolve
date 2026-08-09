# AWI Resolve — installer. Double-click "Install AWI Resolve.cmd" (or right-click
# this file -> Run with PowerShell). It self-elevates: you'll see one Windows
# "Do you want to allow changes?" prompt — click Yes.
#
# What it does:
#   1. Copies the app to C:\Program Files\AWI Resolve
#   2. Registers it to auto-start at logon, WITH the rights needed to apply fixes
#   3. Adds "AWI Resolve Support" shortcuts (Desktop + Start Menu)
#   4. Starts it now so support is available immediately

$ErrorActionPreference = 'Stop'
$AppName   = 'AWI Resolve'
$TaskName  = 'AWI Resolve Agent'
$SvcTaskName = 'AWI Resolve Service'
$InstallTo = Join-Path $env:ProgramFiles $AppName
$UiUrl     = 'http://127.0.0.1:8790'

# --- self-elevate ------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Requesting administrator permission...'
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  )
  return
}

$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Installing $AppName from $Src" -ForegroundColor Cyan

# --- 1. copy files -----------------------------------------------------------
if (Test-Path $InstallTo) {
  # stop a previous instance before overwriting
  foreach ($t in @($TaskName, $SvcTaskName)) {
    try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch {}
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$AppName*agent.js*" -or
                   $_.CommandLine -like "*$AppName*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}
New-Item -ItemType Directory -Force -Path $InstallTo | Out-Null
Copy-Item -Path (Join-Path $Src '*') -Destination $InstallTo -Recurse -Force
Write-Host '  files copied' -ForegroundColor Green

# --- 2. auto-start scheduled task (elevated, in the user session) -------------
$vbs     = Join-Path $InstallTo 'run-agent-hidden.vbs'
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $InstallTo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$who     = "$env:USERDOMAIN\$env:USERNAME"
$princ   = New-ScheduledTaskPrincipal -UserId $who -RunLevel Highest -LogonType Interactive
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $princ -Settings $set -Force -Description 'Runs the AWI Resolve support agent.' | Out-Null
Write-Host '  auto-start registered (runs with fix permissions)' -ForegroundColor Green

# --- 2b. support service, for self-hosted installs ---------------------------
# If this PC is pointed at its own service (localhost) rather than a hosted
# connector, the service has to run here too — otherwise the support window
# opens but reports itself offline, which is what a customer actually sees.
$cfgFile = Join-Path $InstallTo 'config.json'
$orchUrl = try { (Get-Content $cfgFile -Raw | ConvertFrom-Json).orchestratorUrl } catch { '' }
$selfHosted = $orchUrl -match '127\.0\.0\.1|localhost'
if ($selfHosted) {
  $key = $env:ANTHROPIC_API_KEY
  if (-not $key) {
    $existing = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
    if ($existing) { $key = $existing }
  }
  if (-not $key) {
    Write-Host ''
    Write-Host '  This PC runs its own support service, which needs an API key.' -ForegroundColor Yellow
    Write-Host '  Paste it now, or press Enter to skip (support will stay offline).' -ForegroundColor Yellow
    $key = (Read-Host '  ANTHROPIC_API_KEY').Trim()
  }
  if ($key) {
    # User-scoped, NOT machine-scoped: the task runs as this user, so this is
    # enough for it to see the key at logon, and it keeps the secret out of
    # reach of every other account on the PC. (On a real customer endpoint the
    # key should not be here at all — point the agent at the hosted connector.)
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $key, 'User')
    # The User-scoped variable only reaches processes started AFTER the next
    # logon. Set it in this session too, or the service we launch in step 4
    # starts key-less and falls back to the no-AI demo path on first install.
    $env:ANTHROPIC_API_KEY = $key
    $ovbs   = Join-Path $InstallTo 'run-orchestrator-hidden.vbs'
    $oact   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$ovbs`"" -WorkingDirectory $InstallTo
    $oprinc = New-ScheduledTaskPrincipal -UserId $who -RunLevel Highest -LogonType Interactive
    Register-ScheduledTask -TaskName $SvcTaskName -Action $oact -Trigger $trigger `
      -Principal $oprinc -Settings $set -Force `
      -Description 'Runs the AWI Resolve support service (self-hosted installs).' | Out-Null
    Write-Host '  support service registered to start automatically' -ForegroundColor Green
  } else {
    Write-Host '  SKIPPED: no API key, so the support window will report itself offline.' -ForegroundColor Yellow
  }
} else {
  Write-Host "  using hosted support service ($orchUrl) - nothing to start here" -ForegroundColor Green
}

# --- 3. shortcuts ------------------------------------------------------------
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$useEdge = Test-Path $edge
$sh = New-Object -ComObject WScript.Shell
$iconPath = Join-Path $InstallTo 'awi-resolve.ico'
# The shortcut launches Edge in app mode, so without an explicit IconLocation
# Windows shows EDGE's icon in Search and the Start menu, not ours. Treat a
# missing icon as a real problem rather than silently shipping Edge branding.
if (-not (Test-Path $iconPath)) {
  Write-Host '  WARNING: awi-resolve.ico missing - shortcuts would show the browser icon.' -ForegroundColor Yellow
}
foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                   (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'AWI Resolve Support.lnk'))
  if ($useEdge) { $lnk.TargetPath = $edge; $lnk.Arguments = "--app=$UiUrl" }
  else          { $lnk.TargetPath = $UiUrl }
  $lnk.Description = 'Open the AWI Resolve support window'
  if (Test-Path $iconPath) { $lnk.IconLocation = "$iconPath,0" }   # product mark
  $lnk.Save()
}
Write-Host '  shortcuts created (Desktop + Start Menu)' -ForegroundColor Green

# Windows caches shortcut icons aggressively; without this the old (Edge) icon
# keeps showing in Search and Start until the cache happens to rebuild.
try {
  ie4uinit.exe -show 2>$null
  Write-Host '  icon cache refreshed' -ForegroundColor Green
} catch {}

# --- 4. start now ------------------------------------------------------------
# Service first, then the agent, so the agent's first connection attempt lands
# on a service that is already listening rather than retrying for 3 seconds.
if ($selfHosted -and $key) {
  Start-Process wscript.exe -ArgumentList "`"$(Join-Path $InstallTo 'run-orchestrator-hidden.vbs')`"" -WorkingDirectory $InstallTo
  Start-Sleep -Seconds 2
}
Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WorkingDirectory $InstallTo
Start-Sleep -Seconds 2
Write-Host ''
Write-Host "$AppName is installed and running." -ForegroundColor Cyan
Write-Host "Open support any time from the 'AWI Resolve Support' shortcut, or visit $UiUrl"
Write-Host ''
Read-Host 'Press Enter to close'
