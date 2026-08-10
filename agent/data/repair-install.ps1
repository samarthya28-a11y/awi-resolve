$ErrorActionPreference = 'Stop'
$log = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\repair-log.txt'
"=== repair $(Get-Date -Format o) ===" | Out-File $log

$src = 'C:\Users\ASUS\Projects\awi-resolve'
$dst = 'C:\Program Files\AWI Resolve'

# Stop running Resolve processes
Stop-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*AWI Resolve*' -or $_.CommandLine -like '*awi-resolve*'
} | ForEach-Object {
  "Kill $($_.ProcessId)" | Out-File $log -Append
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
foreach ($port in 8787,8790) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep 2

# Preserve licence
$lic = ''
try { $lic = (Get-Content "$dst\config.json" -Raw | ConvertFrom-Json).licenseKey } catch {}

# Copy fixed code
Copy-Item "$src\orchestrator\*.js" "$dst\orchestrator\" -Force
Copy-Item "$src\agent\*.js" "$dst\agent\" -Force
if (Test-Path "$src\orchestrator\licensing-key.pub") {
  Copy-Item "$src\orchestrator\licensing-key.pub" "$dst\orchestrator\" -Force
}

# Missing transitive deps that crash the service on boot
$mods = @('standardwebhooks','@stablelib','fast-sha256','json-schema-to-ts','@babel','ts-algebra')
foreach ($m in $mods) {
  $from = Join-Path $src "node_modules\$m"
  $to = Join-Path $dst "node_modules\$m"
  if (Test-Path $from) {
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
    "copied $m" | Out-File $log -Append
  } else {
    "MISSING in project: $m" | Out-File $log -Append
  }
}
# Refresh anthropic + ws too
foreach ($m in @('@anthropic-ai','ws')) {
  $from = Join-Path $src "node_modules\$m"
  $to = Join-Path $dst "node_modules\$m"
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
  "copied $m" | Out-File $log -Append
}

# Playbooks
New-Item -ItemType Directory -Force -Path "$dst\playbooks\kb","$dst\playbooks\deploy" | Out-Null
Copy-Item "$src\playbooks\kb\*" "$dst\playbooks\kb" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$src\playbooks\deploy\*" "$dst\playbooks\deploy" -Recurse -Force -ErrorAction SilentlyContinue

# Restore licence into config
$cfg = Get-Content "$dst\config.json" -Raw | ConvertFrom-Json
if ($lic) { $cfg.licenseKey = $lic }
($cfg | ConvertTo-Json -Depth 5) | Set-Content "$dst\config.json" -Encoding UTF8
"license len=$($cfg.licenseKey.Length)" | Out-File $log -Append

# Prove the service can load
$probe = & "$dst\node.exe" -e "process.chdir(process.argv[1]); require('standardwebhooks'); require('@anthropic-ai/sdk'); require('./orchestrator/ai'); console.log('LOAD_OK')" $dst 2>&1
"$probe" | Out-File $log -Append
if ($LASTEXITCODE -ne 0) { throw "probe failed: $probe" }

# Start service then agent
Start-ScheduledTask -TaskName 'AWI Resolve Service'
Start-Sleep 4
Start-ScheduledTask -TaskName 'AWI Resolve Agent'
Start-Sleep 3
"Ports:" | Out-File $log -Append
Get-NetTCPConnection -LocalPort 8787,8790 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess | Out-String | Out-File $log -Append
"REPAIR_DONE" | Out-File $log -Append
