'use strict';
// PHASE 5B, TASK 4. `libexec/target-update-check.cjs` is the target-side (quaude/naude)
// "is a newer Claude Code available?" check — a pure network GET + semver compare that
// runs INSIDE a built target with no clode builder present (see the module's own header
// comment). It has exactly ONE throw-site: `resolveLatest()`'s
// `if (!res || !res.ok) throw new Error(...)`. `checkUpdate()` wraps every call to
// `resolveLatest()` in its own try/catch and downgrades ANY throw to `{state:'unknown'}`,
// so in normal operation the throw is invisible from the outside — both real call sites
// (`libexec/extract-claude-js.cjs`, `libexec/naude-entry.cjs`) only ever call
// `checkUpdate()`, never `resolveLatest()` directly. Per decision #3's reachability
// survey, `resolveLatest` is nonetheless exported (`module.exports = { resolveChannel,
// releasesBase, resolveLatest, checkUpdate }`) — verified below — so this guard exercises
// it directly: a regression that removed or weakened the throw would be invisible to any
// test that only calls `checkUpdate()` (its blanket catch would keep "working", just
// returning a DIFFERENT, WRONG state — see the consequence test near the bottom of this
// file for exactly that scenario made concrete).
//
// This is the house-shape (defineGuard/guardTests, per test/build-gates/
// lexical-code-mask.test.cjs, dep-closure-gates.test.cjs, host-provision-gates.test.cjs).
//
// The literal relative require below is load-bearing for Task 5's population sweep, which
// derives "which guard controls this production gate" by reading this exact string out of
// the guard's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLatest, resolveChannel, checkUpdate } = require('../../libexec/target-update-check.cjs');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const LIBEXEC = path.join(REPO, 'libexec');
const SCRIPTS = path.join(REPO, 'scripts');
const PRODUCTION_MODULE = path.join(LIBEXEC, 'target-update-check.cjs');

// ==========================================================================
// ASYNC BRIDGE — why this guard's read()/control()/scan() are plain synchronous
// functions even though the production function they wrap is not.
// ==========================================================================
//
// `resolveLatest()` is declared `async`: even its earliest possible return (the
// numeric-channel fast path) is wrapped in a Promise, and the throw this guard controls
// fires only after `await fetchImpl(...)` — a real promise suspension. Neither outcome
// can be observed inside a synchronous try/catch, and guard.cjs's `scan()` contract is
// deliberately synchronous (see test/guards-population.cjs's own account of leaving
// `fs.promises.rename()` as a standalone test for this exact reason — "guard.cjs's
// scan() contract is synchronous, and unwrapping a promise inside it needs a
// microtask-flush hack this batch did not take on"). Rather than leave this gate
// un-migrated the same way, the one genuinely async step — calling the REAL, exported
// `resolveLatest()` and recording whether it throws — runs exactly once, in the
// `test.before()` hook below, which node:test fully awaits before any `test()` in this
// file executes. Every `read()`/`control()`/`scan()` after that point is a plain, pure,
// synchronous function over the ALREADY-SETTLED outcome: no promise ever crosses
// checkGate()/checkControl(), and nothing here re-derives resolveLatest's verdict — the
// recorded outcome IS resolveLatest's real return value or real thrown message,
// captured verbatim.
async function callRealResolveLatest(channel, opts) {
  try {
    const latest = await resolveLatest(channel, opts);
    return { threw: false, latest };
  } catch (e) {
    return { threw: true, message: String((e && e.message) || e) };
  }
}

// WHAT INPUT TRIPS IT (measured): resolveLatest('latest', { fetchImpl }) where fetchImpl
// resolves to `{ ok: false, status: 404, text: async () => '5.0.0\n' }` throws
// `channel latest: HTTP 404` — verified directly here, with no guard machinery involved,
// before anything else in this file touches it.
const VIOLATION_BODY = '5.0.0\n';
test('measured: resolveLatest throws on a failing HTTP response, naming the channel and status', async () => {
  await assert.rejects(
    () => resolveLatest('latest', {
      env: {}, fetchImpl: async () => ({ ok: false, status: 404, text: async () => VIOLATION_BODY }),
    }),
    (e) => { assert.match(e.message, /channel latest: HTTP 404/); return true; },
  );
});

// The violation body is deliberately a well-formed, NEWER-than-any-shipped version
// string: proof that the throw is guarding a real "wrong answer" risk, not a formality.
test('the violation control body would itself read as a plausible, newer version', () => {
  assert.match(VIOLATION_BODY.trim(), /^\d+\.\d+\.\d+$/);
});

