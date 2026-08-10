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
    try {
      // Strip a UTF-8 BOM if present — Windows editors / PowerShell often write one,
      // and JSON.parse rejects it, which silently drops the licence key.
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch { /* try next */ }
  }
  return {};
}
const CONFIG = loadConfig();
const ORCH_URL = process.env.RESOLVE_ORCH_URL || CONFIG.orchestratorUrl || 'ws://127.0.0.1:8787';
const UI_PORT = Number(process.env.RESOLVE_UI_PORT || CONFIG.uiPort || 8790);
const ENROLLMENT_SECRET = process.env.RESOLVE_ENROLLMENT_SECRET || CONFIG.enrollmentSecret || '';
const LICENSE_KEY = process.env.RESOLVE_LICENSE_KEY || CONFIG.licenseKey || '';
const CUSTOMER_ID = process.env.RESOLVE_CUSTOMER_ID || CONFIG.customerId || '';
const AGENT_VERSION = '0.3.0';
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
          // The agent retries the service every 3s, so this is nearly always a
          // cold start rather than a real outage — say so, instead of implying
          // the customer should give up.
          toUI({ type: 'status', text: 'Still starting the support service — this takes a few seconds after you sign in. Press "Get help" again in a moment.' });
          toUI({ type: 'done' });
        }
      } else if (m.type === 'attach_manual') {
        // Customer-supplied reference document. Forwarded to the AI as untrusted
        // data; size-capped so a huge file can't blow up the session.
        (async () => {
          try {
            const title = String(m.title || 'Document').slice(0, 120);
            let text = '';
            if (m.encoding === 'pdf-base64' && m.data) {
              toUI({ type: 'status', text: `Reading PDF "${title}"…` });
              let pdfParse;
              try { pdfParse = require('pdf-parse'); } catch {
                toUI({ type: 'status', text: 'PDF support is not installed on this agent. Please attach a .txt/.md copy of the manual, or paste the key steps.' });
                return;
              }
              const buf = Buffer.from(String(m.data), 'base64');
              const parsed = await pdfParse(buf);
              text = String(parsed.text || '').trim();
              if (!text) {
                toUI({ type: 'status', text: `Could not extract text from "${title}". Try a text export of the manual.` });
                return;
              }
            } else {
              text = String(m.text || '');
            }
            text = text.slice(0, 500000);
            if (!text.trim()) {
              toUI({ type: 'status', text: 'That file looked empty — please try another.' });
              return;
            }
            if (orchWs && orchWs.readyState === WebSocket.OPEN) {
              log(`customer attached a document: "${title}" (${text.length} chars)`);
              orchWs.send(JSON.stringify({ type: 'attach_manual', title, text }));
              toUI({ type: 'action', text: `Attached "${title}" (${Math.round(text.length / 1000)}k chars) — the technician will use it.` });
            } else {
              toUI({ type: 'status', text: 'Not connected to the support service — please try again in a moment.' });
            }
          } catch (e) {
            toUI({ type: 'status', text: `Could not read that document: ${e.message}` });
          }
        })();
      } else if (m.type === 'attach_image') {
        // A screenshot of an error dialog — often the only way to show a message
        // that can't be copied as text.
        const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(m.mediaType);
        if (!ok) {
          toUI({ type: 'status', text: 'That image type is not supported — please send a PNG or JPG.' });
        } else if (orchWs && orchWs.readyState === WebSocket.OPEN) {
          log(`customer attached a screenshot (${m.mediaType})`);
          orchWs.send(JSON.stringify({ type: 'attach_image', mediaType: m.mediaType, data: m.data }));
          toUI({ type: 'action', text: 'Screenshot attached — the technician will look at it.' });
        } else {
          toUI({ type: 'status', text: 'Not connected to the support service — please try again in a moment.' });
        }
      } else if (m.type === 'consent_response') {
        const resolve = pendingConsents.get(m.consentId);
        if (resolve) { pendingConsents.delete(m.consentId); resolve(m.decision === 'accepted' ? 'accepted' : 'declined'); }
      }
    });
    client.on('close', () => uiClients.delete(client));
  });
  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`support window port ${UI_PORT} is already in use — Resolve is probably already running.`);
      log(`Open http://127.0.0.1:${UI_PORT} (or close the other copy and try again).`);
      process.exit(1);
    }
    log(`support window failed to start: ${e.message}`);
    process.exit(1);
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

// ---------------------------------------------------------------- posture reporting
// Periodically send a read-only security/health summary so the ops dashboard can
// show the whole fleet's protection state. Read-only: nothing here changes the
// machine, and it never includes file contents or personal data.
const POSTURE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function sendPostureReport(ws) {
  try {
    const [posture, snapshot, devices, threats, admins, updates] = await Promise.all([
      TOOLS.get_security_posture.run({}).catch(() => null),
      TOOLS.get_system_snapshot.run({}).catch(() => null),
      TOOLS.list_problem_devices.run({}).catch(() => null),
      TOOLS.get_threat_history.run({}).catch(() => null),
      TOOLS.list_local_admins.run({}).catch(() => null),
      TOOLS.get_update_status.run({}).catch(() => null),
    ]);
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'posture_report',
      at: new Date().toISOString(),
      hostname: os.hostname(),
      agentVersion: AGENT_VERSION,
      posture,
      threats: threats ? { detectionCount: threats.detectionCount } : null,
      admins: admins ? { adminCount: admins.adminCount } : null,
      updates,
      problemDevices: devices ? devices.problemDeviceCount : null,
      machine: snapshot ? {
        os: snapshot.os, uptimeMinutes: snapshot.uptimeMinutes,
        diskFreeGB: snapshot.diskC && snapshot.diskC.freeGB,
        memFreeGB: snapshot.memory && snapshot.memory.freeGB,
        printerCount: Array.isArray(snapshot.printers) ? snapshot.printers.length : null,
      } : null,
    }));
    log('sent security posture report');
  } catch (e) {
    log(`posture report failed: ${e.message}`);
  }
}

let postureTimer = null;
function startPostureReporting(ws) {
  sendPostureReport(ws);                       // report immediately on connect
  clearInterval(postureTimer);
  postureTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) sendPostureReport(ws);
  }, POSTURE_INTERVAL_MS);
}

// ---------------------------------------------------------------- orchestrator link
function connect(identity) {
  log(`connecting to orchestrator at ${ORCH_URL}`);
  const ws = new WebSocket(ORCH_URL);
  orchWs = ws;

  ws.on('open', () => {
    // The licence travels with the enrollment. It is only ever CHECKED by the
    // orchestrator — this side just carries it, so patching the agent gains
    // nothing.
    ws.send(JSON.stringify({ type: 'hello', deviceId: identity.deviceId, deviceSecret: identity.deviceSecret,
      hostname: os.hostname(), agentVersion: AGENT_VERSION, enrollmentSecret: ENROLLMENT_SECRET,
      licenseKey: LICENSE_KEY, customerId: CUSTOMER_ID || undefined }));
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'enrolled':
        log(`enrolled with orchestrator as device ${identity.deviceId}`);
        startPostureReporting(ws);
        break;
      case 'welcome_back':
        log('recognized by orchestrator (already enrolled)');
        startPostureReporting(ws);
        break;
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
