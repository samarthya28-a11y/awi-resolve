#!/usr/bin/env node
// What is the most expensive single ticket Resolve can produce?
//
//   node tools/worst-case-ticket.js
//   node tools/worst-case-ticket.js --usd 88
//
// Average cost is the number that decides whether the business works. WORST
// case is the number that decides whether one customer can hurt you — and a
// prepaid ticket sold at a fixed price is a promise to absorb whatever that
// session costs.
//
// Every figure below is read from the real constants, not estimated, so this
// stays honest when the constants change. Where a token count has to be
// assumed (characters per token, size of the static prompt) the assumption is
// printed alongside the result.

const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const USD_INR = arg('usd', 88);

// ---- read the real limits out of the source ------------------------------
const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'ai.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'server.js'), 'utf8');
const num = (src, re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not read ${label} from source — this script is out of date`);
  return Number(m[1]);
};

const MAX_STEPS      = num(aiSrc,  /const MAX_STEPS = (\d+)/, 'MAX_STEPS');
const MAX_STEPS_FULL = num(aiSrc,  /const MAX_STEPS_FULL = (\d+)/, 'MAX_STEPS_FULL');
const TOOL_CAP       = num(aiSrc,  /const TOOL_RESULT_CAP = (\d+)/, 'TOOL_RESULT_CAP');
const MAX_OUT        = num(aiSrc,  /max_tokens: (\d+)/, 'max_tokens');
const MAX_TURNS      = num(srvSrc, /const MAX_TURNS_PER_TICKET = (\d+)/, 'MAX_TURNS_PER_TICKET');
const MANUAL_CHARS   = num(srvSrc, /text: String\(msg\.text \|\| ''\)\.slice\(0, (\d+)\)/, 'manual char cap');
const MAX_IMAGES     = num(srvSrc, /list\.length < (\d+)/, 'images per message');

const PRICES = {
  opus:  { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  haiku: { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
};

// ---- assumptions, stated -------------------------------------------------
const CHARS_PER_TOKEN = 4;      // English prose; technical text runs a little denser
const STATIC_PROMPT   = 12000;  // system prompt + 32 tool schemas, cached
const IMAGE_TOKENS    = 1600;   // a large screenshot, per Anthropic's sizing
const TICKET_PRICE    = 69;     // mid bundle rate, rupees

// Output per step, and tool-result size, are the two assumptions that decide
// whether this model is useful or merely frightening.
//
// Charging every step at the 4096-token output cap produced a figure ~10x the
// only session actually measured ($0.0204 for six steps). Models are supposed
// to be checked against reality, so these are the OBSERVED values, and the caps
// are modelled separately as a ceiling rather than as the expected case.
const TYPICAL_OUTPUT = 400;   // measured: 612 output tokens across 6 steps
const TYPICAL_TOOL   = 900;   // most tool results are small; 3000 is the cap

// The real ceiling nobody wrote down: the model's context window. A
// conversation cannot grow past it — the API rejects the call — so the runaway
// scenarios do not bill a fortune, they FAIL. That is a bad customer
// experience and a support call, but it is not an unbounded invoice, and
// confusing the two would misprice the risk badly.
const CONTEXT_WINDOW = 200000;

const manualTokens = Math.round(MANUAL_CHARS / CHARS_PER_TOKEN);
const toolTokens = Math.round(TOOL_CAP / CHARS_PER_TOKEN);

/**
 * Cost of one ticket under a given scenario.
 *
 * Models the loop as it actually runs: one API call per step, each carrying the
 * whole conversation so far. Cached content is charged at the cache-read rate
 * after its first appearance, which is what makes long sessions survivable.
 */
function ticketCost({
  model, steps, turns, manualsPerTurn = 0, imagesPerTurn = 0,
  outPerStep = TYPICAL_OUTPUT, toolPerStep = TYPICAL_TOOL,
}) {
  const p = PRICES[model];
  let usd = 0;
  let context = STATIC_PROMPT;      // tokens resident in the conversation
  let cacheWritten = 0;             // tokens already paid for at the write rate

  for (let turn = 0; turn < turns; turn++) {
    // New material arriving with this message.
    const fresh = manualsPerTurn * manualTokens + imagesPerTurn * IMAGE_TOKENS + 500;
    context += fresh;

    for (let step = 0; step < steps; step++) {
      // Past the window the API refuses the call. No further tokens are billed:
      // the session fails instead, which is a support problem rather than a
      // financial one.
      if (context > CONTEXT_WINDOW) {
        return { usd, contextEnd: context, failedAt: { turn: turn + 1, step: step + 1 } };
      }
      const toWrite = Math.max(0, context - cacheWritten);
      usd += (toWrite / 1e6) * p.cacheWrite;         // first sight of new context
      usd += (cacheWritten / 1e6) * p.cacheRead;     // everything already cached
      cacheWritten = context;

      usd += (outPerStep / 1e6) * p.output;

      // The reply and the tool result join the conversation and stay there.
      context += toolPerStep + outPerStep;
    }
  }
  return { usd, contextEnd: context, failedAt: null };
}

/**
 * Check the model against the one session actually measured before trusting
 * anything it says. A cost model that cannot reproduce a known result is a
 * source of confident wrong numbers.
 */
function calibrate() {
  const observedUsd = 0.0204;   // Haiku, 6 steps, from a real session report
  const modelled = ticketCost({ model: 'haiku', steps: 6, turns: 1 }).usd;
  const ratio = modelled / observedUsd;
  return { observedUsd, modelled, ratio };
}

const inr = (usd) => usd * USD_INR;
const money = (usd) => `$${usd.toFixed(2)} (₹${inr(usd).toFixed(0)})`;

console.log('');
console.log('Limits read from the source');
console.log('  messages per ticket        : ' + MAX_TURNS);
console.log('  steps per message          : ' + MAX_STEPS + ' (' + MAX_STEPS_FULL + ' on Full IT Support)');
console.log('  output cap per step        : ' + MAX_OUT + ' tokens');
console.log('  tool result cap            : ' + TOOL_CAP + ' chars (~' + toolTokens + ' tokens)');
console.log('  manual cap                 : ' + MANUAL_CHARS.toLocaleString() + ' chars (~' + manualTokens.toLocaleString() + ' tokens) EACH, no limit on how many');
console.log('  images per message         : ' + MAX_IMAGES);
console.log('');
console.log('Assumptions');
console.log('  chars per token ' + CHARS_PER_TOKEN + ' · static prompt ' + STATIC_PROMPT + ' tokens · image ' + IMAGE_TOKENS + ' tokens · $1 = ₹' + USD_INR);
console.log('');

const cal = calibrate();
console.log('Calibration against the one session actually measured');
console.log('  observed  $' + cal.observedUsd.toFixed(4) + '   modelled  $' + cal.modelled.toFixed(4)
  + '   ratio ' + cal.ratio.toFixed(2) + 'x');
console.log(Math.abs(cal.ratio - 1) < 0.5
  ? '  within half an order of magnitude — the model is usable.'
  : '  OUT BY MORE THAN 50% — treat every figure below with suspicion.');
console.log('');

const scenarios = [
  { name: 'Typical — routed to Haiku, one short exchange',
    o: { model: 'haiku', steps: 6, turns: 1 } },
  { name: 'Busy but ordinary — Opus, all 5 messages',
    o: { model: 'opus', steps: 8, turns: 5 } },
  { name: 'Heavy — Opus, max steps, a screenshot each message',
    o: { model: 'opus', steps: MAX_STEPS, turns: MAX_TURNS, imagesPerTurn: 1 } },
  { name: 'Worst realistic — Full IT Support, one big manual, 4 images',
    o: { model: 'opus', steps: MAX_STEPS_FULL, turns: MAX_TURNS, manualsPerTurn: 1, imagesPerTurn: MAX_IMAGES } },
  { name: 'Worst possible — 5 manuals a message, every cap maxed',
    o: { model: 'opus', steps: MAX_STEPS_FULL, turns: MAX_TURNS, manualsPerTurn: 5,
         imagesPerTurn: MAX_IMAGES, outPerStep: MAX_OUT, toolPerStep: toolTokens } },
];

console.log('Cost of ONE ticket');
for (const s of scenarios) {
  const r = ticketCost(s.o);
  const margin = TICKET_PRICE - inr(r.usd);
  const verdict = margin >= 0 ? `+₹${margin.toFixed(0)}` : `LOSS ₹${Math.abs(margin).toFixed(0)}`;
  console.log('');
  console.log('  ' + s.name);
  console.log('    cost ' + money(r.usd).padEnd(22) + 'vs ₹' + TICKET_PRICE + ' ticket → ' + verdict);
  console.log('    final context ~' + Math.round(r.contextEnd / 1000) + 'k tokens');
  if (r.failedAt) {
    console.log('    STOPS at message ' + r.failedAt.turn + ', step ' + r.failedAt.step
      + ' — context window exceeded, the session fails rather than billing further');
  }
}

console.log('');
console.log('The shape of the expensive ticket');
console.log('  Full IT Support licence (28 steps, not 16), a symptom vague enough to route to');
console.log('  Opus, a large PDF manual attached, screenshots each message, and the customer');
console.log('  using all ' + MAX_TURNS + ' messages. In practice: "install this software for me" with the');
console.log('  vendor installation guide attached, on the tier that allows PowerShell.');
console.log('');