// Reachability survey (decision #3): checkUpdate, resolveChannel and resolveLatest are
// all exported, callable functions, as the brief and this guard both assume.
test('checkUpdate, resolveChannel and resolveLatest are all exported functions', () => {
  assert.strictEqual(typeof checkUpdate, 'function');
  assert.strictEqual(typeof resolveChannel, 'function');
  assert.strictEqual(typeof resolveLatest, 'function');
});

// ==========================================================================
// GUARD — resolveLatest()'s ONE throw-site.
// ==========================================================================
//
// WHAT IT GUARDS. `resolveLatest` GETs a channel's version file and hands back its
// trimmed body as "the latest version" if, and only if, the response is genuinely ok;
// any falsy response or non-2xx status must throw rather than pass along whatever body
// came with it. This is the ONLY thing standing between a failed request and a
// fabricated "latest version" — `checkUpdate` places no other check on `resolveLatest`'s
// return value before comparing it against `current` (its own `if (!latest) return
// {state:'unknown', ...}` only catches an EMPTY string, not a wrong-but-present one).
//
// HOW FAKES AVOID THE NETWORK AND THE REAL CACHE. `fetchImpl` below is a plain async
// function returning a canned, in-memory object literal — it never calls the real global
// `fetch`, never resolves a hostname, never opens a socket. `env` is a plain `{}` (no
// `CLODE_RELEASES_URL` override is ever dereferenced — `releasesBase(env)` only builds a
// URL STRING, handed to the fake `fetchImpl`, which ignores it). `target-update-check.cjs`
// itself never touches the filesystem at all (confirmed by inspection: the whole module
// is fetch + string manipulation, no `fs`/`path`/`os` import anywhere in it) — there is no
// cache, Keychain, or `~/.local/*` path for this guard to avoid writing to, because the
// module's own job never writes to disk.
//
// WHAT INPUT TRIPS IT (measured, verified live above): `resolveLatest('latest', {
// fetchImpl })` where `fetchImpl` resolves to `{ ok: false, status: 404, text: async () =>
// '5.0.0\n' }` throws `channel latest: HTTP 404`. See the consequence test below, which
// runs the real `checkUpdate()` over this same response and shows today's code correctly
// refuses to surface `'5.0.0'` as an upgrade target.
function wellFormedInputs() {
  return {
    channel: 'latest',
    opts: { env: {}, timeoutMs: 50, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '2.1.300\n' }) },
  };
}

function violationInputs() {
  return {
    channel: 'latest',
    opts: { env: {}, timeoutMs: 50, fetchImpl: async () => ({ ok: false, status: 404, text: async () => VIOLATION_BODY }) },
  };
}

let WELL_FORMED_OUTCOME = null;
let VIOLATION_OUTCOME = null;

test.before(async () => {
  const wf = wellFormedInputs();
  WELL_FORMED_OUTCOME = await callRealResolveLatest(wf.channel, wf.opts);
  const v = violationInputs();
  VIOLATION_OUTCOME = await callRealResolveLatest(v.channel, v.opts);
});

// read()/control(): synchronous handles onto the already-settled outcomes computed
// above by actually calling the real, exported resolveLatest() (see the ASYNC BRIDGE
// note). Neither performs any I/O of its own.
function readWellFormedOutcome() {
  if (!WELL_FORMED_OUTCOME) throw new Error('readWellFormedOutcome: test.before() has not run yet');
  return { outcome: WELL_FORMED_OUTCOME };
}

function violationControlInputs() {
  if (!VIOLATION_OUTCOME) throw new Error('violationControlInputs: test.before() has not run yet');
  return { outcome: VIOLATION_OUTCOME };
}

// PURE: no I/O, no re-derivation of resolveLatest's own judgment. The finding, when
// there is one, is exactly the real thrown message resolveLatest produced, recorded
// verbatim by callRealResolveLatest() above — never a second copy of "what should have
// thrown".
function scanResolveLatestOutcome({ outcome }) {
  return { findings: outcome.threw ? [outcome.message] : [], examined: 1 };
}

// Measured 2026-09-12: this guard checks exactly one real call through resolveLatest's
// throw-guarded (network) branch per run, so `examined` is always 1 on a clean call —
// there is no analogous "which ids get checked" corpus the way host-provision's REGISTRY
// gives its call-site scan a real range (see host-provision-gates.test.cjs GUARD 2's own
// identical disclosure for the precedent). Disclosed honestly rather than padded, per
// decision #2: the floor-fire demonstration below exercises `examined: 0` directly
// through the same production-calling `scanResolveLatestOutcome`, since a real call can
// never itself produce fewer than 1.
const guard1 = defineGuard({
  name: 'target-update-resolvelatest-http-failure',
  floor: 1,
  read: readWellFormedOutcome,
  scan: scanResolveLatestOutcome,
  control: violationControlInputs,
});
guardTests(guard1);

