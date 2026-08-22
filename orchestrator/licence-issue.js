'use strict';
// Issue a signed Resolve licence.
//
// Shared deliberately by the command-line tool and the connector's admin
// endpoint. Two implementations of the same signing scheme WILL drift, and the
// drift surfaces as a customer whose key does not verify — the worst possible
// place to discover it. One function, both callers.
//
// The private key is supplied by the caller rather than read here: the CLI
// reads it from disk, the connector from an environment secret, and this module
// should not care which. It never logs the key or the signature input.

const crypto = require('crypto');

const PREFIX = 'RSLIC1-';
const PLANS = ['trial', 'incident', 'standard', 'pro', 'full'];

// Default validity in days. For a time-boxed plan this is the deadline to
// REDEEM, not the length of cover (see validForHours).
const DEFAULT_DAYS = { trial: 15, incident: 90 };

// The 24-hour pass: a window that starts on first use, plus a ticket allowance.
const PASS_TICKETS = 5;
const PASS_HOURS = 24;

/** Default ticket allowance for a plan, when the caller does not specify one. */
function defaultTickets(plan) {
  return plan === 'incident' ? PASS_TICKETS : 0;
}

/** Default hours of cover; 0 means "absolute expiry", the subscription model. */
function defaultValidForHours(plan) {
  return plan === 'incident' ? PASS_HOURS : 0;
}

/**
 * Build and sign a licence.
 *
 * Returns { key, payload }. Throws on invalid input rather than issuing
 * something subtly wrong — a bad licence is discovered by the customer.
 */
function issueLicence(opts, privateKeyPem) {
  const customer = String(opts.customer || '').trim();
  if (!customer) throw new Error('customer name is required');

  const plan = String(opts.plan || 'trial').toLowerCase();
  if (!PLANS.includes(plan)) throw new Error(`plan must be one of: ${PLANS.join(', ')}`);

  const seats = Number(opts.seats == null ? 1 : opts.seats);
  if (!Number.isFinite(seats) || seats < 1) throw new Error('seats must be a positive number');

  // Who the licence is allocated to: the named person or team at the customer
  // who holds it. Optional on purpose — plenty of licences belong to "the
  // company" and nobody in particular, and a blank line on the licence window
  // reads better than an invented owner.
  const licensedTo = String(opts.licensedTo || '').trim();
  const licensedToEmail = String(opts.licensedToEmail || '').trim();

  // The customer's own display name for co-branding the support window. Signed
  // rather than read from their config so a machine cannot be rebranded as
  // somebody else's company; left off, the billing name is used, which is what
  // most customers would have typed anyway.
  const brandName = String(opts.brandName || '').trim();

  const days = Number(opts.days == null ? (DEFAULT_DAYS[plan] || 365) : opts.days);
  if (!Number.isFinite(days) || days < 1) throw new Error('days must be a positive number');

  const validForHours = Number(
    opts.validForHours == null ? defaultValidForHours(plan) : opts.validForHours
  );
  if (!Number.isFinite(validForHours) || validForHours < 0) {
    throw new Error('validForHours must be zero or a positive number');
  }

  const deviceIds = Array.isArray(opts.deviceIds)
    ? opts.deviceIds.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const now = opts.now instanceof Date ? opts.now : new Date();
  const expires = new Date(now.getTime() + days * 86400000);

  const payload = {
    licenseId: crypto.randomUUID(),
    customer,
    ...(opts.customerId ? { customerId: String(opts.customerId) } : {}),
    ...(licensedTo ? { licensedTo } : {}),
    ...(licensedToEmail ? { licensedToEmail } : {}),
    ...(brandName ? { brandName } : {}),
    plan,
    seats,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    ...(validForHours > 0 ? { validForHours } : {}),
    ...(deviceIds.length ? { deviceIds } : {}),
  };

  // Sign the exact bytes the verifier reconstructs — JSON.stringify of the
  // payload object. Key order is preserved by both sides, so this is stable.
  const priv = crypto.createPrivateKey(privateKeyPem);
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto
    .sign('sha256', data, { key: priv, dsaEncoding: 'der' })
    .toString('base64');

  const envelope = JSON.stringify({ payload, signature });
  const key = PREFIX + Buffer.from(envelope, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return { key, payload };
}

module.exports = {
  issueLicence, defaultTickets, defaultValidForHours,
  PLANS, DEFAULT_DAYS, PASS_TICKETS, PASS_HOURS, PREFIX,
};
