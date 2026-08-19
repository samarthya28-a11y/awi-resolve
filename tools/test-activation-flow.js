#!/usr/bin/env node
// End-to-end: does pasting a licence key into the support window work?
//
//   node tools/test-activation-flow.js <RSLIC1-key>
//
// Drives the real agent the way the window does — over its local WebSocket —
// and checks the whole chain: the orchestrator reports the licence state, the
// agent saves a pasted key to the config file it actually reads, reconnects,
// and the orchestrator then reports the licence as valid.
//
// This is the flow that decides whether a customer can self-activate or needs
// a hand-built package, so it is worth testing for real rather than by
// inspection.

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const key = process.argv[2];
if (!key || !key.startsWith('RSLIC1-')) {
  console.error('Usage: node tools/test-activation-flow.js <RSLIC1-key>');
  process.exit(1);
}

const UI = process.env.RESOLVE_TEST_UI || 'ws://127.0.0.1:8793';
const CONFIG = process.env.RESOLVE_TEST_CONFIG;

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

const seen = { licences: [], results: [] };

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(UI);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('UI socket did not open within 20s')), 20000);
  });
}

(async () => {
  const ws = await connect();
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'licence') seen.licences.push(m.licence);
    if (m.type === 'licence_result') seen.results.push(m);
  });

  // Give the agent a moment to enrol and report its initial state.
  await new Promise((r) => setTimeout(r, 6000));

  console.log('\n=== before activation ===');
  const first = seen.licences[0];
  check('the window was told its licence state', Boolean(first),
    first ? `plan=${first.plan} valid=${first.valid}` : 'no licence message received');
  check('and it is unlicensed', first && first.valid === false);

  console.log('\n=== a malformed key is refused without a reconnect ===');
  ws.send(JSON.stringify({ type: 'activate_licence', key: 'RSLIC1-not-a-real-key' }));
  await new Promise((r) => setTimeout(r, 1500));
  const bad = seen.results[seen.results.length - 1];
  check('rejected', bad && bad.ok === false, bad ? bad.message.slice(0, 60) : 'no reply');

  console.log('\n=== pasting a real key ===');
  seen.licences.length = 0;
  ws.send(JSON.stringify({ type: 'activate_licence', key }));
  await new Promise((r) => setTimeout(r, 12000));   // save + reconnect + re-enrol

  const ok = seen.results[seen.results.length - 1];
  check('agent accepted the key', ok && ok.ok === true, ok ? ok.message : 'no reply');

  if (CONFIG) {
    const saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''));
    check('key written to the config the agent reads', saved.licenseKey === key);
    check('other settings survived the write', Boolean(saved.orchestratorUrl),
      'a clobbered config would disconnect the PC entirely');
  }

  const after = seen.licences[seen.licences.length - 1];
  check('orchestrator now reports a valid licence', after && after.valid === true,
    after ? `plan=${after.plan} customer=${after.customer}` : 'no licence message after reconnect');
  check('and the correct plan', after && after.plan === 'pro', after ? after.plan : '');

  ws.close();
  console.log('');
  console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('  ERROR: ' + e.message);
  process.exit(1);
});
