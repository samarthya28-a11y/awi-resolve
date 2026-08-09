# Patch the installed AWI Resolve under Program Files with the current
# project build (shared-manual auto-install + related fixes), then restart.
# Run elevated: right-click -> Run with PowerShell, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\patch-live-install.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$InstallTo = Join-Path $env:ProgramFiles 'AWI Resolve'
if (-not (Test-Path $InstallTo)) {
  Write-Host "No install at $InstallTo — nothing to patch." -ForegroundColor Yellow
  exit 1
}

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

Write-Host "Patching $InstallTo from $Root" -ForegroundColor Cyan
foreach ($t in @('AWI Resolve Agent', 'AWI Resolve Service')) {
  try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*AWI Resolve*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($port in 8787, 8790) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

Copy-Item "$Root\agent\*.js" "$InstallTo\agent\" -Force
Copy-Item "$Root\orchestrator\*.js" "$InstallTo\orchestrator\" -Force
Copy-Item "$Root\orchestrator\ui" "$InstallTo\orchestrator\ui" -Recurse -Force
if (Test-Path "$Root\orchestrator\licensing-key.pub") {
  Copy-Item "$Root\orchestrator\licensing-key.pub" "$InstallTo\orchestrator\" -Force
}

# Keep transitive runtime deps in sync (shared-manual path uses the same download stack).
$mods = @('ws','@anthropic-ai','standardwebhooks','@stablelib','fast-sha256','json-schema-to-ts','@babel','ts-algebra')
foreach ($m in $mods) {
  $src = Join-Path $Root "node_modules\$m"
  if (Test-Path $src) {
    $dest = Join-Path $InstallTo "node_modules\$m"
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $src $dest -Recurse -Force
  }
}

$key = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
if ($key) {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText((Join-Path $InstallTo '.env'), "ANTHROPIC_API_KEY=$key`r`n", $utf8)
}

Start-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Host 'Patched and restarted. Open AWI Resolve Support and try again.' -ForegroundColor Green
