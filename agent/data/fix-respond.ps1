$ErrorActionPreference = 'Continue'
$log = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\fix-respond.txt'
"=== $(Get-Date -Format o) ===" | Out-File $log

# Kill anything on Resolve ports (elevated)
foreach ($port in 8787,8790) {
  Get-NetTCPConnection -LocalPort $port -EA SilentlyContinue | ForEach-Object {
    "kill $($_.OwningProcess) on $port" | Out-File $log -Append
    Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*AWI Resolve*' -or $_.CommandLine -like '*awi-resolve*orchestrator*' -or $_.CommandLine -like '*awi-resolve*agent*'
} | ForEach-Object {
  "kill node $($_.ProcessId)" | Out-File $log -Append
  Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue
}
Start-Sleep 2

# Ensure Program Files has .env so scheduled/hidden starts get the AI key
$key = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User')
if (-not $key) { $key = $env:ANTHROPIC_API_KEY }
"key len=$($key.Length)" | Out-File $log -Append
$pf = 'C:\Program Files\AWI Resolve'
@"
ANTHROPIC_API_KEY=$key
"@ | Set-Content "$pf\.env" -Encoding ASCII

# Copy fixed orchestrator + agent from project
Copy-Item "C:\Users\ASUS\Projects\awi-resolve\orchestrator\*.js" "$pf\orchestrator\" -Force
Copy-Item "C:\Users\ASUS\Projects\awi-resolve\agent\*.js" "$pf\agent\" -Force

# Start service then agent via tasks (they will load .env via process.loadEnvFile)
$env:ANTHROPIC_API_KEY = $key
Start-Process -FilePath "$pf\node.exe" -ArgumentList 'orchestrator\server.js' -WorkingDirectory $pf -WindowStyle Hidden
Start-Sleep 4
Start-ScheduledTask -TaskName 'AWI Resolve Agent' -EA SilentlyContinue
Start-Sleep 4

"ports:" | Out-File $log -Append
netstat -ano | findstr "8787 8790" | Out-File $log -Append

# Quick require probe
$probe = & "$pf\node.exe" -e "process.chdir(r='C:/Program Files/AWI Resolve'); require('fs'); const e=require('fs').readFileSync(r+'/.env','utf8'); console.log('envfile', e.includes('ANTHROPIC_API_KEY=')); require('@anthropic-ai/sdk'); console.log('sdk_ok')" 2>&1
"$probe" | Out-File $log -Append

# Check PF audit for fresh enrollment (agent reconnect)
Start-Sleep 2
if (Test-Path "$pf\orchestrator\data\audit.jsonl") {
  "audit tail:" | Out-File $log -Append
  Get-Content "$pf\orchestrator\data\audit.jsonl" -Tail 8 | Out-File $log -Append
}
"DONE" | Out-File $log -Append
