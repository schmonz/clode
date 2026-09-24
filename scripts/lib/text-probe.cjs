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
    segmenter: null, stringWidth: null, intl: null };
  if (wants.segmenter && typeof (Bun.ant && Bun.ant.CellSegmenter) === 'function') {
    const n = new Bun.ant.CellSegmenter({ ambiguousIsNarrow: true,
      substitute: [[1564, 1564], [8234, 8238], [8294, 8297]],
      screen: { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
        emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 } });
    let cells = new Int32Array(4096), runs = new Int32Array(4096);
    out.segmenter = strings.map((s) => {
      let c = n.segment(s, cells, runs, false);
      if (c < 0) { const f = Math.max(-c, cells.length); cells = new Int32Array(2 * f); runs = new Int32Array(2 * f); c = n.segment(s, cells, runs, false); }
      const row = [];
      for (let i = 0; i < c; i++) { const w = cells[2 * i + 1]; row.push([n.graphemes[cells[2 * i]], w & 255, (w & 256) ? 1 : 0]); }
      return row;
    });
  }
  if (wants.stringWidth) out.stringWidth = strings.map((s) => [
    Bun.stringWidth(s, { ambiguousIsNarrow: true }), Bun.stringWidth(s, { ambiguousIsNarrow: false })]);
  if (wants.intl) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    out.intl = strings.map((s) => Array.from(seg.segment(s), (x) => x.segment));
  }
  return out;
`;

function merge(parts) {
  const out = { runtime: parts[0].runtime, segmenter: null, stringWidth: null, intl: null };
  for (const k of ['segmenter', 'stringWidth', 'intl']) {
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

function runOurs(strings, wants) {
  if (strings.length === 0) throw new Error('empty corpus: nothing to compare');
  const { runLoader } = require(path.join(REPO, 'test', 'node-shim-helper.cjs'));
  const shim = path.join(REPO, 'libexec', 'bun-shim.cjs');
  return merge(batches(strings).map((s) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-probe-'));
    try {
      const inf = path.join(dir, 'in.json'); const outf = path.join(dir, 'out.json'); const prog = path.join(dir, 'p.cjs');
      fs.writeFileSync(inf, JSON.stringify({ strings: s, wants, side: 'ours' }));
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
  const counts = { segmenter: null, stringWidth: null, intl: null };
  const findings = [];
  let more = 0;
  for (const k of ['segmenter', 'stringWidth', 'intl']) {
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

module.exports = { PROBE_SOURCE, runNative, runOurs, compareTextResults, BATCH };
