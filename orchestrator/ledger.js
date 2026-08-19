// Prepaid ticket ledger.
//
// The commercial model: a customer buys tickets in advance, and one AI support
// session spends one ticket. That is what makes the business safe at any usage
// level — a flat per-PC subscription loses money on a heavy customer, and heavy
// customers are exactly who adopts fastest.
//
// Three rules shape everything here:
//
//  1. CHECK ON OPEN, DEBIT ON CLOSE. Checking at the end would let a session run
//     that was never paid for; debiting at the start would charge for a session
//     that crashed before doing anything. Neither is fair to one side.
//
//  2. A SESSION THAT DID NOTHING IS NOT BILLED. If Resolve ran no checks and
//     changed nothing, the customer did not get a ticket's worth of value and
//     should not lose one. This costs us a few rupees and buys the argument we
//     never want to have.
//
//  3. NOBODY IS HARD-STRANDED MID-INCIDENT. An empty balance allows a small
//     overdraft rather than a locked door — a PC that is actually broken at
//     11pm is the worst possible moment to enforce a payment boundary. The
//     overdraft is small, visible, and settles on the next top-up.

const fs = require('fs');
const path = require('path');

// Money lives in this file. In production DATA_DIR is a mounted volume — if it
// ever resolves to the container image instead, every paid balance is one
// deploy away from being erased.
const { DATA_DIR } = require('./paths');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');

// Deliberately small: enough to finish an emergency, not enough to be a
// business model for someone who never intends to pay.
const OVERDRAFT_TICKETS = 3;

function load() {
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { return {}; }
}

function save(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(all, null, 2));
}

