'use strict';
// THE BUNDLE'S CELLSEGMENTER POOL RESETS, FORCED ON EVERY CALL -- a TEST-ONLY patch of a
// carved graph (CellSegmenter phase 5, reset invisibility). Nothing under libexec/ may require
// this file, and nothing a product build runs does: test/reset-patch.test.cjs guards that.
//
// WHAT THE RESETS ARE. Upstream 2.1.278's TUI holds its Bun.ant.CellSegmenter behind a wrapper
// class (the carve's `Mf`, a minified name) whose pools only ever grow. The wrapper drops the
// whole segmenter and builds a new one (its `resetNative()`) at two places, each behind a
// threshold stated IN THE BUNDLE (16384 and 2048 in 2.1.278, the carve's `Cf` and `vC`):
//
//   segment entry    X.sgrKeys.length>A||X.uris.length>A||X.graphemes.length>4*A)X.resetNative()
//   generations      X.sgrKeys.length>B)X.resetNative()   (in refreshGenerations, taken only
//                    when the style pool's or chalk's generation changed; else styleIds clear)
//
// A real session never gets near those thresholds, so the reset path -- a fresh segmenter
// from OUR constructor, and the wrapper re-reading its pools and re-interning its graphemes --
// runs in no gate. Native cannot be patched (its constants are inside the Bun binary), so the
// oracle is a quaude built from a carve patched here, judged against an unpatched quaude that
// the session gates already prove identical to native.
//
// THE PATCH sets both thresholds to 0 (RESET_THRESHOLD). Our segmenter's sgrKeys and uris
// start with one reserved entry each (bun-shim.cjs's constructor), so `length>0` holds on every
// call: the wrapper resets before EVERY segment() call, and again whenever the generations
// moved. Nothing else in the source changes.
//
// MATCHED BY STRUCTURE, never by minified name. The receiver and the threshold are captured
// and required to repeat (`\1`, `\2`); what is spelled out is what a minifier keeps: property
// names (sgrKeys, uris, graphemes, resetNative) and the shape of the condition. Each site must
// occur EXACTLY ONCE, or patchResetThresholds() throws naming it: an upstream rename or
// restructure is loud, never a patch that quietly landed nowhere.
//
// THE TALLY (tallyPrelude) is the other half of the test build: a block appended to the
// patched graph's prelude that wraps Bun.ant.CellSegmenter to count constructions and
// segment() calls, and whether each call ran on a segmenter that had never segmented before.
// It changes no result the bundle sees. It is how the gate proves the resets FIRED: a patched
// condition that compiled but never ran would make "invisible" prove nothing.

// RESET_THRESHOLD: what both thresholds become. 0 resets on every call (see above).
const RESET_THRESHOLD = '0';

// Why every reset gate SKIPS on a carve with no consumer, in one spelling (CI asserts on it):
// 2.1.251, the pin until it moves, never constructs a CellSegmenter, so it has nothing to reset.
const NO_CONSUMER = 'the pinned bundle has no CellSegmenter consumer to reset';

// A carve CONSUMES CellSegmenter when its source names it at all. Wider than "constructs
// Bun.ant.CellSegmenter" on purpose: a carve that reaches the class some other way still
// counts, so the reset gates read BROKEN (loud) rather than SKIP when its sites are not found.
const CONSUMER = /\bCellSegmenter\b/;

// The two sites (see the header). Whitespace is allowed where a non-minified carve would
// put it; the minified carve has none.
const SITES = {
  segmentEntry: {
    what: 'the segment-entry reset condition (X.sgrKeys.length>A||X.uris.length>A||'
      + 'X.graphemes.length>4*A, then X.resetNative())',
    re: /([\w$]+)\.sgrKeys\.length\s*>\s*([\w$]+)\s*\|\|\s*\1\.uris\.length\s*>\s*\2\s*\|\|\s*\1\.graphemes\.length\s*>\s*4\s*\*\s*\2\s*\)\s*\1\.resetNative\(\)/g,
  },
  generation: {
    what: 'the refreshGenerations reset condition (X.sgrKeys.length>B, then X.resetNative())',
    re: /([\w$]+)\.sgrKeys\.length\s*>\s*([\w$]+)\s*\)\s*\1\.resetNative\(\)/g,
  },
};
const SITE_NAMES = Object.keys(SITES);

function hasCellSegmenterConsumer(source) {
  return CONSUMER.test(source);
}

function matchesOf(source, site) {
  return [...source.matchAll(new RegExp(SITES[site].re.source, 'g'))];
}

// findResetSites(source) -> { segmentEntry, generation, counts }: each site's text when it
// occurs EXACTLY once, else null; `counts` says how often each occurred (0, 1, or more).
function findResetSites(source) {
  const out = { counts: {} };
  for (const site of SITE_NAMES) {
    const ms = matchesOf(source, site);
    out.counts[site] = ms.length;
    out[site] = ms.length === 1 ? ms[0][0] : null;
  }
  return out;
}

// One site's text with its threshold (the captured `\2`) replaced wherever the condition
// compares against it: `>A` and `>4*A`, never an identifier that merely contains A.
function withThreshold(text, threshold, to) {
  const esc = threshold.replace(/[$]/g, '\\$&');
  return text.replace(new RegExp(`(>\\s*(?:4\\s*\\*\\s*)?)${esc}(?![\\w$])`, 'g'), (m, lead) => lead + to);
}

