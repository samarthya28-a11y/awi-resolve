#!/usr/bin/env node
// Does one ticket really stop at MAX_TURNS_PER_TICKET messages?
//
//   node tools/test-turn-cap.js
//
// This is a commercial control, not a nicety: without it a single paid ticket
// funds an unlimited number of AI runs, and the customers who use it most are
// the ones who lose money. Reading the code is not proof — the failure modes
// are an off-by-one and a counter that never increments, and both look correct
// on the page.
//
// Drives a real agent against a real orchestrator and watches the LEDGER, which
// is the thing that actually decides whether we get paid.
//
// Expects: a local orchestrator on RESOLVE_TEST_PORT with an Anthropic key, and
// an agent on RESOLVE_TEST_UI licensed to RESOLVE_TEST_ORG.

const WebSocket = require('ws');

const UI = process.env.RESOLVE_TEST_UI || 'ws://127.0.0.1:8798';
const ORG = process.env.RESOLVE_TEST_ORG || 'turncap-test';
const DATA = process.env.RESOLVE_DATA_DIR;
if (!DATA) {
  console.error('Set RESOLVE_DATA_DIR to the orchestrator scratch dir so the ledger can be read.');
  process.exit(1);
}
const ledger = require('../orchestrator/ledger');

const MAX = 5;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

function ask(ws, text) {
  return new Promise((resolve) => {
    const seen = { rolled: false, lastWarning: false };
    const onMsg = (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      const t = String(m.text || '');
      if (/starting a fresh session/.test(t)) seen.rolled = true;
      if (/last message on this support ticket/.test(t)) seen.lastWarning = true;
      if (m.type === 'done') { ws.off('message', onMsg); resolve(seen); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'open_ticket', text }));
  });
}

(async () => {
  const ws = new WebSocket(UI);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise((r) => setTimeout(r, 3000));

  const before = ledger.summary(ORG).balance;
  console.log(`\n  starting balance: ${before} tickets\n`);

  const results = [];
  for (let i = 1; i <= MAX + 1; i++) {
    const label = i === 1 ? 'My printer is not printing.' : `Question ${i}: what should I check next?`;
    process.stdout.write(`  message ${i}… `);
    const seen = await ask(ws, label);
    const bal = ledger.summary(ORG).balance;
    results.push({ i, bal, ...seen });
    console.log(`balance ${bal}${seen.rolled ? '  (rolled to a new ticket)' : ''}${seen.lastWarning ? '  (warned: last message)' : ''}`);
  }

  console.log('\n=== one ticket covers the first five messages ===');
  check('message 1 spent exactly one ticket', results[0].bal === before - 1,
    `${before} -> ${results[0].bal}`);
  for (let i = 1; i < MAX; i++) {
    check(`message ${i + 1} spent nothing more`, results[i].bal === results[0].bal,
      `balance ${results[i].bal}`);
  }

  console.log('\n=== the sixth starts a new ticket ===');
  check('message 6 rolled over', results[MAX].rolled === true);
  check('and spent a second ticket', results[MAX].bal === results[0].bal - 1,
    `${results[0].bal} -> ${results[MAX].bal}`);

  console.log('\n=== the customer was warned before it happened ===');
  check('warned on message 5, not after', results[MAX - 1].lastWarning === true,
    'being told after the ticket is spent is the annoying version');

  ws.close();
  console.log('');
  console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ERROR: ' + e.message); process.exit(1); });
