'use strict';
// TWO-LAYER SHIM GAP INVENTORY — a MAP, goldened, deliberately not an alarm.
//
// Companion to test/node-shim-wall-tripwires.test.cjs; read both before editing
// either, because they answer different questions on purpose:
//
//   wall-tripwires  "has upstream started calling a wall we DECLARED?"
//                   Narrow (direct `require("fs").watch(` only), loud, zero
//                   tolerated noise. A denylist: it can only see gaps someone
//                   remembered to write down.
//
//   THIS FILE       "what is the FULL set of APIs upstream reaches for that we
//                   don't provide?" Wide, quiet, goldened. Derived, not declared:
//                   it enumerates real node's surface, enumerates the shim's,
//                   subtracts, and intersects with what the bundle references.
//                   Nobody has to have predicted the gap for it to appear here.
//
// WHY BOTH: on 2026-08-01 the tripwire reported fs.watch clean while the bundle
// had four call sites, because the tripwire's narrow pattern cannot see minified
// aliases and its rationale wrongly assumed all four were vendored dead code.
// The narrow pattern is still right FOR AN ALARM (an alias-aware alarm is red on
// day one and gets ignored). The fix is not to widen the alarm, it is to add the
// map — and to let the map be reviewed rather than obeyed. That is this file.
//
// WHY GOLDEN RATHER THAN "MUST BE EMPTY": most of these gaps are fine. Upstream
// feature-detects (`"WebView" in Bun`), or the code path is unreachable on our
// supported routes. Demanding zero would mean implementing ~22 APIs nobody calls
// at runtime. Demanding NO CHANGE means the day an upstream bump reaches for
// something new, a human looks at it — which is the actual goal.
//
// HOW TO UPDATE when this fails: read the diff. If the new gap is benign, add it
// to golden.json WITH a note saying why. If it is not, that is a bug found before
// a user found it, which is the entire point.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const models = require('./oracle-models.cjs');
const helper = require('./node-shim-helper.cjs');
const refs = require('./shim-surface/bundle-refs.cjs');
const collect = require('./shim-surface/collect.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const GOLDEN_PATH = path.join(__dirname, 'shim-surface', 'golden.json');

// Both inputs are required: the tjs engine (to enumerate what the shim really
// exposes, under the engine it really runs on) and the staged provider bundle
// (to know what upstream references). Either missing => skip, same convention as
// the other oracles. UPDATE_GOLDEN regenerates instead of asserting.
// Memoized because stageProviderCli() stages into a FRESH temp dir on every
// call — so calling it per test yields a different `cli` path each time, which
// silently defeated the measure() cache below (both tests paid the full ~28s).
let _inputs = null;
function inputs() {
  if (_inputs) return _inputs;
  const tjs = helper.tjsPath();
  if (!tjs) { _inputs = { skip: 'no tjs binary (CLODE_TJS or build/tjs/<tag>)' }; return _inputs; }
  const missing = collect.missingExtDeps();
  if (missing.length) {
    _inputs = { skip: `the shim's ext-dep closure is not installed (${missing.join(', ')}; npm ci --prefix deps/claude): `
      + 'this would measure a shim quaude never ships' };
    return _inputs;
  }
  let staged = null;
  let stageErr = null;
  try { staged = models.stageProviderCli({ env: process.env }); } catch (e) { stageErr = e.message; }
  const skip = stageErr
    ? `provider found but staging it failed: ${stageErr}`
    : models.providerSkipReason(staged, 'no staged provider bundle (CLODE_PROVIDER_BIN)');
  if (skip || !staged.cli || !fs.existsSync(staged.cli)) {
    _inputs = { skip: skip || 'no staged provider bundle (CLODE_PROVIDER_BIN)' };
    return _inputs;
  }
  // Point at the CACHE dir's cli.cjs, not the per-test copy: the cache dir also
  // holds graph.json, and refs.loadBundle() prefers that (real source strings)
  // over the escape-laden graph runner. Read-only here, so sharing is safe.
  const cached = path.join(staged.cacheDir, 'cli.cjs');
  _inputs = { tjs, cli: fs.existsSync(cached) ? cached : staged.cli };
  return _inputs;
}

// Memoized: the measurement spawns a host-node enumerator AND a tjs enumerator
// and indexes a 21MB bundle — about 28s. Two tests consume the same result, and
// re-deriving it per test doubled the suite cost for no extra coverage. Keyed by
// bundle path so a differently-staged provider is never served a stale answer.
let _cache = null;
function measure(cli) {
  if (_cache && _cache.cli === cli) return _cache.value;
  const value = measureUncached(cli);
  _cache = { cli, value };
  return value;
}

function measureUncached(cli) {
  const names = collect.shimModuleNames();
  const nodeSurface = collect.enumerateUnderNode(names);
  const shimSurface = collect.enumerateUnderTjs(names, null, helper.engineSpawn);

  // layer 1 wants the flat text (Bun.* and "bun:*" need no module scope);
  // layer 2 wants the per-module scope (see refs.buildScope).
  const modules = refs.loadModules(cli);
  const text = modules.map((m) => m.src).join('\n');
  const index = refs.buildIndex(text);

  const l2 = collect.layer2Gaps({ nodeSurface, shimSurface, scope: refs.buildScope(modules, names) });

  // bun-shim installs a Module._load hook and sets globalThis.Bun as a side
  // effect of require(). That is why this runs in the test process and not the
  // enumerator: we want the DECLARED surface, and we accept the hook here where
  // nothing else depends on a clean module registry afterwards.
  const bunShim = require('../libexec/bun-shim.cjs');
  const bunProps = new Set(Object.getOwnPropertyNames(globalThis.Bun || {}));
  const bunBuiltins = bunShim.__bunBuiltins || [];
  const l1 = collect.layer1Gaps({ text, index, bunProps, bunBuiltins });

  return { l1, l2, moduleCount: names.length };
}

// The four golden lists, as measured.
function actualOf(m) {
  return {
    layer1_bun_props_missing: m.l1.propGaps.map((g) => g.api),
    layer1_bun_modules_missing: m.l1.moduleGaps,
    layer1_bun_modules_intercepted_but_unused: m.l1.unusedIntercepts,
    layer2_node_apis_missing: m.l2.gaps.map((g) => g.api),
  };
}

// THE GATE, registered as a guard (observability plan Task 5): it was two plain tests,
// so no registry knew it existed, and the CI job that runs it (node-shim-oracle) could only say
// that some anonymous count of tests skipped. As a guard it is a NAME every CI job's gate list
// carries (test/ci-gates.cjs), so a run that skipped it is named, not counted.
//
// Two kinds of finding, both read from one measurement:
//   - DRIFT: a golden list gained or lost an entry. DEFERRED, not silently:
//     `layer1_bun_props_missing_deferred` (golden.json) names drift that IS new, IS real, and is
//     explicitly NOT yet reviewed — see its `_notes` entry and BACKLOG.md's "Bun.zstdDecompress /
//     Bun.zstdDecompressSync are new golden-map drift, unreviewed". Anything on it is excluded from
//     the diff; everything else asserts exactly as before, so a genuinely NEW, DIFFERENT gap still
//     fails loud.
//   - BLIND MODULES: the measurement is only trustworthy if every shim module could actually be
//     enumerated on both sides. A module that failed to load would otherwise contribute zero gaps
//     and read exactly like a clean one — the "a skipped oracle is not a pass" failure mode, in
//     miniature. `unenumerable_allowed` (golden.json) names the measured exceptions.
// examined = the shim modules measured on both sides. Measured 2026-11-19 on the 2.1.283 carve:
// 32 shim modules, `intl` the one allowed unenumerable, so 31; fewer means modules vanished from
// the measurement and the map's silence means nothing.
const SHIM_SURFACE_FLOOR = 31;
// The upstream version a staged bundle carries: the most frequent standalone VERSION:"x.y.z" literal (graph.json
// escapes its quotes, cli.cjs does not). Null when none is found, so an unknown version never blocks the diff.
function bundleVersionOf(text) {
  const counts = new Map();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$])VERSION:\\?"(\d+\.\d+\.\d+)\\?"/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > counts.get(best)) best = v;
  return best;
}

