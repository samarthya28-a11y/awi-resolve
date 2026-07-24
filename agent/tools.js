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

async function clearPrintQueue() {
  // Count first (for an honest result), then remove every queued job.
  const before = await getPrintQueue();
  await ps('Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob }');
  const after = await getPrintQueue();
  return { done: true, jobsCleared: before.jobCount - after.jobCount, jobsRemaining: after.jobCount };
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
};

module.exports = { TOOLS };
