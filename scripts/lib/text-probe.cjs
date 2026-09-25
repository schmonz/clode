'use strict';
// The ONE program both sides run. Native runs it inside Bun (runInNative); ours runs it
// under tjs with bun-shim loaded. Same source, so a difference is a difference in the
// runtime, never in how the two were asked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInNative } = require('./native-oracle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const BATCH = 20000;

// `input` = { strings, wants, side }. The screen options are the bundle's own vs() options.
//
// Controller ruling R4 (phase-3 task 2): the runtime label comes from the CALLER
// (`input.side`), never from `process.versions.bun` — bun-shim may define that too, which
// would mislabel our tjs side as "bun" and defeat the whole point of a differential.
const PROBE_SOURCE = String.raw`
  const { strings, wants, side } = input;
  const out = { runtime: side === 'native' ? 'bun ' + Bun.version : 'shim',
    segmenter: null, stringWidth: null, intl: null, sliceAnsi: null };
  if (wants.segmenter && typeof (Bun.ant && Bun.ant.CellSegmenter) === 'function') {
    const n = new Bun.ant.CellSegmenter({ ambiguousIsNarrow: true,
      substitute: [[1564, 1564], [8234, 8238], [8294, 8297]],
      screen: { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
        emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 } });
    // Each cell's STYLE as the caller sees it, through the bundle's own ansiCodes(): run
    // index 0 is no style; otherwise the run's sgrKeys entry split on NUL, each open code
    // kept only when it passes the bundle's SC regex, paired with its sgrCloseKeys close
    // code (which the caller compares by identity). So a key SC drops is judged as the
    // caller judges it — invisible — and one that changes what is PAINTED is a difference.
    const SC = /^\x1b\[(?:\d{1,3})(?:;5;\d{1,3}|;2;\d{1,3};\d{1,3};\d{1,3})?m$/;
    const ansiCodes = (k) => {
      if (k === 0) return [];
      const s = n.sgrKeys[k].split('\x00'), u = n.sgrCloseKeys[k].split('\x00'), f = [];
      for (let m = 0; m < s.length; m++) if (SC.test(s[m])) f.push([s[m], u[m]]);
      return f;
    };
    // Each cell's HYPERLINK as the caller reads it, through the bundle's own runWords(): the
    // run's uris index, 0 being no link (it interns nothing), otherwise the uris entry it
    // interns into its hyperlinkPool. '' is no link. The index itself is not compared: the
    // caller never keeps one, only the target behind it.
    const linkOf = (p) => (p === 0 ? '' : n.uris[p]);
    let cells = new Int32Array(4096), runs = new Int32Array(4096);
    out.segmenter = strings.map((s) => {
      let c = n.segment(s, cells, runs, false);
      if (c < 0) { const f = Math.max(-c, cells.length); cells = new Int32Array(2 * f); runs = new Int32Array(2 * f); c = n.segment(s, cells, runs, false); }
      const row = [];
      for (let i = 0; i < c; i++) {
        const w = cells[2 * i + 1];
        row.push([n.graphemes[cells[2 * i]], w & 255, (w & 256) ? 1 : 0, ansiCodes(runs[2 * (w >> 10)]), linkOf(runs[2 * (w >> 10) + 1])]);
      }
      return row;
    });
  }
  if (wants.stringWidth) out.stringWidth = strings.map((s) => [
    Bun.stringWidth(s, { ambiguousIsNarrow: true }), Bun.stringWidth(s, { ambiguousIsNarrow: false })]);
  if (wants.intl) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    out.intl = strings.map((s) => Array.from(seg.segment(s), (x) => x.segment));
  }
  // Eleven cuts of each string, in COLUMNS (Ink's truncation passes columns): the edges of the
  // first cluster (a wide one, an emoji sequence, an escape the string begins with), both
  // negative forms (they count back from the total width), the whole string (0 to the end:
  // native returns it untouched), and the string inside a bold run, inside an OSC-8 link, and
  // before an escape and a plain run, each cut so the slice starts or ends inside the run.
  // Availability-checked like the segmenter (task 8, R32): a native without Bun.sliceAnsi
  // reports null (not compared) rather than failing the whole meter. Measured 2026-09-25:
  // 2.1.251 (Bun 1.4.1) and 2.1.278 (Bun 1.4.3) both have it; only the bundle is new to it.
  if (wants.sliceAnsi && typeof Bun.sliceAnsi === 'function') {
    const E = '\x1b';
    out.sliceAnsi = strings.map((s) => {
      const bold = E + '[1m' + s + 'x' + E + '[22m';
      const link = 'a' + E + ']8;;u\x07' + s + E + ']8;;\x07b';
      const tail = s + E + '[31mab' + E + '[39m';
      return [Bun.sliceAnsi(s, 0, 1), Bun.sliceAnsi(s, 1), Bun.sliceAnsi(s, 1, 2), Bun.sliceAnsi(s, 0, -1), Bun.sliceAnsi(s, -1), Bun.sliceAnsi(s, 0),
        Bun.sliceAnsi(bold, 0, 2), Bun.sliceAnsi(bold, 1), Bun.sliceAnsi(link, 1, 3), Bun.sliceAnsi(link, 2), Bun.sliceAnsi(tail, 1, 3)];
    });
  }
  return out;
`;

