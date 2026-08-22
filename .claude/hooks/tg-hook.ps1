# Token Governor — Claude Code hook (Windows)
# Reads JSON on stdin. Exit 0 + JSON to allow/block. Must stay fast.

$ErrorActionPreference = "Stop"
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

function Emit([object]$obj, [int]$code = 0) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.Write($json)
  exit $code
}

function Load-JsonFile([string]$path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Count-UserTurns([string]$transcript) {
  if (-not $transcript -or -not (Test-Path -LiteralPath $transcript)) { return 0 }
  $n = 0
  Get-Content -LiteralPath $transcript -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_ -match '"type"\s*:\s*"user"') { $n++ }
  }
  return $n
}

function Write-Control([string]$cwd, [string]$session, [int]$turns, [string]$event, [string]$reason) {
  $dir = Join-Path $env:LOCALAPPDATA "TokenGovernor"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $log = Join-Path $dir "control.json"
  $doc = Load-JsonFile $log
  $rows = @()
  if ($doc -and $doc.projects) { $rows = @($doc.projects) }
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $rows = @($rows | Where-Object { $_.path -ne $cwd })
  $rows += [pscustomobject]@{
    path      = $cwd
    name      = Split-Path $cwd -Leaf
    sessionId = $session
    turns     = $turns
    event     = $event
    reason    = $reason
    at        = $now
  }
  if ($rows.Count -gt 30) { $rows = $rows | Select-Object -Last 30 }
  @{ updated = $now; projects = @($rows) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $log -Encoding UTF8
}

$raw = ($input | Out-String)
if ([string]::IsNullOrWhiteSpace($raw)) {
  try { $raw = [Console]::In.ReadToEnd() } catch { $raw = "" }
}
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

try { $evt = $raw | ConvertFrom-Json } catch { exit 0 }

$eventName = [string]$evt.hook_event_name
$cwd = [string]$evt.cwd
if (-not $cwd) { $cwd = (Get-Location).Path }
$session = [string]$evt.session_id
$cfgPath = Join-Path $cwd ".claude\token-governor.json"
$cfg = Load-JsonFile $cfgPath
$maxTurns = 8
$blockDumps = $true
$maxRead = 80000
if ($cfg -and $cfg.maxTurns) { $maxTurns = [int]$cfg.maxTurns }
if ($cfg -and $null -ne $cfg.blockDumps) { $blockDumps = [bool]$cfg.blockDumps }
if ($cfg -and $cfg.maxReadBytes) { $maxRead = [int]$cfg.maxReadBytes }
if ($cfg -and $cfg.enabled -eq $false) { exit 0 }

if ($eventName -eq "SessionStart") {
  Write-Control $cwd $session 0 "session" "Claude Code started in a protected folder."
  Emit @{
    hookSpecificOutput = @{
      hookEventName     = "SessionStart"
      additionalContext = "Token Governor is active in this folder. Read .ai/HANDOFF.md and .ai/SESSION.md before exploring. Search, then read a slice. Do not dump the repository. After $maxTurns user turns this chat is blocked until a handoff, then start a new chat."
    }
  }
}

if ($eventName -eq "UserPromptSubmit") {
  $prompt = [string]$evt.prompt
  $fromFile = Count-UserTurns ([string]$evt.transcript_path)
  $turns = $fromFile + 1
  $handoffAsk = $prompt -match '(?i)\b(handoff|compact|new chat|HANDOFF\.md|SESSION\.md)\b'
  if ($turns -ge $maxTurns -and -not $handoffAsk) {
    $reason = "Token Governor blocked this message. This Claude Code chat is at turn $turns (limit $maxTurns). Ask Claude to write .ai/HANDOFF.md, then start a NEW chat in this folder. Old long threads are not allowed to keep growing."
    Write-Control $cwd $session $turns "blocked" $reason
    Emit @{
      decision = "block"
      reason   = $reason
    }
  }
  $note = "Token Governor: turn $turns of $maxTurns in this chat."
  if ($handoffAsk) {
    $note = "Token Governor: write .ai/HANDOFF.md (goal, done, remaining, files, pitfalls, next step, how to verify), refresh .ai/SESSION.md, then stop. User must start a new chat after."
  } elseif ($turns -ge ($maxTurns - 2)) {
    $note = "Token Governor: turn $turns of $maxTurns. Next, write a handoff and start a new chat. Do not dump files."
  }
  Write-Control $cwd $session $turns "allowed" $note
  Emit @{
    hookSpecificOutput = @{
      hookEventName     = "UserPromptSubmit"
      additionalContext = $note
    }
  }
}

if ($eventName -eq "PreToolUse" -and $blockDumps) {
  $tool = [string]$evt.tool_name
  $input = $evt.tool_input
  $why = $null
  if ($tool -eq "Read") {
    $fp = [string]$input.file_path
    $hasLimit = $null -ne $input.limit
    if ($fp -and (Test-Path -LiteralPath $fp)) {
      try {
        $len = [int64](Get-Item -LiteralPath $fp).Length
        if ($len -gt $maxRead -and -not $hasLimit) {
          $why = "Token Governor blocked a full-file read ($len bytes). Read a line range (offset/limit), not the whole file."
        }
      } catch { }
    }
  }
  if ($tool -eq "Glob") {
    $pat = [string]$input.pattern
    if ($pat -match '^\*\*$|^\*\*/\*$|^\*$') {
      $why = "Token Governor blocked a whole-tree glob. Search with a narrower pattern (for example src/**/*.ts)."
    }
  }
  if ($tool -eq "Bash") {
    $cmd = [string]$input.command
    if ($cmd -match '(?i)Get-ChildItem\s+[^\n]*-Recurse|dir\s+/s\b|tree\s+/f|\bcat\s+\*|Get-Content\s+[^\n]*-Recurse') {
      $why = "Token Governor blocked a recursive dump command. Search, then read a slice."
    }
  }
  if ($why) {
    Write-Control $cwd $session 0 "dump-blocked" $why
    Emit @{
      hookSpecificOutput = @{
        hookEventName            = "PreToolUse"
        permissionDecision       = "deny"
        permissionDecisionReason = $why
      }
    }
  }
}

exit 0