function period(at = new Date()) {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

function blankOrg() {
  return {
    purchased: 0,      // lifetime tickets bought
    used: 0,           // lifetime tickets consumed
    quotas: {},        // deviceId or group name -> tickets per month
    groups: {},        // deviceId -> group name
    entries: [],       // append-only history
  };
}

function org(all, customerId) {
  if (!all[customerId]) all[customerId] = blankOrg();
  return all[customerId];
}

// ---- managed service providers ---------------------------------------------
// An MSP is one Alpha Web customer with many client sites. Their org id is
// hierarchical — "acme-msp:bright-dental" — where everything before the colon
// is the MSP and everything after is that MSP's client.
//
// The split that matters commercially: tickets are POOLED AT THE MSP, because
// that is who buys them, but every debit is ATTRIBUTED TO THE CLIENT, because
// that is who the MSP needs to bill and cap. One pool, per-client visibility.
const ORG_SEPARATOR = ':';

function parentOf(customerId) {
  const i = String(customerId || '').indexOf(ORG_SEPARATOR);
  return i > 0 ? customerId.slice(0, i) : null;
}

/** Which org actually holds the tickets for this one. */
function billingOrg(all, customerId) {
  const parent = parentOf(customerId);
  // Only route to the parent if the parent really has a ledger — an MSP that
  // has not bought anything must not silently swallow a client's own balance.
  if (parent && all[parent]) return parent;
  return customerId;
}

function isChildOf(customerId, parent) {
  return String(customerId || '').startsWith(parent + ORG_SEPARATOR);
}

// Tickets expire 12 months after purchase. Unlimited carry-forward means money
// taken with the service owed indefinitely, and 2026 prices honoured in 2031 —
// a liability that only grows. A year is standard for prepaid support blocks
// and still generous.
const TICKET_LIFE_MONTHS = 12;

function addMonths(iso, months) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/**
 * Consume debits against credit batches oldest-expiry-first, so a customer
 * always spends the tickets closest to expiring. Doing it the other way round
 * would quietly expire tickets they had already paid for and could have used.
 */
function batchesOf(o, now = new Date()) {
  const nowIso = now.toISOString();
  const credits = o.entries
    .filter((e) => e.type === 'credit')
    .map((e) => ({
      at: e.at,
      tickets: e.tickets,
      expiresAt: e.expiresAt || addMonths(e.at, TICKET_LIFE_MONTHS),
      remaining: e.tickets,
    }))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  let toSpend = o.used;
  for (const b of credits) {
    const take = Math.min(b.remaining, toSpend);
    b.remaining -= take;
    toSpend -= take;
  }
  const live = credits.filter((b) => b.expiresAt > nowIso)
                      .reduce((s, b) => s + b.remaining, 0);
  const expired = credits.filter((b) => b.expiresAt <= nowIso)
                         .reduce((s, b) => s + b.remaining, 0);
  // Anything still unspent after every batch is overdraft (used beyond purchased).
  return { credits, live, expired, overdraft: toSpend };
}

function balanceOf(o, now = new Date()) {
  const b = batchesOf(o, now);
  return b.live - b.overdraft;
}

/** Tickets this device (and its group) has used in the current month. */
function usedThisPeriod(o, deviceId, at = new Date()) {
  const p = period(at);
  let device = 0, group = 0;
  const g = o.groups[deviceId] || null;
  for (const e of o.entries) {
    if (e.type !== 'debit' || e.period !== p) continue;
    if (e.deviceId === deviceId) device += e.tickets;
    if (g && o.groups[e.deviceId] === g) group += e.tickets;
  }
  return { device, group, group_name: g };
}

/**
 * May this device open a ticket right now? Returns a decision plus a
 * customer-facing reason — the reason is shown verbatim in the support window,
 * so it has to read like something a person would say.
 */
function canOpen(customerId, deviceId, at = new Date()) {
  const all = load();
  const payer = billingOrg(all, customerId);
  const o = all[payer];
  // No ledger for this org yet = not on prepaid tickets (e.g. a plain
  // subscription or a trial). Metering must never block someone it was never
  // configured for.
  if (!o) return { allowed: true, metered: false };

  const bal = balanceOf(o);
  // Quotas are read from the paying org's record, where an MSP sets caps for
  // each of its clients — the whole point is that one client cannot drain the
  // shared pool.
  const used = usedThisPeriod(o, deviceId, at);
  const clientQuota = payer !== customerId ? o.quotas[customerId] : null;
  if (clientQuota != null) {
    const spentByClient = o.entries.filter(
      (e) => e.type === 'debit' && e.period === period(at) && e.forOrg === customerId
    ).reduce((n, e) => n + e.tickets, 0);
    if (spentByClient >= clientQuota) {
      return { allowed: false, metered: true, reason:
        `This site has used its ${clientQuota} support ticket(s) for this month. Your IT provider can raise the limit.` };
    }
  }

  const deviceQuota = o.quotas[deviceId];
  if (deviceQuota != null && used.device >= deviceQuota) {
    return { allowed: false, metered: true, reason:
      `This PC has used its ${deviceQuota} support ticket(s) for this month. Your IT admin can raise the limit or wait until next month.` };
  }
  const groupQuota = used.group_name != null ? o.quotas[used.group_name] : null;
  if (groupQuota != null && used.group >= groupQuota) {
    return { allowed: false, metered: true, reason:
      `The "${used.group_name}" group has used its ${groupQuota} support ticket(s) for this month. Your IT admin can raise the limit.` };
  }

  if (bal <= -OVERDRAFT_TICKETS) {
    // Says only what is true. A refused ticket runs nothing at all — the
    // diagnostics are the AI session, so there is no free tier still running
    // underneath, and claiming one would be found out on the first outage.
    return { allowed: false, metered: true, reason:
      'Your organisation has run out of support tickets, including the short grace allowance. '
      + 'Ask your IT admin to top up and then try again — nothing was charged for this attempt.' };
  }
  if (bal <= 0) {
    return { allowed: true, metered: true, overdraft: true, balance: bal, reason:
      `Your organisation is out of support tickets and is using its short grace allowance (${Math.abs(bal) + 1} of ${OVERDRAFT_TICKETS}). Please ask your IT admin to top up.` };
  }
  return { allowed: true, metered: true, balance: bal };
}

/**
 * Spend one ticket for a completed session. `didWork` false means the session
 * produced nothing (crash, immediate timeout) and is not billed — rule 2.
 */
function debit(customerId, deviceId, { reportId = null, didWork = true, at = new Date() } = {}) {
  const all = load();
  const payer = billingOrg(all, customerId);
  if (!all[payer]) return { metered: false };
  const o = org(all, payer);
  // forOrg records WHICH client the ticket was spent for, even though the MSP
  // paid. Without it an MSP could see a balance falling with no idea whose
  // site to bill.
  const forOrg = customerId;
  if (!didWork) {
    o.entries.push({ type: 'skipped', at: at.toISOString(), period: period(at), deviceId, forOrg, reportId, tickets: 0,
                     note: 'session did nothing — not billed' });
    save(all);
    return { metered: true, charged: 0, balance: balanceOf(o) };
  }
  o.used += 1;
  o.entries.push({ type: 'debit', at: at.toISOString(), period: period(at), deviceId, forOrg, reportId, tickets: 1 });
  save(all);
  return { metered: true, charged: 1, balance: balanceOf(o) };
}

/** Sell tickets to an org. */
function credit(customerId, tickets, { note = '', at = new Date() } = {}) {
  const n = Math.floor(Number(tickets));
  if (!Number.isFinite(n) || n <= 0) throw new Error('tickets must be a positive whole number');
  const all = load();
  const o = org(all, customerId);
  o.purchased += n;
  o.entries.push({ type: 'credit', at: at.toISOString(), period: period(at), tickets: n, note,
                   expiresAt: addMonths(at.toISOString(), TICKET_LIFE_MONTHS) });
  save(all);
  return { customerId, added: n, balance: balanceOf(o) };
}

/** Admin controls: cap a device or a named group, and assign devices to groups. */
function setQuota(customerId, target, ticketsPerMonth) {
  const all = load();
  const o = org(all, customerId);
  if (ticketsPerMonth == null) delete o.quotas[target];
  else o.quotas[target] = Math.max(0, Math.floor(Number(ticketsPerMonth) || 0));
  save(all);
  return o.quotas;
}

function setGroup(customerId, deviceId, groupName) {
  const all = load();
  const o = org(all, customerId);
  if (!groupName) delete o.groups[deviceId];
  else o.groups[deviceId] = String(groupName);
  save(all);
  return o.groups;
}

/** Everything the console needs for one org. */
function summary(customerId, at = new Date()) {
  const all = load();
  const o = all[customerId];
  if (!o) return { metered: false };
  const p = period(at);
  const thisPeriod = o.entries.filter((e) => e.period === p && e.type === 'debit');
  const byDevice = {};
  for (const e of thisPeriod) {
    byDevice[e.deviceId] = (byDevice[e.deviceId] || 0) + e.tickets;
  }
  const b = batchesOf(o, at);
  // Next batch about to lapse, so an admin can act before it does rather than
  // discover it afterwards.
  const nextExpiry = b.credits.filter((c) => c.remaining > 0 && c.expiresAt > at.toISOString())
                              .sort((x, y) => x.expiresAt.localeCompare(y.expiresAt))[0] || null;
  return {
    metered: true,
    balance: balanceOf(o, at),
    expiredTickets: b.expired,
    ticketLifeMonths: TICKET_LIFE_MONTHS,
    nextExpiry: nextExpiry ? { tickets: nextExpiry.remaining, on: nextExpiry.expiresAt } : null,
    purchased: o.purchased,
    used: o.used,
    overdraftLimit: OVERDRAFT_TICKETS,
    period: p,
    usedThisPeriod: thisPeriod.length,
    quotas: o.quotas,
    groups: o.groups,
    perDeviceThisPeriod: byDevice,
    recent: o.entries.slice(-50).reverse(),
  };
}

module.exports = {
  canOpen, debit, credit, setQuota, setGroup, summary,
  parentOf, billingOrg, isChildOf, ORG_SEPARATOR,
  balanceOf, period, OVERDRAFT_TICKETS,
};
