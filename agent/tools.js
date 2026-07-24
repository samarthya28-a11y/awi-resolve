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
};

module.exports = { TOOLS };
