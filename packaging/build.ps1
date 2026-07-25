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

# Agent code (exclude runtime state in agent\data)
Copy-Item "$Root\agent\agent.js","$Root\agent\tools.js" "$Out\agent"
Copy-Item "$Root\agent\ui" "$Out\agent\ui" -Recurse

# Only runtime dependency
Copy-Item "$Root\node_modules\ws" "$Out\node_modules\ws" -Recurse

# Config + installer payload
Copy-Item "$Pkg\config.template.json" (Join-Path $Out 'config.json')
Copy-Item "$Pkg\run-agent-hidden.vbs","$Pkg\Install.ps1","$Pkg\Uninstall.ps1","$Pkg\README.txt" $Out
Copy-Item "$Pkg\Install AWI Resolve.cmd" $Out

$size = [math]::Round(((Get-ChildItem $Out -Recurse | Measure-Object Length -Sum).Sum)/1MB,0)
Write-Host "Done. Package is $size MB at $Out" -ForegroundColor Green
Write-Host "To install on this or any Windows PC: copy the AWI-Resolve folder there and run 'Install AWI Resolve.cmd'."
