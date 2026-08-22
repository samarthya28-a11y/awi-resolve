'use strict';
// AWI Resolve orchestrator — the cloud side. Accepts agent connections, enrolls
// devices, sends tool calls, records every action to an audit log, and (Phase 1b)
// runs the Claude-powered diagnostic loop when an agent connects.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { diagnose, MODEL, pickModel, resolveOrchestratorTool } = require('./ai');
const { loadManuals } = require('./manuals');
const customerConsole = require('./console');
const { evaluate: evaluateLicense, beginIfTimeBoxed, PLANS: LICENCE_PLANS } = require('./licensing');
const licenceIssue = require('./licence-issue');
const alerts = require('./alerts');
const { performance } = require('./performance');
const microsoft = require('./microsoft');
const orgLibrary = require('./org-library');

// deviceId -> licence evaluation, consulted before any tool that changes the PC.
const deviceLicenses = new Map();
// deviceId -> the raw key. Kept because a time-boxed pass has to be re-evaluated
// once its clock starts: the evaluation cached at enrollment was made before the
// window existed, so its expiry would be stale for the rest of the connection.
const deviceLicenseKeys = new Map();
// deviceId -> customer org id (slug) for the IT-admin software library.
const deviceCustomers = new Map();
// customerId -> seats sold on that org's licence, for advisory seat reporting.
const orgSeats = new Map();
const { kbStats, invalidateKb } = require('./kb');
const { recordPosture, fleetView } = require('./fleet');
const { buildReport, saveReport, listReports, getReport } = require('./report');
const ledger = require('./ledger');
const learning = require('./learning');
const { prospects } = require('./prospects');

// The fleet dashboard exposes customer security posture, so it is never open.
// Set RESOLVE_DASHBOARD_TOKEN to enable it; unset = dashboard disabled entirely.
const DASHBOARD_TOKEN = process.env.RESOLVE_DASHBOARD_TOKEN || '';
// Optional bootstrap: RESOLVE_DEFAULT_CUSTOMER_ID used in local/dev when a
// licence has no customerId/customer name (so the admin library still works).
const DEFAULT_CUSTOMER_ID = process.env.RESOLVE_DEFAULT_CUSTOMER_ID || '';

const MANUALS = loadManuals();
const KB = kbStats();

// Load env from a local .env for dev (gitignored). In the cloud, real env vars /
// host secrets are already set, so a missing .env is fine.
const ENV_FILE = path.join(__dirname, '..', '.env');
try { process.loadEnvFile(ENV_FILE); } catch { /* rely on real env vars */ }
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Door key: when set (always in production), an agent must present a matching
// enrollmentSecret to connect. Unset in local dev => open, for convenience.
const ENROLLMENT_SECRET = process.env.RESOLVE_ENROLLMENT_SECRET || '';

// Licence signing key (PEM). Present only where licences are issued; the
// service runs perfectly well without it and simply refuses to issue. Absent by
// default so a self-hosted or development connector never holds it by accident.
const SIGNING_KEY = process.env.RESOLVE_LICENCE_SIGNING_KEY || '';

