'use strict';
// THE GRAPH RUNNER — one extracted file that runs a code-split Claude Code on either host.
//
// WHY IT EXISTS. When 2.1.243 went code-split, the fuse path learned the new shape and
// nothing else did. `clode build` went green while `clode build --naude` AND the entire
// oracle apparatus went dead: five CI jobs, including the agentic round-trips, the shim
// parity gate, and the tjs-vs-node extractor differential. The build path was verified by
// the very thing it had broken. Nothing declared that build-naude consumes an extracted
// cli.cjs — it was an argv at clode-fuse.cjs:1080 and a runtime path check — so only CI
// could notice, hours later.
//
// WHY THESE TESTS AND NOT "IT RAN ONCE". Getting the runner working took four distinct
// failures, EVERY ONE of which was silent or nearly so. Each has an assertion here:
//
//   1. node-shim's loader rewrites `import(` in CJS it evaluates. The runner carries 34MB
//      of upstream ESM as data, so that rewrite edited UPSTREAM'S SOURCES and their
//      dynamic imports came back through the CJS resolver: "cannot resolve
//      /$bunfs/root/chunk-....js". Fixed by a declared marker; both sides tested here.
//   2. Only the ENTRY gets a usable import.meta. tjs attaches it at DESERIALIZE, node has
//      no import.meta.require at all, and upstream's runtime chunk reads it at module
//      scope. The failure was the engine's nameless "not a function", 40 frames deep.
//   3. The two hosts disagreed about import.meta.url (tjs: file:///$bunfs/..., node: the
//      runner's own URL) and upstream calls fileURLToPath on it.
//   4. A staged split bundle wrote graph.json and no runnable file, which is the original
//      defect. The stage must carry BOTH shapes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { graphRunnerSource, moduleWithMeta } = require('../libexec/extract-claude-js.cjs');

const ENTRY = '/$bunfs/root/cli';
const HELPER = '/$bunfs/root/helper.js';

function docOf(entrySrc, helperSrc) {
  return {
    format: 'clode-bun-graph-v1',
    prelude: 'globalThis.Bun = globalThis.Bun || {};',
    entry: ENTRY,
    order: [HELPER, ENTRY],
    externals: [],
    moduleCount: 2,
    sources: { [HELPER]: helperSrc, [ENTRY]: entrySrc },
  };
}

