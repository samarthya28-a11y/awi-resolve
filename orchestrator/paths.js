'use strict';
// Where the orchestrator keeps state that must outlive a restart.
//
// This exists because of one failure mode. On a cloud host the container
// filesystem is REPLACED on every deploy — so state written next to the code
// disappears the next time we ship. Two of the files here are ledger.json
// (tickets a customer has paid for) and admin-tokens.json (their console
// access). Losing those is not a lost cache; it is a customer who paid and has
// nothing to show for it, discovered by them rather than by us.
//
// So the directory is configurable, and in any hosted deployment
// RESOLVE_DATA_DIR must point at a mounted volume. Locally it defaults to
// ./data, which is where existing state already lives — no migration, no
// configuration needed for development.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RESOLVE_DATA_DIR
  ? path.resolve(process.env.RESOLVE_DATA_DIR)
  : path.join(__dirname, 'data');

/** Create a directory if missing. Safe to call repeatedly. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Fail loudly at boot rather than on the first write. A connector that starts
// happily and then cannot record a ticket debit is worse than one that refuses
// to start: the first hides the problem behind a working-looking service.
try {
  ensureDir(DATA_DIR);
} catch (err) {
  console.error(`[paths] FATAL: cannot create data directory ${DATA_DIR}: ${err.message}`);
  console.error('[paths] Set RESOLVE_DATA_DIR to a writable path (a mounted volume in production).');
  process.exit(1);
}

/** A path inside the data directory. */
function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

module.exports = { DATA_DIR, dataPath, ensureDir };
