'use strict';
// How is Resolve actually performing, across every customer?
//
// ALPHA WEB INTERNAL. Crosses customers by definition, so it is reachable only
// with the dashboard token — never an org token.
//
// The three questions this exists to answer, in order of how much they matter:
//
//   1. Does it work?    The escalation rate. Every escalation is a job Resolve
//                       could not finish, and that number decides whether this
//                       is a product or a demo.
//   2. Does it pay?     Cost per session against the ticket price. Selling a
//                       ticket at Rs 69 that costs Rs 90 to serve is a bad
//                       business that looks like a good one on the balance.
//   3. Who needs a call? Out of tickets, gone quiet, escalating too often.
//
// Everything is derived from what is already on the volume. Nothing new is
// recorded, so this is honest about history rather than starting from today.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const ledger = require('./ledger');

const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// Session reports carry a deviceId, not a customer. Anything whose device has
// since been removed cannot be attributed, and is counted as unattributed
// rather than silently dropped — a total that quietly excludes sessions is
// worse than one that says how many it could not place.
function loadDevices() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'devices.json'), 'utf8')); }
  catch { return {}; }
}

function loadReports() {
  let files = [];
  try { files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function daysSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

// Ticket bundles as sold on the website, cheapest per ticket at the top.
// Mirrors lib/pricing.ts; if those change, change these.
const BUNDLES = [
  { tickets: 500, price: 29500 },   // Rs 59 each
  { tickets: 100, price: 6900 },    // Rs 69 each
  { tickets: 25,  price: 1975 },    // Rs 79 each
];

/**
 * What an organisation has most likely paid per ticket.
 *
 * Inferred from how many they bought rather than recorded at purchase, because
 * the ledger stores quantities and not prices. Volume maps cleanly onto the
 * bundle rates, so for a real purchase this is exact; for a hand-credited trial
 * it is a reasonable list-price valuation of what they were given.
 *
 * Everything derived from it is labelled an estimate. A margin figure that
 * looks measured but is inferred is the kind of number a business decision gets
 * made on and then regretted.
 */
function ratePerTicket(purchased) {
  for (const b of BUNDLES) {
    if (purchased >= b.tickets) return b.price / b.tickets;
  }
  return BUNDLES[BUNDLES.length - 1].price / BUNDLES[BUNDLES.length - 1].tickets;
}

/**
 * The one-line verdict for a customer, in words rather than a score.
 *
 * A ranked number tells whoever reads this nothing about what to do. Ordered so
 * the most actionable state wins when several apply.
 */
function flagFor({ balance, metered, sessions, escalationRate, quietDays, pcs,
                   costPerTicketUsedInr, ticketRateInr }) {
  // Losing money on them outranks everything else here. It is the only flag
  // that questions whether to keep the customer at all, rather than what to do
  // for them next.
  if (costPerTicketUsedInr != null && ticketRateInr != null
      && costPerTicketUsedInr > ticketRateInr && sessions >= 3) {
    return {
      level: 'urgent',
      text: `Costing ₹${costPerTicketUsedInr.toFixed(0)} a ticket against ₹${ticketRateInr.toFixed(0)} paid — losing money`,
    };
  }
  if (metered && balance <= 0) {
    return { level: 'urgent', text: 'Out of tickets — sessions are being refused now' };
  }
  if (sessions === 0 && pcs === 0) {
    return { level: 'watch', text: 'Licence issued but never installed' };
  }
  if (sessions === 0) {
    return { level: 'watch', text: 'Installed but never used' };
  }
  if (quietDays != null && quietDays > 30) {
    return { level: 'watch', text: `Quiet for ${quietDays} days — check before renewal` };
  }
  if (sessions >= 5 && escalationRate > 0.3) {
    return {
      level: 'watch',
      text: `${Math.round(escalationRate * 100)}% of sessions escalate — Full IT Support would land`,
    };
  }
  if (metered && balance > 0 && balance <= 5) {
    return { level: 'watch', text: `Down to ${balance} tickets` };
  }
  return { level: 'ok', text: 'Healthy' };
}

/**
 * @param {object} opts
 * @param {number} opts.usdToInr  Exchange rate for reporting cost in rupees.
 * @param {number} opts.days      Window for the "recent" figures.
 */
function performance({ usdToInr = 88, days = 30 } = {}) {
  const devices = loadDevices();
  const reports = loadReports();
  const cutoff = Date.now() - days * 86400000;

  // deviceId -> customerId, and a PC count per org.
  const orgOf = {};
  const pcs = {};
  for (const [id, d] of Object.entries(devices)) {
    if (!d || !d.customerId) continue;
    orgOf[id] = d.customerId;
    pcs[d.customerId] = (pcs[d.customerId] || 0) + 1;
  }

  const blank = () => ({
    sessions: 0, escalated: 0, declined: 0, usd: 0, withCost: 0,
    checks: 0, changes: 0, lastAt: null, recent: 0,
  });
  const byOrg = {};
  let unattributed = 0;
  const all = blank();

  for (const r of reports) {
    const org = orgOf[r.deviceId];
    const at = Date.parse(r.generatedAt);
    const isRecent = Number.isFinite(at) && at >= cutoff;
    const o = r.outcome || {};
    const usd = r.usage && typeof r.usage.estimatedUsd === 'number' ? r.usage.estimatedUsd : null;

    const bump = (t) => {
      t.sessions++;
      if (isRecent) t.recent++;
      if (o.escalated) t.escalated++;
      if (o.customerDeclined) t.declined++;
      t.checks += o.checksRun || 0;
      t.changes += o.changesMade || 0;
      if (usd != null) { t.usd += usd; t.withCost++; }
      if (!t.lastAt || String(r.generatedAt) > t.lastAt) t.lastAt = r.generatedAt;
    };

    bump(all);
    if (!org) { unattributed++; continue; }
    byOrg[org] = byOrg[org] || blank();
    bump(byOrg[org]);
  }

  // Every org with a ledger, even one that has never run a session — "issued
  // but never installed" is exactly the row worth seeing.
  for (const o of ledger.listOrgs()) {
    byOrg[o.customerId] = byOrg[o.customerId] || blank();
  }

  const inr = (usd) => +(usd * usdToInr).toFixed(2);
  const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : 0);

  const customers = Object.entries(byOrg).map(([customerId, t]) => {
    const led = ledger.summary(customerId);
    const escalationRate = rate(t.escalated, t.sessions);
    const quietDays = t.lastAt ? daysSince(t.lastAt) : null;
    const count = pcs[customerId] || 0;

    // Is this customer worth serving?
    //
    // Cost is measured; revenue is inferred from bundle rates, so margin is an
    // estimate and is named as one. The ratio that actually decides it is cost
    // per ticket USED against what a ticket sells for — a customer burning more
    // in tokens than their tickets are worth loses money however many they buy.
    const purchased = led.metered ? (led.purchased || 0) : 0;
    const used = led.metered ? (led.used || 0) : 0;
    const perTicket = purchased > 0 ? ratePerTicket(purchased) : null;
    const revenueInr = perTicket != null ? +(purchased * perTicket).toFixed(2) : null;
    const costInr = inr(t.usd);
    const costPerTicketUsedInr = used > 0 ? +(costInr / used).toFixed(2) : null;

    return {
      customerId,
      pcs: count,
      sessions: t.sessions,
      sessionsRecent: t.recent,
      escalated: t.escalated,
      escalationRate,
      avgCostInr: t.withCost ? inr(t.usd / t.withCost) : null,
      totalCostInr: costInr,
      // Commercials. estimatedRevenueInr is list-price valuation, not billing.
      ticketRateInr: perTicket != null ? +perTicket.toFixed(2) : null,
      estimatedRevenueInr: revenueInr,
      estimatedMarginInr: revenueInr != null ? +(revenueInr - costInr).toFixed(2) : null,
      costPerTicketUsedInr,
      // The verdict that matters: does serving them cost more than they pay?
      unprofitable: costPerTicketUsedInr != null && perTicket != null
        ? costPerTicketUsedInr > perTicket
        : false,
      checksRun: t.checks,
      changesMade: t.changes,
      metered: !!led.metered,
      balance: led.metered ? led.balance : null,
      purchased: led.metered ? (led.purchased ?? null) : null,
      lastActivity: t.lastAt,
      quietDays,
      flag: flagFor({
        balance: led.balance ?? 0, metered: !!led.metered,
        sessions: t.sessions, escalationRate, quietDays, pcs: count,
        costPerTicketUsedInr, ticketRateInr: perTicket,
      }),
    };
  }).sort((a, b) => {
    // Urgent first, then most active. Whoever opens this should not have to
    // hunt for the row that needs doing something about.
    const w = { urgent: 0, watch: 1, ok: 2 };
    const d = w[a.flag.level] - w[b.flag.level];
    return d !== 0 ? d : b.sessions - a.sessions;
  });

  const avgCostInr = all.withCost ? inr(all.usd / all.withCost) : null;
  const ticketsSold = customers.reduce((n, c) => n + (c.purchased || 0), 0);
  const revenueInr = +customers.reduce((n, c) => n + (c.estimatedRevenueInr || 0), 0).toFixed(2);
  const spendInr = inr(all.usd);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    usdToInr,
    totals: {
      customers: customers.length,
      pcs: Object.values(pcs).reduce((a, b) => a + b, 0),
      sessions: all.sessions,
      sessionsRecent: all.recent,
      escalated: all.escalated,
      escalationRate: rate(all.escalated, all.sessions),
      declined: all.declined,
      checksRun: all.checks,
      changesMade: all.changes,
      avgCostInr,
      totalCostInr: inr(all.usd),
      ticketsSold,
      // Margin against the mid ticket price. Stated as the number it is rather
      // than a percentage, because a percentage on tiny volumes reads as more
      // certain than it is.
      midTicketPriceInr: 69,
      marginPerTicketInr: avgCostInr != null ? +(69 - avgCostInr).toFixed(2) : null,
      // Whole-book commercials. Revenue is a list-price valuation of tickets
      // credited, not billing, and every customer figure derived from it says
      // so — a margin that looks measured but is inferred is exactly the number
      // a business decision gets made on and then regretted.
      estimatedRevenueInr: revenueInr,
      totalSpendInr: spendInr,
      estimatedMarginInr: +(revenueInr - spendInr).toFixed(2),
      unprofitableCustomers: customers.filter((c) => c.unprofitable).length,
      sessionsWithoutCost: all.sessions - all.withCost,
      unattributedSessions: unattributed,
    },
    customers,
  };
}

module.exports = { performance, flagFor };
