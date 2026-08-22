'use strict';
// Per-customer product documentation — the knowledge a customer adds themselves.
//
// The shipped knowledge base (playbooks/kb, built by tools/ingest-kb.py) lives
// inside the container image and is the same for everybody. That is right for
// Gespage, which we support for all of them, and useless for the customer whose
// estate runs on something we have never heard of.
//
// This is the other half: documentation an IT admin uploads for THEIR
// organisation, through a web page, without anyone at Alpha Web redeploying
// anything. Three properties make it work:
//
//   1. It lives on the DATA VOLUME, not in the image. The image is replaced on
//      every deploy — anything written beside the code is gone the next time we
//      ship. "Permanent" has to mean permanent, so it goes in RESOLVE_DATA_DIR.
//
//   2. Only the extracted TEXT is kept, never the uploaded file. A 40 MB PDF
//      becomes roughly a megabyte of chunks. The volume also holds ledger.json —
//      a customer filling it with scanned manuals would take out billing for
//      everyone, which is not a trade worth making for storing a file we have
//      already read.
//
//   3. It is PRIVATE to the organisation that uploaded it. Their competitor's
//      installation guide must never surface in somebody else's session, so the
//      customer id is part of the path and every read is scoped by it. Unlike
//      the learned playbooks in learning.js — which are scrubbed precisely so
//      they CAN be shared — nothing here is ever pooled.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath, ensureDir } = require('./paths');
const { terms } = require('./kb');

const ROOT = 'org-kb';

// Chunking, deliberately identical to tools/ingest-kb.py. An excerpt should
// read the same whether it came from a shipped manual or an uploaded one; two
// chunkers would drift and the difference would show up as one source giving
// worse answers than the other for no visible reason.
const CHUNK_CHARS = 1800;      // ~450 tokens: big enough to hold a procedure
const CHUNK_OVERLAP = 250;     // keeps a step from being cut in half
const MIN_CHUNK_CHARS = 120;   // skip near-empty pages (covers, dividers)

// Quotas. The volume is 1 GB and shared with the ledger, so these are sized so
// that a full estate of customers still cannot crowd out billing. 15 MB of
// EXTRACTED TEXT is on the order of seven thousand pages — more manual than any
// real product library — and the raw cap simply stops a huge upload before it
// is parsed rather than after.
const MAX_TEXT_BYTES = 15 * 1024 * 1024;
const MAX_DOCS = 150;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

function orgDir(customerId) {
  const id = slugify(customerId);
  if (!SAFE_ID.test(id)) throw new Error('invalid customer id');
  return dataPath(ROOT, id);
}

