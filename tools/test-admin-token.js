#!/usr/bin/env node
// Organisation access tokens, and rotating them.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-admin-token.js
//
// Rotation exists for one situation: the admin believes their token has been
// seen by someone who should not have it. That makes the only property worth
// testing the unkind one — that the OLD token stops working. A rotation that
// reports success while the previous credential still opens the console is
// worse than no rotate button at all, because the admin stops worrying.
//
// Refuses to run against the real data directory: it writes and replaces
// tokens, and rotating a live customer's console access by accident would lock
// them out of their own documentation.

const fs = require('fs');

if (!process.env.RESOLVE_DATA_DIR) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes and replaces tokens.');
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const org = require('../orchestrator/org-library');

console.log('\nIssuing');
const first = org.ensureAdminToken('acme-mfg');
check('a token is created on first request', first.created && first.token.length > 20);
const again = org.ensureAdminToken('acme-mfg');
check('asking again returns the same one', !again.created && again.token === first.token,
  'a second call must not silently rotate — the customer already has the first');
check('it opens the console', org.adminTokenOk('acme-mfg', first.token));

console.log('\nRotating');
const other = org.ensureAdminToken('rival-co');
const rotated = org.rotateAdminToken('acme-mfg');
check('rotation succeeds', rotated.ok, rotated.error);
check('the new token is different', rotated.token !== first.token);
// The whole point. If this passes and nothing else does, the feature still works.
check('the OLD token stops working', !org.adminTokenOk('acme-mfg', first.token),
  'the leaked credential still opens the console');
check('the new token works', org.adminTokenOk('acme-mfg', rotated.token));

console.log('\nOne organisation at a time');
check('another org is untouched', org.adminTokenOk('rival-co', other.token));
check('and its token did not change', org.ensureAdminToken('rival-co').token === other.token);
check('the rotated token does not open another org', !org.adminTokenOk('rival-co', rotated.token));

console.log('\nRefusals');
check('an empty organisation is refused', !org.rotateAdminToken('').ok);
check('a wrong token is refused', !org.adminTokenOk('acme-mfg', 'not-the-token'));
check('an empty token is refused', !org.adminTokenOk('acme-mfg', ''));
// adminTokenOk compares with timingSafeEqual, which throws on a length
// mismatch unless the lengths are checked first. A truncated token is exactly
// what a bad paste produces, so this must return false rather than crash.
let threw = false;
try { org.adminTokenOk('acme-mfg', rotated.token.slice(0, 5)); } catch { threw = true; }
check('a truncated token is refused without throwing', !threw);

console.log('\nWhen the service pins the token in its environment');
{
  // loadAdminTokens lets RESOLVE_CUSTOMER_ADMIN_TOKENS win over the file, so a
  // rotation here would write a token nothing ever reads — and the admin would
  // be told their leaked one was replaced while it carried on working.
  const before = process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS;
  process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS = JSON.stringify({ 'pinned-co': 'fixed-by-the-service' });
  check('a pinned org is reported as pinned', org.adminTokenIsPinned('pinned-co'));
  const r = org.rotateAdminToken('pinned-co');
  check('rotation is refused rather than faked', !r.ok, 'it claimed to rotate a pinned token');
  check('and says why', /RESOLVE_CUSTOMER_ADMIN_TOKENS/.test(r.error || ''), r.error);
  check('the pinned token still works', org.adminTokenOk('pinned-co', 'fixed-by-the-service'));
  check('an unpinned org is not affected by the override', !org.adminTokenIsPinned('acme-mfg'));
  if (before === undefined) delete process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS;
  else process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS = before;
}

console.log('\nPersistence');
// Separators are normalised on both sides: the env var is given with forward
// slashes and path.resolve hands back Windows ones, which is a difference in
// the test rather than in where the file actually lands.
const norm = (p) => require('path').resolve(p).split('\\').join('/').toLowerCase();
check('tokens are written to the data directory, not the image',
  fs.existsSync(org.ADMIN_TOKENS_FILE) && norm(org.ADMIN_TOKENS_FILE).startsWith(norm(process.env.RESOLVE_DATA_DIR)),
  org.ADMIN_TOKENS_FILE);

console.log('');
if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
console.log('All access-token checks passed.');
