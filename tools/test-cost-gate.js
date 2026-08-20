#!/usr/bin/env node
// A session that costs more than a ticket asks before spending another.
//
//   node tools/test-cost-gate.js accept
//   node tools/test-cost-gate.js decline
//
// Run against an orchestrator started with a tiny RESOLVE_TICKET_BUDGET_INR so
// the gate trips on an ordinary session. Watches the LEDGER, because the only
// thing that matters here is whether the customer is charged for what they
// agreed to and nothing else.
//
// The two failures worth catching, both silent:
//   - declining still charges (the customer said no and paid anyway)
//   - accepting does not charge (we do the work for free and never notice)

const WebSocket = require('ws');

const mode = process.argv[2];
if (!['accept', 'decline'].includes(mode)) {
  console.error('Usage: node tools/test-cost-gate.js accept|decline');
  process.exit(1);
}
const UI = process.env.RESOLVE_TEST_UI || 'ws://127.0.0.1:8798';
const ORG = process.env.RESOLVE_TEST_ORG || 'costgate-test';
if (!process.env.RESOLVE_DATA_DIR) {
  console.error('Set RESOLVE_DATA_DIR to the orchestrator scratch dir so the ledger can be read.');
  process.exit(1);
}
const ledger = require('../orchestrator/ledger');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

(async () => {
  const ws = new WebSocket(UI);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise((r) => setTimeout(r, 3000));

  const before = ledger.summary(ORG).balance;
  console.log(`\n  balance before: ${before}\n`);

  // Counted, not assumed. With a small test budget the threshold is crossed
  // several times in one session; the invariant is that the number of tickets
  // charged equals the number of approvals given, plus the one the session
  // itself spends. An exact expected count would only be testing the budget.
  // isFollowUp matters to the arithmetic: a message continuing an existing
  // conversation spends no ticket of its own, so the expected total is the
  // approvals alone. Detected from what the orchestrator says rather than
  // assumed, since the previous run leaves a conversation open.
  const seen = { asks: 0, approvals: 0, prompt: '', charged: '', stopped: false, followUp: false };

  await new Promise((resolve) => {
    const done = setTimeout(resolve, 180000);
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }

      if (m.type === 'cost_approval') {
        seen.asks++;
        seen.prompt = m.prompt || '';
        console.log(`  [asked]  ${seen.prompt.split('\n')[0].slice(0, 78)}`);
        ws.send(JSON.stringify({
          type: 'cost_approval_response', approvalId: m.approvalId,
          decision: mode === 'accept' ? 'accepted' : 'declined',
        }));
        if (mode === 'accept') seen.approvals++;
        console.log(`  [answer] ${mode}`);
      }
      const text = String(m.text || '');
      if (/Picking up where we left off/.test(text)) seen.followUp = true;
      if (/tickets on this job/.test(text)) { seen.charged = text; console.log(`  [charged] ${text.slice(0, 78)}`); }
      if (/Stopped\.|have stopped there/.test(text)) { seen.stopped = true; console.log(`  [stopped] ${text.slice(0, 78)}`); }
      if (m.type === 'done') { clearTimeout(done); resolve(); }
    });
    ws.send(JSON.stringify({
      type: 'open_ticket',
      text: 'My printer will not print and the PC is slow. Please investigate thoroughly, check services, the print queue, disk space, event logs and network.',
    }));
  });

  const after = ledger.summary(ORG).balance;
  const spent = before - after;
  console.log(`\n  balance after: ${after}  (spent ${spent})\n`);

  check('the customer was asked before extra spend', seen.asks > 0, `${seen.asks} time(s)`);
  check('the prompt says another ticket will be used', /one more support ticket/i.test(seen.prompt),
    'they must know what they are agreeing to');
  check('and offers to stop with nothing further charged', /nothing further is charged/i.test(seen.prompt));

  if (mode === 'accept') {
    console.log('');
    // The invariant: one ticket for the session, plus exactly one per approval.
    // Never more — that would be charging for something not agreed to.
    const sessionTicket = seen.followUp ? 0 : 1;
    check('charged exactly once per approval, plus the session if it opened one',
      spent === sessionTicket + seen.approvals,
      `${seen.approvals} approval(s) + ${sessionTicket} session = expected ${sessionTicket + seen.approvals}, spent ${spent}`);
    check('the customer was told a running total',
      /\d+ tickets on this job/.test(seen.charged), seen.charged.slice(0, 62));
  } else {
    console.log('');
    const sessionTicket = seen.followUp ? 0 : 1;
    check('nothing charged beyond the session itself', spent === sessionTicket,
      `expected ${sessionTicket}, spent ${spent} — charging after a refusal is the worst outcome here`);
    check('and the session stopped cleanly', seen.stopped);
  }

  ws.close();
  console.log('');
  console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ERROR: ' + e.message); process.exit(1); });
