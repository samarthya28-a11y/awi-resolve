'use strict';
// The audit trail: what happened, when, and to whose organisation.
//
// Two jobs, and the first one is not the interesting one but is the one that
// bites.
//
// RETENTION. This file is appended to on every enrollment, licence check,
// console view and refused sign-in, and it lives on the same 1 GB volume as
// ledger.json. Left to grow it eventually fills that volume, and the first
// visible symptom is not "logging stopped" — it is a ticket debit that cannot
// be written, i.e. billing breaking, discovered by a customer. So the file is
// capped and rolled, oldest generation dropped.
//
// READING. An append-only file nobody can read is a file nobody looks at. A
// customer asking "who deleted our manual on Tuesday?" should get an answer
// without anyone opening an SSH session, so entries can be queried — scoped to
// one organisation, because the trail holds every customer's events together.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./paths');

const FILE = dataPath('audit.jsonl');

// 4 MB per generation, six generations: about 25 MB of history at worst, on a
// volume where the ledger needs kilobytes. Small enough never to be the thing
// that fills the disk, large enough to hold months of a normal fleet.
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 5; // audit.1.jsonl … audit.5.jsonl, plus the live file

// Fields that are safe to hand back. A whitelist rather than a blocklist: new
// event types get added all the time, and the failure mode of a blocklist is
// that the first one carrying something sensitive leaks it silently.
const SAFE_FIELDS = new Set([
  'ts', 'event', 'customerId', 'deviceId', 'plan', 'valid', 'reason', 'page',
  'ip', 'docId', 'title', 'chunks', 'productId', 'licenseId', 'seats',
  'allowFullItSupport', 'tickets', 'balance', 'toolId', 'created', 'note',
]);

function generation(n) {
  return n === 0 ? FILE : path.join(path.dirname(FILE), `audit.${n}.jsonl`);
}

/**
 * Roll the file if it has grown past the cap.
 *
 * Renames rather than copies, so an event is never duplicated into two
 * generations, and drops the oldest. Any failure here is swallowed: losing the
 * ability to ROLL the audit file must never take down the request that was
 * being audited.
 */
function rotateIfNeeded() {
  let size = 0;
  try { size = fs.statSync(FILE).size; } catch { return; }
  if (size < MAX_BYTES) return;
  try {
    const oldest = generation(KEEP);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let n = KEEP - 1; n >= 0; n--) {
      const from = generation(n);
      if (fs.existsSync(from)) fs.renameSync(from, generation(n + 1));
    }
  } catch { /* keep serving; the next append simply lands on a large file */ }
}

// Checking the file size on every single append would be a stat per event.
// Counting bytes in process and only stat-ing near the cap costs nothing and is
// accurate enough for a size limit — a restart just re-checks sooner.
let sinceCheck = MAX_BYTES; // force a check on the first write after boot

/**
 * Append one event. Never throws: auditing must not fail the thing it audits.
 *
 * The serialisation is inside the try for that reason — JSON.stringify throws
 * on a circular object, and a caller that accidentally passes one would
 * otherwise take down the request it was in the middle of serving.
 */
function record(event) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    sinceCheck += Buffer.byteLength(line, 'utf8');
    if (sinceCheck >= 64 * 1024) { rotateIfNeeded(); sinceCheck = 0; }
    fs.appendFileSync(FILE, line);
  } catch { /* a missing audit line must not break a customer's session */ }
}

function scrub(entry) {
  const out = {};
  for (const k of Object.keys(entry)) if (SAFE_FIELDS.has(k)) out[k] = entry[k];
  return out;
}

/**
 * Read back the trail, newest first.
 *
 * `customerId` scopes it to one organisation and is what a customer-facing
 * query must always pass: entries belonging to another org, and entries with no
 * organisation at all (service-level events), are both excluded. Omitting it
 * returns everything and is only ever reached with the dashboard token.
 */
function read({ customerId = null, limit = 200, since = null, event = null } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const sinceMs = since ? Date.parse(since) : null;
  const wanted = event ? String(event) : null;
  const out = [];

  for (let n = 0; n <= KEEP && out.length < cap; n++) {
    let text;
    try { text = fs.readFileSync(generation(n), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    // Backwards: the newest entries are at the end of each generation, and the
    // newest generation is read first.
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      const line = lines[i];
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; } // a torn last line, ignored
      if (customerId != null && e.customerId !== customerId) continue;
      if (wanted && e.event !== wanted) continue;
      if (sinceMs && Number.isFinite(sinceMs) && Date.parse(e.ts) < sinceMs) continue;
      out.push(scrub(e));
    }
  }
  return out;
}

/** Size on disk across every generation — for an operator, not a customer. */
function stats() {
  let bytes = 0;
  let files = 0;
  for (let n = 0; n <= KEEP; n++) {
    try { bytes += fs.statSync(generation(n)).size; files++; } catch { /* absent */ }
  }
  return { files, bytes, maxBytesPerFile: MAX_BYTES, generationsKept: KEEP };
}

module.exports = { record, read, stats, FILE, MAX_BYTES, KEEP, generation };
