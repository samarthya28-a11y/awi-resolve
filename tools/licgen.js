#!/usr/bin/env node
// AWI Resolve — licence generator. INTERNAL to Alpha Web: this holds the private
// signing key and must never ship to a customer or be committed.
//
//   node tools/licgen.js --init
//       Creates the signing keypair once. Writes the PUBLIC half to
//       orchestrator/licensing-key.pub (safe to commit and to ship inside the
//       product) and the PRIVATE half to tools/licensing-key.pem (gitignored).
//
//   node tools/licgen.js --customer "Acme Ltd" --plan pro --seats 25 --days 365
//       Issues a licence and prints the pasteable key.
//
//   ...--devices <id>,<id>   Optional: lock the licence to specific device IDs.
//                            Leave it off for a floating seat-count licence.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRIV = path.join(__dirname, 'licensing-key.pem');
const PUB = path.join(__dirname, '..', 'orchestrator', 'licensing-key.pub');
const PLANS = ['trial', 'incident', 'standard', 'pro', 'full'];

// Default validity per plan. `incident` is the paid one-off pass: bounded by a
// day rather than by "one session", because nothing in the licence model counts
// sessions and selling something unenforceable is how a price list starts
// lying.
const DEFAULT_DAYS = { trial: 15, incident: 1 };

// The 24-Hour Pass is a day's licence PLUS a small ticket allowance, so it runs
// through the same ledger as everything else instead of being an unmetered
// special case. Five separate problems in a day is generous — a follow-up
// question does not spend a ticket, only a new conversation does.
const PASS_TICKETS = 5;

function init() {
  if (fs.existsSync(PRIV)) {
    console.error(`Refusing to overwrite the existing signing key at ${PRIV}.`);
    console.error('Every licence ever issued was signed with it — regenerating would invalidate them all.');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(PRIV, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  fs.writeFileSync(PUB, publicKey.export({ format: 'der', type: 'spki' }).toString('base64') + '\n');
  console.log('Signing keypair created.');
  console.log(`  private (KEEP INTERNAL, never commit): ${PRIV}`);
  console.log(`  public  (ships inside the product):    ${PUB}`);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function issue() {
  if (!fs.existsSync(PRIV)) {
    console.error('No signing key yet. Run:  node tools/licgen.js --init');
    process.exit(1);
  }
  const customer = arg('customer');
  const plan = (arg('plan', 'trial') || '').toLowerCase();
  const seats = Number(arg('seats', '1'));
  const days = Number(arg('days', String(DEFAULT_DAYS[plan] || 365)));
  const devices = (arg('devices') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!customer) { console.error('Missing --customer "Name"'); process.exit(1); }
  if (!PLANS.includes(plan)) { console.error(`--plan must be one of: ${PLANS.join(', ')}`); process.exit(1); }
  if (!Number.isFinite(seats) || seats < 1) { console.error('--seats must be a positive number'); process.exit(1); }
  if (!Number.isFinite(days) || days < 1) { console.error('--days must be a positive number'); process.exit(1); }

  const now = new Date();
  const expires = new Date(now.getTime() + days * 86400000);
  const payload = {
    licenseId: crypto.randomUUID(),
    customer,
    customerId: arg('customer-id') || undefined,
    plan,
    seats,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    ...(devices.length ? { deviceIds: devices } : {}),
  };
  if (!payload.customerId) delete payload.customerId;

  // Sign the exact bytes the verifier will reconstruct — JSON.stringify of the
  // payload object. Key order is preserved by both sides, so this is stable.
  const priv = crypto.createPrivateKey(fs.readFileSync(PRIV));
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign('sha256', data, { key: priv, dsaEncoding: 'der' }).toString('base64');

  const envelope = JSON.stringify({ payload, signature });
  const key = 'RSLIC1-' + Buffer.from(envelope, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  console.log('');
  console.log(`Customer : ${customer}`);
  if (payload.customerId) console.log(`Org id   : ${payload.customerId}`);
  console.log(`Plan     : ${plan}   Seats: ${seats}`);
  console.log(`Expires  : ${expires.toISOString().slice(0, 10)}  (${days} days)`);
  if (devices.length) console.log(`Devices  : ${devices.join(', ')}`);

  // Credit the pass's tickets at issue time so it works the moment the key is
  // pasted in, rather than depending on someone remembering a second step.
  if (plan === 'incident') {
    if (payload.customerId) {
      try {
        const ledger = require('../orchestrator/ledger');
        const out = ledger.credit(payload.customerId, PASS_TICKETS, { note: '24-hour pass' });
        console.log(`Tickets  : ${PASS_TICKETS} credited to ${payload.customerId} (balance ${out.balance})`);
      } catch (e) {
        console.error(`WARNING: could not credit pass tickets: ${e.message}`);
      }
    } else {
      console.error('WARNING: no --customer-id given, so the pass tickets were NOT credited and');
      console.error('         this pass will run unmetered. Re-issue with --customer-id <org-slug>.');
    }
  }
  console.log('');
  console.log('Licence key — paste this into the customer\'s Resolve window:');
  console.log('');
  console.log(key);
  console.log('');
}

if (process.argv.includes('--init')) init();
else issue();
