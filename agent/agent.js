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
const { selfCheck } = require('./selfcheck');

// Config precedence: env var > config.json (next to the app) > default. The
// installer writes config.json so the packaged app can point at the cloud
// orchestrator without editing code or setting env vars.
//
// CONFIG_PATH is remembered so a licence pasted into the support window is
// written back to the SAME file the agent read, and not to a second config
// that never gets loaded.
let CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  for (const p of [path.join(__dirname, '..', 'config.json'), path.join(__dirname, 'config.json')]) {
    try {
      // Strip a UTF-8 BOM if present — Windows editors / PowerShell often write one,
      // and JSON.parse rejects it, which silently drops the licence key.
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      CONFIG_PATH = p;
      return parsed;
    } catch { /* try next */ }
  }
  return {};
}
const CONFIG = loadConfig();
const ORCH_URL = process.env.RESOLVE_ORCH_URL || CONFIG.orchestratorUrl || 'ws://127.0.0.1:8787';
const UI_PORT = Number(process.env.RESOLVE_UI_PORT || CONFIG.uiPort || 8790);
const ENROLLMENT_SECRET = process.env.RESOLVE_ENROLLMENT_SECRET || CONFIG.enrollmentSecret || '';
// Not const: a customer can paste a key into the support window, and the whole
// point is that it takes effect without them finding and editing a JSON file.
let LICENSE_KEY = process.env.RESOLVE_LICENSE_KEY || CONFIG.licenseKey || '';

// The orchestrator's last word on this machine's licence. Held so a window
// opened long after startup still learns whether it needs activating.
let lastLicenceState = null;

// How much of a document the technician will read, in characters.
//
// A manual goes into the conversation and is then re-read on every subsequent
// step, so a large one is charged many times over. At 500,000 characters — the
// old limit — a single attachment was ~125,000 tokens and could exhaust the
// model's context window outright, which showed up as a session that simply
// failed. 80,000 is roughly thirty pages: enough for a real installation guide,
// and small enough that attaching one cannot break the session.
const MANUAL_CHAR_LIMIT = 80000;
const CUSTOMER_ID = process.env.RESOLVE_CUSTOMER_ID || CONFIG.customerId || '';
const AGENT_VERSION = '0.3.0';
const CONSENT_TIMEOUT_MS = 60000; // spec §7: timeout is treated as declined
const DATA_DIR = path.join(__dirname, 'data');
const IDENTITY_FILE = path.join(DATA_DIR, 'device.json');
const UI_FILE = path.join(__dirname, 'ui', 'index.html');
const LICENCE_UI_FILE = path.join(__dirname, 'ui', 'licence.html');

// Co-branding the support window is split on purpose. The company NAME comes
// from the signed licence, so a PC cannot be dressed up as somebody else's
// company; the LOGO is a local file, because an image cannot travel inside a
// pasteable key. Either half works without the other.
const BRANDING = (CONFIG.branding && typeof CONFIG.branding === 'object') ? CONFIG.branding : {};
const BRANDING_ENABLED = BRANDING.enabled !== false;

// Where a customer is sent to renew. Configurable because a reseller renews at
// their own desk, and pointing their customer at us would lose them the sale.
const RENEW_URL = String(BRANDING.renewUrl || 'https://www.alphawebin.com/');

// Formats a browser will render inline. Anything else is ignored rather than
// served with a guessed type — a mis-typed logo is a broken image in the header.
const LOGO_TYPES = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

// Renewal warning window, in days. One month, as agreed: long enough for a
// purchase order to go through, short enough that it still feels like news.
const RENEWAL_WARN_DAYS = 30;
const REMINDER_SWEEP_MS = 30 * 60 * 1000;