function scanShimSurface({ actual, golden, unenumerable, moduleCount, bundleVersion = null }) {
  const findings = [];
  // A provider that is not the one golden.json was measured against is a measuring-device fault (a dev box whose
  // newest provider is ahead of the pin), not product drift: name that, and do not diff a map against the wrong
  // upstream. Still red, because a pin bump with no re-measured golden also lands here.
  const want = golden._measured_against_bundle;
  if (bundleVersion && want && bundleVersion !== want) {
    return { findings: [`the staged provider is ${bundleVersion}, but golden.json was measured against ${want}: this is a `
      + 'version mismatch, not shim drift. Point CLODE_PROVIDER_BIN at the pinned provider; if the pin itself moved, '
      + 're-measure with UPDATE_GOLDEN=1 and review the diff'], examined: moduleCount - unenumerable.length,
    note: `${moduleCount} shim module(s), not diffed: provider ${bundleVersion} vs golden ${want}` };
  }
  const deferred = new Set(golden.layer1_bun_props_missing_deferred || []);
  for (const key of Object.keys(actual)) {
    const exp = golden[key] || [];
    const got = key === 'layer1_bun_props_missing' ? actual[key].filter((x) => !deferred.has(x)) : actual[key];
    const added = got.filter((x) => !exp.includes(x));
    const removed = exp.filter((x) => !got.includes(x));
    if (added.length || removed.length) {
      findings.push(`${key} drifted. NEW gaps (upstream now reaches for these, we do not provide them): `
        + `${JSON.stringify(added)}; GONE (we implemented them, or upstream stopped): ${JSON.stringify(removed)}. `
        + 'Review, then regenerate with UPDATE_GOLDEN=1 and record WHY in golden.json notes.');
    }
  }
  const allowed = golden.unenumerable_allowed || [];
  const unexpected = unenumerable.filter((u) => !allowed.includes(u.module));
  if (unexpected.length) {
    findings.push(`these shim modules could not be enumerated on both sides, so their gaps are UNKNOWN (not zero): `
      + `${JSON.stringify(unexpected.map((u) => u.module))}. Full detail: ${JSON.stringify(unexpected)}`);
  }
  return { findings, examined: moduleCount - unenumerable.length,
    note: `${moduleCount} shim module(s), ${unenumerable.length} unenumerable, against test/shim-surface/golden.json` };
}

