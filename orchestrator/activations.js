'use strict';
// First-use activation records for time-boxed licences.
//
// A 24-hour pass whose clock starts when we ISSUE it is unfair in a way the
// customer notices immediately: they open the email on Wednesday and find a key
// that died on Tuesday. So the pass carries a DURATION, and the clock starts the
// first time they actually ask Resolve for something.
//
// The record is kept HERE, on our side, keyed by licence id. The two
// alternatives both fail:
//
//   - in the licence key: impossible, it is signed and immutable by design;
//   - on the customer's PC: "reinstall to get another 24 hours" becomes a
//     one-step exploit, and the pass stops being a paid product.
//
// First write wins and is never overwritten, so a reconnect, a retry or a second
// PC cannot restart a window that has already begun.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'activations.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(all) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

/** When this licence was first used, as an ISO string, or null. Read-only. */
function startedAt(licenseId) {
  if (!licenseId) return null;
  const rec = load()[licenseId];
  return rec && rec.startedAt ? rec.startedAt : null;
}

/**
 * Record first use. Idempotent by design: the first call wins and every later
 * call returns that same moment. Returns { startedAt, isNew }.
 */
function start(licenseId, at = new Date(), meta = {}) {
  if (!licenseId) return { startedAt: null, isNew: false };
  const all = load();
  const existing = all[licenseId];
  if (existing && existing.startedAt) {
    return { startedAt: existing.startedAt, isNew: false };
  }
  all[licenseId] = {
    startedAt: at.toISOString(),
    ...(meta.deviceId ? { firstDeviceId: meta.deviceId } : {}),
    ...(meta.customer ? { customer: meta.customer } : {}),
  };
  save(all);
  return { startedAt: all[licenseId].startedAt, isNew: true };
}

/** Every activation on record. Used by the internal dashboard. */
function all() {
  return load();
}

module.exports = { startedAt, start, all, FILE };
