'use strict';
// Who to call, and what to say.
//
// ALPHA WEB INTERNAL. Reached only with the dashboard token, never an org
// token — this crosses customers by design, which is exactly why a customer
// must never be able to reach it.
//
// A ranked list with no reasons is useless to whoever picks up the phone, so
// every prospect carries the specific observation behind it: "out of tickets,
// 3 sessions blocked this month" is a call worth making, "score 84" is not.
//
// Everything here is derived from telemetry the customer agreed to send (see
// the consent gate in the agent) plus their own ticket ledger. Nothing is
// inferred from another customer's data.

const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');

const DATA_DIR = path.join(__dirname, 'data');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}

function readReports() {
  const dir = path.join(DATA_DIR, 'reports');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function daysSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

/**
 * Signals, each worth points and — more importantly — a sentence. Ordered so
 * the strongest buying signal reads first when several apply.
 */
function signalsFor(ctx) {
  const out = [];
  const { orgId, devices, fleet, tickets, sessions } = ctx;

  // --- ready to buy ---------------------------------------------------------
  if (tickets && tickets.metered) {
    if (tickets.balance <= 0) {
      out.push({ weight: 50, kind: 'out-of-tickets',
        say: `Out of tickets${tickets.balance < 0 ? ` and ${Math.abs(tickets.balance)} into the grace allowance` : ''} — sessions are being refused now.` });
    } else if (tickets.balance <= 10) {
      out.push({ weight: 30, kind: 'low-tickets',
        say: `Down to ${tickets.balance} tickets, using about ${tickets.usedThisPeriod} a month.` });
    }
    if (tickets.nextExpiry) {
      const d = daysSince(tickets.nextExpiry.on);
      if (d != null && d > -60 && d < 0) {
        out.push({ weight: 20, kind: 'expiring',
          say: `${tickets.nextExpiry.tickets} tickets lapse in ${Math.abs(d)} days — a reason to talk before they lose them.` });
      }
    }
  } else if (sessions.length > 0) {
    // Using the product with no ledger at all: a trial or an unmetered install.
    out.push({ weight: 45, kind: 'unmetered-usage',
      say: `${sessions.length} support session(s) with no ticket balance on file — trial or unlicensed.` });
  }

  // --- growing -------------------------------------------------------------
  const pcs = Object.keys(devices).length;
  if (pcs >= 25) {
    out.push({ weight: 15, kind: 'fleet-size', say: `${pcs} PCs enrolled — worth a volume conversation.` });
  }

  // --- pain we sell the fix for --------------------------------------------
  const posture = Object.values(fleet).filter((d) => d && d.posture);
  const unprotected = posture.filter((d) => d.posture.defender &&
    d.posture.defender.realTimeProtection === false).length;
  if (unprotected > 0) {
    out.push({ weight: 35, kind: 'protection-off',
      say: `${unprotected} PC(s) reporting real-time protection OFF — a Heimdal conversation.` });
  }
  const staleDefs = posture.filter((d) => d.posture.defender &&
    (d.posture.defender.signatureAgeDays || 0) > 7).length;
  if (staleDefs > 0) {
    out.push({ weight: 20, kind: 'stale-definitions',
      say: `${staleDefs} PC(s) with virus definitions over a week old.` });
  }
  const faulty = Object.values(fleet).reduce((n, d) => n + (d && d.problemDevices ? d.problemDevices : 0), 0);
  if (faulty >= 5) {
    out.push({ weight: 12, kind: 'faulty-devices',
      say: `${faulty} faulty devices across the fleet — managed IT territory.` });
  }

  // --- they need more product than they bought ------------------------------
  const escalated = sessions.filter((s) => s.outcome && s.outcome.escalated).length;
  if (sessions.length >= 5 && escalated / sessions.length > 0.3) {
    out.push({ weight: 25, kind: 'high-escalation',
      say: `${Math.round((escalated / sessions.length) * 100)}% of sessions end with their IT admin — Full IT Support would land.` });
  }

  // --- going quiet (churn risk, worth a call before renewal) ----------------
  const lastSeen = Object.values(fleet)
    .map((d) => d && d.lastReport).filter(Boolean).sort().pop();
  const quietFor = lastSeen ? daysSince(lastSeen) : null;
  if (quietFor != null && quietFor > 30) {
    out.push({ weight: 18, kind: 'gone-quiet',
      say: `No telemetry for ${quietFor} days — check they are still using it before renewal.` });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** Ranked prospects across every organisation we can see. */
function prospects() {
  const devices = readJson('devices.json', {});
  const fleet = readJson('fleet.json', {});
  const reports = readReports();

  // Group everything by organisation. Devices with no org are ignored rather
  // than lumped together — an unlabelled PC is not a sales lead.
  const orgs = {};
  for (const [id, d] of Object.entries(devices)) {
    if (!d || !d.customerId) continue;
    const o = (orgs[d.customerId] = orgs[d.customerId] || { devices: {}, fleet: {}, sessions: [] });
    o.devices[id] = d;
    if (fleet[id]) o.fleet[id] = fleet[id];
  }
  for (const r of reports) {
    const d = devices[r.deviceId];
    if (d && d.customerId && orgs[d.customerId]) orgs[d.customerId].sessions.push(r);
  }

  const list = Object.entries(orgs).map(([orgId, ctx]) => {
    const tickets = ledger.summary(orgId);
    const signals = signalsFor({ orgId, ...ctx, tickets });
    return {
      customerId: orgId,
      pcs: Object.keys(ctx.devices).length,
      sessions: ctx.sessions.length,
      ticketBalance: tickets.metered ? tickets.balance : null,
      score: signals.reduce((n, s) => n + s.weight, 0),
      signals,
      // The single best thing to open the call with.
      headline: signals.length ? signals[0].say : 'No signal yet — leave them alone.',
    };
  });

  // Anything with no signal is not a prospect. Padding the list with quiet,
  // healthy customers is how a call list stops being used.
  return list.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
}

module.exports = { prospects, signalsFor };
