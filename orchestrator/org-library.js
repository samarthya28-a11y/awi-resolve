'use strict';
// Per-customer IT-admin approved software library (spec §6 v1.3).
//
// Stores manuals + HTTPS download links + sha256 only — not installer binaries.
// End users can install only packages their org admin has enabled here.
// File-backed for pilot; shape matches db/schema.sql org_software.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('./paths');
const LIB_DIR = path.join(DATA_DIR, 'org-libraries');
const ADMIN_TOKENS_FILE = path.join(DATA_DIR, 'admin-tokens.json');

fs.mkdirSync(LIB_DIR, { recursive: true });

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'org';
}

function customerIdFromLicense(lic) {
  if (!lic || !lic.valid) return null;
  if (lic.customerId) return slugify(lic.customerId);
  if (lic.customer) return slugify(lic.customer);
  if (lic.licenseId) return slugify(lic.licenseId);
  return null;
}

function libPath(customerId) {
  const id = slugify(customerId);
  return path.join(LIB_DIR, `${id}.json`);
}

function loadLibrary(customerId) {
  const id = slugify(customerId);
  const p = libPath(id);
  if (!fs.existsSync(p)) {
    return { customerId: id, name: id, packages: [], allowFullItSupport: false, updatedAt: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return {
      customerId: id,
      name: String(raw.name || id).slice(0, 120),
      packages: Array.isArray(raw.packages) ? raw.packages : [],
      // Dual gate with licence plan `full` — IT admin must also enable this.
      allowFullItSupport: Boolean(raw.allowFullItSupport),
      updatedAt: raw.updatedAt || null,
      settingsUpdatedBy: raw.settingsUpdatedBy || null,
    };
  } catch {
    return { customerId: id, name: id, packages: [], allowFullItSupport: false, updatedAt: null };
  }
}

function saveLibrary(lib) {
  const id = slugify(lib.customerId);
  const out = {
    customerId: id,
    name: String(lib.name || id).slice(0, 120),
    allowFullItSupport: Boolean(lib.allowFullItSupport),
    settingsUpdatedBy: lib.settingsUpdatedBy || null,
    updatedAt: new Date().toISOString(),
    packages: lib.packages || [],
  };
  fs.writeFileSync(libPath(id), JSON.stringify(out, null, 2));
  return out;
}

function updateSettings(customerId, settings, actor) {
  const id = slugify(customerId);
  if (!id) throw new Error('customerId required');
  const lib = loadLibrary(id);
  if (settings && typeof settings === 'object') {
    if (Object.prototype.hasOwnProperty.call(settings, 'allowFullItSupport')) {
      lib.allowFullItSupport = Boolean(settings.allowFullItSupport);
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'name') && settings.name) {
      lib.name = String(settings.name).trim().slice(0, 120);
    }
  }
  lib.settingsUpdatedBy = actor || null;
  return saveLibrary(lib);
}

function isFullItSupportAllowed(customerId) {
  const id = slugify(customerId);
  if (!id) return false;
  return Boolean(loadLibrary(id).allowFullItSupport);
}

function publicSettings(lib) {
  return {
    customerId: lib.customerId,
    name: lib.name || lib.customerId,
    allowFullItSupport: Boolean(lib.allowFullItSupport),
    updatedAt: lib.updatedAt || null,
  };
}

function validatePackageInput(input, { requireId = false } = {}) {
  const errors = [];
  const productId = slugify(input.productId || input.productName);
  if (requireId && !input.productId) errors.push('productId is required');
  const productName = String(input.productName || '').trim().slice(0, 120);
  if (!productName) errors.push('productName is required');

  const downloadUrl = String(input.downloadUrl || '').trim();
  let parsed;
  try { parsed = new URL(downloadUrl); } catch { errors.push('downloadUrl must be a valid URL'); }
  if (parsed && parsed.protocol !== 'https:') errors.push('downloadUrl must be https');
  const pathLower = parsed ? decodeURIComponent(parsed.pathname || '').toLowerCase() : '';
  let installerType = null;
  if (pathLower.endsWith('.msi')) installerType = 'msi';
  else if (pathLower.endsWith('.exe')) installerType = 'exe';
  else if (parsed) errors.push('downloadUrl must end in .exe or .msi');

  const sha256 = String(input.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) errors.push('sha256 must be a 64-character hex digest');

  const manualText = String(input.manualText || '').slice(0, 200000);
  if (!manualText.trim()) errors.push('manualText is required (paste the setup guide)');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    package: {
      productId,
      productName,
      version: String(input.version || '').trim().slice(0, 64),
      downloadUrl: parsed.href,
      sha256,
      installerType,
      manualText,
      verifyHint: String(input.verifyHint || '').trim().slice(0, 260),
      enabled: input.enabled !== false,
      updatedAt: new Date().toISOString(),
    },
  };
}

