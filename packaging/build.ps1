# AWI Resolve — build the distributable customer package into dist\AWI-Resolve.
# Produces a fully self-contained folder: bundled node.exe, the agent, the
# support service, runtime modules, config, and the installer scripts.
# No Node install needed on the target.
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
# added, and the package then dies on startup with "Cannot find module".
Get-ChildItem "$Root\agent\*.js" | Copy-Item -Destination "$Out\agent"
Copy-Item "$Root\agent\ui" "$Out\agent\ui" -Recurse

# Support service (orchestrator). Shipped so a self-hosted install can run the
# whole product on one PC; a customer pointed at a hosted connector simply never
# starts it. Runtime state in orchestrator\data is deliberately not shipped.
New-Item -ItemType Directory -Force -Path "$Out\orchestrator" | Out-Null
Get-ChildItem "$Root\orchestrator\*.js" | Copy-Item -Destination "$Out\orchestrator"
Copy-Item "$Root\orchestrator\ui" "$Out\orchestrator\ui" -Recurse
if (Test-Path "$Root\orchestrator\licensing-key.pub") {
  Copy-Item "$Root\orchestrator\licensing-key.pub" "$Out\orchestrator\licensing-key.pub"
}

# Knowledge base + deployment manuals the service searches at runtime.
New-Item -ItemType Directory -Force -Path "$Out\playbooks\kb", "$Out\playbooks\deploy" | Out-Null
if (Test-Path "$Root\playbooks\kb") {
  Copy-Item "$Root\playbooks\kb\*" "$Out\playbooks\kb" -Recurse -Force
}
if (Test-Path "$Root\playbooks\deploy") {
  Copy-Item "$Root\playbooks\deploy\*" "$Out\playbooks\deploy" -Recurse -Force
}

# Runtime dependencies — copy the Anthropic SDK AND every package it needs
# (standardwebhooks, json-schema-to-ts, …). Hand-picking only `ws` +
# `@anthropic-ai` left the installed service crashing on boot with
# "Cannot find module 'standardwebhooks'", so the support window opened
# but never connected to the AI.
#
# Let npm resolve the tree rather than naming packages by hand. The list above
# was itself the second version of this bug: hand-picking `ws` + `@anthropic-ai`
# missed standardwebhooks, and any hand-written list goes stale again the next
# time the SDK adds a dependency. npm always knows the full transitive set.
Write-Host 'Installing runtime dependencies into the package...' -ForegroundColor Cyan
$deps = (Get-Content "$Root\package.json" -Raw | ConvertFrom-Json).dependencies
$pkgJson = @{ name = 'awi-resolve-runtime'; version = '1.0.0'; private = $true
              dependencies = @{} }
foreach ($p in $deps.PSObject.Properties) { $pkgJson.dependencies[$p.Name] = $p.Value }
$pkgJson | ConvertTo-Json -Depth 5 | Set-Content "$Out\package.json" -Encoding utf8

Push-Location $Out
npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Null
$npmFailed = $LASTEXITCODE -ne 0
Pop-Location
if ($npmFailed) {
  Write-Host '  BUILD FAILED: npm install could not resolve runtime dependencies' -ForegroundColor Red
  exit 1
}

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

# Smoke test: resolve the full runtime import graph without binding ports
# (requiring agent.js / server.js would start listeners).
#
# Run it against a copy OUTSIDE the repo. Node resolves a module by walking up
# the directory tree, so probing dist\ — which lives inside the repo — can
# satisfy a missing dependency from the repo's OWN node_modules and report a
# healthy package. That is not hypothetical: it is exactly how the missing
# standardwebhooks passed this check and still crashed on the customer's PC.
Write-Host 'Verifying the package loads (isolated from the repo)...' -ForegroundColor Cyan
$probeDir = Join-Path ([IO.Path]::GetTempPath()) ("awi-resolve-probe-" + [guid]::NewGuid().ToString('N').Substring(0,8))
Copy-Item $Out $probeDir -Recurse -Force
try {
  $probe = & "$probeDir\node.exe" -e @"
process.chdir(process.argv[1]);
['ws','@anthropic-ai/sdk'].forEach(require);
require('./agent/tools');
require('./orchestrator/licensing');
require('./orchestrator/ai');
require('./orchestrator/kb');
require('./orchestrator/manuals');
console.log('ok');
"@ $probeDir 2>&1
  $probeFailed = $LASTEXITCODE -ne 0
} finally {
  Remove-Item $probeDir -Recurse -Force -ErrorAction SilentlyContinue
}
if ($probeFailed) {
  Write-Host '  BUILD FAILED: package is missing a module the service needs' -ForegroundColor Red
  Write-Host "  $probe" -ForegroundColor Red
  exit 1
}
Write-Host '  ok  runtime modules + agent tools + orchestrator AI/KB' -ForegroundColor Green

$size = [math]::Round(((Get-ChildItem $Out -Recurse | Measure-Object Length -Sum).Sum)/1MB,0)
Write-Host "Done. Package is $size MB at $Out" -ForegroundColor Green
Write-Host "To install on this or any Windows PC: copy the AWI-Resolve folder there and run 'Install AWI Resolve.cmd'."
