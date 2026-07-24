'use strict';
// AWI Resolve agent — runs on the customer's PC. Connects OUTBOUND to the
// orchestrator (never listens for incoming connections), enrolls a device
// identity on first run, and executes only allowlisted tools (see tools.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { TOOLS } = require('./tools');

const ORCH_URL = process.env.RESOLVE_ORCH_URL || 'ws://127.0.0.1:8787';
const AGENT_VERSION = '0.1.0';
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITY_FILE = path.join(DATA_DIR, 'device.json');

function log(msg) {
  console.log(`[agent ${new Date().toISOString()}] ${msg}`);
}

// Device identity: created once, reused forever. In production this secret is
// protected with Windows DPAPI; for Phase 0 it lives in agent/data/ (gitignored).
function loadIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  }
  const identity = {
    deviceId: crypto.randomUUID(),
    deviceSecret: crypto.randomBytes(32).toString('hex'),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  log('new device identity created (first run)');
  return identity;
}

async function handleToolCall(ws, msg) {
  const { callId, toolId, params } = msg;
  const tool = TOOLS[toolId];

  if (!tool) {
    // The security core of the product: unknown/forbidden tools are refused ON
    // THE DEVICE, so even a compromised server cannot exceed the allowlist.
    log(`REFUSED '${toolId}' — not in the agent allowlist`);
    ws.send(JSON.stringify({
      type: 'tool_result', callId, toolId,
      status: 'refused',
      reason: 'Tool is not in the agent allowlist. Enforced on the device (spec §6, Tier-X).',
    }));
    return;
  }

  log(`executing Tier-${tool.tier} tool '${toolId}'`);
  try {
    const result = await tool.run(params || {});
    ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'ok', tier: tool.tier, result }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'error', reason: e.message }));
  }
}

function connect(identity) {
  log(`connecting to orchestrator at ${ORCH_URL}`);
  const ws = new WebSocket(ORCH_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      deviceId: identity.deviceId,
      deviceSecret: identity.deviceSecret,
      hostname: require('os').hostname(),
      agentVersion: AGENT_VERSION,
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'enrolled') log(`enrolled with orchestrator as device ${identity.deviceId}`);
    else if (msg.type === 'welcome_back') log('recognized by orchestrator (already enrolled)');
    else if (msg.type === 'auth_failed') { log('AUTH FAILED — identity rejected, not retrying'); ws.close(); process.exit(1); }
    else if (msg.type === 'tool_call') handleToolCall(ws, msg);
  });

  ws.on('close', () => {
    log('disconnected — retrying in 3s');
    setTimeout(() => connect(identity), 3000);
  });

  ws.on('error', (e) => log(`connection error: ${e.message}`));
}

connect(loadIdentity());
