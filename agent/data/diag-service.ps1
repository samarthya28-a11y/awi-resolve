$ErrorActionPreference = 'Continue'
$log = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\service-diag.txt'
"=== $(Get-Date -Format o) ===" | Out-File $log

$svc = Get-ScheduledTask -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
$agt = Get-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
"Service state: $($svc.State)" | Out-File $log -Append
"Agent state: $($agt.State)" | Out-File $log -Append
$si = Get-ScheduledTaskInfo -TaskName 'AWI Resolve Service' -ErrorAction SilentlyContinue
$ai = Get-ScheduledTaskInfo -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
"Service last: $($si.LastRunTime) result=$($si.LastTaskResult)" | Out-File $log -Append
"Agent last: $($ai.LastRunTime) result=$($ai.LastTaskResult)" | Out-File $log -Append
"User API key set: $([bool][Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User'))" | Out-File $log -Append
"Process API key set: $([bool]$env:ANTHROPIC_API_KEY)" | Out-File $log -Append

# Free ports
foreach ($port in 8787,8790) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    "Killing PID $($_.OwningProcess) on $port" | Out-File $log -Append
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep 2

# Launch orchestrator visibly to capture crash (redirect to file)
$pf = 'C:\Program Files\AWI Resolve'
$out = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\orch-stdout.txt'
$err = 'C:\Users\ASUS\Projects\awi-resolve\agent\data\orch-stderr.txt'
Remove-Item $out,$err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath "$pf\node.exe" -ArgumentList 'orchestrator\server.js' `
  -WorkingDirectory $pf -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err
"Started orch PID $($p.Id)" | Out-File $log -Append
Start-Sleep 4
if ($p.HasExited) {
  "Orch EXITED code=$($p.ExitCode)" | Out-File $log -Append
} else {
  "Orch still running" | Out-File $log -Append
}
"Ports:" | Out-File $log -Append
Get-NetTCPConnection -LocalPort 8787,8790 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess |
  Out-String | Out-File $log -Append
"STDOUT:" | Out-File $log -Append
if (Test-Path $out) { Get-Content $out | Out-File $log -Append }
"STDERR:" | Out-File $log -Append
if (Test-Path $err) { Get-Content $err | Out-File $log -Append }

# Also start agent via task
Start-ScheduledTask -TaskName 'AWI Resolve Agent' -ErrorAction SilentlyContinue
Start-Sleep 3
"After agent start:" | Out-File $log -Append
Get-NetTCPConnection -LocalPort 8787,8790 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess |
  Out-String | Out-File $log -Append