const shimSurfaceGuard = defineGuard({
  name: 'shim-surface',
  floor: SHIM_SURFACE_FLOOR,
  read() {
    if (process.env.UPDATE_GOLDEN === '1') return { skip: 'UPDATE_GOLDEN=1: this run regenerates the golden map, it does not judge it' };
    const inp = inputs();
    if (inp.skip) return { skip: inp.skip };
    if (!fs.existsSync(GOLDEN_PATH)) throw new Error(`missing ${GOLDEN_PATH}; regenerate with UPDATE_GOLDEN=1`);
    const m = measure(inp.cli);
    const graph = path.join(path.dirname(inp.cli), 'graph.json');
    const bundleVersion = bundleVersionOf(fs.readFileSync(fs.existsSync(graph) ? graph : inp.cli, 'utf8'));
    return { actual: actualOf(m), golden: JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')),
      unenumerable: m.l2.unenumerable, moduleCount: m.moduleCount, bundleVersion };
  },
  scan: scanShimSurface,
  // The golden as it stands, measured against an inventory that gained one gap nobody reviewed and
  // lost a module to a failed load: both kinds of finding must fire.
  control() {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    const actual = {
      layer1_bun_props_missing: [...golden.layer1_bun_props_missing],
      layer1_bun_modules_missing: [...golden.layer1_bun_modules_missing],
      layer1_bun_modules_intercepted_but_unused: [...golden.layer1_bun_modules_intercepted_but_unused],
      layer2_node_apis_missing: [...golden.layer2_node_apis_missing, 'fs.notARealApi'],
    };
    return { actual, golden, unenumerable: [{ module: 'fs', error: 'control: failed to load' }], moduleCount: 32 };
  },
});
guardTests(shimSurfaceGuard);

test('shim surface: the control names both kinds of finding', () => {
  const r = scanShimSurface(shimSurfaceGuard.control());
  assert.strictEqual(r.findings.length, 2, r.findings.join('\n'));
  assert.match(r.findings[0], /layer2_node_apis_missing drifted.*fs\.notARealApi/);
  assert.match(r.findings[1], /could not be enumerated.*"fs"/);
});

test('shim surface: a provider other than golden\'s is named as a version mismatch, not drift', () => {
  const golden = { _measured_against_bundle: '2.1.283', layer2_node_apis_missing: [] };
  const base = { actual: { layer2_node_apis_missing: ['fs.exists'] }, golden, unenumerable: [], moduleCount: 32 };
  const off = scanShimSurface({ ...base, bundleVersion: '2.1.328' });
  assert.strictEqual(off.findings.length, 1, off.findings.join('\n'));
  assert.match(off.findings[0], /provider is 2\.1\.328, but golden\.json was measured against 2\.1\.283: this is a version mismatch/);
  const on = scanShimSurface({ ...base, bundleVersion: '2.1.283' });
  assert.match(on.findings.join('\n'), /layer2_node_apis_missing drifted/);
  const unknown = scanShimSurface({ ...base, bundleVersion: null });
  assert.match(unknown.findings.join('\n'), /layer2_node_apis_missing drifted/);
  assert.strictEqual(bundleVersionOf('a,{ENGINE_VERSION:"9.9.9",VERSION:"2.1.283"},{VERSION:\\"2.1.283\\"},VERSION:"2.0.0"'), '2.1.283');
});

