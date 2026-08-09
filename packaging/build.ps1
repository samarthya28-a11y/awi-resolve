# AWI Resolve — build the distributable customer package into dist\AWI-Resolve.
# Produces a fully self-contained folder: bundled node.exe, the agent, the ws
# module, config, and the installer scripts. No Node install needed on the target.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Pkg  = $PSScriptRoot
$Out  = Join-Path $Root 'dist\AWI-Resolve'

Write-Host "Building AWI Resolve package -> $Out" -ForegroundColor Cyan
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Out, "$Out\agent", "$Out\node_modules" | Out-Null

# Bundled Node runtime
Copy-Item (Get-Command node).Source (Join-Path $Out 'node.exe')

# Agent code (exclude runtime state in agent\data). Copy EVERY module rather
# than a hand-written list: a list silently goes stale the moment a new file is
# added, and the package then dies on startup with "Cannot find module" — which
# is exactly what shipping without agent\catalog.js did.
Get-ChildItem "$Root\agent\*.js" | Copy-Item -Destination "$Out\agent"
Copy-Item "$Root\agent\ui" "$Out\agent\ui" -Recurse

# Support service (orchestrator). Shipped so a self-hosted install can run the
# whole product on one PC; a customer pointed at a hosted connector simply never
# starts it. Runtime state in orchestrator\data is deliberately not shipped.
New-Item -ItemType Directory -Force -Path "$Out\orchestrator" | Out-Null
Get-ChildItem "$Root\orchestrator\*.js" | Copy-Item -Destination "$Out\orchestrator"
Copy-Item "$Root\orchestrator\ui" "$Out\orchestrator\ui" -Recurse

# Runtime dependencies
Copy-Item "$Root\node_modules\ws" "$Out\node_modules\ws" -Recurse
Copy-Item "$Root\node_modules\@anthropic-ai" "$Out\node_modules\@anthropic-ai" -Recurse

# Product icon (shortcut / taskbar). Regenerate if missing.
if (-not (Test-Path "$Pkg\awi-resolve.ico")) {
  powershell -NoProfile -ExecutionPolicy Bypass -File "$Pkg\make-icon.ps1" | Out-Null
}
Copy-Item "$Pkg\awi-resolve.ico" $Out

# Config + installer payload
Copy-Item "$Pkg\config.template.json" (Join-Path $Out 'config.json')
Copy-Item "$Pkg\run-agent-hidden.vbs","$Pkg\run-orchestrator-hidden.vbs",`
          "$Pkg\Install.ps1","$Pkg\Uninstall.ps1","$Pkg\README.txt" $Out
Copy-Item "$Pkg\Install AWI Resolve.cmd" $Out

# Smoke test: actually load the packaged agent and orchestrator with the bundled
# node. A missing module or bad path fails HERE, at build time, instead of on a
# customer's PC as a support window that silently refuses to connect.
Write-Host 'Verifying the package loads...' -ForegroundColor Cyan
foreach ($entry in @('agent\agent.js', 'orchestrator\server.js')) {
  # Absolute path with forward slashes — a bare "agent/agent.js" would be
  # resolved as a package name, not a file, and always fail.
  $full = (Join-Path $Out $entry).Replace('\','/')
  $probe = & "$Out\node.exe" -e "try{require('$full');process.exit(0)}catch(e){if(/Cannot find module/.test(e.message)){console.error(e.message);process.exit(1)}process.exit(0)}" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  BUILD FAILED: $entry is missing a module in the package" -ForegroundColor Red
    Write-Host "  $probe" -ForegroundColor Red
    exit 1
  }
  Write-Host "  ok  $entry" -ForegroundColor Green
}

$size = [math]::Round(((Get-ChildItem $Out -Recurse | Measure-Object Length -Sum).Sum)/1MB,0)
Write-Host "Done. Package is $size MB at $Out" -ForegroundColor Green
Write-Host "To install on this or any Windows PC: copy the AWI-Resolve folder there and run 'Install AWI Resolve.cmd'."
