'use strict';
// AWI Resolve orchestrator — the cloud side. Accepts agent connections, enrolls
// devices, sends tool calls, records every action to an audit log, and (Phase 1b)
// runs the Claude-powered diagnostic loop when an agent connects.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { diagnose, MODEL } = require('./ai');

// Load the Anthropic API key from awi-resolve/.env (gitignored). Node 20.6+ /
// 26 has process.loadEnvFile built in.
const ENV_FILE = path.join(__dirname, '..', '.env');
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  /* no .env — the AI loop will be skipped and we fall back to the plumbing demo */
}
const API_KEY = process.env.ANTHROPIC_API_KEY;

// The problem the AI technician investigates on connect. Override with the
// RESOLVE_TICKET env var to test a different issue.
const TICKET = process.env.RESOLVE_TICKET || 'My documents are stuck — nothing comes out of the printer.';

const PORT = Number(process.env.RESOLVE_PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const REPORT_FILE = path.join(DATA_DIR, 'demo-report.json');
const DIAGNOSIS_FILE = path.join(DATA_DIR, 'diagnosis.json');

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

function callTool(ws, deviceId, toolId, params) {
  return new Promise((resolve) => {
    const callId = crypto.randomUUID();
    pendingCalls.set(callId, resolve);
    audit({ event: 'tool_call_sent', deviceId, toolId, params });
    ws.send(JSON.stringify({ type: 'tool_call', callId, toolId, params }));
    setTimeout(() => {
      if (pendingCalls.delete(callId)) resolve({ status: 'timeout', toolId });
    }, 45000);
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

// Phase 1b: run the Claude-powered diagnostic loop against the connected agent.
// Claude investigates via the agent's read-only tools and writes a plain-language
// diagnosis. A forbidden-tool probe still runs first as a standing safety check.
async function runDiagnosis(ws, deviceId) {
  log('safety check: attempting a FORBIDDEN shell command (agent must refuse)...');
  const forbidden = await callTool(ws, deviceId, 'run_shell', { command: 'whoami' });
  if (forbidden.status !== 'refused') {
    log('FAIL — agent did not refuse an off-allowlist tool. Aborting diagnosis.');
    return;
  }
  log('safety check PASS — agent refused the off-allowlist tool on-device.');

  log(`gathering machine snapshot for the AI technician...`);
  const snap = await callTool(ws, deviceId, 'get_system_snapshot', {});
  const snapshot = snap.status === 'ok' ? snap.result : null;

  log(`AI technician (${MODEL}) investigating ticket: "${TICKET}"`);
  const started = Date.now();
  const result = await diagnose({
    apiKey: API_KEY,
    ticket: TICKET,
    snapshot,
    callTool: (toolId, params) => callTool(ws, deviceId, toolId, params),
    onStep: (phase, detail) => log(`  AI ${phase}: ${detail}`),
  });

  const out = {
    generatedAt: new Date().toISOString(),
    deviceId,
    model: MODEL,
    ticket: TICKET,
    durationSec: +((Date.now() - started) / 1000).toFixed(1),
    steps: result.steps,
    toolCalls: result.toolCalls,
    report: result.report,
  };
  fs.writeFileSync(DIAGNOSIS_FILE, JSON.stringify(out, null, 2));
  audit({ event: 'diagnosis_complete', deviceId, steps: result.steps, toolCount: result.toolCalls.length });
  log(`diagnosis complete in ${out.durationSec}s over ${result.steps} step(s), ${result.toolCalls.length} tool call(s)`);
  log(`\n===== AI TECHNICIAN REPORT =====\n${result.report}\n================================`);
  log(`full diagnosis written to ${DIAGNOSIS_FILE}`);
}

const wss = new WebSocketServer({ port: PORT });
log(`listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
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
        runDiagnosis(ws, deviceId).catch((e) => log(`diagnosis error: ${e.message}`));
      } else {
        log('no ANTHROPIC_API_KEY found — running the Phase 0 plumbing demo instead of the AI loop.');
        runDemoSequence(ws, deviceId).catch((e) => log(`demo error: ${e.message}`));
      }
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
