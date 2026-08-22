#!/usr/bin/env node
// Per-customer commercials: are we making money on this customer?
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-customer-spend.js
//
// This is the figure a decision to drop a customer would rest on, so the
// arithmetic is worth pinning — and so is the labelling. Cost is measured;
// revenue is inferred from bundle rates. A margin that looks measured but is
// inferred is exactly the number someone acts on and later regrets.

const fs = require('fs');
const path = require('path');

const DATA = process.env.RESOLVE_DATA_DIR;
if (!DATA) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes fixtures.');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, 'reports'), { recursive: true });

fs.writeFileSync(path.join(DATA, 'devices.json'), JSON.stringify({
  'dev-good': { customerId: 'profitable-co', hostname: 'PC-1' },
  'dev-bad': { customerId: 'expensive-co', hostname: 'PC-2' },
}));

// usd chosen so the rupee figures are round at 88/USD.
const report = (id, deviceId, usd, n) => {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(DATA, 'reports', `${id}-${i}.json`), JSON.stringify({
      reportId: `${id}-${i}`, deviceId,
      generatedAt: new Date(Date.now() - 86400000).toISOString(),
      outcome: { escalated: false, customerDeclined: false, checksRun: 5, changesMade: 1 },
      usage: { estimatedUsd: usd },
    }));
  }
};

// Profitable: 10 sessions at ~Rs 2 each.
report('good', 'dev-good', 0.0227, 10);
// Expensive: 5 sessions at ~Rs 176 each — far above what a ticket sells for.
report('bad', 'dev-bad', 2.0, 5);

const ledger = require('../orchestrator/ledger');
ledger.credit('profitable-co', 100, { note: 'business bundle' });
ledger.credit('expensive-co', 100, { note: 'business bundle' });
for (let i = 0; i < 10; i++) ledger.debit('profitable-co', 'dev-good', { didWork: true });
for (let i = 0; i < 5; i++) ledger.debit('expensive-co', 'dev-bad', { didWork: true });

const { performance } = require('../orchestrator/performance');
const p = performance({ usdToInr: 88, days: 30 });

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};
const org = (id) => p.customers.find((c) => c.customerId === id);

console.log('\n=== the ticket rate is inferred from what they bought ===');
check('100 tickets values at the Rs 69 bundle rate', org('profitable-co').ticketRateInr === 69,
  `Rs ${org('profitable-co').ticketRateInr}`);
check('and revenue follows', org('profitable-co').estimatedRevenueInr === 6900,
  `Rs ${org('profitable-co').estimatedRevenueInr}`);

console.log('\n=== a healthy customer ===');
const good = org('profitable-co');
check('cost per ticket used is well under the rate',
  good.costPerTicketUsedInr < good.ticketRateInr,
  `Rs ${good.costPerTicketUsedInr} cost vs Rs ${good.ticketRateInr} paid`);
check('not flagged unprofitable', good.unprofitable === false);
check('margin is positive', good.estimatedMarginInr > 0, `Rs ${good.estimatedMarginInr}`);

console.log('\n=== a customer costing more than they pay ===');
const bad = org('expensive-co');
check('cost per ticket used exceeds the rate',
  bad.costPerTicketUsedInr > bad.ticketRateInr,
  `Rs ${bad.costPerTicketUsedInr} cost vs Rs ${bad.ticketRateInr} paid`);
check('flagged unprofitable', bad.unprofitable === true);
check('and flagged urgently, above every other concern',
  bad.flag.level === 'urgent' && /losing money/i.test(bad.flag.text), bad.flag.text);
check('sorted to the top', p.customers[0].customerId === 'expensive-co',
  p.customers[0].customerId);

console.log('\n=== totals across the book ===');
check('revenue is the sum of customers', p.totals.estimatedRevenueInr === 13800,
  `Rs ${p.totals.estimatedRevenueInr}`);
check('spend is measured, not inferred', p.totals.totalSpendInr > 0, `Rs ${p.totals.totalSpendInr}`);
check('margin is revenue minus spend',
  Math.abs(p.totals.estimatedMarginInr - (p.totals.estimatedRevenueInr - p.totals.totalSpendInr)) < 0.01);
check('unprofitable customers counted', p.totals.unprofitableCustomers === 1);

console.log('\n=== a customer with no sessions is not judged ===');
ledger.credit('brand-new-co', 25, { note: 'starter' });
const p2 = performance({ usdToInr: 88, days: 30 });
const fresh = p2.customers.find((c) => c.customerId === 'brand-new-co');
check('no cost per ticket yet', fresh.costPerTicketUsedInr === null);
check('not called unprofitable on no evidence', fresh.unprofitable === false,
  'judging a customer who has not used it yet would be worse than saying nothing');
check('25 tickets values at the Rs 79 rate', fresh.ticketRateInr === 79, `Rs ${fresh.ticketRateInr}`);

console.log('');
console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
process.exit(fail ? 1 : 0);
