#!/usr/bin/env node
// The cross-customer performance view.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-performance.js
//
// This screen is what the business is judged on, so the arithmetic behind it is
// worth pinning: an escalation rate that reads low because escalations were
// missed, or a margin that reads healthy because expensive sessions were
// dropped, is worse than no screen at all.
//
// The specific traps covered here:
//   - `escalated` lives in report.outcome, NOT at the top level. Reading the
//     wrong one silently reports a 0% escalation rate forever.
//   - Reports carry a deviceId, not a customer. A device that has been removed
//     leaves sessions that must be COUNTED but cannot be attributed.
//   - An org with a licence and no sessions must still appear — "issued but
//     never installed" is the row most worth seeing.

const fs = require('fs');
const path = require('path');

const DATA = process.env.RESOLVE_DATA_DIR;
if (!DATA) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes fixtures.');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, 'reports'), { recursive: true });

fs.writeFileSync(path.join(DATA, 'devices.json'), JSON.stringify({
  'dev-a': { customerId: 'acme-com', hostname: 'PC-A' },
  'dev-b': { customerId: 'acme-com', hostname: 'PC-B' },
  'dev-c': { customerId: 'quiet-co', hostname: 'PC-C' },
}));

const report = (id, deviceId, escalated, usd, daysAgo) => ({
  reportId: id,
  deviceId,
  generatedAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  outcome: { escalated, customerDeclined: false, checksRun: 6, changesMade: escalated ? 0 : 2 },
  usage: { estimatedUsd: usd },
});

const fixtures = [
  report('r1', 'dev-a', false, 0.02, 1),
  report('r2', 'dev-a', true, 0.05, 2),
  report('r3', 'dev-b', false, 0.03, 3),
  report('r4', 'dev-c', false, 0.02, 60),        // outside the 30-day window
  report('r5', 'dev-deleted', false, 0.04, 1),   // device no longer exists
];
for (const r of fixtures) {
  fs.writeFileSync(path.join(DATA, 'reports', r.reportId + '.json'), JSON.stringify(r));
}

const ledger = require('../orchestrator/ledger');
ledger.credit('acme-com', 100, { note: 'test' });
ledger.credit('quiet-co', 3, { note: 'test' });
ledger.credit('never-installed-co', 5, { note: 'test' });

const { performance } = require('../orchestrator/performance');
const p = performance({ usdToInr: 88, days: 30 });

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};
const org = (id) => p.customers.find((c) => c.customerId === id);

console.log('\n=== totals ===');
check('counts every session', p.totals.sessions === 5, `${p.totals.sessions}`);
check('counts only recent in the window', p.totals.sessionsRecent === 4,
  `${p.totals.sessionsRecent} (r4 is 60 days old)`);
check('reads escalation from outcome', p.totals.escalated === 1,
  'reading a top-level field would report 0 forever');
check('escalation rate 1/5', p.totals.escalationRate === 0.2, `${p.totals.escalationRate}`);
check('average cost in rupees', p.totals.avgCostInr === +((0.16 / 5) * 88).toFixed(2),
  `Rs ${p.totals.avgCostInr}`);
check('margin against the ticket price', p.totals.marginPerTicketInr === +(69 - p.totals.avgCostInr).toFixed(2),
  `Rs ${p.totals.marginPerTicketInr}`);

console.log('\n=== a session whose device was deleted is counted, not lost ===');
check('reported as unattributed', p.totals.unattributedSessions === 1);
check('but still in the total', p.totals.sessions === 5,
  'dropping it would flatter both cost and escalation figures');

console.log('\n=== per customer ===');
check('acme has 3 sessions', org('acme-com').sessions === 3);
check('acme escalation is 1 in 3', org('acme-com').escalationRate === 0.3333,
  `${org('acme-com').escalationRate}`);
check('acme PCs counted', org('acme-com').pcs === 2);
check('acme balance from the ledger', org('acme-com').balance === 100);

console.log('\n=== the rows worth acting on ===');
check('never-installed org appears at all', !!org('never-installed-co'),
  'an org with a licence and no sessions is the most actionable row there is');
check('and is flagged as such', /never installed/i.test(org('never-installed-co').flag.text),
  org('never-installed-co').flag.text);
check('quiet customer flagged by age', /quiet for/i.test(org('quiet-co').flag.text),
  org('quiet-co').flag.text);

console.log('\n=== ordering puts action first ===');
ledger.debit('quiet-co', 'dev-c', { didWork: true });
ledger.debit('quiet-co', 'dev-c', { didWork: true });
ledger.debit('quiet-co', 'dev-c', { didWork: true });
const p2 = performance({ usdToInr: 88, days: 30 });
const first = p2.customers[0];
check('an out-of-tickets org sorts to the top', first.customerId === 'quiet-co',
  `${first.customerId} — ${first.flag.text}`);
check('and is marked urgent', first.flag.level === 'urgent');

console.log('');
console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
process.exit(fail ? 1 : 0);
