# Produce a pre-keyed AWI Resolve package for one customer.
#
# The generic package in dist\AWI-Resolve cannot connect: it ships with an empty
# enrollmentSecret, and the connector refuses anything without one. Asking a
# prospect to hand-edit JSON before they have seen the product work is how a
# demo dies at step one, so this stamps their details in first.
#
# Everything here is the machine half of the self-service flow: given a company,
# an org id and a licence key, produce the exact zip that customer downloads.
#
# Usage:
#   .\make-customer-package.ps1 -Customer "Acme Ltd" -CustomerId acme-com `
#       -LicenseKey "RSLIC1-..." -EnrollmentSecret "..."
#
# Run packaging\build.ps1 first — this repackages that output, it does not build.

param(
  [Parameter(Mandatory=$true)][string]$Customer,
  [Parameter(Mandatory=$true)][string]$CustomerId,
  [Parameter(Mandatory=$true)][string]$LicenseKey,
  [Parameter(Mandatory=$true)][string]$EnrollmentSecret,
  [string]$OrchestratorUrl = 'wss://awi-resolve-connector.fly.dev',
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Base = Join-Path $Root 'dist\AWI-Resolve'

if (-not (Test-Path $Base)) {
  Write-Host "No package at $Base. Run packaging\build.ps1 first." -ForegroundColor Red
  exit 1
}

# Fail before copying 135 MB rather than after: a package that ships with a
# placeholder key is worse than no package, because it looks finished.
if ($LicenseKey -notmatch '^RSLIC1-') {
  Write-Host 'LicenseKey does not look like a Resolve key (expected RSLIC1-...).' -ForegroundColor Red
  exit 1
}
if ([string]::IsNullOrWhiteSpace($EnrollmentSecret)) {
  Write-Host 'EnrollmentSecret is empty — the connector would refuse this package.' -ForegroundColor Red
  exit 1
}

if (-not $OutDir) { $OutDir = Join-Path $Root 'dist\customers' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$safe    = ($CustomerId -replace '[^A-Za-z0-9\-_]', '-')
$stage   = Join-Path $OutDir "AWI-Resolve-$safe"
$zipPath = "$stage.zip"

Write-Host "Building package for $Customer ($CustomerId)" -ForegroundColor Cyan
if (Test-Path $stage)   { Remove-Item $stage -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Copy-Item $Base $stage -Recurse -Force

# Stamp the customer's settings. Written as an ordered hashtable so the file
# stays readable if a technician ever opens it.
$config = [ordered]@{
  _comment          = "AWI Resolve - pre-configured for $Customer. No editing needed: install and open Resolve."
  orchestratorUrl   = $OrchestratorUrl
  enrollmentSecret  = $EnrollmentSecret
  licenseKey        = $LicenseKey
  customerId        = $CustomerId
  uiPort            = 8790
}
$config | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $stage 'config.json') -Encoding utf8

# Verify what we just wrote, rather than trusting the write. A package that
# silently lost the key would be discovered by the customer, not by us.
$check = Get-Content (Join-Path $stage 'config.json') -Raw | ConvertFrom-Json
if ($check.licenseKey -ne $LicenseKey -or $check.enrollmentSecret -ne $EnrollmentSecret -or
    $check.customerId -ne $CustomerId) {
  Write-Host '  FAILED: config.json did not round-trip correctly.' -ForegroundColor Red
  exit 1
}
Write-Host '  ok  config stamped and verified' -ForegroundColor Green

Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zipPath).Length/1MB, 1)
Write-Host "Done. $zipPath ($mb MB)" -ForegroundColor Green
Write-Host "Send this one file. The customer unzips it and runs 'Install AWI Resolve.cmd'."
