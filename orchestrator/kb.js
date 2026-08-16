'use strict';
// AWI Resolve — product knowledge base (searchable documentation).
//
// Whole manuals are far too big to put in the AI's context, so documentation is
// ingested into page-tagged chunks (tools/ingest-kb.py) and the AI looks things
// up with the search_knowledge_base tool. It gets short, citable excerpts
// ("Gespage Server v9, p.142") instead of a 200-page book.
//
// Scoring is TF-IDF-ish keyword matching: no embeddings, no extra API cost, no
// network — it runs entirely inside the connector.

const fs = require('fs');
const path = require('path');

const KB_DIR = path.join(__dirname, '..', 'playbooks', 'kb');
const STOP = new Set(('the a an of to in for on is are was were be been and or if it its this that with as at ' +
  'by from how do does can could should would you your i we our my me not no yes please help need want ' +
  'my pc computer laptop system machine it').split(' '));

function tokenize(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
}

function terms(s) {
  return tokenize(s).filter((t) => t.length > 2 && !STOP.has(t));
}

let INDEX = null; // { docs: [...], df: Map(term -> docCount), n }

function loadKb() {
  if (INDEX) return INDEX;
  const docs = [];
  let files = [];
  try {
    files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    INDEX = { docs: [], df: new Map(), n: 0 };
    return INDEX;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(KB_DIR, f), 'utf8'));
      for (const c of d.chunks || []) {
        docs.push({
          docId: d.id, title: d.title, tag: d.tag || '', source: d.source || '',
          page: c.page, text: c.text, tf: null,
        });
      }
    } catch { /* skip malformed file */ }
  }
  // Build term frequencies + document frequencies
  const df = new Map();
  for (const c of docs) {
    const tf = new Map();
    for (const t of terms(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
    // title terms count too, so "Kyocera terminal" finds the Kyocera manual
    for (const t of terms(c.title)) tf.set(t, (tf.get(t) || 0) + 3);
    c.tf = tf;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  INDEX = { docs, df, n: docs.length };
  return INDEX;
}

// Search the knowledge base. Returns the best-matching excerpts.
function searchKb(query, limit = 5) {
  const idx = loadKb();
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
      const idf = Math.log(1 + idx.n / (1 + (idx.df.get(t) || 0)));
      score += (1 + Math.log(f)) * idf;
    }
    if (!hits) continue;
    score *= 1 + hits / qs.length;          // reward covering more of the query
    scored.push({ score, c });
  }
  scored.sort((a, b) => b.score - a.score);

  // At most 2 excerpts from any single document, so results aren't all one manual
  const perDoc = new Map();
  const out = [];
  for (const { score, c } of scored) {
    const used = perDoc.get(c.docId) || 0;
    if (used >= 2) continue;
    perDoc.set(c.docId, used + 1);
    out.push({
      title: c.title, page: c.page, source: c.source, tag: c.tag,
      relevance: +score.toFixed(2),
      excerpt: c.text.length > 1500 ? c.text.slice(0, 1500) + '…' : c.text,
    });
    if (out.length >= limit) break;
  }
  return { available: true, matched: out.length, results: out };
}

function kbStats() {
  const idx = loadKb();
  const byDoc = new Map();
  for (const c of idx.docs) byDoc.set(c.docId, (byDoc.get(c.docId) || 0) + 1);
  return { documents: byDoc.size, chunks: idx.n };
}

// Learned playbooks are written at runtime, so the cached index has to be
// droppable — otherwise a lesson from this morning is invisible until restart.
function invalidateKb() { INDEX = null; }

module.exports = { searchKb, kbStats, loadKb, invalidateKb };