// THE GLOBAL `process`, which no import names. The map was blind to every process.* member until 2026-11-22, when
// 2.1.330's relaunch through process.execve (absent from node-shim) left `/tui classic` with a dead terminal. This
// runs without a provider: a module that calls the global process.execve, a shim surface without it, and a node
// surface with it MUST produce the gap; one the shim provides MUST NOT; and a module that never touches the global
// contributes nothing.
test('shim surface: a GLOBAL process.<member> the shim lacks is a layer-2 gap (process.execve, 2026-11-22)', () => {
  const modules = [
    { id: 'relaunch.js', src: 'function w(e,r,a){try{process.execve(e,r,a)}catch(f){}return process.pid}' },
    { id: 'other.js', src: 'import*as n from"fs";n.readFileSync("x")' },
  ];
  const scope = refs.buildScope(modules, ['process', 'fs']);
  const surface = (props) => ({ ok: true, rootType: 'object', surface: Object.fromEntries(props.map((p) => [p, 'function'])) });
  const nodeSurface = { process: surface(['execve', 'pid', 'kill']), fs: surface(['readFileSync']) };
  const without = collect.layer2Gaps({ nodeSurface, shimSurface: { process: surface(['pid', 'kill']), fs: surface(['readFileSync']) }, scope });
  assert.deepStrictEqual(without.gaps.map((g) => g.api), ['process.execve'],
    'the scanner cannot see a global process member again: the blindness that hid the /tui relaunch P0');
  const withIt = collect.layer2Gaps({ nodeSurface, shimSurface: { process: surface(['execve', 'pid', 'kill']), fs: surface(['readFileSync']) }, scope });
  assert.deepStrictEqual(withIt.gaps, []);
  assert.deepStrictEqual(refs.referencesIn(scope, 'process', 'kill'), { calls: 0, reads: 0, imports: 0 });
});

