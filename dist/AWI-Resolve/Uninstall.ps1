# AWI Resolve — uninstaller. Self-elevates (one "Yes" prompt), then removes the
# app, its auto-start entry, and shortcuts.
$ErrorActionPreference = 'SilentlyContinue'
$AppName   = 'AWI Resolve'
$TaskName  = 'AWI Resolve Agent'
$SvcTaskName = 'AWI Resolve Service'
$InstallTo = Join-Path $env:ProgramFiles $AppName

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  return
}

# stop it, remove auto-start (agent + the self-hosted support service)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Unregister-ScheduledTask -TaskName $SvcTaskName -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$AppName*agent.js*" -or
                 $_.CommandLine -like "*$AppName*server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# remove shortcuts
foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                   (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))) {
  Remove-Item (Join-Path $dir 'AWI Resolve Support.lnk') -Force
}

# remove files
Remove-Item $InstallTo -Recurse -Force

Write-Host "$AppName has been removed." -ForegroundColor Cyan
Read-Host 'Press Enter to close'
