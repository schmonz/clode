'use strict';
// The scope boundary scripts/build-tjs.cjs grew when it stopped being ESM, and the
// one class of bug that boundary can produce.
//
// THE INCIDENT THIS FILE EXISTS FOR (phase 4c1, fix round 1). Converting build-tjs
// from ESM to CommonJS left exactly one `await` that CJS cannot express at top
// level (provisionCosmocc's 441MB fetch), so everything from there to EOF moved
// inside `(async () => { ... })()`. The first cut opened that arrow ~55 lines too
// low, leaving `if (regenOnly)` at module top level while the four functions it
// calls — targetToken, buildHostTjsc, regenBytecodeArrays, and (then) assertBytecodeFresh —
// had moved inside the arrow. `function` declarations hoist to the ARROW's scope,
// not the module's, so `node scripts/build-tjs.cjs --regen-only` died at module
// load with "buildHostTjsc is not defined", before the arrow's own catch was even
// attached. .github/actions/build-leg/action.yml runs exactly that command for the
// qemu guest-bake legs, which would have failed and never regenerated the guest
// tarball.
//
// TWO THINGS LET IT THROUGH, and this file is one answer to each.
//
// (1) The pre-conversion check swept for const/let reads and found nothing,
//     because all four references are to HOISTED FUNCTION DECLARATIONS — the one
//     category that looks fine in a lexical scan and breaks anyway. The guard
//     below makes that sweep permanent and specific to function declarations, so
//     the next person to move that boundary does not have to remember.
//
// (2) test/tjs-bytecode-regen.test.cjs already covered --regen-only, but by
//     asserting on SOURCE TEXT (`assert.match(window, /buildHostTjsc\(/)`). That
//     assertion passes on a file where the call is a guaranteed ReferenceError: it
//     is structurally incapable of catching a scope error, because the property it
//     checks is "a call is written here", not "the call resolves". The first test
//     below therefore EXECUTES the mode.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { stripComments } = require('./strip-comments.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const BUILD_TJS = path.join(REPO, 'scripts/build-tjs.cjs');

// A txiki tree with the shape --regen-only's earlier phases demand and nothing
// else: --build-only handling wants CMakeLists.txt to exist, and the bundle
// verification wants the four JS_BUNDLES outputs (an EMPTY src/js/stdlib makes the
// per-stdlib half of that list empty, which is why this needs four files and not
// twenty). The tree is deliberately not buildable — reaching the compiler IS the
// result we want, because getting there means every name in the block resolved.
//
// PHASE 4c-2b TASK 2: the presence check now has a currency check right behind it
// (assertEsbuildInputsCurrent), which refuses outright when
// src/bundles/js/.clode-inputs.json is absent — exactly what this fixture looked like
// before this comment, and exactly what a pre-4c-2b tree looks like for real. A single
// fake input file per bundle, hashed for real, satisfies it without needing this
// fixture's src/js/** to be anything but a placeholder: what this file verifies
// (module-load scope resolution) does not depend on the recorded input being real
// txiki source, only on the manifest being HONEST for it (one recorded input, hash
// matching what is on disk) so the block downstream of the currency check is reached.
//
// PHASE 4c-2b FIX WAVE (whole-branch review, Minor 8): assertEsbuildInputsCurrent now
// treats a bundle recorded with ZERO inputs as stale rather than current — an empty
// `{}` map used to satisfy it for free, which is exactly the shortcut this fixture used
// to take. A real (if fake) input file plus its real hash is what keeps this fixture
// passing the stricter check while still not requiring a genuine esbuild run.
function fakeCheckout(dir) {
  const tjs = path.join(dir, 'txiki.js');
  fs.mkdirSync(path.join(tjs, 'src/js/stdlib'), { recursive: true });
  fs.mkdirSync(path.join(tjs, 'src/bundles/js/core'), { recursive: true });
  fs.writeFileSync(path.join(tjs, 'CMakeLists.txt'), '# not a real project\n');
  const manifest = {};
  for (const b of ['polyfills', 'core', 'run-main', 'run-repl']) {
    fs.writeFileSync(path.join(tjs, `src/bundles/js/core/${b}.js`), '//\n');
    const inputRel = `src/js/${b}-fake-input.js`;
    const inputContent = `// fake input for ${b}\n`;
    fs.writeFileSync(path.join(tjs, inputRel), inputContent);
    manifest[`src/bundles/js/core/${b}.js`] = {
      [inputRel]: crypto.createHash('sha256').update(inputContent).digest('hex'),
    };
  }
  fs.writeFileSync(path.join(tjs, 'src/bundles/js/.clode-inputs.json'), JSON.stringify(manifest));
  return tjs;
}

// WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the module loads, that the
// --regen-only block is REACHED, and that targetToken and buildHostTjsc resolve and
// run for real (buildHostTjsc appears as a stack FRAME, which a mis-scoped name
// cannot do — it would have thrown at the call site instead). It does NOT reach
// regenBytecodeArrays, because it needs a working host tjsc, which needs a real
// checkout and a full cmake build (~minutes). That name is covered by the guard
// below, which needs neither. A real end-to-end
// `node scripts/build-tjs.cjs --regen-only` against the cached vendor checkout was
// run by hand at fix time and regenerated all 18 bytecode arrays.
test('--regen-only gets past module load and into the block (EXECUTED, not grepped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-only-scope-'));
  try {
    fakeCheckout(dir);
    // Scrubbed rather than inherited: a CLODE_TJS_* knob set in the developer's
    // shell (CLODE_TJS_TARGET=cosmo above all, which would try to fetch 441MB)
    // would steer this run somewhere else entirely and the assertions would be
    // describing a different code path than the one they name.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^CLODE_/.test(k)) env[k] = v;
    env.CLODE_TJS_VENDOR = dir;
    env.CLODE_TJS_BUILD = path.join(dir, 'build');
    env.CLODE_CACHE = path.join(dir, 'cache');
    const r = spawnSync(process.execPath, [BUILD_TJS, '--regen-only'],
      { encoding: 'utf8', timeout: 120000, env });
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    // THE assertion. A scope error is a ReferenceError at the call site, and that
    // is what this whole file is about.
    assert.doesNotMatch(out, /ReferenceError|is not defined/,
      `--regen-only threw a scope error instead of reaching its work:\n${out}`);
    assert.match(out, /js bundles verified present/,
      `--regen-only did not get through module load and the --build-only source phase:\n${out}`);
    // The stack frame is the proof of resolution: buildHostTjsc was entered, so the
    // name bound. A mis-scoped name never produces a frame of its own.
    assert.match(out, /at buildHostTjsc /,
      `--regen-only never entered buildHostTjsc, so the block was not reached:\n${out}`);
    assert.notStrictEqual(r.status, 0,
      'the fake checkout is not buildable, so this run MUST fail at the compiler — '
      + 'a success here means the fixture stopped modelling the real mode');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the boundary itself ----------------------------------------------------
// PURE. `src` is the already-read build-tjs.cjs text. Deliberately narrowed to
// column-0 `function` declarations: those are the hoisting hazard, and restricting
// to them keeps the guard precise. A const/let sweep over the same boundary reports
// two hits that are only PARAMETER NAMES shadowing (dropStaleCmakeCache's
// `buildDir`, bytecodeBundlePairs' `stdlibFiles`) — noise that would train people
// to ignore this.
function scanContinuationScope({ src }) {
  const findings = [];
  let examined = 0;
  const lines = src.split('\n');
  const opener = lines.findIndex((l) => l.startsWith('(async () => {'));

  examined++;
  if (opener < 0) {
    return { findings: ['the async continuation opener `(async () => {` is gone from '
      + 'build-tjs.cjs — either the file went back to top-level await (it cannot: it is '
      + 'CommonJS) or the boundary moved and this guard is now blind'], examined };
  }

  // Comments are stripped with the repo's real tokenizer rather than a
  // line-starts-with-// test: prose above the boundary names these functions
  // constantly (that is how this file documents itself), and counting a mention in
  // a sentence as a call would make the guard cry wolf on its own explanations.
  const above = stripComments(lines.slice(0, opener).join('\n'));
  for (let i = opener; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    examined++;
    if (new RegExp(`\\b${m[1]}\\b`).test(above)) {
      findings.push(`${m[1]} is declared INSIDE the async continuation (line ${i + 1}) but `
        + `named above it — function declarations hoist to the arrow's scope, not the `
        + `module's, so that is a ReferenceError at module load. Move the calling `
        + `statement inside the continuation, or move the opener above it.`);
    }
  }
  return { findings, examined };
}

const continuationScopeGuard = defineGuard({
  name: 'build-tjs-continuation-scope',
  // 1 for the opener + one per function declared inside it (7 today). EXACT, not
  // padded: floor is a minimum, so legitimate growth only raises `examined`. If the
  // count FALLS the guard is inspecting less than it must and BROKEN is the right
  // answer — a human then lowers this deliberately.
  //
  // RE-CUT TWICE IN PHASE 4c-2, both deliberate, both recorded here because that is
  // the whole protocol this floor exists for. 8 -> 7: assertBytecodeFresh was
  // DELETED, not moved — regeneration became a cmake dependency edge, so a stale .c
  // is no longer a state the build can reach and a detector for it is no longer
  // meaningful. 7 -> 8: assertBytecodeRulesPresent was ADDED, because deleting that
  // detector is only safe while the injected rules are actually present, and a
  // --build-only over a pre-4c-2 tree is a real way for them not to be. Kept EXACT
  // rather than left at 7, so the next fall is still caught.
  floor: 8,
  read: () => ({ src: fs.readFileSync(BUILD_TJS, 'utf8') }),
  scan: scanContinuationScope,
  // The incident itself, in miniature: a top-level statement calling a function
  // that lives inside the continuation.
  control: () => ({ src: [
    'if (regenOnly) {',
    '  const tjsc = buildHostTjsc(tjsDir, targetToken(tjsDir));',
    '}',
    '(async () => {',
    'function targetToken(d) { return d; }',
    'function buildHostTjsc(d, t) { return t; }',
    'function regenBytecodeArrays() {}',
    'function assertBytecodeRulesPresent() {}',
    'function cmakeVersionSupportsIgnorePrefixPath() {}',
    'function bytecodeSymbolBase() {}',
    'function checkHermeticDeps() {}',
    '})();',
  ].join('\n') }),
});
guardTests(continuationScopeGuard);
