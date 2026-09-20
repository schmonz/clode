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
const { legBuildEnv, describeConfig, doubleBuildEngine } = require('./repro-double-build.cjs');
const { VERDICTS } = require('./repro-verdicts.cjs');

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
