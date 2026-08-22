#!/usr/bin/env node
// Customer-uploaded documentation.
//
//   RESOLVE_DATA_DIR=<scratch> node tools/test-org-kb.js
//
// The property that matters most here is ISOLATION. These documents are a
// customer's own internal manuals, and one of them surfacing in another
// customer's session would be a breach, not a bug — so it is tested from both
// directions: the right org finds it, and every other org cannot, including one
// that tries to reach sideways with a crafted id.
//
// Refuses to run against the real data directory: it writes and deletes
// documents, and doing that to a live customer's knowledge base would be worse
// than having no test.

const fs = require('fs');
const path = require('path');

if (!process.env.RESOLVE_DATA_DIR) {
  console.error('Set RESOLVE_DATA_DIR to a scratch directory first — this writes and deletes documents.');
  process.exit(1);
}

const orgKb = require('../orchestrator/org-kb');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// A page of plausible manual text, long enough to produce several chunks.
const MANUAL = `
Kyocera TASKalfa 3554ci — administrator guide.

Section 4.2 Card reader configuration.
The card reader must be enabled in Command Center RX before the terminal will
authenticate users. Navigate to Device Settings, then Card Reader, and set the
authentication port to 9095. The default port 9090 is used by the status
monitor and will not accept authentication traffic.

Section 4.3 Job accounting.
Set the accounting code length to 8 digits. A shorter code is accepted by the
panel but rejected by the print server, which reports error C7990 without
explaining the cause.
`.repeat(12);

const ACME = 'acme-mfg';
const RIVAL = 'rival-co';

(async () => {
  // ------------------------------------------------------------ ingestion
  console.log('\nIngesting a manual');
  const added = await orgKb.addDocument(ACME, {
    title: 'Kyocera TASKalfa admin guide', tag: 'Kyocera',
    encoding: 'text', data: MANUAL,
  });
  check('the upload is accepted', added.ok, added.error);
  check('it is split into searchable sections', added.ok && added.doc.chunks > 1,
    added.ok ? String(added.doc.chunks) : '');
  check('the tag is normalised', added.ok && added.doc.tag === 'kyocera',
    added.ok ? added.doc.tag : '');

  const docs = orgKb.listDocuments(ACME);
  check('it appears in the list', docs.length === 1 && docs[0].title === 'Kyocera TASKalfa admin guide');

  const u = orgKb.usage(ACME);
  check('storage is accounted for', u.textBytes > 0 && u.documents === 1, JSON.stringify(u.textBytes));

  // -------------------------------------------------------------- search
  console.log('\nSearching it');
  const hit = orgKb.searchOrgKb(ACME, 'card reader authentication port', 5);
  check('the manual is found', hit.available && hit.results.length > 0,
    `${hit.available} / ${hit.results.length}`);
  check('the excerpt carries the answer', hit.results.length > 0 && /9095/.test(hit.results[0].excerpt));
  check('it is labelled as the customer\'s own', hit.results.length > 0
    && /your organisation/i.test(hit.results[0].source), hit.results[0] && hit.results[0].source);
  check('a page number is carried', hit.results.length > 0 && hit.results[0].page >= 1);

  const miss = orgKb.searchOrgKb(ACME, 'zebra crossing marsupial', 5);
  check('an unrelated query matches nothing', miss.available && miss.results.length === 0);

  // ----------------------------------------------------------- isolation
  console.log('\nOne customer cannot read another\'s documentation');
  const rival = orgKb.searchOrgKb(RIVAL, 'card reader authentication port', 5);
  check('a different org finds nothing', !rival.available || rival.results.length === 0,
    `${rival.results.length} result(s) leaked`);
  check('a different org lists nothing', orgKb.listDocuments(RIVAL).length === 0);

  // The customer id builds a filesystem path, so the property to pin is that
  // it cannot ESCAPE the org-kb root. Note what it deliberately does NOT do:
  // "../acme-mfg" slugifies down to "acme-mfg" rather than being rejected, so a
  // crafted id lands on that org's slug — which is safe because reaching it
  // still needs that org's admin token, and the route slugifies with the same
  // function it authorises with. Authorisation is by token, never by string.
  const root = path.join(process.env.RESOLVE_DATA_DIR, 'org-kb');
  const escaped = await orgKb.addDocument('../../../escape-attempt', {
    title: 'Escape', encoding: 'text', data: MANUAL,
  });
  const strayAbove = fs.existsSync(path.join(root, '..', 'escape-attempt'))
    || fs.existsSync(path.join(root, '..', '..', 'escape-attempt'));
  check('a traversal id cannot write outside the org-kb root', !strayAbove);
  check('and lands on a plain slug inside it', !escaped.ok
    || fs.existsSync(path.join(root, 'escape-attempt')), 'escaped the root');

  // An id that slugifies away to nothing must fail closed, not fall back to a
  // shared directory that every such caller would then read and write.
  const emptyId = orgKb.searchOrgKb('...', 'card reader', 5);
  check('an id that slugifies to nothing reaches nothing', !emptyId.available || emptyId.results.length === 0);

  // --------------------------------------------------------- bad uploads
  console.log('\nUploads that should be refused');
  const noTitle = await orgKb.addDocument(ACME, { title: '  ', encoding: 'text', data: MANUAL });
  check('an untitled document is refused', !noTitle.ok, noTitle.error);

  const empty = await orgKb.addDocument(ACME, { title: 'Scanned brochure', encoding: 'text', data: '   ' });
  check('a document with no readable text is refused', !empty.ok);
  // The overwhelmingly common cause is a scanned PDF, and an admin who is told
  // "invalid input" will conclude the feature is broken rather than run OCR.
  check('and the reason mentions OCR', !empty.ok && /ocr/i.test(empty.error || ''), empty.error);

  const badEnc = await orgKb.addDocument(ACME, { title: 'Odd file', encoding: 'docx-base64', data: 'AAAA' });
  check('an unsupported format is refused', !badEnc.ok, badEnc.error);

  // ------------------------------------------------------------- removal
  console.log('\nRemoving it');
  const gone = orgKb.removeDocument(ACME, docs[0].docId);
  check('removal succeeds', gone.ok, gone.error);
  check('it stops being searchable at once',
    orgKb.searchOrgKb(ACME, 'card reader authentication port', 5).results.length === 0);
  check('storage is released', orgKb.usage(ACME).textBytes === 0);
  check('removing it twice is refused, not silent', !orgKb.removeDocument(ACME, docs[0].docId).ok);

  console.log('');
  if (failures) { console.error(`${failures} check(s) failed.`); process.exit(1); }
  console.log('All customer-documentation checks passed.');
})();
