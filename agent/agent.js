'use strict';
// AWI Resolve agent — runs on the customer's PC. Two connections:
//   1. OUTBOUND WebSocket to the cloud orchestrator (never listens for it) —
//      receives tool calls, enforces the allowlist + consent on-device.
//   2. A LOCAL-ONLY web UI (127.0.0.1) — the chat window the customer sees.
//      This is the page an Electron tray app would host; kept as plain HTML so
//      it renders in any browser during development.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const { TOOLS } = require('./tools');

// Config precedence: env var > config.json (next to the app) > default. The
// installer writes config.json so the packaged app can point at the cloud
// orchestrator without editing code or setting env vars.
function loadConfig() {
  for (const p of [path.join(__dirname, '..', 'config.json'), path.join(__dirname, 'config.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return {};
}
const CONFIG = loadConfig();
const ORCH_URL = process.env.RESOLVE_ORCH_URL || CONFIG.orchestratorUrl || 'ws://127.0.0.1:8787';
const UI_PORT = Number(process.env.RESOLVE_UI_PORT || CONFIG.uiPort || 8790);
const ENROLLMENT_SECRET = process.env.RESOLVE_ENROLLMENT_SECRET || CONFIG.enrollmentSecret || '';
const AGENT_VERSION = '0.2.0';
const CONSENT_TIMEOUT_MS = 60000; // spec §7: timeout is treated as declined
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITY_FILE = path.join(DATA_DIR, 'device.json');
const UI_FILE = path.join(__dirname, 'ui', 'index.html');

function log(msg) {
  console.log(`[agent ${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------- identity
function loadIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  const identity = { deviceId: crypto.randomUUID(), deviceSecret: crypto.randomBytes(32).toString('hex') };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  log('new device identity created (first run)');
  return identity;
}

// ---------------------------------------------------------------- local UI
const uiClients = new Set();
const pendingConsents = new Map(); // consentId -> resolve(decision)
let orchWs = null;

function toUI(obj) {
  const s = JSON.stringify(obj);
  for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// Static assets served to the support window (corporate logo + product mark).
const UI_ASSETS = {
  '/logo.svg': path.join(__dirname, 'ui', 'logo.svg'),
  '/resolve-mark.svg': path.join(__dirname, 'ui', 'resolve-mark.svg'),
  '/resolve-mark-white.svg': path.join(__dirname, 'ui', 'resolve-mark-white.svg'),
};

function startUiServer() {
  const httpServer = http.createServer((req, res) => {
    const route = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (route === '/' || route.startsWith('/index'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(UI_FILE).pipe(res);
    } else if (req.method === 'GET' && UI_ASSETS[route]) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(UI_ASSETS[route]).pipe(res);
    } else {
      res.writeHead(404).end('Not found');
    }
  });
  const wss = new WebSocket.Server({ server: httpServer });
  wss.on('connection', (client) => {
    uiClients.add(client);
    client.send(JSON.stringify({ type: 'hello', hostname: os.hostname() }));
    client.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'open_ticket') {
        if (orchWs && orchWs.readyState === WebSocket.OPEN) {
          toUI({ type: 'status', text: 'Connecting you to the AI technician…' });
          orchWs.send(JSON.stringify({ type: 'open_ticket', text: String(m.text || '').slice(0, 2000) }));
        } else {
          toUI({ type: 'status', text: 'Support service is offline right now. Please try again shortly.' });
          toUI({ type: 'done' });
        }
      } else if (m.type === 'consent_response') {
        const resolve = pendingConsents.get(m.consentId);
        if (resolve) { pendingConsents.delete(m.consentId); resolve(m.decision === 'accepted' ? 'accepted' : 'declined'); }
      }
    });
    client.on('close', () => uiClients.delete(client));
  });
  httpServer.listen(UI_PORT, '127.0.0.1', () => log(`support window available at http://127.0.0.1:${UI_PORT}`));
}

// Ask the customer to approve a Tier-2 action. Prompt text is template-generated
// here (never model-written). Timeout counts as a decline (spec §7).
function requestConsent(promptText) {
  return new Promise((resolve) => {
    const consentId = crypto.randomUUID();
    pendingConsents.set(consentId, resolve);
    toUI({ type: 'consent', consentId, prompt: promptText });
    setTimeout(() => {
      if (pendingConsents.delete(consentId)) resolve('timeout');
    }, CONSENT_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------- tool calls
async function handleToolCall(ws, msg) {
  const { callId, toolId, params } = msg;
  const tool = TOOLS[toolId];

  if (!tool) {
    // Security core: unknown/forbidden tools refused ON THE DEVICE (spec §9.1).
    log(`REFUSED '${toolId}' — not in the agent allowlist`);
    ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'refused',
      reason: 'Tool is not in the agent allowlist. Enforced on the device (spec §6, Tier-X).' }));
    return;
  }

  // Tier-2: hold the action until the customer approves it.
  if (tool.tier === 2) {
    const promptText = tool.consent(params || {});
    log(`Tier-2 '${toolId}' — asking customer for consent`);
    const decision = await requestConsent(promptText);
    if (decision !== 'accepted') {
      log(`Tier-2 '${toolId}' — ${decision} by customer; NOT executed`);
      ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'declined_by_customer',
        reason: `Customer ${decision === 'timeout' ? 'did not respond' : 'declined'} the consent prompt.` }));
      return;
    }
  }

  log(`executing Tier-${tool.tier} tool '${toolId}'`);
  try {
    const result = await tool.run(params || {});
    if (tool.tier >= 1) toUI({ type: 'action', text: result.action || tool.note || `Applied ${toolId}` });
    ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'ok', tier: tool.tier, result }));
  } catch (e) {
    if (tool.tier >= 1) toUI({ type: 'action', text: `Couldn't complete ${toolId}: ${e.message}` });
    ws.send(JSON.stringify({ type: 'tool_result', callId, toolId, status: 'error', reason: e.message }));
  }
}

// ---------------------------------------------------------------- orchestrator link
function connect(identity) {
  log(`connecting to orchestrator at ${ORCH_URL}`);
  const ws = new WebSocket(ORCH_URL);
  orchWs = ws;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', deviceId: identity.deviceId, deviceSecret: identity.deviceSecret,
      hostname: os.hostname(), agentVersion: AGENT_VERSION, enrollmentSecret: ENROLLMENT_SECRET }));
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'enrolled': log(`enrolled with orchestrator as device ${identity.deviceId}`); break;
      case 'welcome_back': log('recognized by orchestrator (already enrolled)'); break;
      case 'auth_failed': log('AUTH FAILED — identity rejected, not retrying'); ws.close(); process.exit(1); break;
      case 'tool_call': handleToolCall(ws, msg); break;
      // Progress + results the orchestrator streams for the customer UI:
      case 'ai_update': toUI({ type: 'status', text: msg.text }); break;
      case 'ai_message': toUI({ type: 'ai_message', text: msg.text }); break;
      case 'ticket_summary': toUI({ type: 'summary', report: msg.report }); break;
      case 'ticket_done': toUI({ type: 'done' }); break;
    }
  });

  ws.on('close', () => { log('disconnected — retrying in 3s'); orchWs = null; setTimeout(() => connect(identity), 3000); });
  ws.on('error', (e) => log(`connection error: ${e.message}`));
}

startUiServer();
connect(loadIdentity());