function writeRunner(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-runner-'));
  const f = path.join(dir, 'cli.cjs');
  fs.writeFileSync(f, graphRunnerSource(doc));
  fs.copyFileSync(path.join(REPO, 'libexec', 'bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, f };
}

function runNode(f, dir) {
  return execFileSync(process.execPath, [f], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const TJS = process.env.CLODE_TJS;
function tjsAvailable(t) {
  if (TJS && fs.existsSync(TJS)) return true;
  t.skip('no engine: set CLODE_TJS to a tjs binary');
  return false;
}
function runTjs(f, dir) {
  return execFileSync(TJS, ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), f],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// --- 1. the marker ------------------------------------------------------------------
// Two files we own have to agree on one string. They are in different directories and
// nothing but this test connects them; if they drift, the loader silently resumes editing
// upstream's sources and the symptom is a resolve error deep inside a chunk.
test('the runner declares the loader opt-out marker, and the loader honours THAT string', () => {
  const loader = fs.readFileSync(path.join(REPO, 'libexec/node-shim/loader.cjs'), 'utf8');
  const m = loader.match(/const GRAPH_RUNNER_MARKER = '([^']+)'/);
  assert.ok(m, 'loader.cjs no longer defines GRAPH_RUNNER_MARKER');
  const runner = graphRunnerSource(docOf('', ''));
  assert.ok(runner.startsWith(m[1] + '\n'),
    `the generated runner must begin with the loader's marker (${m[1]}); it begins with `
    + JSON.stringify(runner.slice(0, 40)));
  // And the loader must actually branch on it, not merely define it.
  assert.match(loader, /if \(!src\.startsWith\(GRAPH_RUNNER_MARKER\)\)/,
    'loader.cjs defines the marker but no longer skips its CJS transforms for it');
});

test('a marked file keeps its dynamic imports — the loader does not rewrite it', (t) => {
  if (!tjsAvailable(t)) return;
  // `import(` inside the payload is the exact text the loader used to rewrite. Assert it
  // survives to runtime by having the module report its own source back.
  const helper = 'export const S = "dynamic: import(\\"x\\")";';
  const entry = `import { S } from ${JSON.stringify(HELPER)};\nconsole.log(S);\n`;
  const { dir, f } = writeRunner(docOf(entry, helper));
  assert.match(runTjs(f, dir), /dynamic: import\("x"\)/,
    'the payload was rewritten by node-shim\'s CJS transforms — the marker is not working');
});

// --- 2 and 3. import.meta on EVERY module, identical on both hosts -------------------
const META_PROBE = docOf(
  `import { R, U } from ${JSON.stringify(HELPER)};\n`
  + 'console.log(JSON.stringify({ require: typeof R, url: U }));\n',
  'export const R = import.meta.require;\nexport const U = import.meta.url;\n');

test('a NON-ENTRY module gets import.meta.require under node', () => {
  const { dir, f } = writeRunner(META_PROBE);
  const got = JSON.parse(runNode(f, dir).trim());
  assert.strictEqual(got.require, 'function',
    'upstream reads import.meta.require at module scope; without it the failure is the '
    + 'engine\'s nameless "not a function", dozens of frames deep');
});

test('a NON-ENTRY module gets import.meta.require under tjs', (t) => {
  if (!tjsAvailable(t)) return;
  const { dir, f } = writeRunner(META_PROBE);
  assert.strictEqual(JSON.parse(runTjs(f, dir).trim()).require, 'function');
});

test('both hosts report the SAME import.meta.url, and it is the file:// URL Bun reports', (t) => {
  const { dir, f } = writeRunner(META_PROBE);
  const viaNode = JSON.parse(runNode(f, dir).trim()).url;
  // Bun names these modules /$bunfs/root/...; upstream calls fileURLToPath() on the URL,
  // so anything that is not a file: URL throws where it is used, not where it is set.
  assert.strictEqual(viaNode, 'file:///$bunfs/root/helper.js');
  if (!tjsAvailable(t)) return;
  assert.strictEqual(JSON.parse(runTjs(f, dir).trim()).url, viaNode,
    'the hosts disagree about import.meta.url — that divergence is invisible until '
    + 'upstream parses it');
});

// --- the preamble is a PREPEND, never an edit ---------------------------------------
// This is the line between "a loader" and "a bundler". bun-graph-plan.cjs refuses to
// rewrite minified upstream text because a regex cannot tell code from a string that
// looks like code, and a mangled prompt inside the reference binary would be silent.
test('upstream source is carried byte-identically; only a generated first line is added', () => {
  const original = '// @bun @bytecode\nconst s = "import(\'x\') // not code";\nexport default s;\n';
  const out = moduleWithMeta(HELPER, original);
  const nl = out.indexOf('\n');
  assert.strictEqual(out.slice(nl + 1), original,
    'the module body changed — everything after the generated line must be upstream verbatim');
  assert.match(out.slice(0, nl), /^import\.meta\.require = globalThis\.__quaudeRequire;/);
  assert.ok(out.slice(0, nl).includes('file:///$bunfs/root/helper.js'),
    'the generated line must pin the URL the engine would derive from the same name');
});

test('a module whose name is not an absolute path gets require but no invented url', () => {
  // The generated per-specifier shims are named "fs", "path", ... — not paths. Claiming
  // file:///fs for them would be a lie the hosts would then have to agree on.
  const out = moduleWithMeta('fs', 'export default 1;\n');
  assert.match(out, /^import\.meta\.require = globalThis\.__quaudeRequire;\n/);
  assert.ok(!out.includes('import.meta.url'), 'invented a url for a bare specifier');
});

// --- 4. the staged bundle carries BOTH shapes ---------------------------------------
// The original defect, as a property rather than an anecdote: a split stage must contain
// the graph (for the fuse worker) AND a runnable file (for naude and every oracle).
test('extract-claude-js produces a RUNNABLE file for either bundle shape', () => {
  const src = fs.readFileSync(path.join(REPO, 'libexec/extract-claude-js.cjs'), 'utf8');
  assert.match(src, /isSplitBundle\(binpath\) \? extractGraphRunnerToFile\(binpath, out\) : extractToFile\(binpath, out\)/,
    'the CLI must give every caller one runnable file whichever shape the provider is — '
    + 'about twenty test files and scripts/build-naude.mjs depend on exactly that');
  const ex = fs.readFileSync(path.join(REPO, 'libexec/clode-extract.cjs'), 'utf8');
  assert.match(ex, /graphRunnerSource\(doc\)/,
    'a staged SPLIT bundle must write cli.cjs beside graph.json. Writing only the graph '
    + 'is what left naude and the oracle apparatus dead while clode build was green');
});

// --- 5. the runner is an ENVELOPE, and analysis tools must not read the envelope -----
// inspect-claude-bundle scans for literal code fragments. A runner carries upstream as
// ONE JSON string, where every `"` is `\"`, so scanning it directly compares against
// escaped text. That is not hypothetical: on a correctly patched 2.1.245 it reported
// three hooks MISSING/AMBIGUOUS — the native autoupdater, the manual `update` switch and
// the Remote Control gate — and said `<target> update` would install upstream over the
// binary. All nine hooks had applied. The three that "failed" are exactly the three
// whose markers contain a double quote.
//
// A partial failure is what made it convincing. Six anchors passed, so it read as "some
// hooks did not apply" rather than "the tool is reading JSON".
test('inspect decodes a graph runner rather than scanning its JSON envelope', () => {
  const INSPECT = path.join(REPO, 'libexec/inspect-claude-bundle.cjs');
  const { decodeGraphRunner } = require(INSPECT);
  assert.strictEqual(typeof decodeGraphRunner, 'function',
    'inspect-claude-bundle must export decodeGraphRunner so this property is testable');

  // A module body carrying a marker WITH a double quote — the shape that broke.
  const marker = 'await globalThis.__clodeCheckUpdate("x")';
  // AS CODE, not inside a string literal — a marker written into a JS string is escaped
  // in the module source too, so the test would pass for the wrong reason.
  const { dir, f } = writeRunner(docOf('export const ok = 1;\n',
    `export async function check() { ${marker}; }\n`));

  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes(marker),
    'precondition: the raw runner should NOT contain the unescaped marker — if it does, '
    + 'the payload is no longer JSON-escaped and this test is checking nothing');

  const decoded = decodeGraphRunner(f);
  assert.ok(decoded.includes(marker),
    'decodeGraphRunner must yield real JavaScript, with the payload unescaped');
  // The prelude belongs to the analysed text too: it is where __clodeCheckUpdate is
  // defined, and an anchor check that cannot see it draws the wrong conclusion.
  assert.ok(decoded.includes('globalThis.Bun'), 'the prelude must be part of the decoded text');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decodeGraphRunner leaves a non-runner file alone, and refuses a malformed one', () => {
  const { decodeGraphRunner } = require(path.join(REPO, 'libexec/inspect-claude-bundle.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-runner-neg-'));
  const plain = path.join(dir, 'cli.cjs');
  fs.writeFileSync(plain, '"use strict";\nmodule.exports = 1;\n');
  assert.strictEqual(decodeGraphRunner(plain), null,
    'a pre-2.1.243 single-CJS bundle must be read as-is');
  // Claiming to be a runner and not being one is a bug, not something to shrug at: it
  // would otherwise fall through to scanning the envelope, which is the whole defect.
  const lying = path.join(dir, 'lying.cjs');
  fs.writeFileSync(lying, '//clode:graph-runner:1\nmodule.exports = 1;\n');
  assert.throws(() => decodeGraphRunner(lying), /carries no graph/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 6. TEXT ASSETS: the class of break that passes every check and dies at runtime ----
// Claude Code 2.1.246 moved 164 files (118 .md — prompt preambles, quickrefs) out of JS
// and into embedded text rows the bundle require()s BY NAME. Nothing about that is
// visible to a decoder, a minimiser self-check, or a build: clode staged the graph, the
// minimiser shrank it, the fuse compiled it, and the target booted — then died on its
// first turn with "cannot resolve /$bunfs/root/loopAutonomousPreamble-07qcyhv4.md",
// naming a file that exists ONLY inside the provider and so cannot be found on any host.
//
// These names never appear on disk, so every layer has to carry them deliberately:
// bun-graph reads them, the staged doc holds them, the minimiser keeps them, the runner
// answers require() from them, and the fuse stores them as a member for the loader.
// A break anywhere in that chain is silent until an agent turn.
const { loadAssets } = require(path.join(REPO, 'libexec/bun-graph.cjs'));

test('a text asset reaches require() through the runner, on both hosts', (t) => {
  const NAME = '/$bunfs/root/preamble-test.md';
  const BODY = '# preamble\nline two\n';
  const doc = docOf(
    `const t = globalThis.__quaudeRequire(${JSON.stringify(NAME)});\n`
    + 'console.log(JSON.stringify({ got: t }));\n', 'export const unused = 1;\n');
  doc.assets = { [NAME]: BODY };
  const { dir, f } = writeRunner(doc);
  assert.strictEqual(JSON.parse(runNode(f, dir).trim()).got, BODY,
    'the runner must answer require() for an embedded text asset — no host path can');
  if (!tjsAvailable(t)) return;
  assert.strictEqual(JSON.parse(runTjs(f, dir).trim()).got, BODY);
});

test('an asset name never shadows a real module or builtin', () => {
  // The asset lookup runs FIRST, so it must be exact: a bundle that requires "fs" must
  // still get fs, not a file that happens to be called that.
  const doc = docOf('console.log(typeof globalThis.__quaudeRequire("fs").readFileSync);\n',
    'export const unused = 1;\n');
  doc.assets = { '/$bunfs/root/fs': 'NOT THE MODULE' };
  const { dir, f } = writeRunner(doc);
  assert.strictEqual(runNode(f, dir).trim(), 'function');
});

test('the whole chain carries assets: extract -> minimise -> fuse member', () => {
  const ex = fs.readFileSync(path.join(REPO, 'libexec/extract-claude-js.cjs'), 'utf8');
  assert.match(ex, /assets: assets/, 'the staged graph doc must carry text assets');
  const mm = fs.readFileSync(path.join(REPO, 'scripts/make-min-provider.cjs'), 'utf8');
  // 13 = text, 5 = file. 2.1.251 moved 94 embedded assets from 13 into 5 by compressing
  // them, and keeping only 13 built a target that smoked green and died on its first turn with
  // upstream's own "embedded text asset is missing or corrupt". The DERIVED version of this
  // check — KEEP read against the loaders bun-graph actually stages, so neither file can drift —
  // is in test/make-min-provider.test.cjs; this one stays as the named tripwire for the chain.
  assert.match(mm, /KEEP = new Set\(\[1, 13, 5\]\)/,
    'the minimiser must keep BOTH asset row classes (13 text, 5 file) as well as JS (1); '
    + 'dropping either yields a provider that passes every check and builds a target that '
    + 'dies on its first turn');
  const qf = fs.readFileSync(path.join(REPO, 'libexec/quaude-fuse.js'), 'utf8');
  assert.match(qf, /graph-assets\.json/, 'the fuse must store assets as a member');
  const ld = fs.readFileSync(path.join(REPO, 'libexec/node-shim/loader.cjs'), 'utf8');
  assert.match(ld, /graph-assets\.json/, 'the loader must answer require() from that member');
});

test('a REAL provider with text rows round-trips through the minimiser', (t) => {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const before = loadAssets(bin);
  if (!before.size) { t.skip('this provider predates text assets (pre-2.1.246)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-min-'));
  const out = path.join(dir, 'provider-min');
  execFileSync(process.execPath, [path.join(REPO, 'scripts/make-min-provider.cjs'), bin, out],
    { stdio: 'pipe' });
  const after = loadAssets(out);
  assert.strictEqual(after.size, before.size, 'minimising dropped text assets');
  for (const [n, body] of before) assert.strictEqual(after.get(n), body, `asset ${n} changed`);
  fs.rmSync(dir, { recursive: true, force: true });
});
