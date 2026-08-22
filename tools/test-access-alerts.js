#!/usr/bin/env node
// Alerting on refused console sign-ins.
//
//   node tools/test-access-alerts.js
//
// One wrong token is a typo; a run of them is someone trying tokens against a
// console that holds an organisation's documentation and decides what software
// may be installed on their PCs. The threshold, the window and the cooldown are
// each easy to get subtly wrong in a way that shows up either as silence during
// a real attempt or as an alert that floods and gets filtered — and both look
// fine until the day they matter.
//
// No network: alerts.js resolves without sending when there is no dashboard
// token, which is exactly the state here.

if (process.env.RESOLVE_DASHBOARD_TOKEN) {
  console.error('Unset RESOLVE_DASHBOARD_TOKEN before running this — otherwise it emails for real.');
  process.exit(1);
}

const alerts = require('../orchestrator/alerts');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const T0 = 1_800_000_000_000; // a fixed instant; the clock is injected
const deny = (org, at, page = 'knowledge') =>
  alerts.accessDenied({ customerId: org, ip: '203.0.113.9', page }, at);

console.log('\nA burst is needed, not a single mistake');
{
  alerts._resetAccessCounters();
  let fired = null;
  for (let i = 0; i < alerts.FAILED_THRESHOLD - 1; i++) fired = deny('acme-mfg', T0 + i * 1000);
  check(`${alerts.FAILED_THRESHOLD - 1} refusals stay quiet`, fired === null,
    'a mistyped token must not page anyone');
  fired = deny('acme-mfg', T0 + 5000);
  check(`the ${alerts.FAILED_THRESHOLD}th in the window alerts`, fired !== null);
}

console.log('\nAttempts outside the window do not accumulate');
{
  alerts._resetAccessCounters();
  let fired = null;
  // Spread just beyond the window: each is forgotten before the next arrives.
  const step = alerts.FAILED_WINDOW_MS + 1000;
  for (let i = 0; i < alerts.FAILED_THRESHOLD + 3; i++) fired = deny('acme-mfg', T0 + i * step);
  check('slow, spread-out failures never alert', fired === null,
    'someone fat-fingering it once a day would page us forever');
}

console.log('\nIt does not flood');
{
  alerts._resetAccessCounters();
  let fired = null;
  for (let i = 0; i < alerts.FAILED_THRESHOLD; i++) fired = deny('acme-mfg', T0 + i * 1000);
  check('the first burst alerts', fired !== null);

  // Someone hammering the endpoint: another full burst inside the cooldown.
  let second = null;
  for (let i = 0; i < alerts.FAILED_THRESHOLD * 3; i++) second = deny('acme-mfg', T0 + 10_000 + i * 1000);
  check('a second burst inside the cooldown stays quiet', second === null,
    'an alert that arrives per attempt is one that gets filtered');

  // Long after, it should speak up again — the attempt is news a second time.
  let later = null;
  const after = T0 + alerts.ALERT_COOLDOWN_MS + 60_000;
  for (let i = 0; i < alerts.FAILED_THRESHOLD; i++) later = deny('acme-mfg', after + i * 1000);
  check('a fresh burst after the cooldown alerts again', later !== null);
}

console.log('\nOne organisation does not mask another');
{
  alerts._resetAccessCounters();
  let acme = null;
  for (let i = 0; i < alerts.FAILED_THRESHOLD; i++) acme = deny('acme-mfg', T0 + i * 1000);
  check('acme alerts', acme !== null);
  // rival-co has had a single failure; it must not inherit acme's count.
  const rival = deny('rival-co', T0 + 6000);
  check('a different org still needs its own burst', rival === null,
    'counters are shared between organisations');
}

console.log('\nRequests with no organisation are still counted');
{
  alerts._resetAccessCounters();
  let fired = null;
  // A caller probing without a customerId is exactly what a scan looks like.
  for (let i = 0; i < alerts.FAILED_THRESHOLD; i++) {
    fired = alerts.accessDenied({ customerId: '', ip: '198.51.100.7', page: 'audit' }, T0 + i * 1000);
  }
  check('a burst with no organisation alerts', fired !== null);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
console.log('All access-alert checks passed.');
