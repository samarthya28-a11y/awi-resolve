'use strict';
// AWI Resolve agent — the ONLY actions this agent can ever perform (spec §6).
// Anything not registered here is refused, no matter who asks — including our own
// server. Adding a tool requires a code change + spec version bump, never config.

const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { getEntry, listProducts } = require('./catalog');

const PS_TIMEOUT_MS = 30000;
const INSTALL_TIMEOUT_MS = 300000; // 5 min for an installer to finish
// Full IT Support (Tier-2) — consented arbitrary PowerShell, hard caps.
const FULL_PS_TIMEOUT_MS = 90000;
const FULL_PS_MAX_COMMAND = 4000;
const FULL_PS_MAX_OUTPUT = 32 * 1024;
const FULL_PS_MAX_BUFFER = 512 * 1024;

// Fixed list of services the agent may inspect (Tier-0) — spec §6.
const ALLOWED_SERVICES = ['Spooler', 'Dhcp', 'Dnscache', 'W32Time', 'wuauserv', 'LanmanWorkstation'];

function ps(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`diagnostic command failed: ${err.message.split('\n')[0]}`));
        resolve(stdout.trim());
      }
    );
  });
}

async function psJson(command) {
  const out = await ps(command);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('diagnostic returned unparseable output');
  }
}

async function getSystemSnapshot() {
  let disk = null;
  try {
    const d = await psJson('Get-PSDrive -Name C | Select-Object Used,Free | ConvertTo-Json');
    if (d) disk = { usedGB: +(d.Used / 1e9).toFixed(1), freeGB: +(d.Free / 1e9).toFixed(1) };
  } catch { /* disk info unavailable — snapshot still useful */ }

  let printers = [];
  try {
    const p = await psJson(
      "Get-Printer | Select-Object Name,DriverName,PortName,@{n='Status';e={$_.PrinterStatus.ToString()}} | ConvertTo-Json"
    );
    if (p) printers = Array.isArray(p) ? p : [p];
  } catch { printers = null; }

  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    uptimeMinutes: Math.round(os.uptime() / 60),
    memory: { totalGB: +(os.totalmem() / 1e9).toFixed(1), freeGB: +(os.freemem() / 1e9).toFixed(1) },
    diskC: disk,
    printers,
  };
}

// All print queues on the machine — no parameters, so nothing user-supplied ever
// reaches the command line (injection-proof by construction).
async function getPrintQueue() {
  const out = await psJson(
    "Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name } | " +
    "Select-Object @{n='Printer';e={$_.PrinterName}},Id,DocumentName," +
    "@{n='Status';e={$_.JobStatus.ToString()}},@{n='SubmittedAt';e={$_.SubmittedTime.ToString('s')}},Size | ConvertTo-Json"
  );
  const jobs = out ? (Array.isArray(out) ? out : [out]) : [];
  // Document names can contain personal info — send only a truncated hint.
  for (const j of jobs) {
    if (j.DocumentName && j.DocumentName.length > 20) j.DocumentName = j.DocumentName.slice(0, 20) + '…';
  }
  return { jobCount: jobs.length, jobs };
}

// Recent warning/error events from a fixed list of logs (spec §6: filtered, 24h, capped).
const ALLOWED_EVENT_LOGS = ['System', 'Application'];

async function readEventLog(params) {
  const logName = params && params.log;
  if (!ALLOWED_EVENT_LOGS.includes(logName)) {
    throw new Error(`log '${logName}' is not on the readable list`);
  }
  const out = await psJson(
    `try { Get-WinEvent -FilterHashtable @{LogName='${logName}'; Level=1,2,3; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 40 -ErrorAction Stop | ` +
    "Select-Object @{n='Time';e={$_.TimeCreated.ToString('s')}},ProviderName,Id,LevelDisplayName," +
    "@{n='Message';e={ if ($_.Message) { $_.Message.Substring(0,[Math]::Min(250,$_.Message.Length)) } else { '' } }} | ConvertTo-Json } catch { '[]' }"
  );
  const events = out ? (Array.isArray(out) ? out : [out]) : [];
  return { logName, hours: 24, eventCount: events.length, events };
}

// Reachability test. Target is validated to hostname/IP characters only before it
// touches the command line; PII never appears in a hostname we generate.
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,252}$/;

async function testNetwork(params) {
  const target = params && params.target;
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    throw new Error('invalid target — must be a hostname or IP address');
  }
  const out = await psJson(
    `$r = Test-Connection -ComputerName '${target}' -Count 2 -Quiet; ` +
    `$dns = try { [System.Net.Dns]::GetHostAddresses('${target}')[0].IPAddressToString } catch { $null }; ` +
    "@{ reachable = [bool]$r; resolvedIp = $dns } | ConvertTo-Json"
  );
  return { target, ...out };
}

async function readServiceStatus(params) {
  const name = params && params.service;
  if (!ALLOWED_SERVICES.includes(name)) {
    throw new Error(`service '${name}' is not on the inspectable list`);
  }
  return psJson(
    `Get-Service -Name ${name} | Select-Object Name,@{n='Status';e={$_.Status.ToString()}},@{n='StartType';e={$_.StartType.ToString()}} | ConvertTo-Json`
  );
}

