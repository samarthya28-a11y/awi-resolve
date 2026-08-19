'use strict';
// AWI Resolve — per-session report (spec §7 transparency artifact, §9.4 replay).
//
// Every ticket produces a permanent, self-contained record of exactly what
// happened: every check run, every change made, and — just as important — every
// action that was NOT taken and why. Kept as JSON (records/audit) plus a
// readable HTML page for the customer or a human technician.

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// Plain-English names so a non-technical reader understands the record.
const TOOL_LABELS = {
  get_system_snapshot: 'Checked the PC overview (Windows, memory, disk, printers)',
  read_service_status: 'Checked a Windows service',
  get_print_queue: 'Checked the print queue',
  read_event_log: 'Read the Windows event log',
  test_network: 'Tested network reachability',
  get_temp_usage: 'Measured temporary-file usage',
  list_processes: 'Listed the programs using most memory',
  list_startup_items: 'Listed programs that start at sign-in',
  get_disk_health: 'Checked drive health',
  list_problem_devices: 'Checked for faulty devices',
  list_installed_programs: 'Listed installed programs',
  get_network_config: 'Checked network settings',
  get_update_status: 'Checked Windows Update status',
  get_security_posture: 'Checked security protection status',
  get_threat_history: 'Reviewed past malware detections',
  get_heimdal_detections: 'Read Heimdal endpoint security detections',
  list_local_admins: 'Listed administrator accounts',
  check_installed: 'Checked whether software is installed',
  list_approved_software: 'Listed approved software',
  search_knowledge_base: 'Searched the product documentation',
  read_deployment_manual: 'Read a deployment manual',
  clear_dns_cache: 'Cleared the DNS cache',
  restart_service: 'Restarted a Windows service',
  enable_service: 'Enabled a Windows service',
  clear_print_queue: 'Cleared stuck print jobs',
  clean_temp_files: 'Deleted old temporary files',
  restart_explorer: 'Restarted Windows Explorer',
  renew_network: 'Renewed the network address',
  update_defender_signatures: 'Updated antivirus definitions',
  run_security_scan: 'Ran an antivirus scan',
  enable_protection: 'Turned a protection back on',
  deploy_software: 'Installed approved software',
};

// Read-only naming convention. Tested against the tool NAME rather than a fixed
// list, so a newly added read-only tool can never be mislabelled as a change to
// the machine (which would wrongly tell a customer we modified something).
const READ_ONLY_PREFIX = /^(get_|list_|read_|check_|test_|search_)/;
function isReadOnly(tool) { return READ_ONLY_PREFIX.test(tool); }

function label(t) { return TOOL_LABELS[t] || t; }

function describeInput(input) {
  if (!input || !Object.keys(input).length) return '';
  return Object.entries(input).map(([k, v]) => `${k}: ${v}`).join(', ');
}

// Split every attempted action into what actually happened.
function classify(toolCalls) {
  const checks = [], changes = [], notDone = [];
  for (const c of toolCalls) {
    const entry = {
      at: c.at, tool: c.tool, what: label(c.tool),
      detail: describeInput(c.input), result: c.result || null, reason: c.reason || null,
    };
    if (c.status === 'ok') {
      (isReadOnly(c.tool) ? checks : changes).push(entry);
      continue;
    }
    // Everything else is something that did NOT happen — record why, plainly.
    let why, category;
    switch (c.status) {
      case 'declined_by_customer':
        category = 'Declined by the customer';
        why = c.reason || 'The customer chose not to approve this action.';
        break;
      case 'timeout':
        category = 'No answer to the approval request';
        why = 'The approval prompt was not answered, so the action was not performed.';
        break;
      case 'refused':
        category = 'Blocked by the security allowlist';
        why = c.reason || 'The action is not permitted by the agent and was refused on the device.';
        break;
      case 'error':
        category = 'Attempted but did not complete';
        why = c.reason || 'The action failed.';
        break;
      default:
        category = 'Not completed';
        why = c.reason || `Status: ${c.status}`;
    }
    notDone.push({ ...entry, category, why });
  }
  return { checks, changes, notDone };
}

// Pull the AI's own "NOT DONE" section out of its closing report.
function extractSection(report, name) {
  const re = new RegExp(`^\\*{0,2}${name}\\*{0,2}\\s*:\\s*([\\s\\S]*?)(?=\\n\\*{0,2}(?:DIAGNOSIS|FIX|OUTCOME|NOT DONE|EVIDENCE|CONFIDENCE)\\*{0,2}\\s*:|$)`, 'im');
  const m = report.match(re);
  return m ? m[1].trim() : null;
}

function buildReport(ticket) {
  const { checks, changes, notDone } = classify(ticket.toolCalls || []);
  return {
    reportId: `${new Date(ticket.generatedAt).toISOString().replace(/[:.]/g, '-')}_${(ticket.deviceId || '').slice(0, 8)}`,
    generatedAt: ticket.generatedAt,
    deviceId: ticket.deviceId,
    hostname: ticket.hostname || null,
    model: ticket.model,
    request: ticket.ticket,
    durationSec: ticket.durationSec,
    steps: ticket.steps,
    outcome: {
      escalated: !!ticket.escalated,
      customerDeclined: !!ticket.customerDeclined,
      changesMade: changes.length,
      checksRun: checks.length,
      actionsNotTaken: notDone.length,
    },
    // What this session cost to run. Stored so unit economics can be computed
    // from history rather than re-measured by hand; `unit-economics.js` reads it.
    usage: ticket.usage || null,
    // Sections of the AI's own closing summary
    summary: {
      diagnosis: extractSection(ticket.report || '', 'DIAGNOSIS'),
      fix: extractSection(ticket.report || '', 'FIX'),
      result: extractSection(ticket.report || '', 'OUTCOME'),
      notDone: extractSection(ticket.report || '', 'NOT DONE'),
      evidence: extractSection(ticket.report || '', 'EVIDENCE'),
      confidence: extractSection(ticket.report || '', 'CONFIDENCE'),
    },
    checksRun: checks,
    changesMade: changes,
    actionsNotTaken: notDone,
    fullNarrative: ticket.report || '',
  };
}

function saveReport(report) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${report.reportId}.json`),
    JSON.stringify(report, null, 2));
  return report.reportId;
}

function listReports(limit = 50) {
  let files = [];
  try { files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  files.sort().reverse();
  return files.slice(0, limit).map((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
      return {
        reportId: r.reportId, generatedAt: r.generatedAt, hostname: r.hostname,
        request: r.request, durationSec: r.durationSec, outcome: r.outcome,
        diagnosis: r.summary && r.summary.diagnosis,
      };
    } catch { return null; }
  }).filter(Boolean);
}

function getReport(id) {
  if (!/^[\w.\-]+$/.test(String(id || ''))) return null;   // no path traversal
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, `${id}.json`), 'utf8'));
  } catch { return null; }
}

module.exports = { buildReport, saveReport, listReports, getReport, REPORTS_DIR };
