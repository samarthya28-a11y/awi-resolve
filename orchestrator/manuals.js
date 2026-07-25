'use strict';
// Loads deployment manuals from playbooks/deploy/*.md (Level 1 guided deployment).
// Each manual has a small header (product, aliases, version) + a body. The AI's
// read_deployment_manual tool matches a customer's request to one of these and
// reads it to produce tailored, step-by-step guidance (it does not execute).

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'playbooks', 'deploy');

function parseManual(id, text) {
  let product = id, aliases = [], version = '';
  let body = text.trim();
  const m = text.match(/^---\s*([\s\S]*?)\s*---/);
  if (m) {
    body = text.slice(m[0].length).trim();
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const k = kv[1].toLowerCase(), v = kv[2].trim();
      if (k === 'product') product = v;
      else if (k === 'aliases') aliases = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      else if (k === 'version') version = v;
    }
  }
  return { id, product, aliases, version, body };
}

function loadManuals() {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter(
      (f) => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md'
    );
  } catch {
    return [];
  }
  return files.map((f) => parseManual(path.basename(f, '.md'), fs.readFileSync(path.join(DIR, f), 'utf8')));
}

// Best-effort match of a free-text product name to a manual.
function findManual(manuals, query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  for (const man of manuals) {
    const names = [man.product.toLowerCase(), man.id.toLowerCase(), ...man.aliases];
    if (names.some((n) => n && (q.includes(n) || n.includes(q)))) return man;
  }
  return null;
}

module.exports = { loadManuals, findManual };