// Reclaimable temp-file usage (Tier-0). Runs as the current user, no elevation.
async function getTempUsage() {
  const out = await psJson(
    "$t = $env:TEMP; " +
    "$f = Get-ChildItem -Path $t -Recurse -File -Force -ErrorAction SilentlyContinue; " +
    "$old = $f | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) }; " +
    "@{ tempTotalMB = [math]::Round((($f | Measure-Object -Property Length -Sum).Sum)/1MB,1); " +
    "   reclaimableMB = [math]::Round((($old | Measure-Object -Property Length -Sum).Sum)/1MB,1); " +
    "   oldFileCount = ($old | Measure-Object).Count } | ConvertTo-Json"
  );
  return out || { tempTotalMB: 0, reclaimableMB: 0, oldFileCount: 0 };
}

// ---- Tier-1 fixes (low risk, no consent prompt, shown live in the feed) ----

async function clearDnsCache() {
  await ps('Clear-DnsClientCache');
  return { done: true, action: 'Flushed the DNS resolver cache.' };
}

// ---- Tier-2 fixes (state-changing, require customer consent) ----

// Services the agent is allowed to restart — narrower than the readable list.
const RESTARTABLE_SERVICES = ['Spooler', 'Dnscache', 'W32Time', 'wuauserv'];
const SERVICE_LABELS = {
  Spooler: 'Print Spooler (printing)',
  Dnscache: 'DNS Client (name lookups)',
  W32Time: 'Windows Time',
  wuauserv: 'Windows Update',
};

async function restartService(params) {
  const name = params && params.service;
  if (!RESTARTABLE_SERVICES.includes(name)) {
    throw new Error(`service '${name}' is not on the restartable list`);
  }
  // Start-or-restart: a stopped service can't be "restarted" (that errors), so
  // start it; a running one is restarted to clear its state. Starting/stopping a
  // system service needs elevation — the agent runs as a Windows service
  // (LocalSystem) in production (spec §5.1). If we're not elevated, say so
  // clearly so the escalation handoff is precise.
  try {
    await ps(
      `$s = Get-Service -Name ${name}; ` +
      `if ($s.Status -eq 'Running') { Restart-Service -Name ${name} -Force } else { Start-Service -Name ${name} } `
    );
  } catch (e) {
    if (/cannot open|access is denied|PermissionDenied/i.test(e.message)) {
      throw new Error(
        `The support agent doesn't have permission to control the ${name} service on this machine ` +
        `(it needs to run with administrator rights, which it does as a Windows service in production).`
      );
    }
    throw e;
  }
  const status = await psJson(
    `Get-Service -Name ${name} | Select-Object @{n='Status';e={$_.Status.ToString()}} | ConvertTo-Json`
  );
  const running = status && status.Status === 'Running';
  return {
    done: running,
    service: name,
    statusAfter: status && status.Status,
    action: running ? `Started the ${name} service (now Running).` : `Tried to start ${name} but it is ${status && status.Status}.`,
  };
}

// Delete temp files older than 1 day (skips in-use/locked files). Runs as the
// current user — no elevation needed, so this is the fix that completes even in a
// non-elevated dev run. Only touches %TEMP%, which Windows/apps regenerate.
async function cleanTempFiles() {
  const out = await psJson(
    "$t = $env:TEMP; " +
    "$before = ($(Get-ChildItem -Path $t -Recurse -File -Force -ErrorAction SilentlyContinue) | Measure-Object -Property Length -Sum).Sum; " +
    "Get-ChildItem -Path $t -Recurse -File -Force -ErrorAction SilentlyContinue | " +
    "  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue; " +
    "$after = ($(Get-ChildItem -Path $t -Recurse -File -Force -ErrorAction SilentlyContinue) | Measure-Object -Property Length -Sum).Sum; " +
    "@{ freedMB = [math]::Round((($before - $after))/1MB,1) } | ConvertTo-Json"
  );
  const freed = (out && out.freedMB) || 0;
  return { done: true, freedMB: freed, action: `Freed ${freed} MB of temporary files.` };
}

async function clearPrintQueue() {
  // Count first (for an honest result), then remove every queued job.
  const before = await getPrintQueue();
  await ps('Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob }');
  const after = await getPrintQueue();
  return { done: true, jobsCleared: before.jobCount - after.jobCount, jobsRemaining: after.jobCount };
}

// ---- Expanded diagnostics (Tier-0, read-only) ----

// Top memory/CPU consumers — the usual cause of "my PC is slow".
async function listProcesses() {
  const out = await psJson(
    "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 " +
    "@{n='name';e={$_.ProcessName}},@{n='memMB';e={[math]::Round($_.WorkingSet64/1MB,0)}}," +
    "@{n='cpuSec';e={if($_.CPU){[math]::Round($_.CPU,0)}else{0}}} | ConvertTo-Json"
  );
  const list = out ? (Array.isArray(out) ? out : [out]) : [];
  return { topByMemory: list };
}

// Programs that launch at sign-in — the usual cause of slow start-up.
async function listStartupItems() {
  const out = await psJson(
    "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location | ConvertTo-Json"
  );
  const list = out ? (Array.isArray(out) ? out : [out]) : [];
  for (const i of list) if (i.Command && i.Command.length > 120) i.Command = i.Command.slice(0, 120) + '…';
  return { count: list.length, items: list.slice(0, 25) };
}

