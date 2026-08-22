'use strict';
// Tell Alpha Web when something happens that is worth acting on.
//
// Three moments, chosen because each has a short window in which acting is
// useful and after which it is not:
//
//   activated  — a pass clock just started. There are 24 hours in which the
//                customer is actually looking at the product.
//   escalated  — Resolve handed a job to the customer's own IT admin. That is
//                the one session worth reading, and worth a call.
//   exhausted  — an org ran out of tickets. Sessions are being refused right
//                now, which is both a support problem and a sales conversation.
//
// Sent through the website rather than direct to an email provider, so the
// mail credentials live in exactly one place. The website authenticates the
// call with the dashboard token, which both services already hold — this adds
// no new secret to set up or rotate.
//
// Nothing here is allowed to break a ticket. A notification that fails is a
// notification that fails; the customer's support session carries on.

const https = require('https');
const { URL } = require('url');

const SITE = process.env.RESOLVE_SITE_URL || 'https://www.alphawebin.com';
const TOKEN = process.env.RESOLVE_DASHBOARD_TOKEN || '';

// Orgs already reported as out of tickets. Without this, every refused session
// sends another email and the alert becomes something you filter to a folder —
// which is the same as not having it. Cleared when they top up.
const reportedEmpty = new Set();

function post(kind, data) {
  return new Promise((resolve) => {
    if (!TOKEN) return resolve({ ok: false, why: 'no dashboard token' });
    let target;
    try { target = new URL('/api/alerts', SITE); } catch { return resolve({ ok: false, why: 'bad site url' }); }
    const body = JSON.stringify({ kind, ...data });
    const req = https.request({
      host: target.host,
      path: target.pathname,
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`,
      },
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, why: e.message }));
    req.write(body);
    req.end();
  });
}

/** A time-boxed licence just started counting. */
function activated({ customer, customerId, validForHours, startedAt, deviceId }) {
  return post('activated', { customer, customerId, validForHours, startedAt, deviceId });
}

/** A session ended with the job handed to the customer's IT admin. */
function escalated({ customerId, deviceId, ticket, reportId, report }) {
  return post('escalated', { customerId, deviceId, ticket, reportId, report });
}

/**
 * An organisation has run out of tickets. Reported once per org until they buy
 * more, because the interesting event is running out, not each refusal after.
 */
function exhausted({ customerId, balance }) {
  if (reportedEmpty.has(customerId)) return Promise.resolve({ ok: true, skipped: 'already reported' });
  reportedEmpty.add(customerId);
  return post('exhausted', { customerId, balance });
}

// ---- refused console sign-ins ---------------------------------------------
// One wrong token is a typo. Five in five minutes is someone trying tokens, and
// the console it guards holds an organisation's documentation and decides what
// software may be installed on their PCs.
//
// Counted in memory on purpose: this is a burst detector, and a burst is by
// definition recent. Losing the counters on restart costs nothing, and it keeps
// a failed sign-in off the disk path of a request that is already being denied.
const FAILED_WINDOW_MS = 5 * 60 * 1000;
const FAILED_THRESHOLD = 5;
// After alerting, stay quiet for an hour. Someone hammering the endpoint would
// otherwise send an email per attempt, and an alert that floods is an alert
// that gets filtered — the same as not having one.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const failedAttempts = new Map(); // customerId -> [timestamps]
const lastAlerted = new Map();    // customerId -> timestamp

/**
 * Record a refused console sign-in, and alert if they are coming in a burst.
 *
 * `now` is injected rather than read from the clock so the threshold and the
 * cooldown can be tested without waiting five real minutes.
 *
 * Returns the alert promise when one is sent, and null otherwise, so a caller
 * can tell the difference without inspecting the counters.
 */
function accessDenied({ customerId, ip, page }, now = Date.now()) {
  const key = customerId || '(no organisation)';
  const seen = (failedAttempts.get(key) || []).filter((t) => now - t < FAILED_WINDOW_MS);
  seen.push(now);
  failedAttempts.set(key, seen);

  if (seen.length < FAILED_THRESHOLD) return null;
  const last = lastAlerted.get(key) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return null;
  lastAlerted.set(key, now);
  // Reset so the next alert needs a fresh burst rather than one more attempt
  // on top of an already-full window.
  failedAttempts.set(key, []);

  return post('access_denied', {
    customerId: customerId || null,
    attempts: seen.length,
    windowMinutes: FAILED_WINDOW_MS / 60000,
    ip,
    page,
  });
}

/** Test seam: forget every counter. Not used in production. */
function _resetAccessCounters() {
  failedAttempts.clear();
  lastAlerted.clear();
}

/** Called when an org is credited, so the next time they run dry we say so. */
function clearExhausted(customerId) {
  reportedEmpty.delete(customerId);
}

module.exports = {
  activated, escalated, exhausted, clearExhausted, accessDenied,
  _resetAccessCounters, FAILED_THRESHOLD, FAILED_WINDOW_MS, ALERT_COOLDOWN_MS,
};
