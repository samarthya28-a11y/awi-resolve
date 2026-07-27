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
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$AppName*agent.js*" } |
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

# --- 3. shortcuts ------------------------------------------------------------
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$useEdge = Test-Path $edge
$sh = New-Object -ComObject WScript.Shell
$iconPath = Join-Path $InstallTo 'awi-resolve.ico'
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

# --- 4. start now ------------------------------------------------------------
Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WorkingDirectory $InstallTo
Start-Sleep -Seconds 2
Write-Host ''
Write-Host "$AppName is installed and running." -ForegroundColor Cyan
Write-Host "Open support any time from the 'AWI Resolve Support' shortcut, or visit $UiUrl"
Write-Host ''
Read-Host 'Press Enter to close'
