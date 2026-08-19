#!/usr/bin/env node
// Microsoft 365 tenant storage.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-m365-store.js
//
// The property under test is narrow and important: a customer's client secret
// is tenant-wide, and it must never come back out of this module. Every return
// value here ends up in an API response, a log line, or an audit record, and a
// secret that reaches any of those has to be rotated with the customer.
//
// Refuses to run against the real data directory — it writes tenant records.

const assert = require('assert');

if (!process.env.RESOLVE_DATA_DIR) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes tenant records.');
  process.exit(1);
}

const m = require('../orchestrator/microsoft');

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

const SECRET = 'super-secret-value-that-must-never-leak';

console.log('\n=== the client secret never comes back out ===');
const saved = m.setTenant('acme-com', {
  tenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: SECRET, domain: 'acme.com',
});
check('setTenant result omits the secret', !JSON.stringify(saved).includes(SECRET),
  JSON.stringify(saved).slice(0, 80));
check('tenantInfo omits the secret', !JSON.stringify(m.tenantInfo('acme-com')).includes(SECRET));
check('tenantInfo still reports what is configured', m.tenantInfo('acme-com').tenantId === 'tenant-guid');

console.log('\n=== but it is stored, so authentication can work ===');
const raw = require('fs').readFileSync(m.TENANTS_FILE, 'utf8');
check('secret is on disk', raw.includes(SECRET));
const mode = require('fs').statSync(m.TENANTS_FILE).mode & 0o777;
// Windows does not honour POSIX modes; assert only where it means something.
if (process.platform !== 'win32') {
  check('file is not world-readable', (mode & 0o077) === 0, '0' + mode.toString(8));
} else {
  console.log('  --    file mode not asserted on Windows (POSIX modes are not enforced)');
}

console.log('\n=== configuration state is per organisation ===');
check('configured org reports true', m.isConfigured('acme-com') === true);
check('unknown org reports false', m.isConfigured('someone-else') === false);
check('unknown org has no info', m.tenantInfo('someone-else') === null);

console.log('\n=== one org cannot see another org\'s tenant ===');
m.setTenant('other-co', { tenantId: 't2', clientId: 'c2', clientSecret: 'other-secret' });
check('acme still points at its own tenant', m.tenantInfo('acme-com').tenantId === 'tenant-guid');
check('other-co points at its own', m.tenantInfo('other-co').tenantId === 't2');
// A lookalike id must not match — the console leak class of bug.
check('lookalike org id does not match', m.isConfigured('acme-com-two') === false);

console.log('\n=== incomplete credentials are refused, not half-saved ===');
for (const [label, input] of [
  ['no tenantId', { clientId: 'c', clientSecret: 's' }],
  ['no clientId', { tenantId: 't', clientSecret: 's' }],
  ['no clientSecret', { tenantId: 't', clientId: 'c' }],
]) {
  let threw = false;
  try { m.setTenant('partial-co', input); } catch { threw = true; }
  check(`${label} rejected`, threw);
}
check('nothing was saved for the rejected org', m.isConfigured('partial-co') === false);

let threwNoOrg = false;
try { m.setTenant('', { tenantId: 't', clientId: 'c', clientSecret: 's' }); } catch { threwNoOrg = true; }
check('missing customerId rejected', threwNoOrg);

console.log('\n=== disconnecting really removes it ===');
check('remove reports it existed', m.removeTenant('other-co') === true);
check('and it is gone', m.isConfigured('other-co') === false);
check('removing again reports false', m.removeTenant('other-co') === false);
const after = require('fs').readFileSync(m.TENANTS_FILE, 'utf8');
check('its secret is gone from disk', !after.includes('other-secret'));

console.log('');
console.log(fail ? `${fail} check(s) FAILED` : 'All checks passed.');
process.exit(fail ? 1 : 0);
