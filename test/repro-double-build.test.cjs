'use strict';
// The double-build runner's ALWAYS-ON half: everything about it that can be checked
// without spending two engine builds.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. The expensive half runs weekly, in a scheduled
// workflow, in a log nobody opens unless it is red. If the runner's argument handling or
// its leg-config derivation rots, that job fails with a usage error and reports nothing —
// a gate that runs and measures nothing, which this repo has already been bitten by. These
// tests are what keep the weekly job's failure mode "the engine is not reproducible"
// rather than "the script does not start".
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  legBuildEnv, describeConfig, doubleBuildEngine, doubleBuildEnv,
} = require('./repro-double-build.cjs');
const { VERDICTS } = require('./repro-verdicts.cjs');
// The launcher's OWN reader, so this file cannot drift into testing a spelling
// scripts/ccache-launcher.cjs does not recognise.
const { ccacheOptedOut } = require('../scripts/ccache-launcher.cjs');

const REPO = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'repro-double-build.cjs');

function legsByName() {
  const all = new Map();
  for (const tier of ['release', 'ci']) {
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/tjs-legs.mjs'), tier],
      { encoding: 'utf8' });
    for (const l of JSON.parse(out)) all.set(l.leg, l);
  }
  return all;
}

// ---- the precondition the whole measurement rests on ---------------------------------
//
// THE GATE THAT COULD NOT FAIL. baseEnv passes PATH and HOME straight through, so on any
// box with ccache installed scripts/build-tjs.cjs enables the compiler launcher and phase
// B is served entirely from the cache phase A warmed: neither phase re-runs the compiler,
// the whole-binary compare passes trivially, and the verdict keeps reading `reproducible`
// while checking almost nothing but the link. True on this developer box since
// scripts/ccache-launcher.cjs's task 2 installed a real ccache, and newly reachable in CI
// now that .github/actions/build-leg installs one on 27 of the 42 legs.

test('the double build opts OUT of ccache, or it measures the cache instead of the compiler', () => {
  const env = doubleBuildEnv({ vendorParent: '/v', outDir: '/o', buildRoot: '/b' });
  assert.strictEqual(env.CLODE_TJS_CCACHE, '0',
    'without this, phase B is served from the cache phase A warmed and the compare is vacuous');
  // The spelling has to be the one scripts/ccache-launcher.cjs actually reads, not a
  // plausible-looking neighbour — ccacheOptedOut() tests for exactly '0'.
  assert.strictEqual(ccacheOptedOut(env), true,
    'the opt-out must be the value the launcher itself recognises');
});

test('a leg config cannot switch ccache back on', () => {
  // legBuildEnv never sets it today; this pins that a future leg knob (or a caller
  // experimenting) cannot empty the gate by accident. The `perturb` seam remains the
  // supported way to show this gate can go red.
  const env = doubleBuildEnv({
    vendorParent: '/v', outDir: '/o', buildRoot: '/b', buildEnv: { CLODE_TJS_CCACHE: '1' },
  });
  assert.strictEqual(env.CLODE_TJS_CCACHE, '0');
  assert.strictEqual(ccacheOptedOut(env), true);
});

test('the leg knobs that ARE a caller seam still win over the defaults', () => {
  // The control for the test above: proving the override is refused only means something
  // if overrides are otherwise honoured.
  const env = doubleBuildEnv({
    vendorParent: '/v', outDir: '/o', buildRoot: '/b', buildEnv: { CLODE_TJS_WASM: 'off' },
  });
  assert.strictEqual(env.CLODE_TJS_WASM, 'off');
  assert.strictEqual(env.CLODE_TJS_OUT, '/o', 'and the fixed paths are untouched');
});

// ---- the engine config a verdict is ABOUT -------------------------------------------
//
// THE SCAR THIS SERVES. The first linux-x64-glibc proof was run with WASM OFF while the
// release leg builds it ON, so the verdict covered a config the leg does not ship. It had
// to be re-run. The runner therefore derives each leg's knobs from scripts/tjs-legs.mjs
// rather than taking the host default.