function listEnabled(customerId) {
  if (!customerId) return [];
  return loadLibrary(customerId).packages
    .filter((p) => p && p.enabled !== false)
    .map((p) => ({
      productId: p.productId,
      product: p.productName,
      version: p.version || null,
      hasManual: !!(p.manualText && p.manualText.trim()),
    }));
}

function getPackage(customerId, productId) {
  if (!customerId || !productId) return null;
  const id = slugify(productId);
  return loadLibrary(customerId).packages.find((p) => p.productId === id) || null;
}

function upsertPackage(customerId, input) {
  const id = slugify(customerId);
  const v = validatePackageInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const lib = loadLibrary(id);
  const idx = lib.packages.findIndex((p) => p.productId === v.package.productId);
  const createdAt = idx >= 0 ? (lib.packages[idx].createdAt || lib.packages[idx].updatedAt) : new Date().toISOString();
  const entry = { ...v.package, createdAt, createdBy: input.createdBy || (idx >= 0 ? lib.packages[idx].createdBy : 'admin') };
  if (idx >= 0) lib.packages[idx] = entry;
  else lib.packages.push(entry);
  saveLibrary(lib);
  return { ok: true, package: publicPackage(entry) };
}

function setEnabled(customerId, productId, enabled) {
  const lib = loadLibrary(customerId);
  const id = slugify(productId);
  const entry = lib.packages.find((p) => p.productId === id);
  if (!entry) return { ok: false, error: 'not found' };
  entry.enabled = !!enabled;
  entry.updatedAt = new Date().toISOString();
  saveLibrary(lib);
  return { ok: true, package: publicPackage(entry) };
}

function removePackage(customerId, productId) {
  const lib = loadLibrary(customerId);
  const id = slugify(productId);
  const before = lib.packages.length;
  lib.packages = lib.packages.filter((p) => p.productId !== id);
  if (lib.packages.length === before) return { ok: false, error: 'not found' };
  saveLibrary(lib);
  return { ok: true };
}

function publicPackage(p) {
  return {
    productId: p.productId,
    productName: p.productName,
    version: p.version || null,
    downloadUrl: p.downloadUrl,
    sha256: p.sha256,
    installerType: p.installerType,
    verifyHint: p.verifyHint || null,
    enabled: p.enabled !== false,
    manualText: p.manualText,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

function listAllPublic(customerId) {
  return loadLibrary(customerId).packages.map(publicPackage);
}

// ---- admin tokens (customerId -> shared secret) ------------------------------
// File: orchestrator/data/admin-tokens.json
//   { "acme-corp": "long-random-token", ... }
// Or env RESOLVE_CUSTOMER_ADMIN_TOKENS as the same JSON object.

function loadAdminTokens() {
  let fromEnv = {};
  if (process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS) {
    try { fromEnv = JSON.parse(process.env.RESOLVE_CUSTOMER_ADMIN_TOKENS); } catch { fromEnv = {}; }
  }
  let fromFile = {};
  try {
    if (fs.existsSync(ADMIN_TOKENS_FILE)) {
      fromFile = JSON.parse(fs.readFileSync(ADMIN_TOKENS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch { fromFile = {}; }
  return { ...fromFile, ...fromEnv };
}

function saveAdminToken(customerId, token) {
  const id = slugify(customerId);
  let current = {};
  try {
    if (fs.existsSync(ADMIN_TOKENS_FILE)) {
      current = JSON.parse(fs.readFileSync(ADMIN_TOKENS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch { current = {}; }
  current[id] = token;
  fs.writeFileSync(ADMIN_TOKENS_FILE, JSON.stringify(current, null, 2));
  return id;
}

function ensureAdminToken(customerId) {
  const id = slugify(customerId);
  const tokens = loadAdminTokens();
  if (tokens[id]) return { customerId: id, token: tokens[id], created: false };
  const token = crypto.randomBytes(24).toString('base64url');
  saveAdminToken(id, token);
  return { customerId: id, token, created: true };
}

function adminTokenOk(customerId, supplied) {
  if (!customerId || !supplied) return false;
  const tokens = loadAdminTokens();
  const expected = tokens[slugify(customerId)];
  if (!expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  slugify,
  customerIdFromLicense,
  loadLibrary,
  listEnabled,
  getPackage,
  upsertPackage,
  setEnabled,
  removePackage,
  listAllPublic,
  publicPackage,
  updateSettings,
  isFullItSupportAllowed,
  publicSettings,
  loadAdminTokens,
  ensureAdminToken,
  adminTokenOk,
  validatePackageInput,
  LIB_DIR,
  ADMIN_TOKENS_FILE,
};
