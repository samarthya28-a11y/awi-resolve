'use strict';
// AWI Resolve — approved installer catalog (Level 2 deployment).
//
// SAFETY CORE (spec §6 Tier-X: "installing software outside the signed-installer
// list" is structurally forbidden):
//   * The AI can NEVER supply a URL, filename or command line. It may only name a
//     product ID that exists in THIS file, which is compiled into the agent.
//   * Every entry pins an exact HTTPS url + sha256. The downloaded bytes are
//     hashed and compared before anything is executed. Mismatch => abort.
//   * Arguments are fixed here, never model-supplied.
//   * An entry with no sha256 is REFUSED (fail closed) — a catalog entry can
//     never run unverified.
//
// Adding an entry = code change + spec update + review. Never config-only.

const CATALOG = {
  '7zip': {
    product: '7-Zip',
    version: '24.08 (x64)',
    url: 'https://www.7-zip.org/a/7z2408-x64.exe',
    // sha256 of the official 7z2408-x64.exe, computed from the file downloaded
    // over HTTPS from 7-zip.org on 2026-07-25 (1.55 MB).
    // NOTE: before pilot, cross-check this against the vendor's published hash /
    // signature. Pinning from our own download is trust-on-first-use.
    sha256: '67cb9d3452c9dd974b04f4a5fd842dbcba8184f2344ff72e3662d7cdb68b099b',
    // Fixed silent-install arguments (NOT model-supplied)
    args: ['/S'],
    // How we prove it installed (a path that must exist afterwards)
    verifyPath: 'C:\\Program Files\\7-Zip\\7zFM.exe',
    // Plain-language description used in the consent prompt
    describe: 'the free 7-Zip file-archive tool (about 5 MB, from the official 7-zip.org site)',
  },

  // ---------------------------------------------------------------------------
  // Gespage Popup (print client) — Alpha Web's flagship deployment.
  //
  // DISABLED until `url` points at an Alpha Web-hosted copy of the installer.
  // Everything else is ready: the sha256 below was computed from Alpha Web's own
  // GespagePopup_Setup_7.3.4.37562148.msi (3,715,072 bytes). Re-compute it if the
  // hosted file is a different build.
  //
  // To enable: host the MSI over HTTPS, put its URL below, confirm the sha256
  // still matches the hosted file, confirm verifyPath on a real install, and
  // uncomment. That is a spec-level change (§6) — review before shipping.
  // ---------------------------------------------------------------------------
  // 'gespage-popup': {
  //   product: 'Gespage Popup (print client)',
  //   version: '7.3.4.37562148',
  //   url: 'https://<alpha-web-approved-host>/GespagePopup_Setup_7.3.4.37562148.msi',
  //   sha256: '4baf8da1b3d2ff09afd91443b8418b49e7c3c1d0602b738eea443a2e477efeb4',
  //   installerType: 'msi',
  //   args: ['/qn'],                       // silent, no UI
  //   params: {
  //     SERVER_IP: {
  //       required: true,
  //       // hostname or IP only — nothing that could smuggle a second argument
  //       pattern: '^[A-Za-z0-9][A-Za-z0-9.\\-]{0,252}$',
  //       describe: 'the Gespage server address',
  //     },
  //   },
  //   verifyPath: 'C:\\Program Files\\Gespage\\Popup',   // CONFIRM on a real install
  //   describe: 'the Gespage Popup print client, pointed at your Gespage server',
  // },
};

function getEntry(id) {
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) return null;
  return CATALOG[id];
}

function listProducts() {
  return Object.entries(CATALOG).map(([id, e]) => ({ id, product: e.product, version: e.version }));
}

module.exports = { CATALOG, getEntry, listProducts };
