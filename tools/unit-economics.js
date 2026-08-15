#!/usr/bin/env node
// AWI Resolve — unit economics from real session reports.
//
//   node tools/unit-economics.js
//   node tools/unit-economics.js --human 400 --usd 88 --target 400
//
// Answers one question: at our list prices, what markup are we actually making
// per PC per month, and which assumption is carrying it?
//
// The headline finding this exists to keep visible: API spend is NOT the cost
// driver. One escalation to a human costs roughly 25 tickets' worth of tokens,
// so the escalation rate — not the token bill — decides whether a plan clears
// its target. Optimising prompts saves paise; deflecting one escalation saves
// hundreds of rupees.

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'orchestrator', 'data', 'reports');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

// Assumptions, all overridable — they matter more than the measured numbers, so
// they are printed back rather than buried.
const HUMAN_COST_INR = arg('human', 400);   // loaded cost of one human tier-1 touch
const USD_TO_INR     = arg('usd', 88);
const TARGET_MARKUP  = arg('target', 400);  // percent; price = (1 + target/100) x cost
const INFRA_PER_PC   = arg('infra', 4);     // hosting, amortised per PC per month

// List prices, per PC per month, excluding GST. Mirrors lib/pricing.ts on the
// website; if those change, change these.
const PLANS = [
  { id: 'standard', name: 'Standard',        inrPerMonth: 199 },
  { id: 'pro',      name: 'Pro',             inrPerMonth: 299 },
  { id: 'full',     name: 'Full IT Support', inrPerMonth: 449 },
];