// Fly/most hosts inject PORT; fall back to our dev default.
const PORT = Number(process.env.PORT || process.env.RESOLVE_PORT || 8787);
const { DATA_DIR } = require('./paths');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const REPORT_FILE = path.join(DATA_DIR, 'demo-report.json');
const DIAGNOSIS_FILE = path.join(DATA_DIR, 'diagnosis.json');
const ESCALATION_FILE = path.join(DATA_DIR, 'escalation.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  console.log(`[orchestrator ${new Date().toISOString()}] ${msg}`);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function loadDevices() {
  return fs.existsSync(DEVICES_FILE) ? JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')) : {};
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

// Black-box recorder: one line per event, append-only (spec §5.2 audit log).
function audit(event) {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

const pendingCalls = new Map(); // callId -> resolve()

/**
 * What the customer's own window is allowed to know about their licence.
 *
 * Enough to show "Standard, 340 days left" or to prompt for a key, and nothing
 * that would help someone forge one. Sent on every connection so the window can
 * offer activation the moment it is needed, rather than making the customer
 * find and hand-edit a JSON file.
 *
 * It also carries the descriptive fields the licence window shows — who the
 * licence belongs to, who it is allocated to, when it was issued — because the
 * customer holds that key already: none of it is a secret from them, and being
 * unable to answer "whose licence is this?" is a support call.
 */
function licenceSummary(lic) {
  if (!lic) return { valid: false, plan: 'none', reason: 'no licence' };
  return {
    valid: Boolean(lic.valid),
    plan: lic.plan || 'none',
    label: (LICENCE_PLANS[lic.plan] || LICENCE_PLANS.none).label,
    customer: lic.customer || null,
    customerId: lic.customerId || null,
    // Who it is allocated to at the customer, and the name their window wears.
    licensedTo: lic.licensedTo || null,
    licensedToEmail: lic.licensedToEmail || null,
    brandName: lic.brandName || lic.customer || null,
    licenseId: lic.licenseId || null,
    seats: lic.seats || null,
    issuedAt: lic.issuedAt || null,
    expiresAt: lic.expiresAt || null,
    daysLeft: lic.daysLeft != null ? lic.daysLeft : null,
    expired: Boolean(lic.expired),
    reason: lic.reason || null,
    // A time-boxed pass that has not been started yet — worth saying so, since
    // "0 days left" would be alarming and wrong.
    timeBoxed: Boolean(lic.timeBoxed),
    startedAt: lic.startedAt || null,
    hoursLeft: lic.hoursLeft != null ? Math.round(lic.hoursLeft) : null,
    activationDeadline: lic.activationDeadline || null,
  };
}

async function resolveCloudTool(ws, deviceId, customerId, name, input) {
  // ---- Microsoft 365 -------------------------------------------------------
  // Answers questions about a user in the customer's Microsoft tenant, not
  // about the PC we are connected to. Runs here rather than on the agent
  // because the credentials are tenant-wide and have no business on an end
  // user's laptop, and because the affected user is frequently at a different
  // machine entirely.
  if (name.startsWith('m365_')) {
    if (!customerId) {
      return {
        status: 'error',
        reason: 'This PC is not linked to a customer organisation, so I cannot tell which Microsoft tenant to look in.',
      };
    }
    if (!microsoft.isConfigured(customerId)) {
      return {
        status: 'error',
        reason:
          'No Microsoft 365 tenant is connected for this organisation. An Alpha Web admin connects one in the licence manager; ' +
          'it needs the customer to register an app in their Entra ID and grant read-only consent. Until then, advise on the ' +
          'admin-portal steps instead of trying to look anything up.',
      };
    }
    const user = input && input.user;
    try {
      switch (name) {
        case 'm365_find_user':
          return { status: 'ok', result: await microsoft.findUser(customerId, user) };
        case 'm365_licence_details':
          return { status: 'ok', result: await microsoft.licenceDetails(customerId, user) };
        case 'm365_recent_signins':
          return { status: 'ok', result: await microsoft.recentSignIns(customerId, user, input && input.limit) };
        case 'm365_onedrive_status':
          return { status: 'ok', result: await microsoft.oneDriveStatus(customerId, user) };
        default:
          return { status: 'error', reason: `Unknown Microsoft 365 tool "${name}".` };
      }
    } catch (e) {
      // Microsoft's own message is genuinely diagnostic here — a missing
      // permission, an expired secret, consent never granted — so pass it
      // through rather than flattening it to "lookup failed".
      audit({ event: 'm365_tool_failed', deviceId, customerId, tool: name, reason: e.message });
      return { status: 'error', reason: e.message };
    }
  }

  if (name === 'list_org_approved_software') {
    if (!customerId) {
      return {
        status: 'ok',
        result: {
          products: [],
          message: 'This PC is not linked to a customer organisation yet. Ask IT admin to issue a licence with a customer name/id, or set RESOLVE_DEFAULT_CUSTOMER_ID on the service for local testing.',
        },
      };
    }
    const products = orgLibrary.listEnabled(customerId);
    return {
      status: 'ok',
      result: {
        customerId,
        products,
        message: products.length
          ? null
          : 'Your IT admin has not approved any packages in the organisation software library yet.',
      },
    };
  }
  if (name === 'read_org_software_manual') {
    if (!customerId) {
      return { status: 'error', reason: 'No customer organisation linked to this device.' };
    }
    const entry = orgLibrary.getPackage(customerId, input && input.productId);
    if (!entry || entry.enabled === false) {
      return {
        status: 'ok',
        result: {
          found: false,
          message: `No enabled org package "${input && input.productId}". Call list_org_approved_software.`,
          available: orgLibrary.listEnabled(customerId).map((p) => p.productId),
        },
      };
    }
    return {
      status: 'ok',
      result: {
        found: true,
        productId: entry.productId,
        product: entry.productName,
        version: entry.version || null,
        manual: entry.manualText,
      },
    };
  }
  if (name === 'deploy_org_software') {
    if (!customerId) {
      return { status: 'error', reason: 'No customer organisation linked — cannot deploy org software.' };
    }
    const entry = orgLibrary.getPackage(customerId, input && input.productId);
    if (!entry || entry.enabled === false) {
      return {
        status: 'error',
        reason: `"${input && input.productId}" is not in this organisation's approved software library (or is disabled). Their IT admin must add it first.`,
      };
    }
    // AI never sees/supplies the URL — we pin it here from the admin library.
    return callTool(ws, deviceId, 'deploy_pinned_software', {
      productName: entry.productName,
      url: entry.downloadUrl,
      sha256: entry.sha256,
      installerType: entry.installerType,
      productId: entry.productId,
    });
  }
  return resolveOrchestratorTool(name, input, MANUALS);
}

// How long the cloud waits for the agent to answer a tool call.
// MUST exceed the agent's consent window (60s) — otherwise we could give up on a
// Tier-2 action while the customer is still deciding, and the action could then
// run after the AI has already concluded it didn't. Deployments also need room
// for a download + installer run (agent caps the installer at 5 min).
const TOOL_TIMEOUT_MS = 120000;         // read-only + quick fixes (> 60s consent)
const DEPLOY_TIMEOUT_MS = 480000;       // consent + download + install + verify
const FULL_SHELL_TIMEOUT_MS = 420000;   // consent 60s + PowerShell up to 5 min + buffer
const TICKET_HARD_TIMEOUT_MS = 15 * 60 * 1000; // force-clear busy if a ticket hangs

// Read-only naming convention, same as the session report uses.
const READ_ONLY_TOOL = /^(get_|list_|read_|check_|test_|search_)/;

// Only these allowlisted change tools are licence-gated. Anything else that
// isn't read-only (e.g. the safety probe's off-allowlist `run_shell`) must
// reach the agent so it can refuse on-device — gating it here as "not
// licensed" would hide a real allowlist failure behind a false FAIL.
const KNOWN_CHANGE_TOOLS = new Set([
  'clear_dns_cache', 'restart_service', 'clear_print_queue', 'enable_service',
  'restart_explorer', 'renew_network', 'update_defender_signatures',
  'run_security_scan', 'enable_protection', 'deploy_software',
  'deploy_pinned_software', 'clean_temp_files', 'run_powershell',
]);

function licenseAllows(deviceId, toolId) {
  if (READ_ONLY_TOOL.test(toolId)) return { allowed: true };
  if (!KNOWN_CHANGE_TOOLS.has(toolId)) return { allowed: true };
  const lic = deviceLicenses.get(deviceId);
  const caps = lic ? lic.caps : null;
  if (!caps || !caps.fixes) {
    return { allowed: false, why: lic && lic.expired
      ? `This machine's licence expired on ${String(lic.expiresAt).slice(0, 10)}.`
      : 'This machine does not have an active Resolve licence.' };
  }
  if ((toolId === 'deploy_software' || toolId === 'deploy_pinned_software') && !caps.deployment) {
    return { allowed: false, why: `Software deployment is not included in the ${caps.label} plan.` };
  }
  if (toolId === 'run_powershell') {
    if (!caps.fullSupport) {
      return { allowed: false, why: `Full IT Support (consented PowerShell) is not included in the ${caps.label} plan.` };
    }
    const customerId = deviceCustomers.get(deviceId);
    if (!orgLibrary.isFullItSupportAllowed(customerId)) {
      return {
        allowed: false,
        why: 'Full IT Support is not enabled by this organisation\'s IT admin. ' +
             'They can turn it on in the Approved Software / org admin page (allow Full IT Support).',
      };
    }
  }
  return { allowed: true };
}

function callTool(ws, deviceId, toolId, params, onProgress) {
  const gate = licenseAllows(deviceId, toolId);
  if (!gate.allowed) {
    audit({ event: 'tool_call_unlicensed', deviceId, toolId });
    log(`licence gate blocked '${toolId}' for ${deviceId}: ${gate.why}`);
    // Returned as a normal tool result so the AI explains it to the customer
    // and escalates, rather than the session simply failing.
    return Promise.resolve({
      status: 'not_licensed', toolId,
      error: `${gate.why} Diagnostics still work, but applying this fix needs an active licence — offer to escalate to a human technician, and mention that Alpha Web can activate a licence.`,
    });
  }
  return new Promise((resolve) => {
    const callId = crypto.randomUUID();
    let settled = false;
    let beat = null;
    let timer = null;
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      if (beat) clearInterval(beat);
      if (timer) clearTimeout(timer);
      pendingCalls.delete(callId);
      resolve(msg);
    };
    pendingCalls.set(callId, finish);
    audit({ event: 'tool_call_sent', deviceId, toolId, params });
    ws.send(JSON.stringify({ type: 'tool_call', callId, toolId, params }));
    const ms = (toolId === 'deploy_software' || toolId === 'deploy_pinned_software')
      ? DEPLOY_TIMEOUT_MS
      : (toolId === 'run_powershell' ? FULL_SHELL_TIMEOUT_MS : TOOL_TIMEOUT_MS);
    // Keep the customer UI alive during long downloads/installs.
    const heartbeatEvery = 25000;
    let elapsed = 0;
    beat = setInterval(() => {
      if (settled) { clearInterval(beat); return; }
      elapsed += heartbeatEvery;
      const secs = Math.round(elapsed / 1000);
      if (typeof onProgress === 'function') {
        onProgress(
          toolId === 'run_powershell' || toolId === 'deploy_software' || toolId === 'deploy_pinned_software'
            ? `Still working on ${toolId.replace(/_/g, ' ')}… (${secs}s). Large downloads can take a few minutes.`
            : `Still running ${toolId.replace(/_/g, ' ')}… (${secs}s)`
        );
      }
    }, heartbeatEvery);
    timer = setTimeout(() => finish({ status: 'timeout', toolId }), ms);
  });
}

// Phase 0 demo: prove the plumbing end-to-end as soon as an agent connects.
// 1) read-only snapshot  2) service status  3) a FORBIDDEN call the agent must refuse.
async function runDemoSequence(ws, deviceId) {
  log('demo: requesting system snapshot...');
  const snapshot = await callTool(ws, deviceId, 'get_system_snapshot', {});

  log('demo: requesting print spooler status...');
  const spooler = await callTool(ws, deviceId, 'read_service_status', { service: 'Spooler' });

  log('demo: reading print queues...');
  const queue = await callTool(ws, deviceId, 'get_print_queue', {});

  log('demo: reading recent System event-log errors...');
  const events = await callTool(ws, deviceId, 'read_event_log', { log: 'System' });

  log('demo: testing network reachability (localhost)...');
  const net = await callTool(ws, deviceId, 'test_network', { target: '127.0.0.1' });

  log('demo: attempting a FORBIDDEN free-form shell command (agent must refuse)...');
  const forbidden = await callTool(ws, deviceId, 'run_shell', { command: 'whoami' });

  log('demo: attempting an off-list event log (agent must reject the parameter)...');
  const badParam = await callTool(ws, deviceId, 'read_event_log', { log: 'Security' });

  const report = {
    generatedAt: new Date().toISOString(),
    deviceId,
    snapshot,
    spoolerStatus: spooler,
    printQueue: queue,
    systemEvents: events,
    networkTest: net,
    forbiddenToolTest: forbidden,
    badParamTest: badParam,
    verdict:
      forbidden.status === 'refused' && badParam.status === 'error'
        ? 'PASS — agent refused off-allowlist tool AND off-list parameter on-device'
        : 'FAIL — a forbidden request got through! Do not proceed.',
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  log(`demo complete — verdict: ${report.verdict}`);
  log(`full report written to ${REPORT_FILE}`);
}

// Standing safety check: on connect, prove the agent refuses an off-allowlist
// tool before we ever run a real session against it (spec §9.1).
async function safetyProbe(ws, deviceId) {
  const forbidden = await callTool(ws, deviceId, 'run_shell', { command: 'whoami' });
  const passed = forbidden.status === 'refused';
  log(passed
    ? 'safety probe PASS — agent refused an off-allowlist tool on-device.'
    : 'safety probe FAIL — agent did NOT refuse an off-allowlist tool!');
  return passed;
}

// A ticket = one customer-initiated support session. The AI technician
// investigates, applies consent-gated fixes, verifies, and closes with a
// plain-language summary that streams back to the customer window.
const busyDevices = new Set();
// Per-device customer-supplied documents: { pending: [] (not yet given to the
// AI), all: [] (everything attached this session) }.
const customerManuals = new Map();
// Live conversations per device, so follow-ups ("done step 3", "here's the
// error") continue the same session instead of starting cold.
const conversations = new Map();   // deviceId -> { messages, lastAt, opened, turns }
const CONVERSATION_TTL_MS = 60 * 60 * 1000;   // an hour of quiet = new session

// How many messages one ticket buys, including the first.
//
// Time alone is not a bound. A conversation capped only by an hour of quiet
// could take fifty follow-ups, each running the full tool loop, and every one
// of them costs tokens against a ticket that was paid for once. That is how a
// per-ticket price becomes loss-making on exactly the customers who use it most.
//
// Five is generous for a real support exchange — investigate, answer, two
// clarifications, confirm — and nobody is cut off: the next message simply
// starts a new ticket, which is said plainly before it happens.
const MAX_TURNS_PER_TICKET = 5;

// How much attached documentation one conversation will carry, in characters.
//
// A manual enters the conversation and is then re-read on every subsequent
// step, so it is charged many times over — on the worst modelled session,
// re-reading accounted for 80% of the cost. The old 500,000-char limit was per
// document with no total, so a handful of files could exhaust the model's
// context window and the session would simply fail.
//
// Until now the only thing preventing that was the context window itself —
// a number Anthropic controls, not us. When a larger window ships, this limit
// is what keeps the ceiling ours.
//
// 80,000 characters is roughly thirty pages: enough for a real installation
// guide, cheap enough to re-read, and far below anything that breaks a session.
const MANUAL_CHAR_LIMIT = 80000;
const MANUAL_TOTAL_CHARS = 80000;

// What one ticket buys, in API spend.
//
// A typical session costs around Rs 2, so this is generous by a factor of
// twenty and no ordinary ticket will ever reach it. It exists for the rare
// session — a long deployment on Full IT Support with documentation attached —
// that would otherwise cost multiples of what the ticket was sold for.
//
// At that point the customer is asked rather than the loss absorbed or the work
// refused: "this is bigger than one ticket, shall I carry on?" Set below the
// Rs 69 ticket price so an approved extension still carries margin.
// Overridable so the gate can be exercised without spending Rs 40 of tokens to
// reach it — a control this important should be testable for pennies.
const TICKET_BUDGET_INR = Number(process.env.RESOLVE_TICKET_BUDGET_INR) || 40;

// How many extra tickets one approval authorises.
//
// A ceiling, not a price: only tickets the session actually reaches are
// charged, so approving three and finishing after one costs one. Asking per
// ticket instead would be maximally transparent and maximally irritating — five
// prompts in a session reads as nickel-and-diming even when every one is
// honest. It also makes the design robust to TICKET_BUDGET_INR being set too
// low, which matters while there is barely any real usage to calibrate against.
const EXTRA_TICKET_GRANT = Number(process.env.RESOLVE_EXTRA_TICKET_GRANT) || 3;
const USD_TO_INR = Number(process.env.RESOLVE_USD_INR) || 88;

// deviceId -> resolve(), for a cost approval the customer has not answered yet.
const pendingCostApprovals = new Map();
const COST_APPROVAL_TIMEOUT_MS = 90000;

/**
 * Ask the customer to approve spending another ticket, and wait.
 *
 * A timeout counts as "no". Charging for work somebody walked away from is
 * exactly the surprise that makes a prepaid model feel like a trap.
 */
function requestCostApproval(ws, deviceId, { ticketsUsed, grant, spentInr }) {
  return new Promise((resolve) => {
    const approvalId = crypto.randomUUID();
    pendingCostApprovals.set(approvalId, resolve);
    ws.send(JSON.stringify({
      type: 'cost_approval',
      approvalId,
      ticketsUsed,
      grant,
      spentInr: Math.round(spentInr),
      // "Up to" is the important phrase. It is a ceiling being authorised, not
      // a price being quoted, and only tickets actually reached are charged.
      prompt:
        `This one is bigger than a single support ticket covers — it has already taken `
        + `${ticketsUsed === 1 ? 'a full ticket' : `${ticketsUsed} tickets`} of work.\n\n`
        + `Shall I keep going? It may take up to ${grant} more support ticket${grant === 1 ? '' : 's'}, `
        + `and you are only charged for the ones it actually uses — if it finishes sooner, you pay less.\n\n`
        + `If you would rather stop, I will write up everything found so far and nothing further is charged.`,
    }));
    setTimeout(() => {
      if (pendingCostApprovals.delete(approvalId)) resolve('timeout');
    }, COST_APPROVAL_TIMEOUT_MS);
  });
}
// Screenshots/images attached but not yet handed to the AI.
const pendingImages = new Map();   // deviceId -> [{mediaType, data}]

async function runTicket(ws, deviceId, ticket) {
  if (busyDevices.has(deviceId)) {
    // A second click while the first ticket is still running — tell the UI so
    // it does not sit forever on "Working…" with no reply.
    ws.send(JSON.stringify({
      type: 'ai_update',
      text: 'Still working on your previous request — please wait a moment, then try again.',
    }));
    ws.send(JSON.stringify({ type: 'ticket_done' }));
    return;
  }
  busyDevices.add(deviceId);
  let hardTimer = null;
  try {
    hardTimer = setTimeout(() => {
      if (!busyDevices.has(deviceId)) return;
      log(`ticket hard-timeout for ${deviceId} — clearing busy lock`);
      busyDevices.delete(deviceId);
      try {
        ws.send(JSON.stringify({
          type: 'ai_update',
          text: 'That request took too long and was stopped so you can try again. If you were installing software, say so and I will continue from where it left off.',
        }));
        ws.send(JSON.stringify({ type: 'ticket_done' }));
      } catch { /* ws may be closed */ }
    }, TICKET_HARD_TIMEOUT_MS);

    // Resume an in-flight conversation if the customer is replying to us.
    const prior = conversations.get(deviceId);
    const withinWindow = !!(prior && (Date.now() - prior.lastAt) < CONVERSATION_TTL_MS);
    // Two things end a conversation: an hour of quiet, or running out of turns.
    // Without the second, one ticket could fund an unlimited number of AI runs.
    const turnsUsed = (prior && prior.turns) || 0;
    const turnsLeft = MAX_TURNS_PER_TICKET - turnsUsed;
    const isFollowUp = withinWindow && turnsLeft > 0;

    // Rolled over rather than refused. The customer keeps talking; it just costs
    // the next ticket, and they are told before it is spent rather than after.
    const rolledOver = withinWindow && turnsLeft <= 0;
    if (rolledOver) {
      log(`conversation for ${deviceId} hit ${MAX_TURNS_PER_TICKET} turns — starting a new ticket`);
      conversations.delete(deviceId);
    }

    const images = pendingImages.get(deviceId) || [];
    pendingImages.delete(deviceId);

    ws.send(JSON.stringify({ type: 'ai_update', text: rolledOver
      ? `That is ${MAX_TURNS_PER_TICKET} messages on this one — starting a fresh session, which uses another support ticket.`
      : isFollowUp
        ? 'Picking up where we left off…'
        : 'Investigating your PC — this usually takes under a minute…' }));

    // Only re-snapshot at the start of a session; a follow-up already has context.
    let snapshot = null;
    if (!isFollowUp) {
      const snap = await callTool(ws, deviceId, 'get_system_snapshot', {}, (text) => {
        ws.send(JSON.stringify({ type: 'ai_update', text }));
      });
      snapshot = snap.status === 'ok' ? snap.result : null;
    }

    const started = Date.now();
    const customerId = deviceCustomers.get(deviceId) || null;
    const lic = deviceLicenses.get(deviceId);
    const fullItSupport = !!(lic && lic.caps && lic.caps.fullSupport
      && orgLibrary.isFullItSupportAllowed(customerId));
    // Logged AFTER the inputs exist. Must mirror what ai.js will decide, so the
    // log names the model that actually runs rather than the default constant.
    const routedModel = pickModel({
      ticket,
      fullItSupport,
      hasImages: images.length > 0,
      isFollowUp,
      conversationModel: isFollowUp && prior ? prior.model : null,
    });
    // Prepaid tickets: check before the model runs, so a session that cannot be
    // paid for never costs anything. Orgs with no ledger are unmetered and pass
    // straight through — metering must not block anyone it was never set up for.
    // A ticket is a CONVERSATION, not a message. Asking a follow-up question is
    // how support works — billing each counter-question separately would punish
    // people for the product behaving well, and it is the kind of surprise a
    // customer only discovers from their balance. The continuation is already
    // paid for, so a follow-up neither checks the balance nor spends again.
    // This is "first use" for a time-boxed pass: a real request, not the
    // enrollment handshake. A follow-up inside an existing conversation is not a
    // fresh start either — and the call is idempotent, so it can never restart a
    // window that is already running.
    const rawKey = deviceLicenseKeys.get(deviceId);
    if (rawKey && !isFollowUp) {
      const begun = beginIfTimeBoxed(rawKey, deviceId);
      if (begun.started && begun.isNew) {
        // Refresh the cached evaluation: the one made at enrollment predates the
        // window, so its expiry would be stale for the rest of this connection.
        deviceLicenses.set(deviceId, evaluateLicense(rawKey, deviceId));
        log(`pass activated for ${deviceId}: ${begun.validForHours}h from ${begun.startedAt}`);
        audit({
          event: 'pass_activated', deviceId, customerId,
          licenseId: begun.licenseId, validForHours: begun.validForHours,
          startedAt: begun.startedAt,
        });
        // The clock just started and the window is short. Never awaited — an
        // alert must not delay or break the customer's session.
        const licNow = deviceLicenses.get(deviceId);
        alerts.activated({
          customer: (licNow && licNow.customer) || customerId,
          customerId, validForHours: begun.validForHours,
          startedAt: begun.startedAt, deviceId,
        }).then((r) => { if (!r.ok) log(`activation alert not sent: ${r.why || r.status}`); });
      }
    }

    const gate = (customerId && !isFollowUp)
      ? ledger.canOpen(customerId, deviceId)
      : { allowed: true, metered: false, continuation: isFollowUp };

    // Extra tickets charged on THIS message beyond the one the session spends,
    // and the ceiling the customer has authorised. Both reset per message, so
    // approving a long job never quietly raises the bar for the next question.
    let extraTicketsCharged = 0;
    let approvedCeiling = 0;
    if (!gate.allowed) {
      log(`ticket refused for ${customerId}/${deviceId}: out of tickets or over quota`);
      audit({ event: 'ticket_refused_no_credit', deviceId, customerId });
      ws.send(JSON.stringify({ type: 'ai_message', text: gate.reason }));
      ws.send(JSON.stringify({ type: 'done' }));
      busyDevices.delete(deviceId);
      return;
    }
    if (gate.overdraft) ws.send(JSON.stringify({ type: 'ai_message', text: gate.reason }));

    log(`AI technician (${routedModel}) working ticket: "${ticket}"`);
    const progress = (text) => ws.send(JSON.stringify({ type: 'ai_update', text }));
    const result = await diagnose({
      apiKey: API_KEY,
      ticket,
      snapshot,
      callTool: (toolId, params) => callTool(ws, deviceId, toolId, params, progress),
      manuals: MANUALS,
      // Documents attached before this ticket started...
      customerManuals: (() => {
        const q = customerManuals.get(deviceId);
        if (!q) return [];
        const ready = q.pending.splice(0, q.pending.length);
        return ready;
      })(),
      // ...and any attached WHILE the AI is working (picked up each step).
      takePendingManuals: () => {
        const q = customerManuals.get(deviceId);
        if (!q || !q.pending.length) return [];
        return q.pending.splice(0, q.pending.length);
      },
      priorMessages: isFollowUp ? prior.messages : null,
      images,
      resolveCloudTool: (name, input) => resolveCloudTool(ws, deviceId, customerId, name, input),
      fullItSupport,
      // Only metered customers can be asked to spend another ticket — an
      // unmetered licence has none to spend, so the prompt would have no
      // meaningful answer.
      //
      // Asked of the LEDGER, not of `gate`. gate.metered is only true on the
      // message that opens a ticket, so keying on it left every follow-up
      // ungated — and follow-ups are the expensive ones, since each carries the
      // whole conversation before it.
      onCostGate: (customerId && ledger.summary(customerId).metered) ? async ({ spentUsd }) => {
        const spentInr = spentUsd * USD_TO_INR;
        // Extra tickets this session has earned beyond the one it already spent.
        const owed = Math.ceil(spentInr / TICKET_BUDGET_INR) - 1;
        if (owed <= extraTicketsCharged) return 'continue';

        // Out of authorisation — ask for another block. Asked once per BLOCK,
        // not once per ticket: a tradesman says "about three hours", not "shall
        // I do another minute?" every minute. The customer also sees the scale
        // of the job up front instead of discovering it four prompts deep.
        if (extraTicketsCharged >= approvedCeiling) {
          ws.send(JSON.stringify({ type: 'ai_update',
            text: 'This is turning into more work than one ticket covers — checking with you…' }));
          const decision = await requestCostApproval(ws, deviceId, {
            ticketsUsed: extraTicketsCharged + 1,
            grant: EXTRA_TICKET_GRANT,
            spentInr,
          });

          if (decision !== 'accepted') {
            log(`cost approval ${decision} for ${customerId} after ₹${spentInr.toFixed(0)}`);
            audit({ event: 'cost_approval_declined', deviceId, customerId,
                    decision, spentInr: Math.round(spentInr) });
            ws.send(JSON.stringify({ type: 'ai_message', text: decision === 'timeout'
              ? 'I did not hear back, so I have stopped there. Nothing further has been charged — everything found so far is above.'
              : 'Stopped. Nothing further has been charged, and everything found so far is above.' }));
            return 'stop';
          }
          approvedCeiling += EXTRA_TICKET_GRANT;
          audit({ event: 'cost_approval_granted', deviceId, customerId,
                  grant: EXTRA_TICKET_GRANT, ceiling: approvedCeiling,
                  spentInr: Math.round(spentInr) });
        }

        // Charge one ticket, now — so what was agreed to and what is billed
        // cannot drift apart if the session later fails. Only tickets actually
        // reached are charged: authorising three and finishing after one costs
        // one, which is the difference between a ceiling and a price.
        extraTicketsCharged++;
        const out = ledger.debit(customerId, deviceId, { reportId: null, didWork: true });
        const used = extraTicketsCharged + 1;
        const remainingGrant = approvedCeiling - extraTicketsCharged;
        log(`extra ticket ${used} charged for ${customerId} — ${out.balance} left, `
          + `${remainingGrant} of the approved block unused`);
        audit({ event: 'extra_ticket_charged', deviceId, customerId,
                ticketsUsed: used, balance: out.balance, ceiling: approvedCeiling,
                spentInr: Math.round(spentInr) });
        ws.send(JSON.stringify({ type: 'ai_message',
          text: `That is ${used} tickets on this job so far`
            + `${out.balance != null ? `, and you have ${out.balance} left` : ''}.`
            + (remainingGrant > 0
              ? ` I will carry on within the ${approvedCeiling} you approved and check with you again if it needs more.`
              : '') }));
        return 'continue';
      } : null,
      model: routedModel,   // decided once, above — logged and run are the same
      onStep: (phase, detail) => log(`  AI ${phase}: ${detail}`),
      onUpdate: (text) => ws.send(JSON.stringify({ type: 'ai_message', text })),
    });

    // Keep the thread alive for follow-ups.
    conversations.set(deviceId, {
      messages: result.messages || [],
      lastAt: Date.now(),
      opened: isFollowUp && prior ? prior.opened : new Date().toISOString(),
      // Turns spent on the ticket this conversation belongs to. Resets with the
      // conversation, which is what makes the cap per-ticket rather than global.
      turns: (isFollowUp ? turnsUsed : 0) + 1,
      // Carried so follow-ups inherit the conversation's model rather than
      // silently escalating to the expensive one on every counter-question.
      model: routedModel,
    });

    // Warn on the LAST turn, not after it. Being told "that used another
    // ticket" once it is already spent is the kind of surprise a customer is
    // right to be annoyed by.
    const turnsNowUsed = (isFollowUp ? turnsUsed : 0) + 1;
    if (turnsNowUsed >= MAX_TURNS_PER_TICKET) {
      ws.send(JSON.stringify({
        type: 'ai_message',
        text: `That is the last message on this support ticket. If you need anything further, just ask — it starts a new session and uses one more ticket.`,
      }));
    }

    const durationSec = +((Date.now() - started) / 1000).toFixed(1);
    const declined = result.toolCalls.some(
      (t) => t.status === 'declined_by_customer' || t.status === 'timeout'
    );
    // Explicit flag from the AI (parsed in ai.js), plus: a declined fix always escalates.
    const escalated = result.escalate === true || declined;

    const out = {
      generatedAt: new Date().toISOString(), deviceId, model: MODEL, ticket,
      durationSec, steps: result.steps, toolCalls: result.toolCalls,
      customerDeclined: declined, escalated, report: result.report,
      // Token spend for this ticket. Kept in the stored report, not just the
      // log, because unit economics have to be computable from history — and
      // the cost of a support session is the number the price list rests on.
      usage: result.usage || null,
    };
    fs.writeFileSync(DIAGNOSIS_FILE, JSON.stringify(out, null, 2));  // latest, for convenience

    // Permanent per-session report — never overwritten (spec §7 / §9.4).
    let reportId = null;
    try {
      const fleetDev = (fleetView().devices || []).find((d) => d.deviceId === deviceId);
      const report = buildReport({ ...out, hostname: fleetDev ? fleetDev.hostname : null });
      reportId = saveReport(report);
      log(`session report saved: ${reportId} ` +
          `(${report.outcome.checksRun} checks, ${report.outcome.changesMade} changes, ` +
          `${report.outcome.actionsNotTaken} not done)`);
    } catch (e) { log(`report save failed: ${e.message}`); }

    audit({ event: 'ticket_closed', deviceId, reportId, steps: result.steps,
            toolCount: result.toolCalls.length, declined, escalated });

    // Learn the METHOD from a solved ticket, never the answer. Scrubbed of every
    // customer identifier before it is written, and refused outright if anything
    // identifying survives — the knowledge base is searched by every customer.
    try {
      if (reportId) {
        const saved = getReport(reportId);
        const lesson = saved && learning.buildPlaybook(saved, {
          customer: (lic && lic.customer) || '', customerId: customerId || '',
        });
        if (lesson && lesson.playbook) {
          const w = learning.savePlaybook(lesson.playbook);
          invalidateKb();
          log(`learned a playbook for "${lesson.key}" (${w.replaced ? 'updated' : 'new'})`);
          audit({ event: 'playbook_learned', key: lesson.key, replaced: w.replaced });
        } else if (lesson && lesson.skipped) {
          log(`no playbook learned: ${lesson.skipped}`);
        }
      }
    } catch (e) { log(`playbook learning failed: ${e.message}`); }

    // Spend the ticket now the work is done. A session that ran no tools and
    // produced no report gave the customer nothing, so it is recorded but not
    // billed — a few rupees to avoid an argument we would deserve to lose.
    if (customerId && gate.metered && !isFollowUp) {
      const didWork = result.toolCalls.length > 0 || !!(result.report && result.report.trim());
      const spent = ledger.debit(customerId, deviceId, { reportId, didWork });
      audit({ event: 'ticket_debited', deviceId, customerId, charged: spent.charged, balance: spent.balance });
      log(didWork
        ? `ticket debited — ${spent.balance} ticket(s) left for ${customerId}`
        : `ticket NOT billed (session did nothing) — ${spent.balance} left for ${customerId}`);
      // Out of tickets. Reported once per org, not on every refusal afterwards.
      if (spent.balance <= 0) {
        alerts.exhausted({ customerId, balance: spent.balance })
          .then((r) => { if (!r.ok && !r.skipped) log(`exhausted alert not sent: ${r.why || r.status}`); });
      }
    }

    if (escalated) {
      // Spec §10: structured handoff for a human technician.
      fs.writeFileSync(ESCALATION_FILE, JSON.stringify({
        createdAt: new Date().toISOString(), deviceId, ticket,
        reason: declined ? 'customer_declined' : 'ai_recommended_escalation',
        toolCalls: result.toolCalls, handoff: result.report,
      }, null, 2));
      log(`ticket escalated — handoff written to ${ESCALATION_FILE}`);
      // The one session worth reading: either a gap we should close, or a job
      // that genuinely needed a person. Knowing which is how the escalation
      // rate comes down.
      alerts.escalated({ customerId, deviceId, ticket, reportId, report: result.report })
        .then((r) => { if (!r.ok) log(`escalation alert not sent: ${r.why || r.status}`); });
    }

    // Support tickets end with the structured DIAGNOSIS/FIX report card; deployment
    // guidance ends with a conversational numbered plan — send it as a normal
    // message bubble so its steps render readably.
    if (/^\s*(DIAGNOSIS|FIX|OUTCOME)\s*:/im.test(result.report)) {
      ws.send(JSON.stringify({ type: 'ticket_summary', report: result.report }));
    } else {
      ws.send(JSON.stringify({ type: 'ai_message', text: result.report }));
    }
    ws.send(JSON.stringify({ type: 'ticket_done' }));
    log(`ticket closed in ${durationSec}s over ${result.steps} step(s), ${result.toolCalls.length} tool call(s)`);
    // Cost per ticket is the number the pricing model rests on — log it every
    // time rather than leaving it to be re-measured by hand later.
    if (result.usage) {
      const u = result.usage;
      log(`cost: $${u.estimatedUsd.toFixed(4)} (would have been $${u.withoutCachingUsd.toFixed(4)} uncached — `
        + `saved $${u.savedUsd.toFixed(4)}); tokens in=${u.input} out=${u.output} `
        + `cacheWrite=${u.cacheWrite} cacheRead=${u.cacheRead}`);
    }
    log(`\n===== AI TECHNICIAN REPORT =====\n${result.report}\n================================`);
  } catch (e) {
    log(`ticket error: ${e.message}`);
    ws.send(JSON.stringify({ type: 'ai_update', text: 'Something went wrong on our side. Please try again shortly.' }));
    ws.send(JSON.stringify({ type: 'ticket_done' }));
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    busyDevices.delete(deviceId);
  }
}

// HTTP server for the host's health check + the WebSocket upgrade endpoint.
const DASHBOARD_FILE = path.join(__dirname, 'ui', 'fleet.html');
const REPORTS_FILE = path.join(__dirname, 'ui', 'reports.html');
const CONSOLE_FILE = path.join(__dirname, 'ui', 'console.html');
const ADMIN_SOFTWARE_FILE = path.join(__dirname, 'ui', 'org-software.html');

// Constant-time-ish token compare
function tokenOk(supplied) {
  if (!DASHBOARD_TOKEN || !supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(DASHBOARD_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('AWI Resolve orchestrator OK');
  }

  // ---- Customer IT-admin software library (token per customer org) ----
  if (route === '/admin/software' || route.startsWith('/api/admin/software')) {
    const customerId = orgLibrary.slugify(url.searchParams.get('customerId') || '');
    const token = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!customerId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('customerId query parameter is required.');
    }
    if (!orgLibrary.adminTokenOk(customerId, token)) {
      log(`org-software admin DENIED for ${customerId} from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorised. Ask Alpha Web / your Resolve operator for this org\'s admin token.');
    }
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (route === '/admin/software' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(ADMIN_SOFTWARE_FILE).pipe(res);
      }
      if (route === '/api/admin/software' && req.method === 'GET') {
        const lib = orgLibrary.loadLibrary(customerId);
        return json({
          customerId,
          settings: orgLibrary.publicSettings(lib),
          packages: orgLibrary.listAllPublic(customerId),
        });
      }
      if (route === '/api/admin/software/settings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const saved = orgLibrary.updateSettings(customerId, body, 'it-admin');
        audit({
          event: 'org_settings_updated',
          customerId,
          allowFullItSupport: saved.allowFullItSupport,
        });
        return json({ ok: true, settings: orgLibrary.publicSettings(saved) });
      }
      if (route === '/api/admin/software' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = orgLibrary.upsertPackage(customerId, { ...body, createdBy: 'it-admin' });
        if (!result.ok) return json({ error: result.errors.join('; ') }, 400);
        audit({ event: 'org_software_upsert', customerId, productId: result.package.productId });
        return json({ ok: true, package: result.package });
      }
      if (route === '/api/admin/software/enable' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = orgLibrary.setEnabled(customerId, body.productId, body.enabled !== false);
        if (!result.ok) return json({ error: result.error }, 404);
        return json({ ok: true, package: result.package });
      }
      if (route === '/api/admin/software' && req.method === 'DELETE') {
        const productId = url.searchParams.get('productId') || (await readJsonBody(req)).productId;
        const result = orgLibrary.removePackage(customerId, productId);
        if (!result.ok) return json({ error: result.error }, 404);
        audit({ event: 'org_software_removed', customerId, productId });
        return json({ ok: true });
      }
      res.writeHead(405).end('Method not allowed');
      return;
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  // Bootstrap helper (dashboard token): create/show an org admin token.
  // Customer usage console. Same per-org admin token as the software library —
  // one credential per organisation, not two. Scope comes from the token, never
  // from the request, so a customer cannot widen their own view.
  if (route === '/console' || route === '/api/console') {
    const customerId = orgLibrary.slugify(url.searchParams.get('customerId') || '');
    const token = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (route === '/console' && !token) {
      // No token yet: serve the page, which asks for one. Serving the shell
      // unauthenticated is fine — it contains no data.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(CONSOLE_FILE));
    }
    if (!customerId || !orgLibrary.adminTokenOk(customerId, token)) {
      audit({ event: 'console_denied', customerId: customerId || null });
      log(`console DENIED for "${customerId}" from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Unauthorised. Check your organisation id and access token.' }));
    }
    if (route === '/console') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(CONSOLE_FILE));
    }
    // Quota controls belong to the CUSTOMER's admin — capping their own people
    // is their business. Selling tickets is not: a top-up route reachable with
    // an org token would let a customer credit themselves, so that lives on the
    // Alpha Web dashboard token instead (below).
    if (route === '/api/console' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (body.action === 'setQuota') {
          const quotas = ledger.setQuota(customerId, String(body.target || ''),
            body.ticketsPerMonth === null ? null : body.ticketsPerMonth);
          audit({ event: 'console_quota_set', customerId, target: body.target, value: body.ticketsPerMonth });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, quotas }));
        }
        if (body.action === 'setGroup') {
          const groups = ledger.setGroup(customerId, String(body.deviceId || ''), body.group || null);
          audit({ event: 'console_group_set', customerId, deviceId: body.deviceId, group: body.group });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, groups }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unknown action' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    audit({ event: 'console_viewed', customerId });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(customerConsole.orgView(customerId, orgSeats.get(customerId) || null)));
  }

  // Sales prospects. Alpha Web's dashboard token ONLY: this deliberately reads
  // across customers, which is precisely why an org token must never reach it.
  if (route === '/api/prospects' || route === '/prospects') {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      audit({ event: 'prospects_denied', from: req.socket.remoteAddress });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    const list = prospects();
    if (route === '/prospects') {
      // Plain text on purpose: this is a call list someone reads down, not a
      // dashboard to admire.
      const lines = list.length
        ? list.map((p, i) => {
            const head = `${String(i + 1).padStart(2)}. ${p.customerId}  (${p.pcs} PCs, `
              + `${p.sessions} sessions${p.ticketBalance != null ? `, ${p.ticketBalance} tickets` : ''})`;
            const rest = p.signals.slice(1).map((sig) => `      - ${sig.say}`);
            return [head, `    ${p.headline}`, ...rest].join('\n');
          }).join('\n\n')
        : 'No prospects with a signal right now.';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`ALPHA WEB - WHO TO CALL\n${'='.repeat(60)}\n\n${lines}\n`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ generatedAt: new Date().toISOString(), prospects: list }));
  }

  // Selling tickets. Alpha Web's dashboard token only — never the org token.
  if (route === '/api/admin/tickets' && req.method === 'POST') {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    try {
      const body = await readJsonBody(req);
      const cid = orgLibrary.slugify(body.customerId || '');
      if (!cid) throw new Error('customerId required');
      const out = ledger.credit(cid, body.tickets, { note: body.note || 'top-up' });
      // Re-arm the out-of-tickets alert: having been topped up, running dry
      // again is news once more.
      alerts.clearExhausted(cid);
      audit({ event: 'tickets_sold', customerId: cid, tickets: body.tickets, balance: out.balance });
      log(`sold ${body.tickets} ticket(s) to ${cid} — balance now ${out.balance}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // How Resolve is performing across every customer. Dashboard token only.
  if (route === '/api/admin/performance' && req.method === 'GET') {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
    const usdToInr = Number(url.searchParams.get('usd')) || 88;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(performance({ days, usdToInr })));
  }

  // Every organisation and its balance. Alpha Web's dashboard token only —
  // this crosses customers by definition.
  if (route === '/api/admin/customers' && req.method === 'GET') {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    const orgs = ledger.listOrgs();
    // Fold in how many PCs each org has enrolled, which is the number that
    // makes a balance meaningful.
    const devices = loadDevices();
    const pcCount = {};
    for (const d of Object.values(devices)) {
      if (d && d.customerId) pcCount[d.customerId] = (pcCount[d.customerId] || 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      customers: orgs.map((o) => ({ ...o, pcs: pcCount[o.customerId] || 0 })),
    }));
  }

  // Connect (or inspect, or disconnect) a customer's Microsoft 365 tenant.
  // Alpha Web's dashboard token only — these are tenant-wide credentials.
  if (route === '/api/admin/m365' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET') {
        const cid = orgLibrary.slugify(url.searchParams.get('customerId') || '');
        if (!cid) throw new Error('customerId required');
        // Never returns the client secret — see microsoft.tenantInfo.
        return reply(200, { customerId: cid, tenant: microsoft.tenantInfo(cid) });
      }
      const body = await readJsonBody(req);
      const cid = orgLibrary.slugify(body.customerId || url.searchParams.get('customerId') || '');
      if (!cid) throw new Error('customerId required');

      if (req.method === 'DELETE') {
        const existed = microsoft.removeTenant(cid);
        audit({ event: 'm365_tenant_removed', customerId: cid, existed });
        log(`Microsoft tenant disconnected for ${cid}`);
        return reply(200, { customerId: cid, removed: existed });
      }

      const saved = microsoft.setTenant(cid, body);
      audit({ event: 'm365_tenant_connected', customerId: cid, tenantId: saved.tenantId });
      log(`Microsoft tenant connected for ${cid} (${saved.tenantId})`);

      // Prove it works now, while whoever configured it is still watching.
      // Discovering a wrong secret during a customer's outage is the worst
      // possible time to find out.
      let check;
      try {
        await microsoft.findUser(cid, body.testUser || 'nobody@invalid.invalid');
        check = { ok: true, note: 'Signed in to the tenant and Graph responded.' };
      } catch (e) {
        check = { ok: false, note: e.message };
      }
      return reply(200, { customerId: cid, tenant: saved, check });
    } catch (e) {
      return reply(400, { error: e.message });
    }
  }

  // Issue a licence. Alpha Web's dashboard token only.
  //
  // Lives here rather than on the website because this is where the signing key
  // is: one place holds it, one place to rotate it, and the website holds only
  // an API token. Issuing and crediting happen together — a licence whose
  // tickets were never credited runs unmetered, which is a silent revenue leak.
  if (route === '/api/admin/issue-licence' && req.method === 'POST') {
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!DASHBOARD_TOKEN || !tokenOk(supplied)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorised' }));
    }
    if (!SIGNING_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'No signing key on this service. Set RESOLVE_LICENCE_SIGNING_KEY to issue licences.',
      }));
    }
    try {
      const body = await readJsonBody(req);
      const customerId = body.customerId ? orgLibrary.slugify(body.customerId) : '';
      const { key, payload } = licenceIssue.issueLicence({
        customer: body.customer,
        customerId: customerId || undefined,
        plan: body.plan,
        seats: body.seats,
        days: body.days,
        validForHours: body.validForHours,
        // Optional, and shown to the customer in their licence window: who the
        // licence is allocated to, and the name their support window wears.
        licensedTo: body.licensedTo,
        licensedToEmail: body.licensedToEmail,
        brandName: body.brandName,
      }, SIGNING_KEY);

      // Credit the allowance in the same call. Doing it as a separate step is
      // how an order ends up half-fulfilled.
      const tickets = Number(
        body.tickets == null ? licenceIssue.defaultTickets(payload.plan) : body.tickets
      );
      let balance = null;
      if (tickets > 0) {
        if (!customerId) throw new Error('customerId is required to credit tickets');
        const out = ledger.credit(customerId, tickets, { note: `${payload.plan} licence` });
        alerts.clearExhausted(customerId);
        balance = out.balance;
        log(`issued ${payload.plan} licence to ${payload.customer} [${customerId}] with ${tickets} ticket(s) — balance ${balance}`);
      } else {
        log(`issued ${payload.plan} licence to ${payload.customer}${customerId ? ` [${customerId}]` : ''}`);
      }

      audit({
        event: 'licence_issued', customerId: customerId || null,
        licenseId: payload.licenseId, plan: payload.plan, seats: payload.seats,
        expiresAt: payload.expiresAt, validForHours: payload.validForHours || null, tickets,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ key, payload, tickets, balance }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (route === '/api/admin/bootstrap-token' && req.method === 'POST') {
    if (!DASHBOARD_TOKEN) {
      res.writeHead(404).end('Dashboard disabled');
      return;
    }
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(supplied)) {
      res.writeHead(401).end('Unauthorised');
      return;
    }
    try {
      const body = await readJsonBody(req);
      const customerId = orgLibrary.slugify(body.customerId || body.customer || '');
      if (!customerId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'customerId required' }));
      }
      const issued = orgLibrary.ensureAdminToken(customerId);
      audit({ event: 'org_admin_token_issued', customerId, created: issued.created });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        customerId: issued.customerId,
        token: issued.token,
        adminUrl: `/admin/software?customerId=${encodeURIComponent(issued.customerId)}&token=${encodeURIComponent(issued.token)}`,
        created: issued.created,
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ---- Fleet security dashboard + session reports (token-gated) ----
  if (route === '/fleet' || route === '/api/fleet' ||
      route === '/reports' || route === '/api/reports' || route === '/api/report') {
    if (!DASHBOARD_TOKEN) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Dashboard disabled (no RESOLVE_DASHBOARD_TOKEN set).');
    }
    const supplied = url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(supplied)) {
      log(`dashboard access DENIED from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorised.');
    }
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (route === '/api/fleet') return json(fleetView());
    if (route === '/api/reports') return json({ reports: listReports(50) });
    if (route === '/api/report') {
      const r = getReport(url.searchParams.get('id'));
      return r ? json(r) : json({ error: 'not found' }, 404);
    }
    const page = route === '/reports' ? REPORTS_FILE : DASHBOARD_FILE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(page).pipe(res);
  }

  if (route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('AWI Resolve orchestrator OK');
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, '0.0.0.0', () => {
  log(`listening on port ${PORT} (health: /health)`);
  log(ENROLLMENT_SECRET ? 'enrollment secret REQUIRED' : 'enrollment OPEN (dev — no secret set)');
  log(`knowledge base: ${KB.documents} document(s), ${KB.chunks} searchable sections`);
  if (!API_KEY) log('WARNING: ANTHROPIC_API_KEY not set — AI loop disabled.');
});

wss.on('connection', (ws) => {
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      // Door key: reject connections that don't present the shared enrollment
      // secret (skipped only in local dev when no secret is configured).
      if (ENROLLMENT_SECRET && msg.enrollmentSecret !== ENROLLMENT_SECRET) {
        log(`rejected connection from ${msg.hostname || 'unknown'} — bad/missing enrollment secret`);
        ws.send(JSON.stringify({ type: 'auth_failed', reason: 'enrollment_secret' }));
        ws.close();
        return;
      }
      const devices = loadDevices();
      const known = devices[msg.deviceId];
      if (!known) {
        devices[msg.deviceId] = {
          deviceKeyHash: sha256(msg.deviceSecret),
          hostname: msg.hostname,
          agentVersion: msg.agentVersion,
          enrolledAt: new Date().toISOString(),
        };
        saveDevices(devices);
        deviceId = msg.deviceId;
        audit({ event: 'device_enrolled', deviceId, hostname: msg.hostname });
        log(`enrolled new device ${deviceId} (${msg.hostname})`);
        ws.send(JSON.stringify({ type: 'enrolled', deviceId }));
      } else if (known.deviceKeyHash === sha256(msg.deviceSecret)) {
        deviceId = msg.deviceId;
        known.lastSeenAt = new Date().toISOString();
        saveDevices(devices);
        audit({ event: 'device_reconnected', deviceId });
        log(`device ${deviceId} reconnected (${msg.hostname})`);
        ws.send(JSON.stringify({ type: 'welcome_back', deviceId }));
      } else {
        audit({ event: 'auth_failed', deviceId: msg.deviceId });
        log(`AUTH FAILED for claimed device ${msg.deviceId}`);
        ws.send(JSON.stringify({ type: 'auth_failed' }));
        ws.close();
        return;
      }
      // Licence check. Done here rather than in the agent because the agent runs
      // on the customer's own PC. An unlicensed device is not cut off — it keeps
      // read-only diagnostics, so nobody is left unable to find out what is
      // wrong — but consent-gated fixes and deployment are withheld.
      const lic = evaluateLicense(msg.licenseKey, deviceId);
      deviceLicenses.set(deviceId, lic);
      // Enrollment deliberately does NOT start a time-boxed pass. Installing the
      // agent and pasting a key is setup, not support — the clock starts on the
      // first actual request, at the ticket gate.
      if (msg.licenseKey) deviceLicenseKeys.set(deviceId, msg.licenseKey);

      // Tell the window its licence state, so it can offer activation rather
      // than making the customer hand-edit config.json.
      //
      // Sent HERE, after `lic` exists — not alongside the enrolled/welcome_back
      // message above, where `lic` is still in its temporal dead zone. Doing
      // that crashed the connector on every single agent connection.
      ws.send(JSON.stringify({ type: 'licence_state', licence: licenceSummary(lic) }));

      // Remember which organisation this PC belongs to. The customer console
      // scopes on it, and it has to survive a restart — deviceLicenses is only
      // in memory and only covers currently-connected machines.
      if (lic.customerId) {
        try {
          const all = loadDevices();
          if (all[deviceId] && all[deviceId].customerId !== lic.customerId) {
            all[deviceId].customerId = lic.customerId;
            saveDevices(all);
          }
        } catch (e) { log(`could not record org for ${deviceId}: ${e.message}`); }
      }
      const customerId = orgLibrary.customerIdFromLicense(lic)
        || (msg.customerId ? orgLibrary.slugify(msg.customerId) : null)
        || (loadDevices()[deviceId] && loadDevices()[deviceId].customerId) || null
        || (DEFAULT_CUSTOMER_ID ? orgLibrary.slugify(DEFAULT_CUSTOMER_ID) : null);
      if (customerId) {
        deviceCustomers.set(deviceId, customerId);
        const devices2 = loadDevices();
        if (devices2[deviceId]) {
          devices2[deviceId].customerId = customerId;
          saveDevices(devices2);
        }
      }
      audit({ event: 'license_checked', deviceId, plan: lic.plan, valid: lic.valid, reason: lic.reason, customerId });
      if (lic.customerId && lic.seats) {
        orgSeats.set(lic.customerId, lic.seats);
        // Advisory only: nothing is switched off. But an org that has quietly
        // outgrown its licence is revenue Alpha Web cannot see unless it is
        // said out loud, so it goes in the log and the audit trail on every
        // enrollment.
        const use = customerConsole.seatUsage(lic.customerId, lic.seats);
        if (!use.withinLicence) {
          log(`SEATS: ${lic.customerId} is using ${use.inUse} PCs on a ${use.seats}-seat licence `
            + `(${use.over} over) — nothing blocked, renewal conversation`);
          audit({ event: 'seats_exceeded', customerId: lic.customerId,
                  inUse: use.inUse, seats: use.seats, over: use.over });
        }
      }
      if (lic.valid) {
        const left = lic.daysLeft != null ? `, ${lic.daysLeft} day(s) left` : '';
        log(`licence OK — ${lic.customer} / ${lic.plan}${left}${customerId ? ` [org ${customerId}]` : ''}`);
      } else {
        log(`UNLICENSED (${lic.reason}) — diagnostics only, fixes withheld`);
      }
      ws.send(JSON.stringify({
        type: 'license_status',
        valid: lic.valid, plan: lic.plan, label: lic.caps.label,
        customer: lic.customer || null, customerId: customerId || null,
        daysLeft: lic.daysLeft ?? null,
        expiresAt: lic.expiresAt || null, reason: lic.reason,
      }));

      if (API_KEY) {
        // Standing safety check on connect, then wait for the customer to open a
        // ticket from their support window (msg.type 'open_ticket', below).
        safetyProbe(ws, deviceId).catch((e) => log(`safety probe error: ${e.message}`));
        log('ready — waiting for the customer to describe a problem in their support window.');
      } else {
        log('no ANTHROPIC_API_KEY found — running the Phase 0 plumbing demo instead of the AI loop.');
        runDemoSequence(ws, deviceId).catch((e) => log(`demo error: ${e.message}`));
      }
    }

    // Customer-attached reference document. Queued per device: picked up by a
    // running ticket on its next step, or used when the next ticket opens.
    // Periodic read-only security/health summary for the fleet dashboard.
    if (msg.type === 'posture_report' && deviceId) {
      try {
        recordPosture(deviceId, msg);
        audit({ event: 'posture_report', deviceId, hostname: msg.hostname });
        log(`posture report from ${msg.hostname || deviceId}`);
      } catch (e) { log(`posture record failed: ${e.message}`); }
    }

    if (msg.type === 'cost_approval_response') {
      const resolve = pendingCostApprovals.get(msg.approvalId);
      if (resolve) {
        pendingCostApprovals.delete(msg.approvalId);
        resolve(msg.decision === 'accepted' ? 'accepted' : 'declined');
      }
    }

    // Screenshot from the customer — queued for the next message to the AI.
    if (msg.type === 'attach_image' && deviceId) {
      const list = pendingImages.get(deviceId) || [];
      if (list.length < 4 && typeof msg.data === 'string' && msg.data.length < 6_000_000) {
        list.push({ mediaType: msg.mediaType, data: msg.data });
        pendingImages.set(deviceId, list);
        audit({ event: 'image_attached', deviceId, mediaType: msg.mediaType });
        log(`customer attached a screenshot (${msg.mediaType})`);
      }
    }

    if (msg.type === 'attach_manual' && deviceId) {
      const doc = { title: String(msg.title || 'Document').slice(0, 120),
                    text: String(msg.text || '').slice(0, MANUAL_CHAR_LIMIT) };
      const q = customerManuals.get(deviceId) || { pending: [], all: [] };
      // Enforced here as well as in the agent, and across the WHOLE
      // conversation rather than per document. The agent runs on the customer's
      // PC and cannot be trusted to police a limit that costs us money, and
      // five documents each just under the per-file limit would exhaust the
      // context window exactly as one huge one did.
      const already = q.all.reduce((n, d) => n + d.text.length, 0);
      if (already + doc.text.length > MANUAL_TOTAL_CHARS) {
        const room = Math.max(0, MANUAL_TOTAL_CHARS - already);
        log(`manual refused for ${deviceId}: ${already + doc.text.length} chars would exceed the ${MANUAL_TOTAL_CHARS} limit`);
        audit({ event: 'manual_refused_too_long', deviceId, title: doc.title,
                chars: doc.text.length, alreadyAttached: already });
        ws.send(JSON.stringify({ type: 'ai_message', text: room > 2000
          ? `I can only hold about ${Math.round(MANUAL_TOTAL_CHARS / 1000)}k characters of documents in one conversation, and there is roughly ${Math.round(room / 1000)}k left. Please attach just the section covering this problem.`
          : `I already have as much documentation as I can read in one conversation. Ask your new question and I will start a fresh session, or paste the specific steps you want me to follow.` }));
        return;
      }
      q.pending.push(doc);
      q.all.push(doc);
      customerManuals.set(deviceId, q);
      audit({ event: 'manual_attached', deviceId, title: doc.title, chars: doc.text.length });
      log(`customer attached "${doc.title}" (${doc.text.length} chars, ${already + doc.text.length} total)`);
    }

    if (msg.type === 'open_ticket' && deviceId) {
      const ticket = String(msg.text || '').slice(0, 2000);
      if (!API_KEY) {
        // Never leave the customer staring at "Working…" with no reply.
        log(`ticket ignored — ANTHROPIC_API_KEY is not set on this service`);
        ws.send(JSON.stringify({
          type: 'ai_update',
          text: 'The support service is running without its AI key, so I cannot help yet. Please ask Alpha Web to check the Resolve service setup.',
        }));
        ws.send(JSON.stringify({ type: 'ticket_done' }));
        return;
      }
      log(`ticket opened by ${deviceId}: "${ticket}"`);
      audit({ event: 'ticket_opened', deviceId });
      runTicket(ws, deviceId, ticket).catch((e) => log(`ticket run error: ${e.message}`));
    }

    if (msg.type === 'tool_result' && pendingCalls.has(msg.callId)) {
      audit({ event: 'tool_result', deviceId, toolId: msg.toolId, status: msg.status });
      const resolve = pendingCalls.get(msg.callId);
      pendingCalls.delete(msg.callId);
      resolve(msg);
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      log(`device ${deviceId} disconnected`);
      // Drop the cached key. The activation record itself is on disk, so a
      // reconnect resumes the same window rather than starting a new one.
      deviceLicenseKeys.delete(deviceId);
    }
  });
});
