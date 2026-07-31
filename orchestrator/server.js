'use strict';
// AWI Resolve orchestrator — the cloud side. Accepts agent connections, enrolls
// devices, sends tool calls, records every action to an audit log, and (Phase 1b)
// runs the Claude-powered diagnostic loop when an agent connects.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { diagnose, MODEL } = require('./ai');
const { loadManuals } = require('./manuals');
const { kbStats } = require('./kb');

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

// Fly/most hosts inject PORT; fall back to our dev default.
const PORT = Number(process.env.PORT || process.env.RESOLVE_PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
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

// How long the cloud waits for the agent to answer a tool call.
// MUST exceed the agent's consent window (60s) — otherwise we could give up on a
// Tier-2 action while the customer is still deciding, and the action could then
// run after the AI has already concluded it didn't. Deployments also need room
// for a download + installer run (agent caps the installer at 5 min).
const TOOL_TIMEOUT_MS = 120000;         // read-only + quick fixes (> 60s consent)
const DEPLOY_TIMEOUT_MS = 480000;       // consent + download + install + verify

function callTool(ws, deviceId, toolId, params) {
  return new Promise((resolve) => {
    const callId = crypto.randomUUID();
    pendingCalls.set(callId, resolve);
    audit({ event: 'tool_call_sent', deviceId, toolId, params });
    ws.send(JSON.stringify({ type: 'tool_call', callId, toolId, params }));
    const ms = toolId === 'deploy_software' ? DEPLOY_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    setTimeout(() => {
      if (pendingCalls.delete(callId)) resolve({ status: 'timeout', toolId });
    }, ms);
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

async function runTicket(ws, deviceId, ticket) {
  if (busyDevices.has(deviceId)) return; // one session per machine at a time
  busyDevices.add(deviceId);
  try {
    ws.send(JSON.stringify({ type: 'ai_update', text: 'Investigating your PC — this usually takes under a minute…' }));
    const snap = await callTool(ws, deviceId, 'get_system_snapshot', {});
    const snapshot = snap.status === 'ok' ? snap.result : null;

    log(`AI technician (${MODEL}) working ticket: "${ticket}"`);
    const started = Date.now();
    const result = await diagnose({
      apiKey: API_KEY,
      ticket,
      snapshot,
      callTool: (toolId, params) => callTool(ws, deviceId, toolId, params),
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
      onStep: (phase, detail) => log(`  AI ${phase}: ${detail}`),
      onUpdate: (text) => ws.send(JSON.stringify({ type: 'ai_message', text })),
    });

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
    };
    fs.writeFileSync(DIAGNOSIS_FILE, JSON.stringify(out, null, 2));
    audit({ event: 'ticket_closed', deviceId, steps: result.steps, toolCount: result.toolCalls.length, declined, escalated });

    if (escalated) {
      // Spec §10: structured handoff for a human technician.
      fs.writeFileSync(ESCALATION_FILE, JSON.stringify({
        createdAt: new Date().toISOString(), deviceId, ticket,
        reason: declined ? 'customer_declined' : 'ai_recommended_escalation',
        toolCalls: result.toolCalls, handoff: result.report,
      }, null, 2));
      log(`ticket escalated — handoff written to ${ESCALATION_FILE}`);
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
    log(`\n===== AI TECHNICIAN REPORT =====\n${result.report}\n================================`);
  } catch (e) {
    log(`ticket error: ${e.message}`);
    ws.send(JSON.stringify({ type: 'ai_update', text: 'Something went wrong on our side. Please try again shortly.' }));
    ws.send(JSON.stringify({ type: 'ticket_done' }));
  } finally {
    busyDevices.delete(deviceId);
  }
}

// HTTP server for the host's health check + the WebSocket upgrade endpoint.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AWI Resolve orchestrator OK');
  } else {
    res.writeHead(404).end();
  }
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
    if (msg.type === 'attach_manual' && deviceId) {
      const doc = { title: String(msg.title || 'Document').slice(0, 120),
                    text: String(msg.text || '').slice(0, 200000) };
      const q = customerManuals.get(deviceId) || { pending: [], all: [] };
      q.pending.push(doc);
      q.all.push(doc);
      customerManuals.set(deviceId, q);
      audit({ event: 'manual_attached', deviceId, title: doc.title, chars: doc.text.length });
      log(`customer attached "${doc.title}" (${doc.text.length} chars)`);
    }

    if (msg.type === 'open_ticket' && deviceId && API_KEY) {
      const ticket = String(msg.text || '').slice(0, 2000);
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
    if (deviceId) log(`device ${deviceId} disconnected`);
  });
});