// patchResetThresholds(source) -> { source, patched, original }: both thresholds set to
// RESET_THRESHOLD. `patched` and `original` are the two sites' texts after and before, in
// SITE_NAMES order. Throws naming every site not found exactly once.
function patchResetThresholds(source) {
  const sites = findResetSites(source);
  const missing = SITE_NAMES.filter((s) => sites.counts[s] !== 1);
  if (missing.length) {
    throw new Error('reset-patch: ' + missing.map((s) => `${SITES[s].what} occurs ${sites.counts[s]} `
      + 'time(s), not exactly once').join('; ') + ' -- upstream renamed or restructured it, so the '
      + 'lowered-threshold build cannot be made; fix the structural match, never skip it');
  }
  let out = source;
  const patched = [], original = [];
  for (const site of SITE_NAMES) {
    const [m] = matchesOf(out, site);
    const text = withThreshold(m[0], m[2], RESET_THRESHOLD);
    out = out.slice(0, m.index) + text + out.slice(m.index + m[0].length);
    patched.push(text);
    original.push(m[0]);
  }
  return { source: out, patched, original };
}

// THE GRAPH: which module of a staged graph (graph.json's { order, sources }) holds the reset
// sites. -> { consumer: false } when no module in the order names CellSegmenter, else
// { consumer: true, module } when exactly one module holds each site exactly once and both
// sit in the same module; throws, naming the counts and modules, otherwise.
function resetModule(doc) {
  const names = doc.order.filter((n) => typeof doc.sources[n] === 'string');
  if (!names.some((n) => hasCellSegmenterConsumer(doc.sources[n]))) return { consumer: false };
  const where = {};
  for (const site of SITE_NAMES) where[site] = [];
  for (const n of names) {
    const c = findResetSites(doc.sources[n]).counts;
    for (const site of SITE_NAMES) for (let i = 0; i < c[site]; i++) where[site].push(n);
  }
  const bad = SITE_NAMES.filter((s) => where[s].length !== 1);
  if (bad.length) {
    throw new Error('reset-patch: the graph consumes CellSegmenter, but '
      + bad.map((s) => `${SITES[s].what} occurs ${where[s].length} time(s)`
        + (where[s].length ? ` (in ${[...new Set(where[s])].join(', ')})` : '')).join('; ')
      + ', not exactly once -- upstream renamed or restructured it');
  }
  if (where.segmentEntry[0] !== where.generation[0]) {
    throw new Error(`reset-patch: the two reset conditions sit in different modules (${where.segmentEntry[0]}, `
      + `${where.generation[0]}); they are one class's methods, so the carve is not the shape this patch knows`);
  }
  return { consumer: true, module: where.segmentEntry[0] };
}

// The tally block for the patched graph's prelude. `dir` is where each process writes
// tally-<pid>.json: { constructed, segments, fresh, retries, stale }, where a segment() call
// is FRESH on a segmenter that never segmented before, a RETRY right after that segmenter
// returned the grow request (a negative count), and STALE otherwise. With the thresholds at 0
// every wrapper call resets first, so a patched run has stale === 0 and fresh > 0.
//
// Written a few ms after the last change rather than on every call (a sync write per
// segment() call would slow the very paints being judged), which lands long before a
// session step settles. A failed write is swallowed: an exception from a timer would take the
// TUI down, and a missing tally is already the gate's finding.
function tallyPrelude(dir) {
  return [
    '// ---- reset-invisibility tally (TEST-ONLY, scripts/lib/reset-patch.cjs; never in a product build) ----',
    '(function () {',
    '  var ant = globalThis.Bun && globalThis.Bun.ant;',
    "  if (!ant || typeof ant.CellSegmenter !== 'function') return;",
    "  var fs = require('fs');",
    `  var file = ${JSON.stringify(dir)} + '/tally-' + process.pid + '.json';`,
    '  var t = { constructed: 0, segments: 0, fresh: 0, retries: 0, stale: 0 };',
    '  var pending = null;',
    '  function flush() { pending = null; try { fs.writeFileSync(file, JSON.stringify(t)); } catch (e) { /* see reset-patch.cjs */ } }',
    '  function dirty() { if (pending === null) pending = setTimeout(flush, 25); }',
    '  var Base = ant.CellSegmenter;',
    '  ant.CellSegmenter = class extends Base {',
    '    constructor(o) { super(o); t.constructed++; this.__tallyCalls = 0; this.__tallyGrow = false; dirty(); }',
    '    segment() {',
    '      t.segments++;',
    '      if (this.__tallyCalls === 0) t.fresh++; else if (this.__tallyGrow) t.retries++; else t.stale++;',
    '      var r = super.segment.apply(this, arguments);',
    '      this.__tallyCalls++; this.__tallyGrow = r < 0;',
    '      dirty();',
    '      return r;',
    '    }',
    '  };',
    '})();',
    '',
  ].join('\n');
}

module.exports = { RESET_THRESHOLD, NO_CONSUMER, SITES, hasCellSegmenterConsumer, findResetSites, patchResetThresholds,
  resetModule, tallyPrelude };