// UPDATE_GOLDEN regenerates instead of asserting. Declared only when asked for, so a normal run
// carries no skipped placeholder for it.
if (process.env.UPDATE_GOLDEN === '1') {
  test('shim surface: regenerate the golden map (UPDATE_GOLDEN=1)', (t) => {
    const inp = inputs();
    if (inp.skip) { t.skip(inp.skip); return; }
    const prev = fs.existsSync(GOLDEN_PATH) ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ ...prev, ...actualOf(measure(inp.cli)) }, null, 2)}\n`);
    t.diagnostic('golden regenerated (UPDATE_GOLDEN=1)');
  });
}

// Guards the scanner itself against silent breakage. If binding resolution ever
// stops working, every gap list above collapses to empty and the golden test
// reports "all clear" — the most dangerous possible failure for a map. fs.watch
// is the anchor because its call sites were established by hand on 2026-08-01
// (Zlm/w3f/DTp = first-party, MDt = vendored chokidar).
//
// IT DID ITS JOB, on 2026-08-29. It went red with "found 0 aliases" and stayed
// red for weeks as part of a tolerated "baseline". It was not describing
// upstream; it was describing itself — and behind it, THE WHOLE OF LAYER 2 WAS
// BLIND. At 2.1.243 upstream went code-split ESM and stopped emitting
// `require()` for builtins entirely (measured: 0 for fs, os, path, crypto, net,
// http, child_process, stream, util, tty, v8 — every module but
// worker_threads), so `aliasesFor` returned an empty set for each one and
// layer2Gaps `continue`d past all of them. The golden's 16 layer-2 entries only
// escaped being reported as GONE because the golden test asserts layer 1 first
// and died on Bun.ant before reaching them.
//
// So the fix is not "teach the anchor a new regex". Upstream's builtin imports
// now arrive in three shapes, and the scanner has to know all three:
//   import*as X from"fs"     namespace  -> X.watch(...)   (11 sites)
//   import X from"fs"        default    -> X.watch(...)   ( 8 sites)
//   import{watch as z}from"fs"  named   -> z(...)         (185 sites)
// The named form has no `<alias>.<prop>` site to find at all, which is why
// alias-only resolution could not be widened into working — see
// namedImportsFor() in shim-surface/bundle-refs.cjs.
test('shim surface: the scanner still finds the known fs.watch call sites', (t) => {
  const inp = inputs();
  if (inp.skip) { t.skip(inp.skip); return; }

  const modules = refs.loadModules(inp.cli);
  const scope = refs.buildScope(modules, ['fs']);
  const text = modules.map((m) => m.src).join('\n');

  // Both mechanisms, counted separately over the SCOPED path the map itself
  // uses: a bundle can legitimately shift its mix between them, but ZERO on
  // either side means that resolution path is dead and every module using only
  // that shape is being reported as gap-free.
  let objects = 0;
  let namedSites = 0;
  for (const mod of scope) {
    for (const spec of ['fs', 'node:fs']) {
      const b = mod.bindings.get(spec);
      if (!b) continue;
      objects += b.objects.size;
      for (const n of b.named.values()) namedSites += n;
    }
  }
  assert.ok(objects >= 5,
    'expected many object-binding fs imports (import*as / import X / require),'
    + ` found ${objects} — object-binding resolution is broken`);
  assert.ok(namedSites >= 50,
    `expected many named fs imports (import{watch as z}from"fs"), found ${namedSites}`
    + ' — named-import resolution is broken');

  const watch = refs.referencesIn(scope, 'fs', 'watch');
  const found = watch.calls + watch.imports;
  assert.ok(found >= 4,
    `expected >=4 fs.watch references (4 established by hand against 2.1.218), got ${found}`
    + ` (${watch.calls} via object binding, ${watch.imports} via named import).`
    + ' A DROP here means the scanner regressed, not that upstream removed them —'
    + ' verify by hand before trusting it.');

  // The narrow tripwire pattern must still NOT see them; if it started to, the
  // two files' division of labor has changed and both comments need revisiting.
  const direct = /require\(\s*["'](?:node:)?fs["']\s*\)\s*\.watch\s*\(/.test(text);
  assert.strictEqual(direct, false,
    'the direct require("fs").watch( shape now appears — node-shim-wall-tripwires.test.cjs'
    + ' should be firing, and this file\'s "wide vs narrow" rationale needs an update');
});

// The oracle's node version must not flip the map by itself. buffer.SlowBuffer is the measured case:
// node 24 exports it, node 26 does not, and the shim has it only through its ext-dep (feross
// buffer). With the closure installed, both oracles agree there is no gap; it is only a shim
// WITHOUT the closure (buffer-lite) whose gap appears under 24 and hides under 26, which is why
// inputs() refuses to measure that shim.
test('shim surface: a version-only node export does not flip the map when the shim is measured as shipped', () => {
  const scope = refs.buildScope([{ id: 'm', src: 'import{SlowBuffer as q,Buffer as b}from"buffer";q(1);b.from("x");' }], ['buffer']);
  const node24 = { buffer: { ok: true, surface: { Buffer: 1, SlowBuffer: 1 } } };
  const node26 = { buffer: { ok: true, surface: { Buffer: 1 } } };
  const shipped = { buffer: { ok: true, surface: { Buffer: 1, SlowBuffer: 1 } } };
  const bare = { buffer: { ok: true, surface: { Buffer: 1 } } };
  const gaps = (nodeSurface, shimSurface) => collect.layer2Gaps({ nodeSurface, shimSurface, scope }).gaps.map((g) => g.api);
  assert.deepStrictEqual(gaps(node24, shipped), []);
  assert.deepStrictEqual(gaps(node26, shipped), []);
  // the control: the flip is real for a shim without its closure, so the guard below must hold
  assert.deepStrictEqual(gaps(node24, bare), ['buffer.SlowBuffer']);
  assert.deepStrictEqual(gaps(node26, bare), []);
});

test('shim surface: the ext-dep closure is derived from libexec and found where requireExt looks', () => {
  assert.ok(collect.shimExtDeps().includes('buffer'), 'buffer.cjs takes feross buffer through requireExt');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shim-extdeps-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    assert.deepStrictEqual(collect.missingExtDeps({ env: {}, repo, deps: ['buffer'] }), ['buffer']);
    const np = path.join(tmp, 'np');
    fs.mkdirSync(path.join(np, 'buffer'), { recursive: true });
    fs.writeFileSync(path.join(np, 'buffer', 'package.json'), '{}');
    assert.deepStrictEqual(collect.missingExtDeps({ env: { NODE_PATH: np }, repo, deps: ['buffer'] }), []);
    fs.mkdirSync(path.join(repo, 'deps', 'claude', 'node_modules', 'buffer'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'deps', 'claude', 'node_modules', 'buffer', 'package.json'), '{}');
    assert.deepStrictEqual(collect.missingExtDeps({ env: {}, repo, deps: ['buffer'] }), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
