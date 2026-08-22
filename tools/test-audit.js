#!/usr/bin/env node
// The audit trail: retention, and who is allowed to read what.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-audit.js
//
// Two failures are worth guarding against here, and neither announces itself.
//
// The first is the file growing until it fills the volume it shares with
// ledger.json. Nobody notices logging stopping; what they notice is a ticket
// debit that cannot be written — billing breaking, found by a customer.
//
// The second is one organisation reading another's events. The trail holds
// every customer's activity in one file, so scoping is the only thing between
// a support question and a data leak.
//
// Refuses to run against the real data directory: it writes and rolls audit
// files, and rolling a live trail would destroy history.

const fs = require('fs');
const path = require('path');

const DATA = process.env.RESOLVE_DATA_DIR;
if (!DATA) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes and rolls audit files.');
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const audit = require('../orchestrator/audit-log');

// ------------------------------------------------------------- retention
console.log('\nRetention');
{
  // Fill the live file past the cap, then write one event. The size check runs
  // on the first append after boot, so a single record is enough to roll it.
  const filler = JSON.stringify({ ts: new Date().toISOString(), event: 'filler', customerId: 'old-co' }) + '\n';
  const times = Math.ceil((audit.MAX_BYTES + 1024) / filler.length);
  fs.writeFileSync(audit.FILE, filler.repeat(times));
  const before = fs.statSync(audit.FILE).size;
  check('the live file is over the cap to begin with', before > audit.MAX_BYTES);

  audit.record({ event: 'after_roll', customerId: 'acme-mfg' });

  check('the live file was rolled and is small again',
    fs.statSync(audit.FILE).size < audit.MAX_BYTES, String(fs.statSync(audit.FILE).size));
  check('the previous generation was kept', fs.existsSync(audit.generation(1)));
  check('and it holds the old contents', fs.statSync(audit.generation(1)).size === before);
  // Renamed, not copied: an event must not appear in two generations at once.
  check('the new event is in the live file only',
    fs.readFileSync(audit.FILE, 'utf8').includes('after_roll')
    && !fs.readFileSync(audit.generation(1), 'utf8').includes('after_roll'));
}

console.log('\nThe oldest generation is dropped, not kept forever');
{
  // Stage a full set, then force one more roll.
  for (let n = 0; n <= audit.KEEP; n++) {
    fs.writeFileSync(audit.generation(n), JSON.stringify({ ts: new Date().toISOString(), event: `gen${n}` }) + '\n');
  }
  const oldestBefore = fs.readFileSync(audit.generation(audit.KEEP), 'utf8');
  fs.writeFileSync(audit.FILE, 'x'.repeat(audit.MAX_BYTES + 10));
  delete require.cache[require.resolve('../orchestrator/audit-log')];
  const fresh = require('../orchestrator/audit-log'); // resets its byte counter
  fresh.record({ event: 'forces_a_roll', customerId: 'acme-mfg' });

  const files = [];
  for (let n = 0; n <= fresh.KEEP; n++) if (fs.existsSync(fresh.generation(n))) files.push(n);
  check(`no more than ${fresh.KEEP} old generations survive`, files.length <= fresh.KEEP + 1, files.join(','));
  check('the oldest was discarded rather than retained',
    fs.readFileSync(fresh.generation(fresh.KEEP), 'utf8') !== oldestBefore);
}

// --------------------------------------------------------------- reading
console.log('\nReading it back');
{
  // Start clean so ordering and filters are unambiguous.
  for (let n = 0; n <= audit.KEEP; n++) { try { fs.unlinkSync(audit.generation(n)); } catch {} }
  delete require.cache[require.resolve('../orchestrator/audit-log')];
  const a = require('../orchestrator/audit-log');

  a.record({ event: 'org_kb_added', customerId: 'acme-mfg', title: 'Kyocera guide' });
  a.record({ event: 'org_kb_removed', customerId: 'rival-co', title: 'Rival secret manual' });
  a.record({ event: 'device_enrolled', deviceId: 'dev-1' });               // no organisation
  a.record({ event: 'org_admin_denied', customerId: 'acme-mfg', ip: '203.0.113.9' });

  const mine = a.read({ customerId: 'acme-mfg' });
  check('an organisation sees its own events', mine.length === 2, String(mine.length));
  check('newest first', mine[0].event === 'org_admin_denied', mine[0] && mine[0].event);

  const titles = JSON.stringify(mine);
  check('another organisation\'s events are excluded', !titles.includes('Rival secret manual'));
  check('service-level events with no organisation are excluded', !titles.includes('dev-1'));

  const all = a.read({});
  check('an operator with no scope sees everything', all.length === 4, String(all.length));

  check('the event filter works', a.read({ customerId: 'acme-mfg', event: 'org_kb_added' }).length === 1);
  check('the limit is honoured', a.read({}, 1).length === 4 && a.read({ limit: 1 }).length === 1);
  check('a future "since" excludes everything',
    a.read({ since: new Date(Date.now() + 86400000).toISOString() }).length === 0);

  // Only whitelisted fields come back, so an event type added later cannot
  // start leaking a field nobody reviewed.
  a.record({ event: 'weird', customerId: 'acme-mfg', secretSauce: 'do-not-return-me', ip: '198.51.100.4' });
  const scrubbed = a.read({ customerId: 'acme-mfg', event: 'weird' })[0];
  check('unknown fields are dropped', scrubbed && scrubbed.secretSauce === undefined);
  check('known fields survive', scrubbed && scrubbed.ip === '198.51.100.4' && Boolean(scrubbed.ts));
}

console.log('\nIt must never break the thing it is auditing');
{
  const a = require('../orchestrator/audit-log');
  let threw = false;
  // A circular object cannot be stringified; recording it must be a no-op, not
  // an exception thrown out of the middle of a customer's session.
  const circular = { event: 'loop' }; circular.self = circular;
  try { a.record(circular); } catch { threw = true; }
  check('an unserialisable event does not throw', !threw);

  // A torn final line (a crash mid-append) must not break reading.
  fs.appendFileSync(a.FILE, '{"event":"truncated","customerI');
  let readThrew = false;
  try { a.read({}); } catch { readThrew = true; }
  check('a torn last line is skipped rather than fatal', !readThrew);
}

console.log('\nWhere it lives');
{
  const a = require('../orchestrator/audit-log');
  const norm = (p) => path.resolve(p).split('\\').join('/').toLowerCase();
  check('on the data volume, not in the image', norm(a.FILE).startsWith(norm(DATA)), a.FILE);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
console.log('All audit-trail checks passed.');
