#!/usr/bin/env node
// Licence identity, co-branding and the renewal reminder.
//
//   node tools/test-licence-details.js
//
// Three customer-visible promises are checked here:
//
//   1. A licence says whose it is. The name, the holder and the branding are
//      SIGNED, so they survive the trip to the PC and cannot be edited there.
//   2. Every key ever issued brands correctly, including the thousands issued
//      before brandName existed — those fall back to the customer name.
//   3. The renewal reminder fires once a day inside the last month of cover,
//      and stops the moment the licence is renewed.
//
// Read-only: signs licences in memory, never writes to the data directory.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const licenceIssue = require('../orchestrator/licence-issue');
const licensing = require('../orchestrator/licensing');

const PRIV = path.join(__dirname, 'licensing-key.pem');
if (!fs.existsSync(PRIV)) {
  console.error(`No signing key at ${PRIV} — run: node tools/licgen.js --init`);
  process.exit(1);
}
const privKey = fs.readFileSync(PRIV);

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const DEVICE = 'test-device-0001';

// ---------------------------------------------------------------- identity
console.log('\nLicence identity');
{
  const { key, payload } = licenceIssue.issueLicence({
    customer: 'Acme Manufacturing Pvt Ltd',
    customerId: 'acme-mfg',
    plan: 'pro',
    seats: 25,
    days: 365,
    licensedTo: 'Priya Nair, IT Manager',
    licensedToEmail: 'priya@acme.example',
    brandName: 'Acme',
  }, privKey);

  check('the allocation is signed into the payload',
    payload.licensedTo === 'Priya Nair, IT Manager' && payload.brandName === 'Acme');

  const lic = licensing.evaluate(key, DEVICE);
  check('a valid licence verifies', lic.valid, lic.reason);
  check('evaluate reports the holder', lic.licensedTo === 'Priya Nair, IT Manager', lic.licensedTo);
  check('evaluate reports the contact', lic.licensedToEmail === 'priya@acme.example', lic.licensedToEmail);
  check('evaluate reports the brand name', lic.brandName === 'Acme', lic.brandName);
  check('evaluate reports when it was issued', Boolean(lic.issuedAt), lic.issuedAt);
  check('evaluate reports the seat count', lic.seats === 25, String(lic.seats));

  // The whole point of signing it: a customer cannot rebrand their PC as
  // somebody else by editing the key, because the signature stops verifying.
  const raw = Buffer.from(key.slice('RSLIC1-'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const tampered = JSON.parse(raw);
  tampered.payload.brandName = 'Somebody Else Ltd';
  const forged = 'RSLIC1-' + Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bad = licensing.evaluate(forged, DEVICE);
  check('an edited brand name is rejected', !bad.valid && /signature/i.test(bad.reason || ''), bad.reason);
}

// -------------------------------------------------------- backwards compat
console.log('\nLicences issued before any of this existed');
{
  // No licensedTo, no brandName — exactly what every key in the field today
  // looks like. It must still brand the window, using the billing name.
  const { key } = licenceIssue.issueLicence({
    customer: 'Gespage India', customerId: 'gespage-in', plan: 'standard', seats: 5, days: 200,
  }, privKey);
  const lic = licensing.evaluate(key, DEVICE);
  check('an old-style licence still verifies', lic.valid, lic.reason);
  check('brand falls back to the customer name', lic.brandName === 'Gespage India', lic.brandName);
  check('an unallocated licence reports no holder', lic.licensedTo === null, String(lic.licensedTo));
}

// -------------------------------------------------- details after expiry
console.log('\nAn expired licence still says whose it was');
{
  const issued = new Date(Date.now() - 400 * 86400000);
  const { key } = licenceIssue.issueLicence({
    customer: 'Lapsed Ltd', plan: 'standard', seats: 3, days: 365,
    licensedTo: 'Ravi Menon', now: issued,
  }, privKey);
  const lic = licensing.evaluate(key, DEVICE);
  check('it is reported as expired', !lic.valid && lic.expired, lic.reason);
  // Without this the renewal conversation starts with "we cannot tell you whose
  // licence this is", which is precisely the wrong moment for that answer.
  check('the customer is still named', lic.customer === 'Lapsed Ltd', lic.customer);
  check('the holder is still named', lic.licensedTo === 'Ravi Menon', String(lic.licensedTo));
  check('the brand still resolves', lic.brandName === 'Lapsed Ltd', String(lic.brandName));
}

// ------------------------------------------------------ renewal reminder
// The agent's rule, reproduced here rather than imported: agent.js opens a
// WebSocket server on load, so requiring it would leave a listener behind.
// If the rule changes there, this test is the thing that should be updated
// alongside it.
console.log('\nRenewal reminder timing');
{
  const WARN_DAYS = 30;
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function due(lic, now, state) {
    if (!lic || !lic.expiresAt) return null;
    if (lic.timeBoxed) return null;
    if (!lic.valid && !lic.expired) return null;
    const daysLeft = Math.ceil((new Date(lic.expiresAt) - now) / 86400000);
    if (daysLeft > WARN_DAYS) return null;
    const same = state.licenseId === (lic.licenseId || null) && state.expiresAt === lic.expiresAt;
    if (same && state.lastShown === dayKey(now)) return null;
    return { daysLeft, mark: { licenseId: lic.licenseId || null, expiresAt: lic.expiresAt, lastShown: dayKey(now) } };
  }

  // Anchored in LOCAL time, not UTC. "Once a day" means the customer's day, so
  // a fixture built from a UTC instant lands either side of local midnight
  // depending on where the test is run — which is a bug in the test, not the
  // rule, but it fails just as loudly.
  const base = new Date(2026, 5, 1, 9, 0, 0);
  const at = (days) => new Date(base.getTime() + days * 86400000);
  const laterSameDay = new Date(base.getTime() + 9 * 3600000);

  const lic = { valid: true, licenseId: 'lic-1', expiresAt: at(25).toISOString() };
  const far = { valid: true, licenseId: 'lic-1', expiresAt: at(200).toISOString() };

  let state = {};
  const first = due(lic, at(0), state);
  // A one-day tolerance: a clock change inside the window shifts the arithmetic
  // by an hour, and the reminder does not care.
  check('a reminder is owed inside the last month',
    Boolean(first) && first.daysLeft >= 24 && first.daysLeft <= 26,
    first ? String(first.daysLeft) : 'none');
  state = first.mark;

  check('no second reminder the same day', due(lic, laterSameDay, state) === null);
  check('a reminder again the next day', due(lic, at(1), state) !== null);
  check('nothing owed with a year of cover left', due(far, at(0), {}) === null);

  // Renewed: the new expiry does not match the recorded one, so the daily count
  // starts over — and with cover back over a month, nothing is owed at all.
  check('renewing silences it', due(far, at(0), state) === null);

  // Expired cover keeps nagging: "until renewed" means exactly that.
  const dead = { valid: false, expired: true, licenseId: 'lic-1', expiresAt: at(-3).toISOString() };
  const after = due(dead, at(0), {});
  check('an expired licence still reminds', Boolean(after) && after.daysLeft <= 0,
    after ? String(after.daysLeft) : 'none');

  // A 24-hour pass is re-bought, not renewed, and never lives a month.
  check('a time-boxed pass is left alone',
    due({ valid: true, timeBoxed: true, licenseId: 'p1', expiresAt: at(1).toISOString() }, at(0), {}) === null);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
console.log('All licence detail checks passed.');
