'use strict';
// AWI Resolve agent — the ONLY actions this agent can ever perform (spec §6).
// Anything not registered here is refused, no matter who asks — including our own
// server. Adding a tool requires a code change + spec version bump, never config.

const { execFile } = require('child_process');
const os = require('os');

const PS_TIMEOUT_MS = 30000;

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

// The complete allowlist. tier 0 = read-only diagnostic, runs without consent.
// Tier 1/2 tools arrive in Phase 2 together with the consent UI.
const TOOLS = {
  get_system_snapshot: { tier: 0, run: () => getSystemSnapshot() },
  read_service_status: { tier: 0, run: (p) => readServiceStatus(p) },
  get_print_queue:     { tier: 0, run: () => getPrintQueue() },
  read_event_log:      { tier: 0, run: (p) => readEventLog(p) },
  test_network:        { tier: 0, run: (p) => testNetwork(p) },
};

module.exports = { TOOLS };
