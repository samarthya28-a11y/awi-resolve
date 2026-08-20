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

/** Called when an org is credited, so the next time they run dry we say so. */
function clearExhausted(customerId) {
  reportedEmpty.delete(customerId);
}

module.exports = { activated, escalated, exhausted, clearExhausted };
