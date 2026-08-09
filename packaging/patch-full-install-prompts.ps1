# Hot-patch Program Files Resolve with updated Full-mode install prompts, then restart service.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$InstallTo = Join-Path $env:ProgramFiles 'AWI Resolve'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath) -Wait
  exit $LASTEXITCODE
}

Copy-Item (Join-Path $Root 'orchestrator\ai.js') (Join-Path $InstallTo 'orchestrator\ai.js') -Force
Copy-Item (Join-Path $Root 'orchestrator\server.js') (Join-Path $InstallTo 'orchestrator\server.js') -Force

foreach ($t in @('AWI Resolve Agent','AWI Resolve Service')) {
  try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*AWI Resolve*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$ai = Get-Content -LiteralPath (Join-Path $InstallTo 'orchestrator\ai.js') -Raw
if ($ai -notmatch 'OVERRIDES the Standard/Pro') { throw 'Patch failed - addendum not present' }
Write-Host 'Patched. Full mode will now install off-catalog software via consented PowerShell when asked.' -ForegroundColor Green
