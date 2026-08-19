'use strict';
// Microsoft 365 / Entra ID diagnostics, via Microsoft Graph.
//
// WHY THIS RUNS IN THE CLOUD, NOT ON THE PC
//
// Every other Resolve tool runs on the customer's machine. These must not. Two
// reasons, both decisive:
//
//   1. The credentials are tenant-wide. An app secret that can read every user
//      in a Microsoft tenant has no business sitting on an end user's laptop,
//      where any local administrator could read it out of a config file.
//
//   2. The affected PC is frequently not the one we are talking to. The ticket
//      that prompted this was "our customer cannot open OneDrive" raised by an
//      IT provider from their own machine. On-device tools would have inspected
//      the wrong computer and found nothing wrong, which is exactly what
//      happened.
//
// READ-ONLY BY DESIGN (for now)
//
// Everything here reads. Nothing assigns a licence, resets a password, or
// changes a permission. That is a deliberate first step: these credentials are
// among the most powerful a customer can hand over, and a read-only integration
// is one a security-conscious IT manager can actually approve. Write actions
// belong behind consent and a separate, narrower permission set.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const TENANTS_FILE = path.join(DATA_DIR, 'm365-tenants.json');
const GRAPH = 'graph.microsoft.com';
const LOGIN = 'login.microsoftonline.com';

// Access tokens live an hour; cache them so a multi-step diagnosis does not
// fetch a new one for every question. Keyed by customerId, in memory only —
// a restart simply re-authenticates.
const tokenCache = new Map();

// ---------------------------------------------------------------- storage --

