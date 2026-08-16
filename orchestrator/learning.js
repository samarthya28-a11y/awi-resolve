'use strict';
// Playbook feedback loop — turning resolved tickets into reusable method.
//
// What this DOES: after a ticket is resolved, write a short note saying which
// checks mattered for that symptom, so the next ticket starts from a shortlist
// instead of from nothing. Fewer steps means a faster answer and a cheaper
// ticket, and it compounds with volume.
//
// What this deliberately does NOT do: store an answer and serve it to the next
// customer. "Printer offline" has no universal answer — it depends on that
// machine's spooler, queue, port and event log. A stored verdict would be wrong
// whenever the same symptom has a different cause, which is most of the time.
// The AI still investigates the actual PC every time; a playbook only says
// where to look first.
//
// The hard requirement is SCRUBBING. These notes are searched by every
// customer, so anything identifying one of them must never survive into the
// knowledge base. Scrubbing runs before anything is written, and the writer
// refuses rather than guesses when it cannot make a note safe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KB_DIR = path.join(__dirname, '..', 'playbooks', 'kb');
const PREFIX = 'learned-';

// ---- scrubbing --------------------------------------------------------------
// Ordered most-specific first: a Windows path containing a username must be
// caught as a path before the bare-username rule sees it.
const SCRUBBERS = [
  // Windows user paths: C:\Users\jsmith\... -> C:\Users\<user>\...
  [/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1<user>'],
  [/(\/home\/)[^/\s"']+/gi, '$1<user>'],
  // UNC shares: \\SERVER\share -> \\<server>\<share>
  [/\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+/g, '\\\\<server>\\<share>'],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  // IPv4, but keep well-known public resolvers which are genuinely useful
  [/\b(?!8\.8\.8\.8|1\.1\.1\.1)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  // MAC addresses
  [/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '<mac>'],
  // Windows machine names in common shapes (LAPTOP-XXXX, DESKTOP-XXXX, PC-XXXX)
  [/\b(?:LAPTOP|DESKTOP|PC|WS|WKS)-[A-Z0-9]{4,}\b/gi, '<pc>'],
  // Serial-ish / licence-ish long tokens
  [/\bRSLIC1-[A-Za-z0-9_-]+/g, '<licence-key>'],
  [/\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3,}\b/g, '<product-key>'],
  // GUIDs (device ids, report ids)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
];

function scrub(text, extraTerms = []) {
  let out = String(text || '');
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  // Caller-supplied terms: the customer and organisation names, which no
  // generic pattern can know. Longest first so "Acme Printing Ltd" is removed
  // before "Acme" leaves a fragment behind.
  for (const term of [...extraTerms].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (String(term).trim().length < 3) continue;   // too short to match safely
    const re = new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, '<customer>');
  }
  return out;
}

/** Anything that still looks identifying after scrubbing. Used as a tripwire. */
function residualIdentifiers(text) {
  const hits = [];
  const checks = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email'],
    [/\b(?!8\.8\.8\.8|1\.1\.1\.1)(?:\d{1,3}\.){3}\d{1,3}\b/, 'ip address'],
    [/\b(?:LAPTOP|DESKTOP|PC|WS|WKS)-[A-Z0-9]{4,}\b/i, 'machine name'],
    [/[A-Za-z]:\\Users\\(?!<user>)[^\\\s]+/i, 'user path'],
  ];
  for (const [re, label] of checks) if (re.test(text)) hits.push(label);
  return hits;
}

// ---- qualification ----------------------------------------------------------
/**
 * Only resolved work teaches anything. An escalated or declined ticket records
 * that we could not finish, which is not a method worth repeating, and a
 * session with no tool calls has no method in it at all.
 */
function qualifies(report) {
  if (!report || !report.outcome) return { ok: false, why: 'no report' };
  if (report.outcome.escalated) return { ok: false, why: 'escalated — not a solved method' };
  if (report.outcome.customerDeclined) return { ok: false, why: 'customer declined the fix' };
  if ((report.outcome.checksRun || 0) < 2) return { ok: false, why: 'too few checks to be a method' };
  if (!report.summary || !report.summary.diagnosis) return { ok: false, why: 'no diagnosis recorded' };
  return { ok: true };
}

/** Stable key for the symptom, so the same lesson is updated not duplicated. */
function symptomKey(request) {
  const words = String(request || '').toLowerCase()
    .match(/[a-z]{3,}/g) || [];
  const stop = new Set(['the','and','for','not','with','that','this','have','from','you','your','can','cant',
                        'wont','doesnt','isnt','please','help','need','when','what','why','how','its']);
  const sig = words.filter((w) => !stop.has(w)).slice(0, 6).sort().join('-');
  return sig || 'general';
}

/**
 * Build a playbook from a resolved session. Returns null when the session does
 * not qualify or cannot be made safe.
 */
function buildPlaybook(report, { customer = '', customerId = '' } = {}) {
  const q = qualifies(report);
  if (!q.ok) return { skipped: q.why };

  const terms = [customer, customerId, report.hostname].filter(Boolean);
  const checks = (report.checksRun || []).map((c) => c.tool).filter(Boolean);
  const changes = (report.changesMade || []).map((c) => c.what || c.tool).filter(Boolean);

  const body = [
    `Symptom: ${scrub(report.request, terms)}`,
    '',
    `Checks that mattered, in the order they were run: ${checks.join(' → ') || 'n/a'}`,
    '',
    `What it turned out to be: ${scrub(report.summary.diagnosis, terms)}`,
    changes.length ? `\nWhat fixed it: ${scrub(changes.join('; '), terms)}` : '',
    report.summary.evidence ? `\nEvidence that confirmed it: ${scrub(report.summary.evidence, terms)}` : '',
  ].filter(Boolean).join('\n');

  // Tripwire: if anything identifying survived, refuse rather than publish.
  // A playbook is optional; a leak is not recoverable.
  const residual = residualIdentifiers(body);
  if (residual.length) return { skipped: `scrubbing left ${residual.join(', ')} — refused` };

  const key = symptomKey(report.request);
  return {
    playbook: {
      id: `${PREFIX}${key}`,
      title: `Learned: ${scrub(report.request, terms).slice(0, 80)}`,
      tag: 'learned',
      source: 'resolved ticket',
      // Kept so a wrong lesson can be traced and removed, without naming anyone.
      learnedFrom: { at: report.generatedAt, reportId: report.reportId },
      chunks: [{ page: 1, text: body }],
    },
    key,
  };
}

/**
 * Write the playbook, replacing any earlier lesson for the same symptom rather
 * than accumulating fifty near-identical printer notes.
 */
function savePlaybook(playbook) {
  fs.mkdirSync(KB_DIR, { recursive: true });
  const file = path.join(KB_DIR, `${playbook.id}.json`);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, JSON.stringify(playbook, null, 2));
  return { file, replaced: existed };
}

function listLearned() {
  try {
    return fs.readdirSync(KB_DIR).filter((f) => f.startsWith(PREFIX) && f.endsWith('.json'));
  } catch { return []; }
}

module.exports = { scrub, residualIdentifiers, qualifies, symptomKey, buildPlaybook, savePlaybook, listLearned };