// The consumers the probe can answer for, in the order every comparison reports them.
const KEYS = ['segmenter', 'stringWidth', 'intl', 'sliceAnsi'];

function merge(parts) {
  const out = { runtime: parts[0].runtime };
  for (const k of KEYS) {
    out[k] = null;
    if (parts.every((p) => p[k])) out[k] = [].concat(...parts.map((p) => p[k]));
  }
  return out;
}

function batches(strings) {
  const b = [];
  for (let i = 0; i < strings.length; i += BATCH) b.push(strings.slice(i, i + BATCH));
  return b;
}

function runNative(bin, strings, wants) {
  if (strings.length === 0) throw new Error('empty corpus: nothing to compare');
  return merge(batches(strings).map((s) => runInNative(bin, PROBE_SOURCE, { input: { strings: s, wants, side: 'native' } })));
}

// JSON with every non-ASCII UTF-16 unit written as an escape, so the file is pure ASCII.
// The tjs side must get back EXACTLY the strings Node wrote, and it would not: the engine's
// TextDecoder, under node-shim's fs.readFileSync(f, 'utf8'), drops EVERY U+FEFF it decodes
// (measured 2026-09-24: `a U+FEFF b` read back as `ab`), where Node's fs keeps them all. That
// is what the baseline's one Intl.Segmenter "difference" at U+FEFF was: the instrument, not
// the segmenter.
function asciiJson(v) {
  return JSON.stringify(v).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function runOurs(strings, wants) {
  if (strings.length === 0) throw new Error('empty corpus: nothing to compare');
  const { runLoader } = require(path.join(REPO, 'test', 'node-shim-helper.cjs'));
  const shim = path.join(REPO, 'libexec', 'bun-shim.cjs');
  return merge(batches(strings).map((s) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-probe-'));
    try {
      const inf = path.join(dir, 'in.json'); const outf = path.join(dir, 'out.json'); const prog = path.join(dir, 'p.cjs');
      fs.writeFileSync(inf, asciiJson({ strings: s, wants, side: 'ours' }));
      fs.writeFileSync(prog, `require(${JSON.stringify(shim)});\nconst fs = require('fs');\n`
        + `const input = JSON.parse(fs.readFileSync(${JSON.stringify(inf)}, 'utf8'));\n`
        + `const r = (function (input) {${PROBE_SOURCE}\n})(input);\n`
        + `fs.writeFileSync(${JSON.stringify(outf)}, JSON.stringify(r));\n`);
      // NODE_PATH so bun-shim's npm-backed helpers (string-width, etc.) resolve
      // regardless of the caller's own environment — same fix as test/node-shim-vm.test.cjs,
      // test/node-shim-esm.test.cjs and ~8 other call sites in this repo.
      const r = runLoader(prog, [], { timeout: 600000, env: { NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') } });
      if (r.status !== 0) throw new Error(`our probe failed under tjs (exit ${r.status}): ${r.stderr.slice(0, 800)}`);
      return JSON.parse(fs.readFileSync(outf, 'utf8'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));
}

const hex = (s) => Array.from(s, (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

function compareTextResults(strings, native, ours) {
  const counts = {};
  for (const k of KEYS) counts[k] = null;
  const findings = [];
  let more = 0;
  for (const k of KEYS) {
    if (!native[k]) continue;                      // native lacks it: not compared, and counts says null
    counts[k] = 0;
    for (let i = 0; i < strings.length; i++) {
      const a = JSON.stringify(native[k][i]); const b = JSON.stringify(ours[k] ? ours[k][i] : null);
      if (a === b) continue;
      counts[k]++;
      if (findings.length < 200) findings.push(`${k} ${hex(strings[i])}: native ${a} ours ${b}`);
      else more++;
    }
  }
  if (more) findings.push(`... ${more} more`);
  return { examined: strings.length, findings, counts };
}

module.exports = { PROBE_SOURCE, runNative, runOurs, compareTextResults, asciiJson, BATCH };
