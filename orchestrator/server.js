'use strict';
// AWI Resolve orchestrator — the cloud side. Phase 0: accepts agent connections,
// enrolls devices, sends tool calls, records every action to an audit log.
// (Phase 1 replaces the hard-coded demo sequence with the AI technician loop.)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.RESOLVE_PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const REPORT_FILE = path.join(DATA_DIR, 'demo-report.json');

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

  log('demo: attempting a FORBIDDEN free-form shell command (agent must refuse)...');
  const forbidden = await callTool(ws, deviceId, 'run_shell', { command: 'whoami' });

  const report = {
    generatedAt: new Date().toISOString(),
    deviceId,
    snapshot,
    spoolerStatus: spooler,
    forbiddenToolTest: forbidden,
    verdict:
      forbidden.status === 'refused'
        ? 'PASS — agent refused the off-allowlist command on-device'
        : 'FAIL — agent executed a forbidden command! Do not proceed.',
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  log(`demo complete — verdict: ${report.verdict}`);
  log(`full report written to ${REPORT_FILE}`);
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
      runDemoSequence(ws, deviceId).catch((e) => log(`demo error: ${e.message}`));
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