test('legBuildEnv derives a lean leg\'s knobs from the leg manifest, not the host default', () => {
  const legs = legsByName();
  const netbsd = legs.get('netbsd-amd64');
  assert.strictEqual(netbsd.wasm, 'off', 'precondition: netbsd-amd64 is a lean leg');
  assert.deepStrictEqual(legBuildEnv(netbsd), {
    CLODE_TJS_WASM: 'off', CLODE_TJS_MIMALLOC: 'off', CLODE_TJS_FFI: 'off',
  });
});

test('legBuildEnv passes the static flag for the musl publishers', () => {
  const legs = legsByName();
  assert.strictEqual(legBuildEnv(legs.get('linux-x64-musl')).CLODE_TJS_STATIC, '1');
});

test('legBuildEnv pushes NOTHING for a leg that takes the defaults', () => {
  const legs = legsByName();
  const darwin = legs.get('darwin-arm64');
  assert.strictEqual(darwin.wasm, undefined, 'precondition: darwin-arm64 declares no knobs');
  assert.deepStrictEqual(legBuildEnv(darwin), {},
    'a leg with no engine-config keys must inherit build-tjs.cjs\'s own defaults, exactly '
    + 'as that leg\'s CI job does — pushing an explicit value here would make the gate '
    + 'measure a config the leg does not build');
});

test('describeConfig records every knob, naming the defaulted ones as defaulted', () => {
  assert.strictEqual(describeConfig({ CLODE_TJS_WASM: 'off' }),
    'wasm=off mimalloc=default ffi=default static=default');
});

// ---- the CLI refuses rather than guesses ---------------------------------------------

test('the runner REFUSES to guess which leg it is on', () => {
  const r = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--leg is required/,
    'a runner that inferred "I am darwin/arm64 so this must be darwin-arm64" would happily '
    + 'label a differently-configured engine with a leg it is not');
});

test('the runner refuses an unknown leg and lists the real ones', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--leg', 'linux-x64-gnu'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown leg 'linux-x64-gnu'/);
  assert.match(r.stderr, /darwin-arm64/, 'the refusal must name the legs that DO exist');
});

test('the runner rejects an unrecognised argument instead of ignoring it', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--leg', 'darwin-arm64', '--fast'],
    { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown argument '--fast'/);
});

// ---- the runner refuses to clone, and says so ------------------------------------------

test('doubleBuildEngine refuses a missing vendor checkout rather than cloning 785MB', () => {
  assert.throws(() => doubleBuildEngine({
    legName: 'darwin-arm64', sharedCheckout: path.join(REPO, 'no-such-checkout'),
  }), /no vendor checkout/);
});

// ---- every leg the runner can be pointed at has a verdict to be judged against ---------

test('every leg the CLI accepts has a manifest entry to judge it against', () => {
  const missing = [...legsByName().keys()].filter((n) => !VERDICTS[n]);
  assert.deepStrictEqual(missing, [],
    'the CLI resolves legs from scripts/tjs-legs.mjs and judges them against '
    + 'test/repro-verdicts.cjs; a leg in the first and not the second makes the runner '
    + 'throw AFTER two engine builds, which is the most expensive possible place to '
    + 'discover it');
});

test('the runner refuses a CROSS leg before spending two builds, not after', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--leg', 'netbsd-m68k'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /not built natively/,
    'pointing the runner at a cross leg must be refused in milliseconds — running it would '
    + "double-build the HOST engine and record the verdict under that leg's name, which is "
    + 'the one outcome worse than having no verdict');
  assert.match(r.stderr, /cross-file/, 'the refusal must name the FIELD that made it non-native');
});

test('the runner refuses a guest-container leg too', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--leg', 'linux-x64-musl'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /guest-platform/);
});
