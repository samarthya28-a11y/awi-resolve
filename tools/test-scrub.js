// Adversarial test for the playbook scrubber. Written as a file, not an inline
// -e script, because shell escaping of backslashes makes inline tests lie about
// what was actually passed in.
const L = require('../orchestrator/learning');

let fail = 0;
function t(label, input, mustNotContain, terms = []) {
  const out = L.scrub(input, terms);
  const leaked = mustNotContain.filter((x) => out.includes(x));
  const ok = leaked.length === 0;
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  LEAK ') + label.padEnd(30) +
    (ok ? out.slice(0, 62) : 'LEAKED ' + leaked.join(', ') + '  ->  ' + out.slice(0, 50)));
}

console.log('=== scrubbing ===');
t('machine name', 'Fixed on LAPTOP-TV749CH9 today', ['LAPTOP-TV749CH9']);
t('windows user path', 'Cleared C:\\Users\\girish.manchanda\\AppData\\Temp', ['girish.manchanda']);
t('linux home path', 'Checked /home/girish/logs', ['/home/girish']);
t('email', 'Contact admin@acmeprinting.co.in', ['admin@acmeprinting.co.in']);
t('internal ip', 'Printer at 192.168.1.45 offline', ['192.168.1.45']);
t('mac address', 'Adapter 00:1A:2B:3C:4D:5E down', ['00:1A:2B:3C:4D:5E']);
t('unc share', 'Mapped \\\\FILESRV01\\accounts failed', ['FILESRV01', '\\accounts']);
t('guid', 'device 5c7e5b1f-e85c-4f88-b1fd-7bc6dae69051', ['5c7e5b1f']);
t('licence key', 'key RSLIC1-eyJwYXlsb2FkIjp7 pasted', ['RSLIC1-eyJ']);
t('customer name', 'Acme Printing Ltd reported it', ['Acme'], ['Acme Printing Ltd']);
t('org slug', 'org acme-printing had it', ['acme-printing'], ['acme-printing']);

console.log('\n=== useful detail that must SURVIVE ===');
for (const s of ['Ping 8.8.8.8 succeeded', 'Restarted the Spooler service', 'Gespage client v9 was outdated']) {
  const out = L.scrub(s);
  const kept = out === s;
  if (!kept) fail++;
  console.log((kept ? '  ok   ' : '  LOST ') + s + (kept ? '' : '  ->  ' + out));
}

console.log('\n=== tripwire catches anything that slipped ===');
const dirty = 'Fixed on LAPTOP-ABCD1234 for bob@x.com at 10.0.0.5';
console.log('  residual on raw text :', L.residualIdentifiers(dirty).join(', ') || 'none');
console.log('  residual on scrubbed :', L.residualIdentifiers(L.scrub(dirty)).join(', ') || 'none');

process.exit(fail ? 1 : 0);
