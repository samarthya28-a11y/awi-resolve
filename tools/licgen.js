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
const PLANS = ['trial', 'standard', 'pro'];

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
  const days = Number(arg('days', plan === 'trial' ? '15' : '365'));
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
    plan,
    seats,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    ...(devices.length ? { deviceIds: devices } : {}),
  };

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
  console.log(`Plan     : ${plan}   Seats: ${seats}`);
  console.log(`Expires  : ${expires.toISOString().slice(0, 10)}  (${days} days)`);
  if (devices.length) console.log(`Devices  : ${devices.join(', ')}`);
  console.log('');
  console.log('Licence key — paste this into the customer\'s Resolve window:');
  console.log('');
  console.log(key);
  console.log('');
}

if (process.argv.includes('--init')) init();
else issue();