// Drive health (SMART predict-failure + per-disk status).
async function getDiskHealth() {
  const out = await psJson(
    "$r=@(); " +
    "try { Get-PhysicalDisk | ForEach-Object { $r += @{ name=$_.FriendlyName; " +
    "  mediaType=[string]$_.MediaType; healthStatus=[string]$_.HealthStatus; " +
    "  operationalStatus=[string]$_.OperationalStatus; sizeGB=[math]::Round($_.Size/1GB,0) } } } catch {}; " +
    "$pred=$null; try { $pred = (Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | " +
    "  ForEach-Object { $_.PredictFailure }) -contains $true } catch {}; " +
    "@{ disks=$r; failurePredicted=$pred } | ConvertTo-Json -Depth 4"
  );
  return out || { disks: [], failurePredicted: null };
}

// Devices Windows reports as faulty (Device Manager error codes) — drivers,
// touchpads, adapters, printers that aren't working.
async function listProblemDevices() {
  const out = await psJson(
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne 0 } | " +
    "Select-Object @{n='name';e={$_.Name}},@{n='errorCode';e={$_.ConfigManagerErrorCode}}," +
    "@{n='status';e={$_.Status}} | ConvertTo-Json"
  );
  const list = out ? (Array.isArray(out) ? out : [out]) : [];
  return { problemDeviceCount: list.length, devices: list };
}

// Installed programs (name + version) — "is X installed / what version?".
async function listInstalledPrograms() {
  const out = await psJson(
    "$p='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; " +
    "Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | " +
    "Select-Object @{n='name';e={$_.DisplayName}},@{n='version';e={$_.DisplayVersion}} | " +
    "Sort-Object name -Unique | ConvertTo-Json"
  );
  const list = out ? (Array.isArray(out) ? out : [out]) : [];
  return { count: list.length, programs: list.slice(0, 120) };
}

// IP / DNS / gateway per adapter — connectivity problems.
async function getNetworkConfig() {
  const out = await psJson(
    "$a=@(); Get-NetIPConfiguration | ForEach-Object { $a += @{ " +
    "  adapter=[string]$_.InterfaceAlias; status=[string]$_.NetAdapter.Status; " +
    "  ipv4=[string]$_.IPv4Address.IPAddress; gateway=[string]$_.IPv4DefaultGateway.NextHop; " +
    "  dns=@($_.DNSServer | Where-Object {$_.AddressFamily -eq 2} | ForEach-Object { $_.ServerAddresses }) } }; " +
    "@{ adapters=$a } | ConvertTo-Json -Depth 5"
  );
  return out || { adapters: [] };
}

// Windows Update health: last install + pending reboot.
async function getUpdateStatus() {
  const out = await psJson(
    "$last=$null; try { $last=(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1).InstalledOn.ToString('yyyy-MM-dd') } catch {}; " +
    "$reboot = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or " +
    "          (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'); " +
    "@{ lastUpdateInstalled=$last; rebootPending=[bool]$reboot } | ConvertTo-Json"
  );
  return out || {};
}

// ---- Expanded fixes ----

// Tier-2. Enable a stopped/disabled service AND set it to start automatically.
// This is the fix the earlier clock ticket actually needed (W32Time was Stopped
// with StartType Manual, so a plain restart could never work).
async function enableService(params) {
  const name = params && params.service;
  if (!RESTARTABLE_SERVICES.includes(name)) {
    throw new Error(`service '${name}' is not on the manageable list`);
  }
  try {
    await ps(`Set-Service -Name ${name} -StartupType Automatic; Start-Service -Name ${name}`);
  } catch (e) {
    if (/cannot open|access is denied|PermissionDenied/i.test(e.message)) {
      throw new Error(
        `The support agent needs administrator rights to enable the ${name} service ` +
        `(it has them when installed as a Windows service).`
      );
    }
    throw e;
  }
  const status = await psJson(
    `Get-Service -Name ${name} | Select-Object @{n='Status';e={$_.Status.ToString()}},@{n='StartType';e={$_.StartType.ToString()}} | ConvertTo-Json`
  );
  const running = status && status.Status === 'Running';
  return { done: running, service: name, statusAfter: status && status.Status,
           startTypeAfter: status && status.StartType,
           action: running ? `Enabled ${name} and set it to start automatically.`
                           : `Tried to enable ${name}; it is ${status && status.Status}.` };
}

// Tier-2. Restart Windows Explorer — clears a frozen taskbar/desktop/File Explorer.
async function restartExplorer() {
  await ps('Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }');
  return { done: true, action: 'Restarted Windows Explorer (taskbar and desktop).' };
}

// Tier-2. Release + renew the DHCP lease — fixes many "connected, no internet" cases.
async function renewNetwork() {
  await ps('ipconfig /release | Out-Null; ipconfig /renew | Out-Null; Clear-DnsClientCache');
  const cfg = await getNetworkConfig();
  const ok = (cfg.adapters || []).some((a) => a.ipv4 && !/^169\.254\./.test(a.ipv4));
  return { done: ok, adapters: cfg.adapters,
           action: ok ? 'Renewed the network address and cleared the DNS cache.'
                      : 'Renewed the network address, but no valid IP was obtained.' };
}

