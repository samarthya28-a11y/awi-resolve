$ErrorActionPreference = 'Stop'
$log = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\fix-result.txt'
$pf = 'C:\Program Files\AWI Resolve'
$src = 'C:\Users\ASUS\Projects\awi-resolve\node_modules'
$mods = @('standardwebhooks','@stablelib','fast-sha256','json-schema-to-ts','@babel','ts-algebra','@anthropic-ai','ws')

"=== $(Get-Date -Format o) patching missing modules ===" | Out-File $log

# Stop running Resolve processes on our ports
foreach ($port in 8787,8790) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    "kill PID $($_.OwningProcess) on $port" | Out-File $log -Append
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Stop-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
Start-Sleep 2

New-Item -ItemType Directory -Force -Path "$pf\node_modules" | Out-Null
foreach ($m in $mods) {
  $from = Join-Path $src $m
  $to = Join-Path "$pf\node_modules" $m
  if (-not (Test-Path $from)) { "MISSING SOURCE $m" | Out-File $log -Append; continue }
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
  "copied $m" | Out-File $log -Append
}

# Keep existing licence; copy pub key + updated orchestrator/agent from project
Copy-Item 'C:\Users\ASUS\Projects\awi-resolve\orchestrator\licensing-key.pub' "$pf\orchestrator\licensing-key.pub" -Force
Copy-Item 'C:\Users\ASUS\Projects\awi-resolve\orchestrator\*.js' "$pf\orchestrator\" -Force
Copy-Item 'C:\Users\ASUS\Projects\awi-resolve\agent\*.js' "$pf\agent\" -Force

# Smoke-test require with bundled node
$probe = & "$pf\node.exe" -e "try{require('C:/Program Files/AWI Resolve/orchestrator/server.js');console.log('PROBE_OK')}catch(e){console.error('PROBE_FAIL '+e.message);process.exit(1)}" 2>&1
"$probe" | Out-File $log -Append
if ($LASTEXITCODE -ne 0) { "SMOKE FAIL" | Out-File $log -Append; exit 1 }

# Ensure API key is in this elevated session
if (-not $env:ANTHROPIC_API_KEY) {
  $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User')
}

Start-ScheduledTask -TaskName 'AWI Resolve Service'
Start-Sleep 4
Start-ScheduledTask -TaskName 'AWI Resolve Agent'
Start-Sleep 3

"Ports:" | Out-File $log -Append
Get-NetTCPConnection -LocalPort 8787,8790 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess | Out-String | Out-File $log -Append

# Quick health check
try {
  $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 5
  "HEALTH $($h.StatusCode) $($h.Content)" | Out-File $log -Append
} catch {
  "HEALTH FAIL $($_.Exception.Message)" | Out-File $log -Append
}
"DONE" | Out-File $log -Append
