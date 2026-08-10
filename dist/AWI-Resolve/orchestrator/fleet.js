'use strict';
// AWI Resolve — fleet security posture.
//
// Stores the latest posture report from every enrolled machine and turns it into
// a prioritised risk view for the ops dashboard. Reports are read-only summaries
// (no file contents, no personal data).
//
// NOTE: this writes to local disk, which is ephemeral on the cloud host. Before a
// real pilot this should move to Supabase (db/schema.sql is ready).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FLEET_FILE = path.join(DATA_DIR, 'fleet.json');

const STALE_DEFINITIONS_DAYS = 3;
const OFFLINE_AFTER_HOURS = 24;

function load() {
  try { return JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8')); } catch { return {}; }
}

function save(fleet) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
}

function recordPosture(deviceId, report) {
  const fleet = load();
  fleet[deviceId] = {
    deviceId,
    hostname: report.hostname || 'unknown',
    agentVersion: report.agentVersion || null,
    lastReport: report.at || new Date().toISOString(),
    posture: report.posture || null,
    threats: report.threats || null,
    admins: report.admins || null,
    updates: report.updates || null,
    problemDevices: report.problemDevices ?? null,
    machine: report.machine || null,
  };
  save(fleet);
  return fleet[deviceId];
}

// Turn one machine's raw posture into concrete, ranked findings.
// severity: 'critical' (actively unprotected) | 'warning' | 'info'
function assess(dev) {
  const f = [];
  const p = dev.posture || {};
  const d = p.defender || null;
  const av = Array.isArray(p.antivirusProducts) ? p.antivirusProducts : [];

  // --- Protection actually switched off: critical ---
  const rtOff = (d && d.realTimeProtection === false) ||
                (av.length > 0 && av.every((a) => a.realtimeOn === false));
  if (rtOff) f.push({ severity: 'critical', code: 'realtime_off',
    title: 'Real-time antivirus protection is OFF',
    detail: 'The machine is running without live malware protection.',
    fix: 'enable_protection (realtime_protection)' });

  if (av.length === 0 && !d) f.push({ severity: 'warning', code: 'av_unknown',
    title: 'No antivirus could be detected',
    detail: 'No registered antivirus product was reported. May be a reporting failure, or genuinely unprotected.',
    fix: 'Investigate on the machine' });

  const fwOff = (p.firewallProfiles || []).filter((x) => x.enabled === false).map((x) => x.profile);
  if (fwOff.length) f.push({ severity: 'critical', code: 'firewall_off',
    title: `Firewall OFF (${fwOff.join(', ')})`,
    detail: 'Inbound network protection is disabled for these profiles.',
    fix: 'enable_protection (firewall)' });

  // --- Weakened / stale protection: warning ---
  if (d && typeof d.signatureAgeDays === 'number' && d.signatureAgeDays > STALE_DEFINITIONS_DAYS) {
    f.push({ severity: 'warning', code: 'stale_definitions',
      title: `Antivirus definitions ${d.signatureAgeDays} days old`,
      detail: 'Newer threats may not be recognised.',
      fix: 'update_defender_signatures' });
  }
  if (d && d.tamperProtection === false) f.push({ severity: 'warning', code: 'tamper_off',
    title: 'Tamper Protection is OFF',
    detail: 'Malware could switch the antivirus off. Turn it on in Windows Security.',
    fix: 'Manual — Windows Security settings' });

  if (p.uacEnabled === false) f.push({ severity: 'warning', code: 'uac_off',
    title: 'User Account Control (UAC) is OFF',
    detail: 'Programs can gain admin rights without prompting.',
    fix: 'Manual — re-enable UAC' });

  if (d && !d.lastFullScan) f.push({ severity: 'info', code: 'no_full_scan',
    title: 'No full antivirus scan on record',
    detail: 'Quick scans only cover common hiding places.',
    fix: 'run_security_scan (quick) / schedule a full scan' });

  if (p.diskEncryptionC && String(p.diskEncryptionC).toLowerCase() !== 'on') {
    f.push({ severity: 'warning', code: 'no_encryption',
      title: 'Disk encryption not confirmed on C:',
      detail: `BitLocker protection reported as "${p.diskEncryptionC}". Data is readable if the device is lost or stolen.`,
      fix: 'Manual — enable BitLocker' });
  }

  // --- Hygiene ---
  if (dev.threats && dev.threats.detectionCount > 0) {
    f.push({ severity: 'info', code: 'past_detections',
      title: `${dev.threats.detectionCount} past malware detection(s)`,
      detail: 'Items previously blocked or quarantined. Worth reviewing what the users are downloading.',
      fix: 'Review threat history' });
  }
  if (dev.admins && dev.admins.adminCount > 2) {
    f.push({ severity: 'warning', code: 'admin_sprawl',
      title: `${dev.admins.adminCount} local administrator accounts`,
      detail: 'Extra admin accounts widen the blast radius of any compromise.',
      fix: 'Review and remove unnecessary admins' });
  }
  if (dev.updates && dev.updates.rebootPending) {
    f.push({ severity: 'warning', code: 'reboot_pending',
      title: 'Restart pending for Windows updates',
      detail: 'Security patches are not fully applied until the machine restarts.',
      fix: 'Ask the user to restart' });
  }
  if (typeof dev.problemDevices === 'number' && dev.problemDevices > 0) {
    f.push({ severity: 'info', code: 'device_faults',
      title: `${dev.problemDevices} device(s) reporting a fault`,
      detail: 'Faulty or missing drivers.', fix: 'Investigate in Device Manager' });
  }

  // --- Reachability ---
  const ageH = (Date.now() - new Date(dev.lastReport).getTime()) / 3600000;
  const offline = ageH > OFFLINE_AFTER_HOURS;
  if (offline) f.push({ severity: 'warning', code: 'stale_report',
    title: `No report for ${Math.round(ageH)} hours`,
    detail: 'The machine may be off, or the agent may have stopped.',
    fix: 'Check the machine is on and the agent is running' });

  const order = { critical: 0, warning: 1, info: 2 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);

  const status = f.some((x) => x.severity === 'critical') ? 'critical'
               : f.some((x) => x.severity === 'warning') ? 'warning' : 'ok';
  return { status, offline, findings: f };
}

function fleetView() {
  const fleet = load();
  const devices = Object.values(fleet).map((d) => ({ ...d, assessment: assess(d) }));
  const rank = { critical: 0, warning: 1, ok: 2 };
  devices.sort((a, b) => rank[a.assessment.status] - rank[b.assessment.status] ||
                          a.hostname.localeCompare(b.hostname));
  const summary = {
    total: devices.length,
    critical: devices.filter((d) => d.assessment.status === 'critical').length,
    warning: devices.filter((d) => d.assessment.status === 'warning').length,
    ok: devices.filter((d) => d.assessment.status === 'ok').length,
    offline: devices.filter((d) => d.assessment.offline).length,
    generatedAt: new Date().toISOString(),
  };
  return { summary, devices };
}

module.exports = { recordPosture, fleetView, assess };
