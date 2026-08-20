#!/usr/bin/env node
// Attached documentation cannot exhaust a conversation.
//
//   node tools/test-manual-cap.js                 (against a local orchestrator)
//   RESOLVE_TEST_WS=wss://… node tools/test-manual-cap.js
//
// The bug this guards against was not one huge file — it was FIVE files each
// comfortably under the per-file limit. Any cap that only checks one document
// at a time passes a review and still lets a conversation blow its context
// window, at which point the session does not get expensive, it simply fails.
//
// Driven over the real WebSocket so it exercises the orchestrator's own limit
// rather than a copy of the arithmetic. The agent has the same limit, but the
// agent runs on the customer's PC and cannot be trusted to enforce it.

const WebSocket = require('ws');

const WS = process.env.RESOLVE_TEST_WS || 'ws://127.0.0.1:8799';
const SECRET = process.env.RESOLVE_TEST_ENROLL || '';
const LIMIT = 80000;

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

const doc = (n) => 'x'.repeat(n);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const t = setTimeout(() => reject(new Error('no connection in 20s')), 20000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', deviceId: 'MANUAL-CAP-TEST', deviceSecret: 'manual-cap-secret',
        hostname: 'test', agentVersion: 'test',
        ...(SECRET ? { enrollmentSecret: SECRET } : {}),
      }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'enrolled' || m.type === 'welcome_back') { clearTimeout(t); resolve(ws); }
      if (m.type === 'auth_failed') { clearTimeout(t); reject(new Error('enrollment refused')); }
    });
    ws.on('error', reject);
  });
}

/** Attach a document and report whether the orchestrator pushed back. */
function attach(ws, title, chars) {
  return new Promise((resolve) => {
    let refused = null;
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'ai_message') refused = m.text;
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'attach_manual', title, text: doc(chars) }));
    // No ack on success, so give it a beat and treat silence as accepted.
    setTimeout(() => { ws.off('message', onMsg); resolve(refused); }, 1200);
  });
}

(async () => {
  const ws = await connect();

  console.log('\n=== a document within the limit is accepted ===');
  const a = await attach(ws, 'Small guide', 30000);
  check('30k accepted', a === null, a || '');

  console.log('\n=== the case the old code missed: several files, each legal ===');
  const b = await attach(ws, 'Second guide', 30000);
  check('a second 30k accepted (60k total)', b === null, b || '');
  const c = await attach(ws, 'Third guide', 30000);
  check('a third 30k REFUSED — 90k would exceed the total', c !== null,
    c ? c.slice(0, 90) : 'accepted, which is the bug');
  check('and the refusal says how much room is left', /left|as much/i.test(c || ''), c ? c.slice(0, 60) : '');

  console.log('\n=== one oversized document is refused outright ===');
  const ws2 = await connect();
  const d = await attach(ws2, 'Whole vendor manual', 500000);
  check('500k refused', d !== null, d ? d.slice(0, 80) : 'accepted, which is the old behaviour');

  console.log('\n=== the refusal is useful, not just a rejection ===');
  check('names a limit the customer can act on', /\d+k characters|specific steps|section/i.test(d || ''),
    'a bare "too long" leaves them stuck');

  ws.close(); ws2.close();
  console.log('');
  console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ERROR: ' + e.message); process.exit(1); });