// ---- Endpoint security posture (Tier-0, read-only) ----
//
// DESIGN RULE: security tools may only ever move protection in the SAFE
// direction. There is deliberately NO tool to disable antivirus, real-time
// protection, the firewall or SmartScreen — not even consent-gated (spec §6
// Tier-X). An agent that could disarm protection fleet-wide would be the most
// valuable target on a customer's network.

// Overall protection state: registered AV products, Defender detail, firewall
// per profile, disk encryption, UAC, SmartScreen.
async function getSecurityPosture() {
  const out = await psJson(
    // Registered AV products (works even when a 3rd-party AV replaces Defender)
    "$av=@(); try { Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | " +
    "  ForEach-Object { $s=$_.productState; $av += @{ name=$_.displayName; " +
    "    realtimeOn=(($s -band 0x1000) -ne 0); definitionsUpToDate=(($s -band 0x10) -eq 0) } } } catch {}; " +
    // Defender specifics (may be passive if a 3rd-party AV is active)
    "$d=$null; try { $m=Get-MpComputerStatus -ErrorAction Stop; $d=@{ " +
    "  realTimeProtection=[bool]$m.RealTimeProtectionEnabled; antivirusEnabled=[bool]$m.AntivirusEnabled; " +
    "  tamperProtection=[bool]$m.IsTamperProtected; " +
    "  signatureAgeDays=[int]$m.AntivirusSignatureAge; " +
    "  lastQuickScan=if($m.QuickScanEndTime){$m.QuickScanEndTime.ToString('yyyy-MM-dd')}else{$null}; " +
    "  lastFullScan=if($m.FullScanEndTime){$m.FullScanEndTime.ToString('yyyy-MM-dd')}else{$null} } } catch {}; " +
    // Firewall per profile
    "$fw=@(); try { Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object { " +
    "  $fw += @{ profile=[string]$_.Name; enabled=[bool]$_.Enabled } } } catch {}; " +
    // Disk encryption
    "$enc='unknown'; try { $b=Get-BitLockerVolume -MountPoint 'C:' -ErrorAction Stop; " +
    "  $enc=[string]$b.ProtectionStatus } catch {}; " +
    // UAC + SmartScreen
    "$uac=$null; try { $uac=[bool](Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA -ErrorAction Stop).EnableLUA } catch {}; " +
    "$ss=$null; try { $ss=[string](Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer' -Name SmartScreenEnabled -ErrorAction Stop).SmartScreenEnabled } catch {}; " +
    "@{ antivirusProducts=$av; defender=$d; firewallProfiles=$fw; diskEncryptionC=$enc; uacEnabled=$uac; smartScreen=$ss } | ConvertTo-Json -Depth 5"
  );
  return out || {};
}

// Recent Defender detections / quarantine history.
async function getThreatHistory() {
  const out = await psJson(
    "$t=@(); try { Get-MpThreatDetection -ErrorAction Stop | Sort-Object InitialDetectionTime -Descending | " +
    "  Select-Object -First 15 | ForEach-Object { $id=$_; $name='unknown'; " +
    "    try { $name=[string](Get-MpThreat -ThreatID $_.ThreatID -ErrorAction Stop).ThreatName } catch {}; " +
    "    $t += @{ threat=$name; detected=$id.InitialDetectionTime.ToString('yyyy-MM-dd HH:mm'); " +
    "             action=[string]$id.ActionSuccess; resources=@($id.Resources) | Select-Object -First 2 } } } catch {}; " +
    "@{ detections=$t } | ConvertTo-Json -Depth 5"
  );
  const d = (out && out.detections) || [];
  return { detectionCount: d.length, detections: d };
}

// Accounts with local administrator rights (privilege sprawl is a common risk).
async function listLocalAdmins() {
  const out = await psJson(
    "$m=@(); try { Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object { " +
    "  $m += @{ name=[string]$_.Name; type=[string]$_.ObjectClass; source=[string]$_.PrincipalSource } } } catch {}; " +
    "@{ admins=$m } | ConvertTo-Json -Depth 4"
  );
  const a = (out && out.admins) || [];
  return { adminCount: a.length, admins: a };
}

