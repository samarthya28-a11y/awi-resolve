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

// Default validity per plan, in days.
//
// For the pass this is the ACTIVATION DEADLINE, not the length of cover: the
// 24-hour window starts when the customer first uses it (validForHours below),
// so this is simply how long the key stays redeemable. Three months is long
// enough that nobody loses what they paid for, short enough that keys do not
// float around indefinitely.
const DEFAULT_DAYS = { trial: 15, incident: 90 };

// The pass is a window of TIME that starts on first use, plus a small ticket
// allowance, so it runs through the same ledger as everything else instead of
// being an unmetered special case. Five separate problems in a day is generous
// — a follow-up question does not spend a ticket, only a new conversation does.
const PASS_TICKETS = 5;
const PASS_HOURS = 24;

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

  // Hours of cover once started. Present => the licence is time-boxed and its
  // clock begins on first use, which is what makes expiresAt a deadline to
  // redeem rather than the end of cover.
  // Machine mode, for the order-fulfilment script. Emits JSON instead of the
  // human summary, so the caller never has to scrape a formatted line.
  const jsonOut = process.argv.includes('--json');
  // Skip the local ledger write. When fulfilling a real order the tickets must
  // be credited on the HOSTED connector, and a local credit would be a second,
  // invisible balance that never reaches the customer.
  const noCredit = process.argv.includes('--no-credit');

  const validForHours = Number(arg('valid-for-hours', String(plan === 'incident' ? PASS_HOURS : 0)));
  if (!Number.isFinite(validForHours) || validForHours < 0) {
    console.error('--valid-for-hours must be zero or a positive number');
    process.exit(1);
  }

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
    ...(validForHours > 0 ? { validForHours } : {}),
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

  if (!jsonOut) {
    console.log('');
    console.log(`Customer : ${customer}`);
    if (payload.customerId) console.log(`Org id   : ${payload.customerId}`);
    console.log(`Plan     : ${plan}   Seats: ${seats}`);
    if (validForHours > 0) {
      console.log(`Cover    : ${validForHours} hours, starting when the customer first uses it`);
      console.log(`Redeem by: ${expires.toISOString().slice(0, 10)}  (${days} days to start it)`);
    } else {
      console.log(`Expires  : ${expires.toISOString().slice(0, 10)}  (${days} days)`);
    }
    if (devices.length) console.log(`Devices  : ${devices.join(', ')}`);
  }

  // Credit tickets at issue time so the licence works the moment the key is
  // pasted in, rather than depending on someone remembering a second step.
  //
  // The pass defaults to PASS_TICKETS; any plan can be given an explicit
  // allowance with --tickets. That matters for a demo licence: a trial with no
  // ledger record runs UNMETERED (ledger.canOpen returns metered:false when the
  // org is unknown), so a bounded evaluation needs the tickets credited or the
  // bound does not exist.
  const tickets = Number(arg('tickets', String(plan === 'incident' ? PASS_TICKETS : 0)));
  if (!Number.isFinite(tickets) || tickets < 0) {
    console.error('--tickets must be zero or a positive number');
    process.exit(1);
  }
  if (tickets > 0 && !noCredit) {
    if (payload.customerId) {
      try {
        const ledger = require('../orchestrator/ledger');
        const note = plan === 'incident' ? '24-hour pass' : `${plan} licence`;
        const out = ledger.credit(payload.customerId, tickets, { note });
        if (!jsonOut) console.log(`Tickets  : ${tickets} credited to ${payload.customerId} (balance ${out.balance})`);
      } catch (e) {
        console.error(`WARNING: could not credit tickets: ${e.message}`);
      }
    } else {
      console.error('WARNING: no --customer-id given, so the tickets were NOT credited and this');
      console.error('         licence will run UNMETERED. Re-issue with --customer-id <org-slug>.');
    }
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ key, payload }) + '\n');
    return;
  }

  console.log('');
  console.log('Licence key — paste this into the customer\'s Resolve window:');
  console.log('');
  console.log(key);
  console.log('');
}

if (process.argv.includes('--init')) init();
else issue();
