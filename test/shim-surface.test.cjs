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
  let staged = null;
  try { staged = models.stageProviderCli({ env: process.env }); } catch { /* fall through */ }
  if (!staged || !staged.cli || !fs.existsSync(staged.cli)) {
    _inputs = { skip: 'no staged provider bundle (CLODE_PROVIDER_BIN)' };
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

test('shim surface: the two-layer gap inventory matches the golden map', (t) => {
  const inp = inputs();
  if (inp.skip) { t.skip(inp.skip); return; }

  const m = measure(inp.cli);
  const actual = {
    layer1_bun_props_missing: m.l1.propGaps.map((g) => g.api),
    layer1_bun_modules_missing: m.l1.moduleGaps,
    layer1_bun_modules_intercepted_but_unused: m.l1.unusedIntercepts,
    layer2_node_apis_missing: m.l2.gaps.map((g) => g.api),
  };

  if (process.env.UPDATE_GOLDEN === '1') {
    const prev = fs.existsSync(GOLDEN_PATH)
      ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ ...prev, ...actual }, null, 2)}\n`);
    t.diagnostic('golden regenerated (UPDATE_GOLDEN=1)');
    return;
  }

  assert.ok(fs.existsSync(GOLDEN_PATH),
    `missing ${GOLDEN_PATH}; regenerate with UPDATE_GOLDEN=1`);
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  for (const key of Object.keys(actual)) {
    const exp = golden[key] || [];
    const got = actual[key];
    const added = got.filter((x) => !exp.includes(x));
    const removed = exp.filter((x) => !got.includes(x));
    assert.deepStrictEqual({ key, added, removed }, { key, added: [], removed: [] },
      `${key} drifted.\n`
      + `  NEW gaps (upstream now reaches for these, we do not provide them): ${JSON.stringify(added)}\n`
      + `  GONE (we implemented them, or upstream stopped): ${JSON.stringify(removed)}\n`
      + '  Review, then regenerate with UPDATE_GOLDEN=1 and record WHY in golden.json notes.');
  }
});

// The measurement is only trustworthy if every shim module could actually be
// enumerated on both sides. A module that failed to load would otherwise
// contribute zero gaps and read exactly like a clean one — the "a skipped oracle
// is not a pass" failure mode, in miniature.
test('shim surface: every shim module was enumerable on both sides', (t) => {
  const inp = inputs();
  if (inp.skip) { t.skip(inp.skip); return; }

  const m = measure(inp.cli);
  const golden = fs.existsSync(GOLDEN_PATH)
    ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
  const allowed = golden.unenumerable_allowed || [];
  const unexpected = m.l2.unenumerable
    .map((u) => u.module)
    .filter((mod) => !allowed.includes(mod));

  assert.deepStrictEqual(unexpected, [],
    `these shim modules could not be enumerated on both sides, so their gaps are UNKNOWN`
    + ` (not zero): ${JSON.stringify(unexpected)}.\n`
    + `  Full detail: ${JSON.stringify(m.l2.unenumerable, null, 2)}`);
});

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