// Third-party endpoint security (Heimdal). Alpha Web resells Heimdal, so its
// detections matter as much as Defender's — and customers frequently ask
// "is this flag real, or has it hit one of our own files?".
//
// Heimdal writes JSON-per-line logs; detections appear as
//   "[WD][REPORT] New Infected file detected: <path>"
// The [WD] prefix means Heimdal's Next-Gen Antivirus is orchestrating Windows
// Defender on that machine, so its quarantine view surfaces Defender detections
// (get_threat_history covers those) plus anything Heimdal holds itself.
async function getHeimdalDetections() {
  const out = await psJson(
    "$root = Join-Path $env:ProgramData 'Heimdal Security'; " +
    "if (-not (Test-Path $root)) { @{ installed=$false } | ConvertTo-Json; exit }; " +
    // Version + which protection modules are actually running
    "$svc = @(); Get-Service -ErrorAction SilentlyContinue | " +
    "  Where-Object { $_.DisplayName -like 'Heimdal*' } | " +
    "  ForEach-Object { $svc += @{ name=[string]$_.DisplayName; status=[string]$_.Status } }; " +
    "$ver = $null; " +
    // Detections from the antivirus logs (last 60 days of files, newest first)
    "$dets = @(); " +
    "$logs = Get-ChildItem (Join-Path $root 'HeimdalLogs\\Heimdal.Antivirus\\*.log') -ErrorAction SilentlyContinue | " +
    "  Sort-Object LastWriteTime -Descending | Select-Object -First 60; " +
    "foreach ($f in $logs) { " +
    "  foreach ($line in (Select-String -Path $f.FullName -Pattern 'Infected file detected|quarantine.*restored|Threat removed' -ErrorAction SilentlyContinue)) { " +
    "    try { $o = $line.Line | ConvertFrom-Json; " +
    "      if ($null -eq $ver) { $ver = [string]$o.Version } " +
    "      $dets += @{ at=[string]$o.Timestamp; message=[string]$o.Message } } catch {} } }; " +
    "$dets = $dets | Sort-Object at -Descending | Select-Object -First 40; " +
    "@{ installed=$true; version=$ver; services=$svc; detections=$dets } | ConvertTo-Json -Depth 5"
  );
  if (!out || out.installed === false) {
    return { installed: false, note: 'Heimdal is not installed on this PC.' };
  }
  const raw = out.detections ? (Array.isArray(out.detections) ? out.detections : [out.detections]) : [];
  // Pull the file path out of the log message so the AI can judge what was hit.
  const detections = raw.map((d) => {
    const m = /detected:\s*(.+?)\s*$/i.exec(d.message || '');
    return {
      at: d.at,
      file: m ? m[1] : null,
      viaWindowsDefender: /^\[WD\]/.test(d.message || ''),
      message: (d.message || '').slice(0, 300),
    };
  });
  const svc = out.services ? (Array.isArray(out.services) ? out.services : [out.services]) : [];
  return {
    installed: true,
    version: out.version || null,
    modulesRunning: svc.filter((s) => s.status === 'Running').length,
    modules: svc,
    detectionCount: detections.length,
    detections,
    note: 'Heimdal logs are retained for a limited period, so older quarantined items may not appear here — check the Heimdal console for the full list.',
  };
}

// ---- Security hardening (Tier-2, consent-gated, SAFE DIRECTION ONLY) ----

async function updateDefenderSignatures() {
  await ps('Update-MpSignature -ErrorAction Stop');
  const st = await psJson("(Get-MpComputerStatus) | Select-Object @{n='ageDays';e={[int]$_.AntivirusSignatureAge}} | ConvertTo-Json");
  return { done: true, signatureAgeDays: st && st.ageDays,
           action: 'Updated the antivirus definitions to the latest available.' };
}

async function runSecurityScan() {
  // Quick scan: checks the places malware actually lives. Minutes, not hours.
  await ps('Start-MpScan -ScanType QuickScan -ErrorAction Stop');
  const t = await getThreatHistory();
  return { done: true, detectionCount: t.detectionCount, detections: t.detections,
           action: t.detectionCount
             ? `Quick scan finished. ${t.detectionCount} item(s) in the threat history.`
             : 'Quick scan finished — nothing harmful found.' };
}

// Turn protection ON only. There is intentionally no counterpart to switch
// anything off.
async function enableProtection(params) {
  const what = params && params.protection;
  if (what === 'firewall') {
    await ps('Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -ErrorAction Stop');
    const fw = await psJson("Get-NetFirewallProfile | Select-Object @{n='p';e={$_.Name}},@{n='on';e={[bool]$_.Enabled}} | ConvertTo-Json");
    return { done: true, firewall: fw, action: 'Turned the Windows Firewall on for all network profiles.' };
  }
  if (what === 'realtime_protection') {
    await ps('Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction Stop');
    const st = await psJson("(Get-MpComputerStatus) | Select-Object @{n='rtp';e={[bool]$_.RealTimeProtectionEnabled}} | ConvertTo-Json");
    return { done: !!(st && st.rtp), action: 'Turned real-time antivirus protection back on.' };
  }
  throw new Error(`'${what}' is not a protection this tool can enable`);
}

// ---- Level 2 deployment: install from the approved, hash-pinned catalog ----

// Check whether a catalogued product is already installed (Tier-0, read-only).
function checkInstalled(params) {
  const entry = getEntry(params && params.productId);
  if (!entry) {
    throw new Error(`'${params && params.productId}' is not in the approved installer catalog`);
  }
  const installed = fs.existsSync(entry.verifyPath);
  return { productId: params.productId, product: entry.product, installed, checkedPath: entry.verifyPath };
}