function loadReports() {
  let files = [];
  try { files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  return files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function summarise(reports) {
  const withCost = reports.filter((r) => r.usage && typeof r.usage.estimatedUsd === 'number');
  const escalated = reports.filter((r) => r.outcome && r.outcome.escalated);
  const devices = new Set(reports.map((r) => r.deviceId).filter(Boolean));

  const times = reports.map((r) => new Date(r.generatedAt).getTime()).filter((n) => !Number.isNaN(n));
  const spanDays = times.length > 1
    ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86400000)
    : null;

  const usdTotal = withCost.reduce((s, r) => s + r.usage.estimatedUsd, 0);
  const usdUncached = withCost.reduce((s, r) => s + (r.usage.withoutCachingUsd || r.usage.estimatedUsd), 0);

  return {
    tickets: reports.length,
    ticketsWithCost: withCost.length,
    devices: devices.size,
    spanDays,
    escalationRate: reports.length ? escalated.length / reports.length : null,
    avgInrPerTicket: withCost.length ? (usdTotal / withCost.length) * USD_TO_INR : null,
    avgInrUncached: withCost.length ? (usdUncached / withCost.length) * USD_TO_INR : null,
    // Tickets per PC per month, annualised from the observed window. Needs a
    // real span and more than one ticket to mean anything.
    ticketsPerPcPerMonth: (spanDays && devices.size)
      ? (reports.length / devices.size) / (spanDays / 30)
      : null,
  };
}

function money(n) { return '₹' + n.toFixed(2); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

const reports = loadReports();
if (!reports.length) {
  console.log(`No reports found in ${REPORTS_DIR}.`);
  console.log('Run a few tickets first — this reads real sessions, it does not model them.');
  process.exit(0);
}

const s = summarise(reports);

console.log('');
console.log('=== Measured from real sessions ===');
console.log(`  tickets                : ${s.tickets} across ${s.devices} device(s)`
  + (s.spanDays ? `, over ${s.spanDays.toFixed(1)} day(s)` : ''));
console.log(`  with cost recorded     : ${s.ticketsWithCost}`
  + (s.ticketsWithCost < s.tickets ? '   (older reports predate cost logging)' : ''));
if (s.avgInrPerTicket != null) {
  console.log(`  API cost per ticket    : ${money(s.avgInrPerTicket)}`
    + (s.avgInrUncached ? `   (${money(s.avgInrUncached)} without caching)` : ''));
}
console.log(`  escalation rate        : ${s.escalationRate != null ? pct(s.escalationRate) : 'n/a'}`);
console.log(`  tickets/PC/month       : ${s.ticketsPerPcPerMonth != null ? s.ticketsPerPcPerMonth.toFixed(2) : 'n/a'}`);

// Sample size is the honest caveat, and it belongs BEFORE any early exit: the
// ticket rate is printed above, and a handful of test sessions on one machine
// produces a number that looks precise and is meaningless.
const thin = s.tickets < 30 || s.devices < 3 || !s.spanDays || s.spanDays < 7;
if (thin) {
  console.log('');
  console.log('  NOTE: too few sessions to trust tickets/PC/month — that needs roughly 30+ tickets');
  console.log('  across 3+ devices over a week or more. Test sessions inflate it badly. Cost per');
  console.log('  ticket and escalation rate are meaningful much sooner.');
}

if (s.avgInrPerTicket == null) {
  console.log('\nNo cost data recorded yet — run a ticket on the current build, then re-run this.');
  process.exit(0);
}

console.log('');
console.log('=== Assumptions (override with --human / --usd / --infra / --target) ===');
console.log(`  human touch per escalation : ${money(HUMAN_COST_INR)}`);
console.log(`  USD -> INR                 : ${USD_TO_INR}`);
console.log(`  infra per PC per month     : ${money(INFRA_PER_PC)}`);
console.log(`  target markup              : ${TARGET_MARKUP}%`);

// The observed ticket rate is the least trustworthy input — a burst of testing
// on one machine inflates it wildly — so it can be overridden with a planning
// figure while the measured cost and escalation rate are kept. Modelling a
// realistic rate is more honest than reporting markup off a bogus one.
const T = arg('tickets', s.ticketsPerPcPerMonth);
const E = arg('escalation', s.escalationRate != null ? s.escalationRate : null);
if (arg('tickets', null) != null || arg('escalation', null) != null) {
  console.log('');
  console.log('  (modelling with overrides: '
    + `tickets/PC/month=${T != null ? Number(T).toFixed(2) : 'n/a'}, `
    + `escalation=${E != null ? pct(E) : 'n/a'})`);
}
if (T != null && E != null) {
  const apiPart = T * s.avgInrPerTicket;
  const humanPart = T * E * HUMAN_COST_INR;
  const cogs = apiPart + humanPart + INFRA_PER_PC;

  console.log('');
  console.log('=== Cost per PC per month at the observed rate ===');
  console.log(`  API      : ${money(apiPart)}   (${T.toFixed(2)} tickets x ${money(s.avgInrPerTicket)})`);
  console.log(`  human    : ${money(humanPart)}   (${pct(E)} escalated x ${money(HUMAN_COST_INR)})`);
  console.log(`  infra    : ${money(INFRA_PER_PC)}`);
  console.log(`  TOTAL    : ${money(cogs)}`);
  if (humanPart > apiPart) {
    const ratio = apiPart > 0 ? (humanPart / apiPart).toFixed(1) : '∞';
    console.log(`  -> escalations cost ${ratio}x the API spend. That is the lever, not tokens.`);
  }

  console.log('');
  console.log('=== Markup at list price ===');
  for (const p of PLANS) {
    const markup = cogs > 0 ? ((p.inrPerMonth - cogs) / cogs) * 100 : Infinity;
    const verdict = markup >= TARGET_MARKUP ? 'OK ' : '   ';
    console.log(`  ${verdict} ${p.name.padEnd(16)} ₹${String(p.inrPerMonth).padEnd(4)} -> ${markup.toFixed(0)}% markup`);
  }

  // The actionable number: what escalation rate would clear the target on the
  // entry plan, holding everything else constant.
  const entry = PLANS[0];
  const ceiling = entry.inrPerMonth / (1 + TARGET_MARKUP / 100);
  const allowedHuman = ceiling - apiPart - INFRA_PER_PC;
  console.log('');
  console.log(`=== To clear ${TARGET_MARKUP}% on ${entry.name} (₹${entry.inrPerMonth}) ===`);
  console.log(`  cost ceiling           : ${money(ceiling)} per PC per month`);

  // Answer the question that is actually binding. Escalation rate only matters
  // while escalations cost something; with no human backstop the constraint is
  // the ticket rate instead, and reporting an escalation target there would be
  // arithmetic on a number that no longer means anything.
  if (cogs <= ceiling) {
    console.log(`  status                 : already clear — ${money(ceiling - cogs)} of headroom per PC per month`);
    if (HUMAN_COST_INR > 0 && T > 0) {
      const maxE = allowedHuman / (T * HUMAN_COST_INR);
      console.log(`  escalation headroom    : up to ${pct(Math.min(maxE, 1))} (currently ${pct(E)})`);
    } else {
      const maxT = s.avgInrPerTicket > 0 ? (ceiling - INFRA_PER_PC) / s.avgInrPerTicket : null;
      if (maxT != null) {
        console.log(`  ticket headroom        : up to ${maxT.toFixed(1)} tickets/PC/month (currently ${T.toFixed(2)})`);
      }
    }
  } else if (HUMAN_COST_INR > 0 && T > 0 && allowedHuman > 0) {
    console.log(`  escalation rate needed : at or below ${pct(Math.min(allowedHuman / (T * HUMAN_COST_INR), 1))}`
      + `   (currently ${pct(E)})`);
  } else {
    console.log('  status                 : over the ceiling on API + infra alone —');
    console.log('                           the ticket rate is the problem, not escalations');
  }
}

if (thin) {
  console.log('');
  console.log('Reminder: the markup above inherits the unreliable ticket rate flagged earlier.');
  console.log('Treat it as indicative until there are 30+ tickets across 3+ devices.');
}
console.log('');
