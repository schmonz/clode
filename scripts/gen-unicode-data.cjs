#!/usr/bin/env node
'use strict';
// Generate the GENERATED region of libexec/unicode-text.cjs.
//
// RULES from pinned UCD (the Unicode version native Bun turns out to use); WIDTHS from
// native itself, per code point, under both ambiguous settings. Nothing hand-written.
//
//   node scripts/gen-unicode-data.cjs --pin VERSION                # fill missing sha256 pins (TOFU; review the diff)
//   node scripts/gen-unicode-data.cjs --native BIN                 # regenerate
//   node scripts/gen-unicode-data.cjs --native BIN --check         # exit 1 if regeneration would change the file
//
// Exit status: 0 written / fresh, 1 --check found the region stale, 2 a refusal (an
// unverified input, a native that did not answer, a width shape the table cannot encode),
// 3 offline (CLODE_OFFLINE=1) with a pinned UCD input not yet in the cache.
//
// Plain CommonJS over fs/path/crypto.createHash/child_process.spawnSync only — the APIs
// libexec/node-shim provides — so this runs under tjs as well as Node. Node is only ever
// the oracle HOST, never required.
const fs = require('node:fs');
const path = require('node:path');
const { runInNative, nativeVersion } = require('./lib/native-oracle.cjs');
const ucd = require('./lib/ucd.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'libexec', 'unicode-text.cjs');
const BEGIN = '// BEGIN GENERATED unicode-data';
const END = '// END GENERATED unicode-data';
const CODE_POINTS = 0x110000;
const CHUNK = 0x10000;                   // one native launch per plane: 17 launches
const GCB = { Other: 0, CR: 1, LF: 2, Control: 3, Extend: 4, ZWJ: 5, Regional_Indicator: 6, Prepend: 7, SpacingMark: 8, L: 9, V: 10, T: 11, LV: 12, LVT: 13 };
const INCB = { Linker: 1, Consonant: 2, Extend: 3 };
const GENERATOR_SHA = ucd.sha256Text(fs.readFileSync(__filename, 'utf8'));

// Per-code-point width from native: the CellSegmenter advance of the one-code-point
// string (0 when it produced no cell), under ambiguousIsNarrow true and false. Lone
// surrogates go in as the one UTF-16 unit they are. `substitute: []` so the bidi
// controls report their own width, not U+FFFD's.
const WIDTH_PROBE = String.raw`
  const mk = (amb) => new Bun.ant.CellSegmenter({ ambiguousIsNarrow: amb, substitute: [],
    screen: { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3, emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 } });
  const a = mk(true), b = mk(false);
  const cells = new Int32Array(64), runs = new Int32Array(64);
  const out = [];
  for (let cp = input.lo; cp <= input.hi; cp++) {
    const s = (cp >= 0xd800 && cp <= 0xdfff) ? String.fromCharCode(cp) : String.fromCodePoint(cp);
    const na = a.segment(s, cells, runs, false); const wa = na > 0 ? (cells[1] & 255) : 0;
    const nb = b.segment(s, cells, runs, false); const wb = nb > 0 ? (cells[1] & 255) : 0;
    out.push(wa, wb);
  }
  return { bun: Bun.version, out };
`;

const hexCp = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

function nativeWidths(bin) {
  const narrow = new Uint8Array(CODE_POINTS); const wide = new Uint8Array(CODE_POINTS);
  let bun = '';
  for (let lo = 0; lo < CODE_POINTS; lo += CHUNK) {
    const hi = lo + CHUNK - 1;
    const r = runInNative(bin, WIDTH_PROBE, { input: { lo, hi }, timeoutMs: 600000 });
    // A short answer would leave the rest of the plane at width 0 — a table that looks
    // complete and is not. Refuse instead.
    if (!r || !Array.isArray(r.out) || r.out.length !== 2 * CHUNK) {
      throw new Error(`native answered ${r && Array.isArray(r.out) ? r.out.length : 'nothing'} widths for `
        + `${hexCp(lo)}..${hexCp(hi)}, expected ${2 * CHUNK}; refusing to generate from a partial probe`);
    }
    bun = r.bun;
    for (let i = 0; i < r.out.length; i += 2) { narrow[lo + i / 2] = r.out[i]; wide[lo + i / 2] = r.out[i + 1]; }
  }
  return { narrow, wide, bun };
}

// Run-length encode a per-code-point array into flat [lo, hi, value, ...], keeping only
// the runs whose value `keep` accepts.
function toRanges(arr, keep) {
  const out = [];
  let lo = 0;
  for (let cp = 1; cp <= arr.length; cp++) {
    if (cp === arr.length || arr[cp] !== arr[lo]) {
      if (keep(arr[lo])) out.push(lo, cp - 1, arr[lo]);
      lo = cp;
    }
  }
  return out;
}

// The same for a 0/1 membership array, as flat [lo, hi, ...] (no value column).
function toSpans(arr) { return toRanges(arr, (v) => v !== 0).filter((_, i) => i % 3 !== 2); }

// Controller ruling R5 (phase 3): the table stores ONE width (the ambiguousIsNarrow one)
// plus an "ambiguous" flag meaning "1 when narrow, 2 when wide". A code point whose two
// widths differ any other way cannot be represented, so refuse rather than write a table
// that silently answers 2 for it.
function ambiguousFrom(narrow, wide) {
  const amb = new Uint8Array(narrow.length);
  const bad = [];
  for (let c = 0; c < narrow.length; c++) {
    if (narrow[c] === wide[c]) continue;
    if (narrow[c] === 1 && wide[c] === 2) { amb[c] = 1; continue; }
    bad.push(c);
  }
  if (bad.length) {
    throw new Error(`${bad.length} code point(s) have a narrow/wide width pair the table cannot encode `
      + `(only 1 -> 2 is representable): ${bad.slice(0, 20).map((c) => `${hexCp(c)} narrow ${narrow[c]} wide ${wide[c]}`).join(', ')}`
      + (bad.length > 20 ? `, ... ${bad.length - 20} more` : ''));
  }
  return amb;
}

// Controller ruling R6: "assigned" = covered by an explicit EastAsianWidth.txt line.
// parseRanges skips the `# @missing` default lines, so a code point only a default covers
// (every unassigned CJK plane defaults to W) stays unassigned here.
function eawAssigned(eawText) {
  const a = new Uint8Array(CODE_POINTS);
  for (const [lo, hi] of ucd.parseRanges(eawText)) for (let c = lo; c <= hi; c++) a[c] = 1;
  return a;
}

// UCD's own width prediction, used ONLY to choose the version; the table's widths are
// native's. Ambiguous (A) predicts 1, so it is compared against the ambiguousIsNarrow
// widths; comparing the wide-ambiguous widths would add every A code point to every count.
function eawPredicted(eawText, emojiText) {
  const w = new Uint8Array(CODE_POINTS).fill(1);
  for (const [lo, hi, v] of ucd.parseRanges(eawText)) if (v === 'W' || v === 'F') for (let c = lo; c <= hi; c++) w[c] = 2;
  for (const [lo, hi, v] of ucd.parseRanges(emojiText)) if (v === 'Emoji_Presentation') for (let c = lo; c <= hi; c++) w[c] = 2;
  return w;
}

// Counted over printable code points (>= U+0020) native gives a nonzero width: the
// prediction has no notion of zero width, so a zero-width answer is not a version signal.
function widthDisagreements(pred, nat, assigned) {
  let a = 0; let u = 0;
  const assignedCodePoints = [];
  for (let cp = 0x20; cp < nat.length; cp++) {
    if (nat[cp] === 0 || pred[cp] === nat[cp]) continue;
    if (assigned[cp]) { a++; assignedCodePoints.push(cp); } else u++;
  }
  return { total: a + u, assigned: a, unassigned: u, assignedCodePoints };
}

// Class name -> number, refusing a name the table does not know (a new UCD value would
// otherwise land silently as 0, i.e. Other / no InCB).
function mapValues(ranges, table, what) {
  const arr = new Uint8Array(CODE_POINTS);
  for (const [lo, hi, v] of ranges) {
    if (!Object.prototype.hasOwnProperty.call(table, v)) throw new Error(`${what}: unknown value ${JSON.stringify(v)} at ${hexCp(lo)}; the generator's class table needs it first`);
    for (let c = lo; c <= hi; c++) arr[c] = table[v];
  }
  return arr;
}

// Expand a flat range table back to per-code-point values, so --check can NAME the code
// points a regeneration would move instead of only saying "stale".
// `absent` is the value a code point no range covers: 1 for `width` (only non-1 widths are
// stored), 0 for every other table.
function fromRanges(flat, stride, absent = 0) {
  const arr = new Uint8Array(CODE_POINTS).fill(absent);
  for (let i = 0; i < flat.length; i += stride) for (let c = flat[i]; c <= flat[i + 1]; c++) arr[c] = stride === 3 ? flat[i + 2] : 1;
  return arr;
}

const TABLES = { gcb: [3, 0], incb: [3, 0], extPict: [2, 0], width: [3, 1], ambiguous: [2, 0] };   // [stride, absent]

function describeDrift(was, now) {
  const lines = [];
  if (!was) return ['the current region holds no UNICODE_DATA'];
  if (JSON.stringify(was.header) !== JSON.stringify(now.header)) {
    for (const k of new Set([...Object.keys(was.header || {}), ...Object.keys(now.header)])) {
      const a = JSON.stringify((was.header || {})[k]); const b = JSON.stringify(now.header[k]);
      if (a !== b) lines.push(`header.${k}: ${a} -> ${b}`);
    }
  }
  for (const [name, [stride, absent]] of Object.entries(TABLES)) {
    if (JSON.stringify(was[name]) === JSON.stringify(now[name])) continue;
    const a = fromRanges(was[name] || [], stride, absent); const b = fromRanges(now[name], stride, absent);
    const moved = [];
    for (let c = 0; c < CODE_POINTS; c++) if (a[c] !== b[c]) moved.push(c);
    lines.push(`${name}: ${moved.length} code point(s) change: `
      + moved.slice(0, 20).map((c) => `${hexCp(c)} ${a[c]} -> ${b[c]}`).join(', ') + (moved.length > 20 ? ', ...' : ''));
  }
  if (JSON.stringify(was.overrides) !== JSON.stringify(now.overrides)) lines.push('overrides change');
  return lines;
}

function currentData(src) {
  const a = src.indexOf('const UNICODE_DATA = ');
  if (a < 0) return null;
  const b = src.indexOf(';\n', a);
  try { return JSON.parse(src.slice(a + 'const UNICODE_DATA = '.length, b)); } catch { return null; }
}

async function pinVersion(version, o) {   // TOFU pinning, one version, reviewed in the diff
  const all = ucd.pins();
  if (!all[version]) throw new Error(`no version ${version} in scripts/unicode-inputs.json`);
  for (const [name, pin] of Object.entries(all[version])) {
    if (pin.sha256) continue;
    const dest = path.join(o.cacheDir, version, `${name}.txt`);
    await ucd.download(pin.url, dest, { offline: o.offline });
    pin.sha256 = ucd.sha256Text(fs.readFileSync(dest, 'utf8'));
    process.stdout.write(`pinned ${version}/${name} ${pin.sha256}\n`);
  }
  fs.writeFileSync(ucd.PINS, JSON.stringify(all, null, 2) + '\n');
}

async function main(argv, env = process.env) {
  const o = { cacheDir: path.join(clodeCacheDir(env), 'unicode'), offline: env.CLODE_OFFLINE === '1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--pin') o.pin = argv[++i];
    else if (argv[i] === '--check') o.check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (o.pin) { await pinVersion(o.pin, o); return 0; }
  if (!o.native) throw new Error('usage: gen-unicode-data.cjs --native BIN [--check] | --pin VERSION');

  // Every version's width inputs BEFORE the native probe, so an offline cache miss or an
  // unverified pin refuses at once instead of after 17 native launches.
  const versions = Object.keys(ucd.pins());
  const choice = {};
  for (const ver of versions) {
    choice[ver] = { eaw: await ucd.fetchVerified(ver, 'EastAsianWidth', o), emoji: await ucd.fetchVerified(ver, 'emoji-data', o) };
  }
  const nat = nativeWidths(o.native);

  // Choose the Unicode version whose EAW+Emoji_Presentation prediction disagrees with
  // native's widths the least. Data-driven; no sentinel code points guessed. Measured
  // 2026-09-24 against 2.1.278 (Bun 1.4.3): 15.1.0 382, 16.0.0 184, 17.0.0 27 — and
  // 17.0.0's 27 are the same in every version (the 26 Regional Indicators are 1 alone,
  // U+20E3 COMBINING ENCLOSING KEYCAP is 2 alone), so they say nothing about the version.
  // The counts are recorded in the header, split per controller ruling R6, so a Bun bump
  // that moves them shows up in the freshness gate's diff.
  const counts = {};
  let best = null;
  for (const ver of versions) {
    const { eaw, emoji } = choice[ver];
    const d = widthDisagreements(eawPredicted(eaw, emoji), nat.narrow, eawAssigned(eaw));
    counts[ver] = { total: d.total, assigned: d.assigned, unassigned: d.unassigned };
    process.stdout.write(`unicode ${ver}: ${d.total} width disagreements with native (${d.assigned} assigned, ${d.unassigned} unassigned)\n`);
    if (!best || d.total < best.total) best = { ver, ...d };
  }
  const ver = best.ver;

  const gcb = mapValues(ucd.parseRanges(await ucd.fetchVerified(ver, 'GraphemeBreakProperty', o)), GCB, 'GraphemeBreakProperty');
  const incb = mapValues(ucd.parseRanges(await ucd.fetchVerified(ver, 'DerivedCoreProperties', o), 'InCB'), INCB, 'InCB');
  const ext = new Uint8Array(CODE_POINTS);
  for (const [lo, hi, v] of ucd.parseRanges(await ucd.fetchVerified(ver, 'emoji-data', o))) if (v === 'Extended_Pictographic') for (let c = lo; c <= hi; c++) ext[c] = 1;
  const amb = ambiguousFrom(nat.narrow, nat.wide);
  // Verify every pinned input of the chosen version, including the two test corpora
  // Task 4 reads (GraphemeBreakTest, emoji-test), so the header's hashes are all proven.
  const pinsUsed = {};
  for (const [name, p] of Object.entries(ucd.pins()[ver])) { await ucd.fetchVerified(ver, name, o); pinsUsed[name] = p.sha256; }

  const data = {
    header: { unicode: ver, ucdSha256: pinsUsed, nativeClaude: nativeVersion(o.native), nativeBun: nat.bun,
      versionChoice: counts, generatorSha256: GENERATOR_SHA },
    gcb: toRanges(gcb, (v) => v !== 0),
    incb: toRanges(incb, (v) => v !== 0),
    extPict: toSpans(ext),
    width: toRanges(nat.narrow, (v) => v !== 1),     // absent = width 1
    ambiguous: toSpans(amb),
    overrides: [],                                    // Task 4/5 append named overrides with evidence
  };
  const region = `${BEGIN}\n// DO NOT EDIT. Regenerate: node scripts/gen-unicode-data.cjs --native <claude ${data.header.nativeClaude}>\n`
    + `const UNICODE_DATA = ${JSON.stringify(data)};\n${END}`;
  const cur = fs.readFileSync(TARGET, 'utf8');
  const a = cur.indexOf(BEGIN); const b = cur.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`${TARGET} lacks the GENERATED markers`);
  const next = cur.slice(0, a) + region + cur.slice(b + END.length);
  if (o.check) {
    if (next !== cur) {
      process.stdout.write('unicode-data: STALE — regeneration changes libexec/unicode-text.cjs\n'
        + describeDrift(currentData(cur), data).map((l) => `  ${l}\n`).join(''));
      return 1;
    }
    process.stdout.write('unicode-data: fresh\n'); return 0;
  }
  fs.writeFileSync(TARGET, next);
  process.stdout.write(`unicode-data: wrote ${TARGET} (unicode ${ver}, ${data.header.nativeClaude})\n`);
  return 0;
}

// A refusal is 2; an offline cache miss is 3 (see the header), so a caller can tell "this
// run could not look" from "this run looked and refused".
function exitCodeFor(e) { return e && e.name === 'UcdOfflineMiss' ? 3 : 2; }

module.exports = { toRanges, toSpans, ambiguousFrom, eawAssigned, eawPredicted, widthDisagreements, mapValues, fromRanges, describeDrift, main, exitCodeFor };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`gen-unicode-data: ${e.message}\n`); process.exit(exitCodeFor(e)); });
}
