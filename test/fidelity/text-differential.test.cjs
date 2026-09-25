'use strict';
// Ours vs NATIVE Bun, per consumer, exact equality. The four text consumers the bundle
// calls, each against the native it stands in for:
//   text-diff-segmenter    Bun.ant.CellSegmenter's cells (grapheme text, advance, tab bit,
//                          and the style the caller PAINTS: the run's SGR keys through the
//                          bundle's own ansiCodes()/SC filter, close codes included)
//   text-diff-stringwidth  Bun.stringWidth, both ambiguousIsNarrow settings
//   text-diff-intl         Intl.Segmenter's grapheme segments
//   text-diff-sliceansi    Bun.sliceAnsi, eleven cuts of each string in columns: the edges
//                          of its first cluster, both negative forms, the whole string, and
//                          the string inside a bold run, an OSC-8 link and before an escape
//                          (scripts/lib/text-probe.cjs says which)
// Ours is bun-shim + the node-shim Intl polyfill under tjs, so the shipped code is what is
// judged; native runs the SAME probe program (scripts/lib/text-probe.cjs) inside native
// Claude's own Bun through scripts/lib/native-oracle.cjs (BUN_OPTIONS --preload).
//
// THE CORPUS, and why each part is in it:
//   every code point (0x110000, lone surrogates included)     -- the floor
//   corpusComposed    the multi-code-point cases the plan named
//   corpusCellProbes  task 4b's bun-cell probes: every measured clustering/width delta,
//                     and clusters wider than the cell's 8-bit advance (255 saturation)
//   corpusEscapes     the escape layer both native consumers put in front of the
//                     clusterer: every parser state x every two-token continuation, and
//                     clusters that span an escape. Without it the differential could not
//                     judge the layer at all.
//   corpusSliceProbes Bun.sliceAnsi's own rules: SGR and OSC 8 variety around a cut, a
//                     1-wide Prepend before each control, its scan horizon. Without it that
//                     gate stayed green with several of those rules switched off.
//   emoji-test        every sequence in the pinned emoji-test.txt
//   bundle literals   the carved bundle's own non-ASCII snippets, when CLODE_PROVIDER_BIN
//                     names a provider (CI's provider-min carves; it need not run)
//
// WHEN IT RUNS. Only against the native the tables were generated from (ruling R11): a
// different Bun is a different oracle, not a failure of ours, so any other version SKIPS
// and names both. The native is resolveNativeOracle() (ruling R1): CLODE_NATIVE_ORACLE,
// else the frame gate's resolver. emoji-test is a pinned UCD input; offline with a cold
// cache (test/run.mjs is offline by default) the gate SKIPS naming the file (ruling R17)
// rather than pass on part of its corpus.
const { before } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('../guard.cjs');
const { resolveNativeOracle, nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const { runNative, runOurs, compareTextResults } = require('../../scripts/lib/text-probe.cjs');
const C = require('../../scripts/lib/text-corpus.cjs');
const ucd = require('../../scripts/lib/ucd.cjs');
const { clodeCacheDir } = require('../../libexec/clode-paths.cjs');
const { UNICODE_DATA } = require('../../libexec/unicode-text.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS_FLOOR = 0x110000;   // every code point, at minimum

let SKIP = null, STRINGS = null, NATIVE = null, OURS = null, WHAT = '';

// The carved bundle's non-ASCII literals, or [] when no provider is at hand (named in WHAT).
function bundleLiterals() {
  const prov = process.env.CLODE_PROVIDER_BIN;
  if (!prov || !fs.existsSync(prov)) return { strings: [], why: 'no CLODE_PROVIDER_BIN' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-diff-carve-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const r = spawnSync(process.execPath, [path.join(REPO, 'libexec', 'extract-claude-js.cjs'), prov, cli], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not carve ${prov}: ${(r.stderr || '').slice(0, 400)}`);
    return { strings: C.corpusBundleLiterals(fs.readFileSync(cli, 'utf8')), why: prov };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

before(async () => {
  if (!tjsPath()) { SKIP = 'no tjs engine (set CLODE_TJS): ours runs under the engine quaude ships'; return; }
  const want = UNICODE_DATA.header.nativeClaude;
  const bin = resolveNativeOracle();
  if (!bin) { SKIP = `no native claude; libexec/unicode-text.cjs was generated from ${want} (set CLODE_NATIVE_ORACLE)`; return; }
  const v = nativeVersion(bin);
  if (v !== want) {
    SKIP = `native is ${JSON.stringify(v)} but libexec/unicode-text.cjs was generated from ${JSON.stringify(want)}; `
      + 'set CLODE_NATIVE_ORACLE to that version';
    return;
  }
  const ver = UNICODE_DATA.header.unicode;
  let emoji;
  try {
    emoji = await ucd.fetchVerified(ver, 'emoji-test', {
      cacheDir: path.join(clodeCacheDir(process.env), 'unicode'), offline: process.env.CLODE_OFFLINE === '1' });
  } catch (e) {
    if (!(e instanceof ucd.UcdOfflineMiss)) throw e;
    SKIP = `emoji-test ${ver} not cached and this run is offline — ${e.message}`;
    return;
  }
  const parts = [
    ['code points', C.corpusCodePoints()], ['composed', C.corpusComposed()], ['cell probes', C.corpusCellProbes()],
    ['escapes', C.corpusEscapes()], ['slice probes', C.corpusSliceProbes()], ['emoji-test', C.corpusEmojiTest(emoji)],
  ];
  const lit = bundleLiterals();
  parts.push([`bundle literals (${lit.why})`, lit.strings]);
  STRINGS = [].concat(...parts.map(([, s]) => s));
  WHAT = `${v} vs ours under tjs; ${parts.map(([n, s]) => `${s.length} ${n}`).join(', ')}`;
  const wants = { segmenter: true, stringWidth: true, intl: true, sliceAnsi: true };
  NATIVE = runNative(bin, STRINGS, wants);
  OURS = runOurs(STRINGS, wants);
});

// One guard per consumer: the four share their read/scan/control shapes, differing only in
// which of the probe's answers they judge. Four literal calls to defineGuard, one per
// guard, because test/guards-population.cjs counts guards by their call sites.
const judge = (key) => ({
  floor: CORPUS_FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    if (!NATIVE[key]) return { skip: `native (${NATIVE.runtime}) has no ${key} to compare against` };
    return { strings: STRINGS, native: { [key]: NATIVE[key] }, ours: { [key]: OURS[key] }, what: WHAT };
  },
  scan({ strings, native, ours, what }) {
    const d = compareTextResults(strings, native, ours);
    return { examined: d.examined, findings: d.findings, note: `${what}; ${d.counts[key]} differ` };
  },
  // One string of the floor-sized corpus differs, in the shape this consumer reports.
  control() {
    const strings = new Array(CORPUS_FLOOR).fill('a');
    const SHAPES = {
      segmenter: [[['a', 1, 0, []]], [['a', 1, 0, [['\x1b[1m', '\x1b[22m']]]]], stringWidth: [[1, 1], [2, 2]], intl: [['a'], ['', 'a']],
      sliceAnsi: [['a', '', '\x1b[1ma\x1b[22m'], ['a', 'a', '\x1b[1ma\x1b[22m']],
    };
    const [one, bad] = SHAPES[key];
    const nat = new Array(CORPUS_FLOOR).fill(one); const ours = nat.slice(); ours[97] = bad;
    return { strings, native: { [key]: nat }, ours: { [key]: ours }, what: 'synthetic control' };
  },
});

guardTests(defineGuard({ name: 'text-diff-segmenter', ...judge('segmenter') }));
guardTests(defineGuard({ name: 'text-diff-stringwidth', ...judge('stringWidth') }));
guardTests(defineGuard({ name: 'text-diff-intl', ...judge('intl') }));
guardTests(defineGuard({ name: 'text-diff-sliceansi', ...judge('sliceAnsi') }));
