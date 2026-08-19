#!/usr/bin/env node
// First-use activation for time-boxed licences.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-pass-activation.js
//
// The behaviour under test is a promise to a paying customer: the 24 hours they
// bought start when they first ask for something, not when we press send. The
// cases that matter most are the unkind ones — a key redeemed late, a customer
// reconnecting, someone trying to restart the window by reinstalling.
//
// Refuses to run against the real data directory: it writes activation records,
// and a test that quietly marks a live pass as used would be worse than no test.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (!process.env.RESOLVE_DATA_DIR) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes activation records.');
  process.exit(1);
}

const licensing = require('../orchestrator/licensing');
const activations = require('../orchestrator/activations');

const PRIV = path.join(__dirname, 'licensing-key.pem');
if (!fs.existsSync(PRIV)) {
  console.error(`No signing key at ${PRIV} — run: node tools/licgen.js --init`);
  process.exit(1);
}
const privKey = crypto.createPrivateKey(fs.readFileSync(PRIV));

/** Build a real, correctly signed licence key. */
function makeKey(overrides = {}) {
  const now = new Date();
  const payload = {
    licenseId: crypto.randomUUID(),
    customer: 'Test Customer',
    customerId: 'test-customer',
    plan: 'incident',
    seats: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 90 * 86400000).toISOString(),
    validForHours: 24,
    ...overrides,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign('sha256', data, { key: privKey, dsaEncoding: 'der' }).toString('base64');
  const env = JSON.stringify({ payload, signature });
  return {
    key: 'RSLIC1-' + Buffer.from(env, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    payload,
  };
}

const hours = (n) => n * 3600000;
let fail = 0;
function check(label, cond, detail = '') {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== a pass sitting unused does not tick ===');
{
  const { key } = makeKey();
  const issued = new Date();
  const a = licensing.evaluate(key, 'PC-1', issued);
  check('valid on the day it is issued', a.valid, `plan=${a.plan}`);
  check('reports the full window remaining', a.hoursLeft === 24, `hoursLeft=${a.hoursLeft}`);
  check('no start recorded yet', a.startedAt === null);

  // The whole point: three days later, still untouched, still good.
  const later = new Date(issued.getTime() + hours(72));
  const b = licensing.evaluate(key, 'PC-1', later);
  check('still valid 3 days after issue', b.valid, `reason=${b.reason || 'none'}`);
  check('still the full 24 hours', b.hoursLeft === 24, `hoursLeft=${b.hoursLeft}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== the clock starts on first use, and runs 24h from there ===');
{
  const { key } = makeKey();
  const firstUse = new Date(Date.now() + hours(72));   // used 3 days after issue
  const begun = licensing.beginIfTimeBoxed(key, 'PC-1', firstUse);
  check('activation recorded', begun.started && begun.isNew, `startedAt=${begun.startedAt}`);

  const at1h = licensing.evaluate(key, 'PC-1', new Date(firstUse.getTime() + hours(1)));
  check('valid one hour in', at1h.valid);
  check('~23 hours left', Math.round(at1h.hoursLeft) === 23, `hoursLeft=${at1h.hoursLeft.toFixed(2)}`);

  const at23h = licensing.evaluate(key, 'PC-1', new Date(firstUse.getTime() + hours(23)));
  check('still valid at 23 hours', at23h.valid);

  const at25h = licensing.evaluate(key, 'PC-1', new Date(firstUse.getTime() + hours(25)));
  check('expired at 25 hours', !at25h.valid && at25h.expired, `reason="${at25h.reason}"`);
  check('falls back to diagnostics, not a locked tool', at25h.caps.diagnostics === true);
  check('fixes withheld once expired', at25h.caps.fixes === false);
}

// ---------------------------------------------------------------------------
console.log('\n=== the window cannot be restarted ===');
{
  const { key } = makeKey();
  const t0 = new Date();
  const first = licensing.beginIfTimeBoxed(key, 'PC-1', t0);

  // Reconnect, second PC, a reinstall — every one of these calls activation again.
  const again = licensing.beginIfTimeBoxed(key, 'PC-1', new Date(t0.getTime() + hours(20)));
  const otherPc = licensing.beginIfTimeBoxed(key, 'PC-2', new Date(t0.getTime() + hours(20)));

  check('second activation is not new', again.started && !again.isNew);
  check('start time unchanged on reconnect', again.startedAt === first.startedAt);
  check('a different PC cannot restart it', otherPc.startedAt === first.startedAt);

  const at25h = licensing.evaluate(key, 'PC-1', new Date(t0.getTime() + hours(25)));
  check('still expires 24h after the ORIGINAL start', !at25h.valid, `reason="${at25h.reason}"`);
}

// ---------------------------------------------------------------------------
console.log('\n=== a pass never redeemed lapses at the deadline ===');
{
  const { key } = makeKey();
  const past = new Date(Date.now() + 91 * 86400000);   // one day past the 90-day deadline
  const r = licensing.evaluate(key, 'PC-1', past);
  check('unredeemed pass lapses', !r.valid && r.expired, `reason="${r.reason}"`);
  check('message says it was never used', /never used/.test(r.reason || ''), `reason="${r.reason}"`);
}

// ---------------------------------------------------------------------------
console.log('\n=== subscriptions are untouched by any of this ===');
{
  // No validForHours: the original absolute-expiry behaviour.
  const { key } = makeKey({ plan: 'standard', validForHours: undefined, expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() });
  const now = licensing.evaluate(key, 'PC-1', new Date());
  check('annual licence valid', now.valid, `plan=${now.plan}`);
  check('not marked time-boxed', now.timeBoxed === undefined);
  check('no activation record created', activations.startedAt(now.licenseId) === null);

  const expired = licensing.evaluate(key, 'PC-1', new Date(Date.now() + 400 * 86400000));
  check('expires on its own date as before', !expired.valid && expired.expired);
  check('uses the plain expiry wording', /licence expired on/.test(expired.reason || ''), `reason="${expired.reason}"`);

  // beginIfTimeBoxed must be a no-op here, not an accidental activation.
  const begun = licensing.beginIfTimeBoxed(key, 'PC-1');
  check('beginIfTimeBoxed is a no-op on a subscription', begun.started === false);
}

// ---------------------------------------------------------------------------
console.log('\n=== a tampered key is still rejected ===');
{
  const { key } = makeKey();
  // Flip the window from 24 hours to 240 by editing the payload after signing.
  const raw = Buffer.from(key.slice('RSLIC1-'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const env = JSON.parse(raw);
  env.payload.validForHours = 240;
  const forged = 'RSLIC1-' + Buffer.from(JSON.stringify(env), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = licensing.evaluate(forged, 'PC-1', new Date());
  check('extending the window breaks the signature', !r.valid, `reason="${r.reason}"`);
  const begun = licensing.beginIfTimeBoxed(forged, 'PC-1');
  check('a forged key cannot activate', begun.started === false);
}

console.log('');
console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
process.exit(fail ? 1 : 0);