// The concrete "wrong answer sends a user to a wrong version" consequence: run the real,
// public checkUpdate() (the ONLY thing either real call site ever calls) over the exact
// same failing response and show it still reports 'unknown', never 'newer'/'5.0.0'.
test('consequence: checkUpdate() reports "unknown", never "newer 5.0.0", for the exact same failing response', async () => {
  const v = violationInputs();
  const order = (a, b) => (a === b ? 0 : a > b ? 1 : -1);
  const r = await checkUpdate({
    current: '2.1.218', channel: v.channel, env: v.opts.env,
    fetchImpl: v.opts.fetchImpl, semverOrder: order, timeoutMs: v.opts.timeoutMs,
  });
  assert.deepStrictEqual(r, { state: 'unknown', latest: null, current: '2.1.218' },
    'a failing HTTP response must never surface as a version to upgrade to, however '
    + 'plausible its body looks');
});

test('floor fires: target-update-resolvelatest-http-failure goes BROKEN below its floor', () => {
  // Same shape as host-provision-gates.test.cjs GUARD 2's floor-probe: a single real call
  // can never itself produce examined < 1, so this proves checkGate()'s floor wiring for
  // THIS guard's exact floor value via a stand-in scan, not a re-derivation of
  // scanResolveLatestOutcome's own logic.
  const r = checkGate({
    name: 'floor-probe-1', floor: guard1.floor,
    read: () => ({}),
    scan: () => ({ findings: [], examined: 0 }),
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

// ==========================================================================
// GUARD 2 — the safety net around the throw-site: no OTHER production source calls
// resolveLatest() directly.
// ==========================================================================
//
// WHAT IT GUARDS. GUARD 1 above proves the throw-site itself still fires. That is only a
// safe design because `checkUpdate()` is the SOLE production caller and always catches
// it (see this file's header comment). A future call site that invoked `resolveLatest()`
// directly — bypassing `checkUpdate()`'s try/catch — would let the exact same throw
// escape UNCAUGHT: a crash instead of a graceful 'unknown'. This guard keeps that claim
// true by re-checking it, over the real shipped source, on every run — the same
// call-site-scan shape host-provision-gates.test.cjs's GUARD 1 uses, adapted from
// "every call site names a KNOWN id" to "no call site bypasses the catcher".
//
// HOW FAKES AVOID THE NETWORK AND THE REAL CACHE. The only I/O here is `fs.readFileSync`
// over this repo's own `libexec/` and `scripts/` source — never `~/.local/share/clode` or
// anything this guard could write to (nothing does; this guard never writes).
//
// WHAT INPUT TRIPS IT (measured): a file other than `libexec/target-update-check.cjs`
// itself containing a bare `resolveLatest(` call. See the control below, which is exactly
// that file, synthesised.
//
// WHERE THE DETECTION LIVES, and why it moved (FIX ROUND 2, reviewer 2026-09-12). The first
// cut did the whole job — the walk, stripLineComments, and the regex — inside `read()`, and
// `scan()` was a bare `sites.map(...)`. `checkControl()` never calls `read()`, so the
// control proved only that `.map()` works: mutating RESOLVE_LATEST_CALL_RE to
// `/\bresolveLatestXX\s*\(/` left every test in this file green, forever. The floor did not
// save it either — `examined` was the FILE count, which is independent of the regex, so a
// blind regex still read OK (contrast host-provision-gates.test.cjs GUARD 1, whose floor IS
// the detection count). And because the real corpus contains no direct caller, the regex's
// true-positive path had never executed against anything at all. So `read()` is now pure
// I/O — it hands back the source TEXT — and every act of detection happens in `scan()`,
// where the control reaches it.
const RESOLVE_LATEST_CALL_RE = /\bresolveLatest\s*\(/;

// The one file allowed to call resolveLatest() directly: checkUpdate() lives in it and its
// call is the caught one. It is still READ and still EXAMINED — it is exempted by name in
// scan(), not skipped unseen, so `examined` stays an honest count of what was inspected.
const PRODUCTION_MODULE_REL = path.relative(REPO, PRODUCTION_MODULE);

// read() — the only I/O in this guard: the repo's own libexec/ and scripts/ source, never
// ~/.local/share/clode or anything this guard could write to. No detection here.
function readRealSourceFiles() {
  const files = [
    ...discoverFilesByExt(LIBEXEC, ['.cjs', '.js']),
    ...discoverFilesByExt(SCRIPTS, ['.mjs', '.cjs', '.js']),
  ];
  return { sources: files.map((f) => ({ file: path.relative(REPO, f), text: fs.readFileSync(f, 'utf8') })) };
}

// PURE: no I/O. Every judgment this guard makes is here — comment stripping, the regex, the
// one exemption — so the control exercises all of it. `examined` is the size of the real
// corpus scanned (every libexec/scripts source file), not the (normally zero) match count:
// a shrinking corpus is exactly what should make this guard go BROKEN, not "cleaner".
function scanNoDirectResolveLatestCalls({ sources }) {
  const findings = [];
  for (const { file, text } of sources) {
    // Examined, then exempted: checkUpdate's own, caught call is not a violation.
    if (file === PRODUCTION_MODULE_REL) continue;
    if (!RESOLVE_LATEST_CALL_RE.test(stripLineComments(text))) continue;
    findings.push(`${file}: calls resolveLatest() directly, outside `
      + `checkUpdate()'s try/catch — its one throw-site would escape uncaught here`);
  }
  return { findings, examined: sources.length };
}

// TWO synthetic sources, and the second one is the point. The first is a real direct caller
// and MUST be found — it is the only place the regex's true-positive path ever runs, since
// the real corpus (correctly) contains no such caller. The second mentions `resolveLatest(`
// in a `//` COMMENT and must NOT be found, which puts stripLineComments under test for the
// first time: a guard that reported every prose mention of the function as a bypassing call
// site would be noise, and this control fails if it becomes one (see the test below, which
// asserts the control produces EXACTLY the one finding).
function directCallControlInputs() {
  return {
    sources: [
      { file: 'synthetic/control-direct-caller.cjs',
        text: "const { resolveLatest } = require('./target-update-check.cjs');\n"
          + "const latest = await resolveLatest('latest', {});\n" },
      { file: 'synthetic/control-comment-only.cjs',
        text: '// a prose mention of resolveLatest(channel) in a comment, like this file\'s\n'
          + '// own header and naude-entry.cjs\'s — not a call site.\nconst x = 1;\n' },
    ],
  };
}

// Measured 2026-09-12: calling the real, exported readRealSourceFiles() directly from
// the repo root (`node -e "console.log(require('./test/build-gates/
// target-update-gates.test.cjs').readRealSourceFiles().sources.length)"`) counts 114 real
// source files. This is NOT the same as a shell `find libexec scripts -name '*.cjs' -o
// ...` count (129) — this NFS checkout carries stray macOS AppleDouble shadow files
// (`libexec/._build-compose.cjs` and eight siblings) that `find`'s glob matches and
// readRealSourceFiles()'s own dotfile exclusion correctly does not; see task-4-report.md
// for both counts and the exact commands. The floor is the exact count this guard's own
// read() produces — a drop means either the corpus shrank for real (in which case this
// floor should move with it) or read() broke.
const guard2 = defineGuard({
  name: 'target-update-no-direct-resolvelatest-callers',
  floor: 114,
  read: readRealSourceFiles,
  scan: scanNoDirectResolveLatestCalls,
  control: directCallControlInputs,
});
guardTests(guard2);

// The control's SECOND source is what this pins: checkControl() only demands "at least one
// finding", so a scan that reported both sources — every prose mention of resolveLatest( in
// the tree — would still certify as "can fail" while being useless. Exactly one finding,
// naming the real caller and not the comment, is the claim.
test('the control finds the direct caller and NOT the comment-only mention', () => {
  const r = scanNoDirectResolveLatestCalls(directCallControlInputs());
  assert.strictEqual(r.findings.length, 1, `expected exactly one finding, got: ${r.findings.join(' | ')}`);
  assert.match(r.findings[0], /control-direct-caller\.cjs/);
  assert.doesNotMatch(r.findings[0], /control-comment-only\.cjs/,
    'a `// resolveLatest(...)` mention in a comment is not a call site — stripLineComments '
    + 'is part of the detection and must run where the control can reach it');
  assert.strictEqual(r.examined, 2);
});

test('floor fires: target-update-no-direct-resolvelatest-callers goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-2', floor: guard2.floor,
    read: () => ({ sources: [{ file: 'x.cjs', text: '' }] }), // far fewer than the real 114
    scan: scanNoDirectResolveLatestCalls,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = {
  readWellFormedOutcome, scanResolveLatestOutcome, violationControlInputs, guard1,
  readRealSourceFiles, scanNoDirectResolveLatestCalls, directCallControlInputs, guard2,
};
