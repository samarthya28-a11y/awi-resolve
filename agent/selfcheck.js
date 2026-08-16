'use strict';
// Offline self-check.
//
// Resolve's intelligence lives in the cloud, so with no internet there is no AI
// technician. But every read-only diagnostic tool already runs ON the PC — they
// are PowerShell — so the machine can still be examined and the common faults
// can still be named and fixed.
//
// There is a particular irony worth designing for: when there is no internet,
// the problem very often IS the internet. That is exactly the case this handles
// best, and the case where a cloud-only product is useless.
//
// This deliberately does NOT pretend to be the AI. It runs a fixed list of
// checks and matches them against a small set of known faults. When nothing
// matches it says so plainly and offers to hand the findings to the AI once the
// connection is back — a confident wrong answer offline would be worse than an
// honest "I can see this much".

const { TOOLS } = require('./tools');

// Known faults, checked in order. Each rule reads the gathered facts and either
// matches or does not; the first match wins so the most specific fault is
// reported rather than a generic one.
//
// Every rule states what was OBSERVED, so the person can judge for themselves
// rather than taking a verdict on faith.
// A service is only reported as stopped when we actually read a status. An
// unreadable service tells us nothing, and "unknown" must never be presented as
// "broken" — that was a real bug: reading the wrong field made every service on
// a healthy PC look stopped.
function svcStopped(svc) {
  const status = svc && (svc.Status || svc.status);
  return !!status && status !== 'Running';
}
function svcStatus(svc) {
  return (svc && (svc.Status || svc.status)) || 'not readable';
}

/** Adapters that are actually connected. A disconnected virtual adapter
 *  normally holds a self-assigned address and means nothing. */
function liveAdapters(f) {
  return ((f.network && f.network.adapters) || []).filter((a) => (a.status || '') === 'Up');
}
function routable(a) {
  return !!a.ipv4 && !/^169\.254\./.test(a.ipv4);
}

const RULES = [
  {
    id: 'no-ip',
    title: 'This PC has not been given a network address',
    // Only a fault when connected adapters exist and NONE of them has a usable
    // address. Firing on any single self-assigned address reported a fault on a
    // healthy PC that merely had a disconnected virtual adapter.
    when: (f) => {
      const live = liveAdapters(f);
      return live.length > 0 && !live.some(routable);
    },
    observed: (f) => {
      const a = liveAdapters(f).find((x) => /^169\.254\./.test(x.ipv4 || ''));
      return a ? `Adapter "${a.adapter}" has a self-assigned address (${a.ipv4}), which means it never heard back from the router.`
               : 'No connected adapter has a usable address.';
    },
    advice: [
      'Check the network cable is seated at both ends, or that Wi-Fi is connected to the right network.',
      'Restart the router if other devices are also offline.',
      'Resolve can renew the address for you once you are back online, or your IT admin can run: ipconfig /renew',
    ],
  },
  {
    id: 'dhcp-stopped',
    title: 'The Windows service that gets a network address is not running',
    when: (f) => svcStopped(f.services && f.services.Dhcp),
    observed: (f) => `The DHCP Client service is ${svcStatus(f.services.Dhcp)}.`,
    advice: ['This service must run for the PC to join a network. Your IT admin can start it from Services, or Resolve can once reconnected.'],
  },
  {
    id: 'dns-stopped',
    title: 'The Windows service that looks up website names is not running',
    when: (f) => svcStopped(f.services && f.services.Dnscache),
    observed: (f) => `The DNS Client service is ${svcStatus(f.services.Dnscache)}.`,
    advice: ['Without it, names like alphawebin.com cannot be resolved even when the connection itself works.'],
  },
  {
    id: 'spooler-stopped',
    title: 'The print service is not running',
    when: (f) => svcStopped(f.services && f.services.Spooler),
    observed: (f) => `The Print Spooler service is ${svcStatus(f.services.Spooler)}.`,
    advice: ['Nothing will print until it is started. This is the most common cause of "printer offline".'],
  },
  {
    id: 'queue-stuck',
    title: 'Print jobs are stuck in the queue',
    when: (f) => (f.printQueue && f.printQueue.jobCount) > 0,
    observed: (f) => `${f.printQueue.jobCount} job(s) are waiting in the print queue.`,
    advice: ['Clearing the queue usually releases printing. Resolve can do this with your approval once reconnected.'],
  },
  {
    id: 'disk-low',
    title: 'This PC is nearly out of disk space',
    when: (f) => f.snapshot && f.snapshot.diskC && f.snapshot.diskC.freeGB != null && f.snapshot.diskC.freeGB < 5,
    observed: (f) => `Drive C: has ${f.snapshot.diskC.freeGB} GB free.`,
    advice: ['Windows becomes unstable below a few GB free. Emptying the Recycle Bin and clearing temporary files usually recovers space.'],
  },
  {
    id: 'protection-off',
    title: 'Virus protection is not active',
    when: (f) => f.posture && f.posture.realTimeProtection === false,
    observed: () => 'Real-time protection is reported as off.',
    advice: ['Turn it back on from Windows Security. If it will not stay on, treat that as urgent and contact your IT admin.'],
  },
];

/** Gather the facts every rule reads. Read-only, no changes to the PC. */
async function gather() {
  const run = async (name, params = {}) => {
    try {
      const t = TOOLS[name];
      if (!t) return null;
      const r = await t.run(params);
      return r && r.status === 'error' ? null : r;
    } catch { return null; }
  };
  const [snapshot, network, printQueue, posture] = await Promise.all([
    run('get_system_snapshot'),
    run('get_network_config'),
    run('get_print_queue'),
    run('get_security_posture'),
  ]);
  const services = {};
  for (const svc of ['Spooler', 'Dhcp', 'Dnscache']) {
    services[svc] = await run('read_service_status', { service: svc });
  }
  return { snapshot, network, printQueue, posture, services };
}

/** Run the checks and return findings a person can act on. */
async function selfCheck() {
  const facts = await gather();
  const findings = [];
  for (const rule of RULES) {
    let hit = false;
    try { hit = !!rule.when(facts); } catch { hit = false; }
    if (!hit) continue;
    findings.push({
      id: rule.id,
      title: rule.title,
      observed: (() => { try { return rule.observed(facts); } catch { return ''; } })(),
      advice: rule.advice,
    });
  }
  return {
    at: new Date().toISOString(),
    offline: true,
    findings,
    // Said plainly. Offline this is pattern-matching against a short list, not
    // the AI technician, and implying otherwise would be the kind of promise
    // that gets found out on the one occasion it matters.
    note: findings.length
      ? 'These are the faults I can recognise on my own while offline. I have not changed anything. Once this PC is back online, ask me again and the AI technician can investigate properly and apply fixes with your approval.'
      : 'I checked the usual causes — network address, network services, printing, disk space and virus protection — and none of them is obviously wrong. Offline I can only recognise common faults; once this PC is back online the AI technician can investigate properly.',
    facts,
  };
}

module.exports = { selfCheck, RULES };