// Download over HTTPS to a file, following redirects, with a size cap.
// Redirects must stay on https — never follow an http/file/unc hop.
function download(url, dest, maxBytes = 200 * 1024 * 1024, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) return reject(new Error('installer URL must be https'));
    https.get(url, { timeout: 120000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        let next = res.headers.location;
        try {
          // Relative Location headers resolve against the current URL.
          next = new URL(next, url).href;
        } catch {
          return reject(new Error('redirect target is not a valid URL'));
        }
        if (!/^https:\/\//i.test(next)) {
          return reject(new Error('redirect left HTTPS — refusing to follow'));
        }
        return resolve(download(next, dest, maxBytes, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed: HTTP ${res.statusCode}`)); }
      let bytes = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) { res.destroy(); file.destroy(); reject(new Error('installer exceeded size limit')); }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(bytes)));
      file.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('download timed out')); });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// Tier-2. The AI may only pass a catalog ID — never a URL, filename or arguments.
// Sequence: resolve entry -> download pinned URL -> verify sha256 (abort on
// mismatch) -> run with the catalog's fixed args -> verify the install landed.
// Validate deployment parameters (e.g. a Gespage server address) against the
// catalog's schema. The model may supply the VALUE, but never the parameter name
// and never a value that fails the catalog's pattern — so nothing can be
// smuggled onto the command line.
function validateParams(entry, supplied) {
  const schema = entry.params || {};
  const given = supplied || {};
  const out = {};
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new Error(`'${key}' is not a parameter this installer accepts`);
    }
  }
  for (const [key, rule] of Object.entries(schema)) {
    const val = given[key];
    if (val == null || val === '') {
      if (rule.required) throw new Error(`missing required setting: ${key} (${rule.describe || key})`);
      continue;
    }
    const s = String(val);
    if (!new RegExp(rule.pattern).test(s)) {
      throw new Error(`the value given for ${key} is not valid (${rule.describe || key})`);
    }
    out[key] = s;
  }
  return out;
}

async function deploySoftware(params) {
  const id = params && params.productId;
  const entry = getEntry(id);
  if (!entry) throw new Error(`'${id}' is not in the approved installer catalog`);
  // Validate BEFORE downloading anything.
  const deployParams = validateParams(entry, params && params.settings);
  if (!entry.sha256 || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
    // Fail closed: an entry without a valid pinned hash can never run.
    throw new Error(`catalog entry '${id}' has no valid pinned checksum — refusing to install`);
  }
  if (fs.existsSync(entry.verifyPath)) {
    return { done: true, alreadyInstalled: true, product: entry.product,
             action: `${entry.product} is already installed — nothing to do.` };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awi-resolve-'));
  const isMsi = entry.installerType === 'msi';
  const file = path.join(dir, isMsi ? 'installer.msi' : 'installer.exe');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  try {
    const bytes = await download(entry.url, file);
    const digest = await sha256File(file);
    if (digest.toLowerCase() !== entry.sha256.toLowerCase()) {
      cleanup();
      throw new Error(
        `SECURITY: installer checksum mismatch for ${entry.product} — expected ${entry.sha256}, got ${digest}. Installation aborted.`
      );
    }

    // Build the command. Arguments come from the catalog; validated parameters
    // are appended as KEY=VALUE. execFile (not a shell) so nothing is re-parsed.
    const paramArgs = Object.entries(deployParams).map(([k, v]) => `${k}=${v}`);
    const exe = isMsi ? 'msiexec.exe' : file;
    const argv = isMsi ? ['/i', file, ...entry.args, ...paramArgs] : [...entry.args, ...paramArgs];

    await new Promise((resolve, reject) => {
      execFile(exe, argv, { timeout: INSTALL_TIMEOUT_MS, windowsHide: true }, (err) => {
        if (err) return reject(new Error(`installer failed: ${err.message.split('\n')[0]}`));
        resolve();
      });
    });

    const installed = fs.existsSync(entry.verifyPath);
    cleanup();
    return {
      done: installed, product: entry.product, version: entry.version,
      downloadedBytes: bytes, checksumVerified: true, verifyPath: entry.verifyPath,
      action: installed
        ? `Installed ${entry.product} ${entry.version} (checksum verified).`
        : `Ran the ${entry.product} installer, but ${entry.verifyPath} was not found afterwards.`,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---- Org / pinned deploy (spec §6 v1.3) ----
// The AI never supplies these fields. The orchestrator resolves an
// IT-admin-approved org library entry (or similar) and sends a pinned
// payload: productName + https url + required sha256 + installer type.

const FORBIDDEN_INSTALL_EXT = /\.(ps1|bat|cmd|vbs|js|jse|wsf|wsh|zip|7z|rar|tar|gz|iso|img|scr|com|pif)(\?|$)/i;

function classifyManualInstaller(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('installer URL is not valid'); }
  if (parsed.protocol !== 'https:') throw new Error('installer URL must be https');
  const pathname = decodeURIComponent(parsed.pathname || '');
  const base = path.basename(pathname).split('?')[0];
  if (!base || FORBIDDEN_INSTALL_EXT.test(pathname) || FORBIDDEN_INSTALL_EXT.test(base)) {
    throw new Error('refusing this file type — only .exe or .msi installers are allowed');
  }
  const lower = base.toLowerCase();
  if (lower.endsWith('.msi')) return { kind: 'msi', fileName: base || 'installer.msi', host: parsed.host, href: parsed.href };
  if (lower.endsWith('.exe')) return { kind: 'exe', fileName: base || 'installer.exe', host: parsed.host, href: parsed.href };
  throw new Error('installer URL must end in .exe or .msi');
}

async function deployPinnedSoftware(params) {
  const productName = String((params && params.productName) || '').trim().slice(0, 120);
  if (!productName) throw new Error('productName is required');
  const url = String((params && params.url) || '').trim();
  if (!url) throw new Error('url is required');
  const info = classifyManualInstaller(url);

  const rawHash = params && params.sha256 != null ? String(params.sha256).trim() : '';
  if (!/^[a-f0-9]{64}$/i.test(rawHash)) {
    throw new Error('sha256 is required — refusing to install without a pinned checksum');
  }
  const expectHash = rawHash.toLowerCase();

  const kind = (params && params.installerType) === 'msi' ? 'msi' : info.kind;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awi-resolve-pinned-'));
  const file = path.join(dir, kind === 'msi' ? 'installer.msi' : 'installer.exe');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  try {
    const bytes = await download(info.href, file);
    const digest = await sha256File(file);
    if (digest !== expectHash) {
      cleanup();
      throw new Error(
        `SECURITY: installer checksum mismatch for ${productName} — expected ${expectHash}, got ${digest}. Installation aborted.`
      );
    }

    const exe = kind === 'msi' ? 'msiexec.exe' : file;
    const argv = kind === 'msi' ? ['/i', file, '/qn'] : ['/S'];

    await new Promise((resolve, reject) => {
      execFile(exe, argv, { timeout: INSTALL_TIMEOUT_MS, windowsHide: true }, (err) => {
        if (err) return reject(new Error(`installer failed: ${err.message.split('\n')[0]}`));
        resolve();
      });
    });

    cleanup();
    return {
      done: true,
      product: productName,
      url: info.href,
      host: info.host,
      downloadedBytes: bytes,
      checksumVerified: true,
      action: `Downloaded and installed ${productName} from ${info.host} (IT-admin approved, checksum verified).`,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// Full IT Support only — orchestrator dual-gates (licence plan `full` + org
// admin allowFullItSupport) before this tool is ever sent to the agent.
async function runPowerShell(params) {
  const command = String((params && params.command) || '').trim();
  if (!command) throw new Error('command is required');
  if (command.length > FULL_PS_MAX_COMMAND) {
    throw new Error(`command exceeds ${FULL_PS_MAX_COMMAND} character limit`);
  }

  // EncodedCommand avoids shell metacharacter issues; execFile (not a shell).
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const started = Date.now();
  const result = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: FULL_PS_TIMEOUT_MS, maxBuffer: FULL_PS_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const trunc = (s) => {
          const t = String(s || '');
          if (t.length <= FULL_PS_MAX_OUTPUT) return { text: t, truncated: false };
          return { text: t.slice(0, FULL_PS_MAX_OUTPUT) + '\n…[output truncated]', truncated: true };
        };
        const out = trunc(stdout);
        const errOut = trunc(stderr);
        const exitCode = err && typeof err.code === 'number' ? err.code
          : (err && err.killed ? null : 0);
        resolve({
          exitCode: exitCode == null ? -1 : exitCode,
          timedOut: !!(err && err.killed),
          stdout: out.text,
          stderr: errOut.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: errOut.truncated,
          durationMs: Date.now() - started,
          error: err && !err.killed ? String(err.message || '').split('\n')[0] : null,
        });
      }
    );
  });

  return {
    ...result,
    command,
    action: result.timedOut
      ? `PowerShell timed out after ${FULL_PS_TIMEOUT_MS / 1000}s (command was not completed).`
      : `Ran consented PowerShell command (exit ${result.exitCode}).`,
  };
}

// The complete allowlist. Adding a tool here requires a spec version bump (§6).
//   tier 0 = read-only diagnostic — runs silently.
//   tier 1 = low-risk fix       — runs without a prompt, shown live in the feed.
//   tier 2 = state-changing fix — requires customer consent. `consent(params)`
//            returns the plain-language prompt text; it is TEMPLATE-generated here
//            from {tool, params}, never written by the AI model (spec §9.3), so a
//            hijacked model can't forge what the customer sees.
const TOOLS = {
  // Tier 0
  get_system_snapshot: { tier: 0, run: () => getSystemSnapshot() },
  read_service_status: { tier: 0, run: (p) => readServiceStatus(p) },
  get_print_queue:     { tier: 0, run: () => getPrintQueue() },
  read_event_log:      { tier: 0, run: (p) => readEventLog(p) },
  test_network:        { tier: 0, run: (p) => testNetwork(p) },
  get_temp_usage:      { tier: 0, run: () => getTempUsage() },
  check_installed:     { tier: 0, run: (p) => checkInstalled(p) },
  list_approved_software: { tier: 0, run: () => ({ products: listProducts() }) },
  list_processes:      { tier: 0, run: () => listProcesses() },
  list_startup_items:  { tier: 0, run: () => listStartupItems() },
  get_disk_health:     { tier: 0, run: () => getDiskHealth() },
  list_problem_devices:{ tier: 0, run: () => listProblemDevices() },
  list_installed_programs: { tier: 0, run: () => listInstalledPrograms() },
  get_network_config:  { tier: 0, run: () => getNetworkConfig() },
  get_update_status:   { tier: 0, run: () => getUpdateStatus() },
  get_security_posture:{ tier: 0, run: () => getSecurityPosture() },
  get_threat_history:  { tier: 0, run: () => getThreatHistory() },
  list_local_admins:   { tier: 0, run: () => listLocalAdmins() },
  get_heimdal_detections: { tier: 0, run: () => getHeimdalDetections() },
  // Tier 1
  clear_dns_cache:     { tier: 1, run: () => clearDnsCache(), note: 'Flushing the DNS cache' },
  // Tier 2
  restart_service: {
    tier: 2,
    run: (p) => restartService(p),
    consent: (p) =>
      `I'd like to restart the ${SERVICE_LABELS[p.service] || p.service} service. ` +
      (p.service === 'Spooler'
        ? 'Any documents currently waiting to print will be cancelled and need re-printing.'
        : 'A brief interruption to that service is expected.') +
      ' Is that OK?',
  },
  clear_print_queue: {
    tier: 2,
    run: () => clearPrintQueue(),
    consent: () =>
      "I'd like to delete the stuck print jobs so new documents can print. " +
      'Anything currently in the queue will need to be sent again. Is that OK?',
  },
  enable_service: {
    tier: 2,
    run: (p) => enableService(p),
    consent: (p) =>
      `The ${SERVICE_LABELS[p && p.service] || (p && p.service)} service is switched off. ` +
      `I'd like to turn it on and set it to start automatically from now on. Is that OK?`,
  },
  restart_explorer: {
    tier: 2,
    run: () => restartExplorer(),
    consent: () =>
      "I'd like to restart Windows Explorer (your taskbar and desktop). They'll blink off for a " +
      'second and come back — open windows and files are not affected. Is that OK?',
  },
  renew_network: {
    tier: 2,
    run: () => renewNetwork(),
    consent: () =>
      "I'd like to renew this PC's network address and clear the DNS cache. Your connection will " +
      'drop for a few seconds. Is that OK?',
  },
  update_defender_signatures: {
    tier: 2,
    run: () => updateDefenderSignatures(),
    consent: () =>
      "Your antivirus definitions are out of date. I'd like to download the latest ones now — " +
      'this only makes your protection stronger. Is that OK?',
  },
  run_security_scan: {
    tier: 2,
    run: () => runSecurityScan(),
    consent: () =>
      "I'd like to run a quick antivirus scan of the places malware usually hides. It takes a few " +
      "minutes and you can keep working, though the PC may feel a little slower. Is that OK?",
  },
  enable_protection: {
    tier: 2,
    run: (p) => enableProtection(p),
    consent: (p) =>
      (p && p.protection === 'firewall'
        ? "The Windows Firewall is switched off. I'd like to turn it back on for all networks."
        : 'Real-time antivirus protection is switched off. I\'d like to turn it back on.') +
      ' This only increases your protection — I have no way to switch protection off. Is that OK?',
  },
  deploy_software: {
    tier: 2,
    run: (p) => deploySoftware(p),
    consent: (p) => {
      const e = getEntry(p && p.productId);
      const what = e ? `${e.product} ${e.version} — ${e.describe}` : `'${p && p.productId}' (not in the approved catalog)`;
      return `I'd like to download and install ${what} on this PC. ` +
             `I'll check the download is genuine (checksum) before running it, and it comes only from Alpha Web's approved list. Is that OK?`;
    },
  },
  // Called only after the orchestrator resolves an IT-admin org-library entry.
  // The AI never names this tool — it calls deploy_org_software (cloud-side).
  deploy_pinned_software: {
    tier: 2,
    run: (p) => deployPinnedSoftware(p),
    consent: (p) => {
      const name = String((p && p.productName) || 'this software').trim().slice(0, 120);
      let host = '(unknown host)';
      let href = String((p && p.url) || '').trim();
      try {
        const u = new URL(href);
        host = u.host;
        href = u.href;
      } catch { /* show raw */ }
      return `I'd like to download and install ${name}. Your IT admin approved this package for your organisation.\n` +
             `Download host: ${host}\n` +
             `Full URL: ${href}\n` +
             `I will verify the file checksum before running a silent install. Is that OK?`;
    },
  },
  clean_temp_files: {
    tier: 2,
    run: () => cleanTempFiles(),
    consent: () =>
      "I'd like to delete temporary files older than a day to free up disk space. " +
      'Windows and your apps automatically recreate any they still need, and nothing ' +
      'personal is touched. Is that OK?',
  },
  // Full IT Support only (licence plan `full` + org admin allowFullItSupport).
  // Consent always shows the exact command — never AI-authored prose alone.
  run_powershell: {
    tier: 2,
    run: (p) => runPowerShell(p),
    consent: (p) => {
      const cmd = String((p && p.command) || '').trim();
      const shown = cmd.length > 1200 ? `${cmd.slice(0, 1200)}\n…[command truncated in prompt; full command is audited]` : cmd;
      return `Full IT Support wants to run this PowerShell command on your PC:\n\n${shown || '(empty)'}\n\n` +
             'This can change software, files, or settings on this machine. Approve only if you trust it. Is that OK?';
    },
  },
};

module.exports = { TOOLS };
