# Elevate live install to Full IT Support (consented PowerShell + org gate on).
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$InstallTo = Join-Path $env:ProgramFiles 'AWI Resolve'
$LicFile = Join-Path $PSScriptRoot 'full-license-key.txt'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Requesting administrator permission...'
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
  ) -Wait
  exit $LASTEXITCODE
}

if (-not (Test-Path $InstallTo)) {
  Write-Host "No install at $InstallTo" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $LicFile)) {
  Write-Host "Missing $LicFile - generate a Full licence first." -ForegroundColor Red
  exit 1
}
$lic = (Get-Content -LiteralPath $LicFile -Raw).Trim()

$libDir = Join-Path $Root 'orchestrator\data\org-libraries'
New-Item -ItemType Directory -Force -Path $libDir | Out-Null
$libPath = Join-Path $libDir 'alpha-web.json'
$libObj = [ordered]@{
  customerId = 'alpha-web'
  name = 'Alpha Web'
  allowFullItSupport = $true
  settingsUpdatedBy = 'local-full-upgrade'
  updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  packages = @()
}
$utf8 = New-Object System.Text.UTF8Encoding $false
$nl = [Environment]::NewLine
[System.IO.File]::WriteAllText($libPath, (($libObj | ConvertTo-Json -Depth 6) + $nl), $utf8)

Write-Host 'Stopping Resolve tasks/processes...' -ForegroundColor Cyan
foreach ($t in @('AWI Resolve Agent', 'AWI Resolve Service')) {
  try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*AWI Resolve*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($port in 8787, 8790) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

Write-Host "Copying Full IT Support code into $InstallTo ..." -ForegroundColor Cyan
Copy-Item (Join-Path $Root 'agent\*.js') (Join-Path $InstallTo 'agent\') -Force
Copy-Item (Join-Path $Root 'orchestrator\*.js') (Join-Path $InstallTo 'orchestrator\') -Force
Copy-Item (Join-Path $Root 'orchestrator\ui') (Join-Path $InstallTo 'orchestrator\ui') -Recurse -Force
$pub = Join-Path $Root 'orchestrator\licensing-key.pub'
if (Test-Path $pub) {
  Copy-Item $pub (Join-Path $InstallTo 'orchestrator\') -Force
}

$destData = Join-Path $InstallTo 'orchestrator\data'
New-Item -ItemType Directory -Force -Path (Join-Path $destData 'org-libraries') | Out-Null
Copy-Item $libPath (Join-Path $destData 'org-libraries\alpha-web.json') -Force
$tokens = Join-Path $Root 'orchestrator\data\admin-tokens.json'
if (Test-Path $tokens) {
  Copy-Item $tokens (Join-Path $destData 'admin-tokens.json') -Force
}

$mods = @('ws', '@anthropic-ai', 'standardwebhooks', '@stablelib', 'fast-sha256', 'json-schema-to-ts', '@babel', 'ts-algebra')
foreach ($m in $mods) {
  $src = Join-Path $Root "node_modules\$m"
  if (Test-Path $src) {
    $dest = Join-Path $InstallTo "node_modules\$m"
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $src $dest -Recurse -Force
  }
}

$cfgPath = Join-Path $InstallTo 'config.json'
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.licenseKey = $lic
if (-not $cfg.PSObject.Properties['customerId']) {
  $cfg | Add-Member -NotePropertyName customerId -NotePropertyValue 'alpha-web'
} else {
  $cfg.customerId = 'alpha-web'
}
[System.IO.File]::WriteAllText($cfgPath, (($cfg | ConvertTo-Json -Depth 8) + $nl), $utf8)

$key = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
$envLines = New-Object System.Collections.Generic.List[string]
if ($key) { [void]$envLines.Add("ANTHROPIC_API_KEY=$key") }
[void]$envLines.Add('RESOLVE_DEFAULT_CUSTOMER_ID=alpha-web')
$envText = [string]::Join($nl, $envLines.ToArray()) + $nl
[System.IO.File]::WriteAllText((Join-Path $InstallTo '.env'), $envText, $utf8)

$tools = Get-Content -LiteralPath (Join-Path $InstallTo 'agent\tools.js') -Raw
if ($tools -notmatch 'run_powershell') { throw 'Patch failed: run_powershell missing from agent tools' }
$licJs = Get-Content -LiteralPath (Join-Path $InstallTo 'orchestrator\licensing.js') -Raw
if ($licJs -notmatch 'fullSupport:\s*true') { throw 'Patch failed: full plan missing from licensing.js' }

Start-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host ''
Write-Host 'DONE - Full IT Support is active on this PC.' -ForegroundColor Green
Write-Host '  Licence plan : full'
Write-Host '  Org          : alpha-web (allowFullItSupport=true)'
Write-Host '  Capability   : consented PowerShell for legitimate IT / installs'
Write-Host '  Still refused: illegitimate asks'
Write-Host 'Open AWI Resolve Support and try a real IT request.'