function log(msg) {
  console.log(`[agent ${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------- branding
// Resolved per request rather than once at startup, so a customer who drops
// their logo in after installing does not have to restart the agent to see it.
function resolveCustomerLogo() {
  if (!BRANDING_ENABLED) return null;
  const base = path.dirname(CONFIG_PATH);
  const candidates = [];
  if (BRANDING.logoPath) {
    candidates.push(path.isAbsolute(BRANDING.logoPath)
      ? BRANDING.logoPath
      : path.join(base, BRANDING.logoPath));
  }
  // The zero-configuration path: drop a file into branding next to config.json.
  for (const ext of Object.keys(LOGO_TYPES)) candidates.push(path.join(base, 'branding', 'logo' + ext));
  for (const p of candidates) {
    const type = LOGO_TYPES[path.extname(p).toLowerCase()];
    if (!type) continue;
    try { if (fs.statSync(p).isFile()) return { file: p, type }; } catch { /* next */ }
  }
  return null;
}

// The company name last seen on a valid licence, remembered on disk. Without
// this, a PC that cannot reach the connector opens an unbranded window — the
// customer would read that as the product having lost their details, when all
// that is really wrong is the network.
const BRAND_CACHE_FILE = path.join(DATA_DIR, 'branding.json');

function readBrandName() {
  if (!BRANDING_ENABLED) return null;
  try { return JSON.parse(fs.readFileSync(BRAND_CACHE_FILE, 'utf8')).companyName || null; } catch { return null; }
}

function rememberBrandName(name) {
  if (!BRANDING_ENABLED || !name || name === readBrandName()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BRAND_CACHE_FILE, JSON.stringify({ companyName: name }, null, 2));
  } catch (e) { log(`could not remember branding: ${e.message}`); }
}

function brandingForUi() {
  if (!BRANDING_ENABLED) return { enabled: false, renewUrl: RENEW_URL };
  return {
    enabled: true,
    companyName: readBrandName(),
    logoUrl: resolveCustomerLogo() ? '/customer-logo' : null,
    renewUrl: RENEW_URL,
  };
}

// ------------------------------------------------------- renewal reminders
// A licence that lapses unnoticed is the customer's worst day and our worst
// invoice conversation, so the last month of cover gets one reminder per day —
// one, not one per window opened, and not one per reconnect.
//
// The "shown today" mark lives on disk keyed by licence id AND expiry date, so
// renewing (or pasting a longer key) resets the count by itself: the new
// expiry does not match the recorded one, and the state is cleared the moment
// cover goes back over a month anyway.
const REMINDER_FILE = path.join(DATA_DIR, 'licence-reminder.json');

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readReminderState() {
  try { return JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8')); } catch { return {}; }
}

function writeReminderState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REMINDER_FILE, JSON.stringify(state, null, 2));
  } catch (e) { log(`could not record the renewal reminder: ${e.message}`); }
}

/**
 * The reminder owed to the customer right now, or null.
 *
 * Pure apart from reading the state file: deciding and delivering are kept
 * apart so a reminder is never marked as shown when no window was open to
 * show it in.
 */
function dueRenewalReminder(now = new Date()) {
  const lic = lastLicenceState;
  if (!lic || !lic.expiresAt) return null;
  // A 24-hour pass is re-bought, not renewed, and it never lives long enough
  // for a month's warning to mean anything.
  if (lic.timeBoxed) return null;
  if (!lic.valid && !lic.expired) return null;

  const daysLeft = Math.ceil((new Date(lic.expiresAt) - now) / 86400000);
  const state = readReminderState();
  if (daysLeft > RENEWAL_WARN_DAYS) {
    // Renewed, or never close to expiring. Forget the count.
    if (state.licenseId || state.lastShown) writeReminderState({});
    return null;
  }

  const key = { licenseId: lic.licenseId || null, expiresAt: lic.expiresAt };
  const sameLicence = state.licenseId === key.licenseId && state.expiresAt === key.expiresAt;
  if (sameLicence && state.lastShown === localDayKey(now)) return null;

  return {
    message: {
      type: 'licence_reminder',
      daysLeft,
      expired: Boolean(lic.expired) || daysLeft <= 0,
      licence: lic,
      renewUrl: RENEW_URL,
    },
    mark: { ...key, lastShown: localDayKey(now) },
  };
}

/**
 * Deliver today's reminder, if one is owed and there is somebody to show it to.
 * Pass a single client to deliver into a window that has just opened.
 */
function pushRenewalReminder(client) {
  const due = dueRenewalReminder();
  if (!due) return;
  const raw = JSON.stringify(due.message);
  if (client) {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(raw);
  } else {
    if (!uiClients.size) return; // nobody watching — try again when a window opens
    toUI(due.message);
  }
  writeReminderState(due.mark);
  log(`renewal reminder shown — ${due.message.daysLeft} day(s) of cover left`);
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
    } else if (req.method === 'GET' && (route === '/licence' || route === '/licence.html' || route === '/license')) {
      // A separate window rather than a panel in the chat: licence questions
      // come up while something else is already on screen, and the customer is
      // usually reading it out to somebody on the phone.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(LICENCE_UI_FILE).pipe(res);
    } else if (req.method === 'GET' && route === '/customer-logo') {
      const logo = resolveCustomerLogo();
      if (!logo) { res.writeHead(404).end('No customer logo configured'); return; }
      // Deliberately not cached: a customer who replaces the file expects to
      // see the new one, and this is a local read of a few kilobytes.
      res.writeHead(200, { 'Content-Type': logo.type, 'Cache-Control': 'no-cache' });
      fs.createReadStream(logo.file).pipe(res);
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
    client.send(JSON.stringify({
      type: 'hello', hostname: os.hostname(), branding: brandingForUi(),
    }));
    // The agent starts at boot and the customer opens this window hours later,
    // so the licence state it was told at enrollment has long since been sent
    // to nobody. Replay the last known state to every window that opens, or an
    // unlicensed PC would never show the activation prompt at all.
    if (lastLicenceState) {
      client.send(JSON.stringify({ type: 'licence', licence: lastLicenceState }));
      // If today's renewal reminder is still owed, this is the first window
      // that can carry it — a reminder nobody saw has not been given.
      pushRenewalReminder(client);
    }
    // Ask once, on the first window the customer opens. Until they answer,
    // nothing is uploaded (see sendPostureReport).
    const consent = readConsent();
    if (!consent.decided) client.send(JSON.stringify({ type: 'telemetry_ask' }));
    client.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'cost_approval_response') {
        // Passed straight through: the orchestrator is the only side that knows
        // what was asked and the only side that can charge for it.
        if (orchWs && orchWs.readyState === WebSocket.OPEN) {
          orchWs.send(JSON.stringify({ type: 'cost_approval_response',
            approvalId: m.approvalId, decision: m.decision }));
        }
        return;
      }
      if (m.type === 'activate_licence') {
        // Save a pasted licence key and reconnect so the orchestrator
        // re-evaluates it. The agent does NOT judge whether the key is valid —
        // it cannot be trusted to, since it runs on the customer's own PC. It
        // only checks the shape, to catch a half-copied paste before a
        // reconnect makes the failure look like a network problem.
        const key = String(m.key || '').replace(/\s+/g, '');
        if (!/^RSLIC1-[A-Za-z0-9_-]{40,}$/.test(key)) {
          toUI({ type: 'licence_result', ok: false,
            message: 'That does not look like a complete licence key. It starts with RSLIC1- and is one long line — copy the whole thing.' });
          return;
        }
        try {
          // Merge rather than overwrite: config.json also carries the
          // orchestrator URL and enrollment secret, and losing those would
          // disconnect the PC entirely.
          let current = {};
          try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch { current = {}; }
          current.licenseKey = key;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
          LICENSE_KEY = key;
          log(`licence key saved to ${CONFIG_PATH} — reconnecting to verify`);
          toUI({ type: 'licence_result', ok: true, message: 'Key saved. Checking it…' });
          // Reconnect: the orchestrator verifies the signature and replies with
          // the real licence state, which the window then displays.
          if (orchWs) { try { orchWs.close(); } catch { /* already gone */ } }
        } catch (e) {
          log(`could not save licence key: ${e.message}`);
          toUI({ type: 'licence_result', ok: false,
            message: `Could not save the key to ${CONFIG_PATH}: ${e.message}. Try running Resolve as administrator.` });
        }
        return;
      }
      if (m.type === 'telemetry_choice') {
        const rec = writeConsent(m.allowed);
        log(`customer ${rec.allowed ? 'allowed' : 'declined'} health reporting`);
        toUI({ type: 'telemetry_set', allowed: rec.allowed });
        // Start reporting straight away if they agreed; if they declined,
        // sendPostureReport already refuses, so there is nothing to stop.
        if (rec.allowed && orchWs && orchWs.readyState === WebSocket.OPEN) {
          sendPostureReport(orchWs).catch(() => {});
        }
        return;
      }
      if (m.type === 'open_ticket') {
        if (orchWs && orchWs.readyState === WebSocket.OPEN) {
          toUI({ type: 'status', text: 'Connecting you to the AI technician…' });
          orchWs.send(JSON.stringify({ type: 'open_ticket', text: String(m.text || '').slice(0, 2000) }));
        } else {
          // Offline. Rather than send the customer away, examine the PC with
          // the read-only tools that run here anyway — and when there is no
          // internet, the problem very often IS the internet, which is exactly
          // what this can recognise.
          toUI({ type: 'status', text: "I can't reach the AI technician right now, so let me check this PC myself…" });
          selfCheck().then((r) => {
            toUI({ type: 'selfcheck', result: r });
            toUI({ type: 'done' });
            log(`offline self-check ran — ${r.findings.length} finding(s)`);
          }).catch((e) => {
            log(`self-check failed: ${e.message}`);
            toUI({ type: 'status', text: 'Still starting the support service — press "Get help" again in a moment.' });
            toUI({ type: 'done' });
          });
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
            text = text.trim();
            if (!text) {
              toUI({ type: 'status', text: 'That file looked empty — please try another.' });
              return;
            }
            // Refused, not truncated. A silently halved manual is worse than no
            // manual: the technician reads the first half, does not find the
            // relevant step, and answers confidently from an incomplete
            // document. Better to say so and let the customer send the part
            // that matters.
            if (text.length > MANUAL_CHAR_LIMIT) {
              toUI({ type: 'status', text:
                `"${title}" is about ${Math.round(text.length / 1000)}k characters — too long to read in one go ` +
                `(the limit is ${Math.round(MANUAL_CHAR_LIMIT / 1000)}k, roughly 30 pages). ` +
                `Please attach just the section that covers this problem, or paste the relevant steps.` });
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

  // The agent runs for weeks between restarts, so "one reminder a day" cannot
  // rely on a licence check happening at the right moment. Sweep on a timer;
  // the day key in the state file is what actually enforces once-a-day.
  setInterval(() => {
    try { pushRenewalReminder(); } catch (e) { log(`renewal check failed: ${e.message}`); }
  }, REMINDER_SWEEP_MS);
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

// Telemetry consent. Reporting is disclosed in the support window and can be
// turned off there; the decision is remembered per machine.
//
// Deliberately defaults to OFF until the customer has actually been shown the
// disclosure. A health summary that uploads before anyone has been told is the
// thing a security-minded buyer holds against a security product, and Resolve's
// whole pitch is that nothing happens without the customer knowing.
const CONSENT_FILE = path.join(__dirname, 'data', 'telemetry-consent.json');

function readConsent() {
  try { return JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf8')); }
  catch { return { decided: false, allowed: false }; }
}

function writeConsent(allowed) {
  const record = { decided: true, allowed: !!allowed, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(CONSENT_FILE), { recursive: true });
    fs.writeFileSync(CONSENT_FILE, JSON.stringify(record, null, 2));
  } catch (e) { log(`could not save telemetry choice: ${e.message}`); }
  return record;
}

async function sendPostureReport(ws) {
  const consent = readConsent();
  if (!consent.allowed) {
    log(consent.decided ? 'posture reporting is off (customer declined)'
                        : 'posture reporting held — customer has not been asked yet');
    return;
  }
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
      // The orchestrator is the authority on licence state; the window shows
      // whatever it says, including an activation prompt when unlicensed.
      case 'licence_state':
        log(`licence: ${msg.licence.plan}${msg.licence.valid ? '' : ' (not active)'}`);
        lastLicenceState = msg.licence;
        rememberBrandName(msg.licence.brandName || msg.licence.customer);
        toUI({ type: 'licence', licence: msg.licence });
        // Re-broadcast branding: the company name may have only just arrived,
        // or changed with a re-issued key.
        toUI({ type: 'branding', branding: brandingForUi() });
        pushRenewalReminder();
        break;
      case 'auth_failed': log('AUTH FAILED — identity rejected, not retrying'); ws.close(); process.exit(1); break;
      case 'tool_call': handleToolCall(ws, msg); break;
      // The orchestrator wants the customer to approve spending another ticket.
      // Shown through the same prompt as a tool consent — the customer is being
      // asked to agree to something either way, and one pattern is enough to
      // learn.
      case 'cost_approval':
        toUI({ type: 'cost_approval', approvalId: msg.approvalId, prompt: msg.prompt,
               ticketsUsed: msg.ticketsUsed });
        break;
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
