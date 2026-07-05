'use strict';
// Shared corpus + compute for the shim-fidelity gate. Runs each of clode's
// Bun-native-backing npm deps over a fixed input corpus and returns a stable,
// JSON-serializable result. Imported by BOTH test/shim-fidelity.test.cjs and
// test/update-shim-fidelity.cjs, so a clean run reproduces test/shim-fidelity.json
// byte-for-byte (mirrors test/golden-shas-lib.cjs).
//
// Requires the REAL npm packages with the same interop the shim uses: string-width/
// strip-ansi/wrap-ansi are ESM-only, and require() of ESM returns a namespace whose
// .default is the function (Node >=24, no top-level await) — hence `.default || m`.
// The deps MUST be installed (npm ci); the gate is meaningless against absent deps, so
// we throw loudly rather than skip.
//
// NOTE: this lib resolves the RAW npm packages directly (NOT libexec/bun-shim.cjs).
// Deliberate: importing bun-shim.cjs has heavy global side effects unwanted in a unit
// test (it patches fs / child_process, installs globalThis.WebSocket, hooks Module._load).
// Today the shim's wrappers for these five are pure pass-throughs
// (stringWidth(...a){return _stringWidthFn(...a)}, YAML.parse:(...a)=>_yaml.parse(...a),
// semver.order/satisfies -> the package's compare/satisfies), so the raw package measures
// exactly what clode ships. CAVEAT: if a shim wrapper ever gains real logic — e.g. passing
// options to wrap-ansi to close the Bun {trim,hard,wordWrap} divergence — update THIS lib
// to measure the shim's wrapped behavior, or the guard will silently keep measuring the
// raw package and miss both the fix and any regression of it.

function req(pkg) {
  let m;
  try { m = require(pkg); }
  catch (e) {
    throw new Error(
      `shim-fidelity: dep '${pkg}' not installed — run \`npm ci\` at the repo root first ` +
      `(${e.message})`);
  }
  return (m && m.default) || m;
}

const stringWidth = req('string-width');
const stripAnsi   = req('strip-ansi');
const wrapAnsi    = req('wrap-ansi');
const YAML        = req('yaml');
const semver      = req('semver');

// --- corpus: fixed literals only (determinism). Each stresses a real fidelity edge. ---
const WIDTH_INPUTS = [
  '', 'hello',
  '日本語',                 // 3 fullwidth CJK
  'Ａ',                     // fullwidth Latin
  '👍',                     // emoji presentation
  '👨‍👩‍👧‍👦',              // ZWJ family sequence
  '👋🏽',                    // skin-tone modifier
  'a\u0300',                // 'a' + combining grave
  '\u200bhi',               // zero-width space + text
  '\x1b[31mred\x1b[0m',     // ANSI-wrapped
  'a\tb',                   // tab
];

const STRIP_INPUTS = [
  'plain',
  '\x1b[31mred\x1b[0m',
  '\x1b[1;32mbold green\x1b[0m',
  '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\', // OSC-8 hyperlink
  '\x1b[2J\x1b[Hcleared',                                // cursor/clear
  'nested \x1b[31m\x1b[1mx\x1b[0m',
];

// [text, columns, options|undefined]
const WRAP_INPUTS = [
  ['the quick brown fox jumps', 10, undefined],
  ['the quick brown fox jumps', 10, { hard: true }],
  ['  leading and trailing  ', 10, { trim: false }],
  ['longwordwithoutbreaks', 8, { hard: true }],
  ['longwordwithoutbreaks', 8, { wordWrap: false }],
  ['日本語 の テキスト', 6, { hard: true }],
  ['\x1b[31mred text that wraps\x1b[0m', 8, { hard: true }],
];

const YAML_PARSE_INPUTS = [
  'a: 1\nb: two\n',
  'list:\n  - x\n  - y\n',
  'anchored: &a hi\nref: *a\n',
  'multi: |\n  line1\n  line2\n',
  'flow: {x: 1, y: [2, 3]}\n',
  'nullish: ~\nbool: yes\nstr: "yes"\nnum: 007\n',
];

const YAML_STRINGIFY_INPUTS = [
  { a: 1, b: 'two', c: [1, 2, 3] },
  { nested: { x: true, y: null } },
  ['a', 'b', { c: 3 }],
];

const SEMVER_SORT_INPUTS = [
  ['1.0.0', '1.0.0-alpha', '1.0.0-beta', '1.0.0-alpha.1', '2.1.70', '2.1.179', '1.2.3'],
];

// [version, range]
const SEMVER_SATISFIES_INPUTS = [
  ['1.2.3', '^1.0.0'],
  ['2.0.0', '^1.0.0'],
  ['1.0.0-alpha', '>=1.0.0'],
  ['8.0.1', '^8'],
  ['2.1.179', '>2.1.70'],
];

// Runs the corpus. Any input that throws propagates (a thrown corpus case IS a behavior
// change worth failing on). Result is deterministic and JSON-serializable.
// Corpus outputs must be JSON-round-trippable: a case returning `undefined` would be
// dropped by JSON.stringify on BOTH sides of the compare and produce no signal — keep
// corpus cases to defined values (a throwing case is fine; it fails loudly).
function compute() {
  return {
    stringWidth: WIDTH_INPUTS.map((s) => ({ in: s, out: stringWidth(s) })),
    stripAnsi:   STRIP_INPUTS.map((s) => ({ in: s, out: stripAnsi(s) })),
    wrapAnsi:    WRAP_INPUTS.map(([s, c, o]) =>
      ({ in: s, cols: c, opts: o || null, out: wrapAnsi(s, c, o) })),
    yamlParse:   YAML_PARSE_INPUTS.map((s) => ({ in: s, out: YAML.parse(s) })),
    yamlStringify: YAML_STRINGIFY_INPUTS.map((v) => ({ in: v, out: YAML.stringify(v) })),
    semverSort:  SEMVER_SORT_INPUTS.map((arr) => ({ in: arr, out: semver.sort(arr.slice()) })),
    semverSatisfies: SEMVER_SATISFIES_INPUTS.map(([v, r]) =>
      ({ in: [v, r], out: semver.satisfies(v, r) })),
  };
}

module.exports = { compute, fns: { stringWidth, stripAnsi, wrapAnsi, YAML, semver } };
