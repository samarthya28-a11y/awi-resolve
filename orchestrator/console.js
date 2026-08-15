// Customer-facing usage console.
//
// Answers one question for the customer: what has Resolve actually been doing
// on our PCs, and is anyone misusing it? That is a fair thing to ask of a tool
// with this much reach, and answering it in the product is a better argument
// than any assurance on a website.
//
// Everything here is scoped to ONE organisation. The scoping is deliberately
// done by filtering to a known device set rather than by trusting anything in
// the request: a customer must never be able to widen their own view, and the
// failure mode of a leaky console on a security product is severe.

const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');

const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch { return {}; }
}

/** Device ids belonging to this org. The only source of scope. */
function devicesForOrg(customerId) {
  const all = loadDevices();
  const out = {};
  for (const [id, d] of Object.entries(all)) {
    if (d && d.customerId === customerId) out[id] = d;
  }
  return out;
}

function loadReports() {
  let files = [];
  try { files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

// Signals a customer would reasonably call misuse, or at least want to look at.
// Kept factual — the console reports what happened and lets the customer judge,
// rather than accusing anyone.
function flagsFor(report) {
  const flags = [];
  const changes = Array.isArray(report.changesMade) ? report.changesMade : [];
  const notDone = Array.isArray(report.actionsNotTaken) ? report.actionsNotTaken : [];

  const shell = changes.filter((c) => /powershell/i.test(c.tool || ''));
  if (shell.length) flags.push({ kind: 'powershell', label: `${shell.length} PowerShell command(s) run`, severity: 'review' });

  const installs = changes.filter((c) => /deploy_software|install/i.test(c.tool || ''));
  if (installs.length) flags.push({ kind: 'install', label: `${installs.length} software install(s)`, severity: 'review' });

  const declined = notDone.filter((c) => /declined/i.test(c.category || '') || /declined/i.test(c.why || ''));
  if (declined.length) flags.push({ kind: 'declined', label: `${declined.length} action(s) the user declined`, severity: 'info' });

  const unlicensed = notDone.filter((c) => /licen/i.test(c.why || ''));
  if (unlicensed.length) flags.push({ kind: 'unlicensed', label: 'blocked by licence', severity: 'info' });

  return flags;
}

/**
 * Everything the console shows for one organisation.
 * `customerId` is trusted only because the caller has already proven the org
 * admin token for it.
 */
function orgView(customerId) {
  const devices = devicesForOrg(customerId);
  const deviceIds = new Set(Object.keys(devices));

  const sessions = loadReports()
    .filter((r) => deviceIds.has(r.deviceId))
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
    .map((r) => ({
      reportId: r.reportId,
      at: r.generatedAt,
      deviceId: r.deviceId,
      hostname: (devices[r.deviceId] && devices[r.deviceId].hostname) || r.hostname || 'unknown',
      request: r.request,
      escalated: !!(r.outcome && r.outcome.escalated),
      declined: !!(r.outcome && r.outcome.customerDeclined),
      checksRun: (r.outcome && r.outcome.checksRun) || 0,
      changesMade: (r.outcome && r.outcome.changesMade) || 0,
      // What was actually done, in the customer's words not ours.
      changes: (r.changesMade || []).map((c) => c.what || c.tool),
      flags: flagsFor(r),
    }));

  const flagged = sessions.filter((s) => s.flags.some((f) => f.severity === 'review'));
  const byDevice = {};
  for (const s of sessions) {
    byDevice[s.deviceId] = byDevice[s.deviceId] || { hostname: s.hostname, sessions: 0, changes: 0, flagged: 0 };
    byDevice[s.deviceId].sessions += 1;
    byDevice[s.deviceId].changes += s.changesMade;
    if (s.flags.some((f) => f.severity === 'review')) byDevice[s.deviceId].flagged += 1;
  }

  // Ticket balance and quotas. Shown alongside usage because "how many tickets
  // are left" and "who is spending them" are the same question to an admin.
  const tickets = ledger.summary(customerId);
  if (tickets.metered) {
    // Attach the hostname to per-device consumption — an admin thinks in PCs,
    // not device ids.
    tickets.perDeviceNamed = Object.entries(tickets.perDeviceThisPeriod || {}).map(([id, n]) => ({
      deviceId: id,
      hostname: (devices[id] && devices[id].hostname) || 'unknown',
      used: n,
      group: tickets.groups[id] || null,
      quota: tickets.quotas[id] != null ? tickets.quotas[id] : null,
    })).sort((a, b) => b.used - a.used);
  }

  return {
    customerId,
    generatedAt: new Date().toISOString(),
    tickets,
    totals: {
      devices: deviceIds.size,
      sessions: sessions.length,
      changes: sessions.reduce((n, s) => n + s.changesMade, 0),
      declined: sessions.filter((s) => s.declined).length,
      flaggedForReview: flagged.length,
    },
    devices: Object.entries(byDevice).map(([id, d]) => ({ deviceId: id, ...d })),
    sessions: sessions.slice(0, 200),
  };
}

module.exports = { orgView, devicesForOrg };