function loadTenants() {
  try { return JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8')); } catch { return {}; }
}

function saveTenants(all) {
  // 0600: the file holds client secrets for customer tenants.
  fs.writeFileSync(TENANTS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** Store (or replace) one organisation's tenant credentials. */
function setTenant(customerId, { tenantId, clientId, clientSecret, domain }) {
  if (!customerId) throw new Error('customerId is required');
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('tenantId, clientId and clientSecret are all required');
  }
  const all = loadTenants();
  all[customerId] = {
    tenantId: String(tenantId).trim(),
    clientId: String(clientId).trim(),
    clientSecret: String(clientSecret),
    domain: domain ? String(domain).trim() : null,
    configuredAt: new Date().toISOString(),
  };
  saveTenants(all);
  tokenCache.delete(customerId);
  // Return without the secret. Callers log their result, and a secret that
  // reaches a log is a secret that has to be rotated.
  const { clientSecret: _omit, ...safe } = all[customerId];
  return safe;
}

/** What is configured, never including the secret. */
function tenantInfo(customerId) {
  const t = loadTenants()[customerId];
  if (!t) return null;
  const { clientSecret: _omit, ...safe } = t;
  return safe;
}

function removeTenant(customerId) {
  const all = loadTenants();
  const existed = Boolean(all[customerId]);
  delete all[customerId];
  saveTenants(all);
  tokenCache.delete(customerId);
  return existed;
}

function isConfigured(customerId) {
  return Boolean(loadTenants()[customerId]);
}

// ------------------------------------------------------------------- http --

function request(host, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: pathname, method, headers, timeout: 20000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Microsoft did not respond within 20 seconds')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** App-only access token for a customer's tenant, cached until shortly before expiry. */
async function accessToken(customerId) {
  const cached = tokenCache.get(customerId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const t = loadTenants()[customerId];
  if (!t) throw new Error('No Microsoft 365 tenant is connected for this organisation');

  const form = new URLSearchParams({
    client_id: t.clientId,
    client_secret: t.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();

  const res = await request(LOGIN, `/${encodeURIComponent(t.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
    },
    body: form,
  });

  if (res.status !== 200 || !res.body || !res.body.access_token) {
    // Microsoft's description is genuinely useful here (expired secret, wrong
    // tenant, consent not granted), so pass it through rather than flattening
    // it to "authentication failed".
    const why = (res.body && (res.body.error_description || res.body.error)) || `HTTP ${res.status}`;
    throw new Error(`Could not sign in to the customer's Microsoft tenant: ${String(why).split('\n')[0]}`);
  }

  const token = res.body.access_token;
  tokenCache.set(customerId, {
    token,
    expiresAt: Date.now() + Number(res.body.expires_in || 3600) * 1000,
  });
  return token;
}

/** A Graph GET, with Microsoft's own error text preserved. */
async function graph(customerId, pathname) {
  const token = await accessToken(customerId);
  const res = await request(GRAPH, pathname, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 403) {
    const msg = res.body?.error?.message || 'Access denied';
    throw new Error(
      `Microsoft refused this request (403). The app registration is probably missing a permission ` +
      `or admin consent: ${msg}`
    );
  }
  if (res.status === 404) return { notFound: true };
  if (res.status >= 400) {
    const msg = res.body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Microsoft Graph error: ${msg}`);
  }
  return res.body;
}

// ------------------------------------------------------------------ tools --

/** Escape a value for an OData filter string literal. */
function odata(v) {
  return String(v).replace(/'/g, "''");
}

/**
 * Find a user and say, in one answer, the things a support call actually needs:
 * do they exist, can they sign in, and are they licensed.
 */
async function findUser(customerId, upnOrEmail) {
  const q = String(upnOrEmail || '').trim();
  if (!q) throw new Error('A user email or UPN is required');

  const select = 'id,displayName,userPrincipalName,mail,accountEnabled,assignedLicenses,usageLocation,createdDateTime,onPremisesSyncEnabled';
  let user = await graph(customerId, `/v1.0/users/${encodeURIComponent(q)}?$select=${select}`);

  // Not found by UPN — the address may be an alias or a mail attribute.
  if (user && user.notFound) {
    const filter = encodeURIComponent(`mail eq '${odata(q)}' or userPrincipalName eq '${odata(q)}'`);
    const list = await graph(customerId, `/v1.0/users?$filter=${filter}&$select=${select}`);
    user = list && Array.isArray(list.value) && list.value.length ? list.value[0] : null;
  }
  if (!user || user.notFound) {
    return { found: false, searched: q, note: 'No user with that address exists in this tenant. Check for a typo, or whether they are in a different tenant.' };
  }

  return {
    found: true,
    displayName: user.displayName,
    userPrincipalName: user.userPrincipalName,
    mail: user.mail,
    accountEnabled: user.accountEnabled,
    signInBlocked: user.accountEnabled === false,
    licenceCount: (user.assignedLicenses || []).length,
    hasAnyLicence: (user.assignedLicenses || []).length > 0,
    usageLocation: user.usageLocation || null,
    // A missing usage location is a classic cause of "licence will not assign".
    usageLocationMissing: !user.usageLocation,
    syncedFromOnPrem: Boolean(user.onPremisesSyncEnabled),
    createdDateTime: user.createdDateTime || null,
    id: user.id,
  };
}

/**
 * Which licences the user holds, and specifically whether the OneDrive and
 * SharePoint service plans inside them are actually enabled — a licence can be
 * assigned with the very service the user needs switched off.
 */
async function licenceDetails(customerId, upnOrEmail) {
  const q = String(upnOrEmail || '').trim();
  if (!q) throw new Error('A user email or UPN is required');

  const data = await graph(customerId, `/v1.0/users/${encodeURIComponent(q)}/licenseDetails`);
  if (!data || data.notFound) return { found: false, searched: q };

  const licences = (data.value || []).map((l) => ({
    skuPartNumber: l.skuPartNumber,
    servicePlans: (l.servicePlans || []).map((p) => ({
      name: p.servicePlanName,
      status: p.provisioningStatus,
    })),
  }));

  const plans = licences.flatMap((l) => l.servicePlans);
  const matching = (re) => plans.filter((p) => re.test(p.name || ''));
  const oneDrive = matching(/ONEDRIVE|SHAREPOINT/i);
  const enabled = oneDrive.filter((p) => /Success|PendingProvisioning/i.test(p.status || ''));

  return {
    found: true,
    licences,
    oneDriveOrSharePointPlans: oneDrive,
    // The question the ticket is really asking.
    oneDriveEntitled: enabled.length > 0,
    diagnosis: licences.length === 0
      ? 'The user holds no licences at all — this alone explains an AccessDenied on OneDrive.'
      : enabled.length === 0
        ? 'The user is licensed, but every OneDrive/SharePoint service plan is disabled on that licence.'
        : 'The user is entitled to OneDrive/SharePoint. If access still fails, look at sign-in logs and site permissions rather than licensing.',
  };
}

/**
 * Recent sign-ins, with the failure reason spelled out. This is where
 * conditional access blocks and wrong-tenant sign-ins become visible.
 */
async function recentSignIns(customerId, upnOrEmail, limit = 10) {
  const q = String(upnOrEmail || '').trim();
  if (!q) throw new Error('A user email or UPN is required');
  const top = Math.min(Math.max(Number(limit) || 10, 1), 25);

  const filter = encodeURIComponent(`userPrincipalName eq '${odata(q)}'`);
  const data = await graph(customerId, `/v1.0/auditLogs/signIns?$filter=${filter}&$top=${top}`);
  if (!data || data.notFound) {
    return { available: false, note: 'Sign-in logs are not available. They need the AuditLog.Read.All permission, and an Entra ID P1 licence on the tenant.' };
  }

  const rows = (data.value || []).map((s) => ({
    at: s.createdDateTime,
    app: s.appDisplayName,
    ip: s.ipAddress,
    status: s.status?.errorCode === 0 ? 'success' : 'failure',
    errorCode: s.status?.errorCode || 0,
    failureReason: s.status?.failureReason || null,
    conditionalAccess: s.conditionalAccessStatus || null,
  }));

  const failures = rows.filter((r) => r.status === 'failure');
  return {
    available: true,
    signIns: rows,
    failureCount: failures.length,
    mostRecentFailure: failures[0] || null,
    caBlocked: rows.some((r) => r.conditionalAccess === 'failure'),
  };
}

/**
 * Whether the user's OneDrive has actually been provisioned. A OneDrive that
 * has never been created returns 404 here, which looks identical to "access
 * denied" from the user's side and is a completely different fix.
 */
async function oneDriveStatus(customerId, upnOrEmail) {
  const q = String(upnOrEmail || '').trim();
  if (!q) throw new Error('A user email or UPN is required');

  const drive = await graph(customerId, `/v1.0/users/${encodeURIComponent(q)}/drive`);
  if (!drive || drive.notFound) {
    return {
      provisioned: false,
      diagnosis:
        'This user has no OneDrive. It is created the first time they open OneDrive with a valid licence — ' +
        'so an unlicensed user, or one who has never signed in, will see an access error rather than an empty drive.',
    };
  }
  const quota = drive.quota || {};
  return {
    provisioned: true,
    webUrl: drive.webUrl || null,
    createdDateTime: drive.createdDateTime || null,
    quotaState: quota.state || null,
    usedGB: quota.used != null ? +(quota.used / 1e9).toFixed(2) : null,
    totalGB: quota.total != null ? +(quota.total / 1e9).toFixed(2) : null,
    diagnosis: /exceeded|critical/i.test(quota.state || '')
      ? `The drive exists but its quota state is "${quota.state}", which blocks writes.`
      : 'The drive exists and is in a normal state. An access error is then a permission or sign-in problem, not provisioning.',
  };
}

module.exports = {
  setTenant, tenantInfo, removeTenant, isConfigured,
  findUser, licenceDetails, recentSignIns, oneDriveStatus,
  TENANTS_FILE,
};