function clean(text) {
  return String(text || '')
    .replace(/\0/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Chunk text while remembering which page each chunk came from. */
function chunkPages(pages) {
  const chunks = [];
  let buf = '';
  let bufStartPage = null;
  for (const [pageNo, raw] of pages) {
    const text = clean(raw);
    if (text.length < 20) continue;
    if (bufStartPage === null) bufStartPage = pageNo;
    buf += (buf ? '\n\n' : '') + text;
    while (buf.length >= CHUNK_CHARS) {
      const piece = buf.slice(0, CHUNK_CHARS);
      buf = buf.slice(CHUNK_CHARS - CHUNK_OVERLAP);
      if (piece.trim().length >= MIN_CHUNK_CHARS) {
        chunks.push({ page: bufStartPage, text: piece.trim() });
      }
      bufStartPage = pageNo;
    }
  }
  if (buf.trim().length >= MIN_CHUNK_CHARS) {
    chunks.push({ page: bufStartPage || 1, text: buf.trim() });
  }
  return chunks;
}

/**
 * Pull page-tagged text out of an upload.
 *
 * PDFs go through pdf-parse, which is already a dependency because the agent
 * reads customer attachments with it. Page numbers are collected as it renders,
 * so an excerpt can cite "p.142" rather than pointing vaguely at a document.
 */
async function extractPages({ encoding, data }) {
  if (encoding === 'text') {
    return [[1, String(data || '')]];
  }
  if (encoding === 'pdf-base64') {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new Error('the upload was empty');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(`that file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB`);
    }
    let pdfParse;
    try {
      pdfParse = require('pdf-parse');
    } catch {
      throw new Error('PDF support is not installed on this service — upload a .txt or .md copy instead');
    }
    const pages = [];
    await pdfParse(buf, {
      pagerender: async (pageData) => {
        const tc = await pageData.getTextContent();
        const text = (tc.items || []).map((i) => i.str).join(' ');
        pages.push([pages.length + 1, text]);
        return text;
      },
    });
    return pages;
  }
  throw new Error(`unsupported encoding "${encoding}"`);
}

function docPath(customerId, docId) {
  if (!SAFE_ID.test(docId)) throw new Error('invalid document id');
  return path.join(orgDir(customerId), `${docId}.json`);
}

function readDoc(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listFiles(customerId) {
  try {
    return fs.readdirSync(orgDir(customerId)).filter((f) => f.endsWith('.json'));
  } catch { return []; }
}

/** Everything this organisation has uploaded, newest first. */
function listDocuments(customerId) {
  const out = [];
  for (const f of listFiles(customerId)) {
    const d = readDoc(path.join(orgDir(customerId), f));
    if (!d) continue;
    out.push({
      docId: d.id, title: d.title, tag: d.tag || '',
      pages: d.pages || 0, chunks: (d.chunks || []).length,
      textBytes: d.textBytes || 0, addedAt: d.addedAt, addedBy: d.addedBy || 'it-admin',
    });
  }
  return out.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

function usage(customerId) {
  const docs = listDocuments(customerId);
  const textBytes = docs.reduce((n, d) => n + (d.textBytes || 0), 0);
  return {
    documents: docs.length,
    chunks: docs.reduce((n, d) => n + d.chunks, 0),
    textBytes,
    maxTextBytes: MAX_TEXT_BYTES,
    maxDocuments: MAX_DOCS,
    percentUsed: +((textBytes / MAX_TEXT_BYTES) * 100).toFixed(1),
  };
}

// Per-customer search index, cached and dropped on write. Rebuilt lazily, so a
// document uploaded thirty seconds ago is searchable in the next session
// without restarting anything.
const CACHE = new Map(); // customerId -> { docs, df, n }

function invalidate(customerId) { CACHE.delete(slugify(customerId)); }

function loadIndex(customerId) {
  const id = slugify(customerId);
  if (CACHE.has(id)) return CACHE.get(id);
  const docs = [];
  for (const f of listFiles(id)) {
    const d = readDoc(path.join(orgDir(id), f));
    if (!d) continue;
    for (const c of d.chunks || []) {
      docs.push({ docId: d.id, title: d.title, tag: d.tag || '', page: c.page, text: c.text, tf: null });
    }
  }
  const df = new Map();
  for (const c of docs) {
    const tf = new Map();
    for (const t of terms(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
    // Title terms weigh more, so "the Kyocera terminal guide" finds the guide.
    for (const t of terms(c.title)) tf.set(t, (tf.get(t) || 0) + 3);
    c.tf = tf;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idx = { docs, df, n: docs.length };
  CACHE.set(id, idx);
  return idx;
}

/**
 * Search one organisation's own documentation.
 *
 * Same TF-IDF-ish scoring as the shipped knowledge base, and same cap of two
 * excerpts per document so one long manual cannot fill the whole answer.
 */
function searchOrgKb(customerId, query, limit = 5) {
  if (!customerId) return { available: false, results: [] };
  let idx;
  try { idx = loadIndex(customerId); } catch { return { available: false, results: [] }; }
  if (!idx.n) return { available: false, results: [] };
  const qs = terms(query);
  if (!qs.length) return { available: true, results: [] };

  const scored = [];
  for (const c of idx.docs) {
    let score = 0, hits = 0;
    for (const t of qs) {
      const f = c.tf.get(t);
      if (!f) continue;
      hits++;
      score += (1 + Math.log(f)) * Math.log(1 + idx.n / (1 + (idx.df.get(t) || 0)));
    }
    if (!hits) continue;
    score *= 1 + hits / qs.length;
    scored.push({ score, c });
  }
  scored.sort((a, b) => b.score - a.score);

  const perDoc = new Map();
  const out = [];
  for (const { score, c } of scored) {
    const used = perDoc.get(c.docId) || 0;
    if (used >= 2) continue;
    perDoc.set(c.docId, used + 1);
    out.push({
      title: c.title, page: c.page, tag: c.tag,
      // Named so the AI can tell the customer where the answer came from. "Your
      // own documentation" is a materially different claim from "the Gespage
      // manual", and the customer is entitled to know which they are getting.
      source: 'your organisation\'s documentation',
      relevance: +score.toFixed(2),
      excerpt: c.text.length > 1500 ? `${c.text.slice(0, 1500)}…` : c.text,
    });
    if (out.length >= limit) break;
  }
  return { available: true, matched: out.length, results: out };
}

/**
 * Ingest a document for one organisation.
 *
 * Returns { ok, doc } or { ok:false, error }. Errors are messages an IT admin
 * can act on, because this runs behind a web form and "invalid input" tells
 * them nothing about which of their files was the problem.
 */
async function addDocument(customerId, { title, tag, encoding, data, addedBy = 'it-admin' } = {}) {
  const name = String(title || '').trim();
  if (!name) return { ok: false, error: 'give the document a title' };
  if (name.length > 200) return { ok: false, error: 'that title is too long (200 characters max)' };

  const before = usage(customerId);
  if (before.documents >= MAX_DOCS) {
    return { ok: false, error: `this organisation already has ${MAX_DOCS} documents — remove one first` };
  }

  let pages;
  try {
    pages = await extractPages({ encoding, data });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const chunks = chunkPages(pages);
  if (!chunks.length) {
    // Overwhelmingly this is a scanned PDF: pages of images with no text layer.
    // Saying so is the difference between the admin running it through OCR and
    // them concluding the feature is broken.
    return { ok: false, error: 'no readable text was found. If this is a scanned PDF it has no text layer — run it through OCR, or upload a text copy' };
  }

  const textBytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0);
  if (before.textBytes + textBytes > MAX_TEXT_BYTES) {
    const mb = (n) => (n / 1048576).toFixed(1);
    return { ok: false, error:
      `that would take this organisation to ${mb(before.textBytes + textBytes)} MB of documentation, over the ${mb(MAX_TEXT_BYTES)} MB limit — remove something first` };
  }

  const base = slugify(name) || 'document';
  const id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  const doc = {
    id,
    title: name,
    tag: slugify(tag || ''),
    source: 'uploaded by the customer',
    customerId: slugify(customerId),
    addedAt: new Date().toISOString(),
    addedBy,
    pages: pages.length,
    textBytes,
    chunkCount: chunks.length,
    chunks,
  };

  ensureDir(orgDir(customerId));
  fs.writeFileSync(docPath(customerId, id), JSON.stringify(doc));
  invalidate(customerId);
  return { ok: true, doc: {
    docId: id, title: doc.title, tag: doc.tag, pages: doc.pages,
    chunks: chunks.length, textBytes, addedAt: doc.addedAt, addedBy,
  } };
}

function removeDocument(customerId, docId) {
  let file;
  try { file = docPath(customerId, String(docId || '')); }
  catch { return { ok: false, error: 'unknown document' }; }
  if (!fs.existsSync(file)) return { ok: false, error: 'unknown document' };
  fs.unlinkSync(file);
  invalidate(customerId);
  return { ok: true };
}

/** Titles the AI can be told about up front, so it knows what it may look in. */
function documentTitles(customerId) {
  return listDocuments(customerId).map((d) => d.title);
}

module.exports = {
  addDocument, removeDocument, listDocuments, documentTitles,
  searchOrgKb, usage, invalidate, chunkPages,
  MAX_TEXT_BYTES, MAX_DOCS, MAX_UPLOAD_BYTES,
};
