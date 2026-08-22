# Produce the ONE generic AWI Resolve package that every customer downloads.
#
# The per-customer packages this replaces do not scale: each one is a 47 MB zip
# built by hand and shared individually, which is a job per sale. This package
# carries the connector address and the enrollment secret but NO licence key,
# because the customer now pastes their key into the Resolve window itself.
#
# So the flow becomes: host this once, email a key per customer.
#
# On the enrollment secret: it is a door key, not an authorisation. Someone who
# extracts it from the download can connect an agent, and without a licence that
# agent gets read-only diagnostics and nothing else — no fixes, no deployment,
# and no tickets, since it belongs to no organisation. That is the trade for a
# download link that just works. Host it unlisted rather than advertised, and
# rotate the secret (fly secrets set RESOLVE_ENROLLMENT_SECRET=...) if it is
# ever abused — note that rotating it invalidates every installed agent.
#
# Usage:
#   .\make-generic-package.ps1 -EnrollmentSecret "<the connector's secret>"
#
# Run packaging\build.ps1 first — this repackages that output.

param(
  [Parameter(Mandatory=$true)][string]$EnrollmentSecret,
  [string]$OrchestratorUrl = 'wss://awi-resolve-connector.fly.dev',
  [string]$RenewUrl = 'https://www.alphawebin.com/',
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Base = Join-Path $Root 'dist\AWI-Resolve'

if (-not (Test-Path $Base)) {
  Write-Host "No package at $Base. Run packaging\build.ps1 first." -ForegroundColor Red
  exit 1
}
if ([string]::IsNullOrWhiteSpace($EnrollmentSecret)) {
  Write-Host 'EnrollmentSecret is required — without it every install is refused at the door.' -ForegroundColor Red
  exit 1
}

# Refuse to ship a package that predates in-app activation. Without it the
# customer has no way to enter the key we email them, and the whole point of a
# generic package is lost — silently.
$agentJs = Join-Path $Base 'agent\agent.js'
$uiHtml  = Join-Path $Base 'agent\ui\index.html'
if (-not (Select-String -Path $agentJs -Pattern 'activate_licence' -Quiet)) {
  Write-Host '  FAILED: this build has no in-app activation. Re-run packaging\build.ps1.' -ForegroundColor Red
  exit 1
}
if (-not (Select-String -Path $uiHtml -Pattern 'lic-key' -Quiet)) {
  Write-Host '  FAILED: the window has no licence box. Re-run packaging\build.ps1.' -ForegroundColor Red
  exit 1
}
Write-Host '  ok  build includes in-app activation' -ForegroundColor Green

if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stage   = Join-Path $OutDir 'AWI-Resolve-Setup'
$zipPath = Join-Path $OutDir 'AWI-Resolve-Setup.zip'
if (Test-Path $stage)   { Remove-Item $stage -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Copy-Item $Base $stage -Recurse -Force

$config = [ordered]@{
  _comment         = 'AWI Resolve. Install, then open Resolve and paste the licence key from your Alpha Web email into the box at the top.'
  orchestratorUrl  = $OrchestratorUrl
  enrollmentSecret = $EnrollmentSecret
  licenseKey       = ''
  customerId       = ''
  # Co-branding. No logo is bundled — this one file goes to every customer —
  # but the block ships enabled and documented so an IT admin can drop their
  # logo in without being told the setting exists. The company NAME needs
  # nothing here: it comes from the licence they paste in.
  branding         = [ordered]@{
    _how     = "To show your own logo beside AWI Resolve, create a 'branding' folder next to this file and put logo.png (or logo.svg) in it. Your company name comes from your licence."
    enabled  = $true
    logoPath = ''
    renewUrl = $RenewUrl
  }
  uiPort           = 8790
}
$config | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $stage 'config.json') -Encoding utf8

# Verify the write, rather than trusting it.
$check = Get-Content (Join-Path $stage 'config.json') -Raw | ConvertFrom-Json
if ($check.enrollmentSecret -ne $EnrollmentSecret -or $check.licenseKey -ne '') {
  Write-Host '  FAILED: config.json did not round-trip correctly.' -ForegroundColor Red
  exit 1
}

# The licence window is the customer's answer to "whose licence is this, and how
# long does it run". Shipping a build without it is a support call per install.
if (-not (Test-Path (Join-Path $stage 'agent\ui\licence.html'))) {
  Write-Host '  FAILED: this build has no licence window. Re-run packaging\build.ps1.' -ForegroundColor Red
  exit 1
}
Write-Host '  ok  licence window and co-branding included' -ForegroundColor Green

Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zipPath).Length/1MB, 1)
Write-Host "Done. $zipPath ($mb MB)" -ForegroundColor Green
Write-Host 'Host this once. Every customer downloads the same file and activates with their own key.'
