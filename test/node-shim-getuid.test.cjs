'use strict';
// process.getuid() (Task 5, Class C — genuine gap, PROVEN behavioral impact).
// Real uid, over tjs.system.userInfo.userId (the real libuv primitive — see
// libexec/node-shim/modules/process.cjs's unixGetuid comment), falling back
// to the same shell-out pattern process.arch already uses (`id -u -r`) only
// if that primitive is ever unavailable, and DEGRADING to 0 (never throwing)
// as an absolute last resort — a getuid() call must not be able to crash a
// process real Node starts successfully.
//
// ACCEPTANCE TEST (not just "the function exists"): the bundle computes its
// tmp-dir prefix as `claude-${process.getuid?.() ?? 0}` (found verbatim in
// the extracted 2.1.218 cli.js, function wC()). Without process.getuid,
// quaude falls back to uid 0 (`claude-0`) while naude/real Node computes the
// operator's real uid (`claude-502` on this box) — two processes on the SAME
// machine landing in DIFFERENT tmp sandboxes, a confirmed contributor to
// test/fidelity/agentic-subagent-diff.test.cjs's divergence. This test proves
// that divergence actually CLOSES: quaude's computed prefix must equal the
// real host's os.getuid()-derived prefix, not merely that process.getuid is
// callable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-getuid-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('process.getuid() is a function on POSIX and returns a real number', (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.platform === 'win32') { t.skip('process.getuid is POSIX-only'); return; }
  const f = writeProg(`
    console.log(JSON.stringify({
      isFunction: typeof process.getuid === 'function',
      uid: process.getuid(),
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.isFunction, true);
  assert.strictEqual(typeof out.uid, 'number');
  assert.ok(Number.isInteger(out.uid) && out.uid >= 0, `uid must be a non-negative integer, got ${out.uid}`);
});

// A uid to drop to when the test runner is itself root. Any number works —
// we compare against the number we PASSED, never a name lookup — so this does
// not depend on the container having a 'nobody' entry (alpine does: 65534).
const DROP_UID = 65534;

// WHY THIS ROW HAS TWO MODES. The oracle below is "the prefix quaude computes
// is not the ?? 0 default". That assertion is VALUE-BLIND when the test runner
// is uid 0: `claude-0` is simultaneously the right answer and the fallback's
// answer, and no amount of reading the output can tell them apart. This is not
// hypothetical — the musl reference leg runs in a node:24.18.1-alpine
// container as root, and this row failed there with
// `actual: 'claude-0', expected: 'claude-0'` on a notStrictEqual: a test
// asserting a thing its environment had made unobservable.
//
// So: when the runner is NOT root (every dev box, the darwin leg), assert
// exactly as before. When the runner IS root, don't weaken the oracle — move
// it. Run the same fixture with the privileges DROPPED to a non-zero uid,
// where `claude-<DROP_UID>` and the `?? 0` fallback are once again distinct
// strings. That is strictly STRONGER than the non-root form: it proves the
// shim read a uid it could not have guessed. If the drop itself is not
// possible in this environment (spawn uid EPERM, or the engine/repo not
// readable by the dropped uid), we say so out loud and fall back to the one
// discrimination that survives at uid 0 — process.getuid being PRESENT rather
// than absent-and-defaulted — while naming what went untested.
test('ACCEPTANCE: the bundle tmpdir prefix (claude-<uid>) matches the real host uid — the quaude/naude divergence closes', (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.platform === 'win32') { t.skip('process.getuid is POSIX-only'); return; }
  if (typeof process.getuid !== 'function') { t.skip('host node has no process.getuid (non-POSIX host)'); return; }
  // Reproduce the EXACT expression found in the extracted cli.js (function
  // wC()): `claude-${process.getuid?.()??0}`.
  const f = writeProg(`
    const prefix = \`claude-\${process.getuid?.()??0}\`;
    console.log(JSON.stringify({ prefix, isFunction: typeof process.getuid === 'function' }));`);
  const realUid = process.getuid();

  if (realUid !== 0) {
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    const { prefix } = JSON.parse(r.stdout.trim());
    const naudePrefix = `claude-${realUid}`;
    assert.notStrictEqual(prefix, 'claude-0',
      `quaude fell back to the uid-0 default (${prefix}) — the divergence this test exists to close did NOT close`);
    assert.strictEqual(prefix, naudePrefix,
      `quaude computed ${prefix} but naude/real-node (real uid ${realUid}) computes ${naudePrefix} — tmp sandboxes would still diverge`);
    return;
  }

  // --- runner is root: relocate the oracle to a dropped uid ---
  // mkdtemp is 0700 and owned by root; the dropped child must be able to
  // traverse and read the fixture it is asked to run.
  const dir = path.dirname(f);
  try { fs.chmodSync(dir, 0o755); fs.chmodSync(f, 0o644); } catch { /* reported below */ }
  const dropped = runLoader(f, [], { uid: DROP_UID, gid: DROP_UID });
  let droppedPrefix = null;
  if (dropped.status === 0) {
    try { droppedPrefix = JSON.parse(dropped.stdout.trim()).prefix; } catch { /* fall through */ }
  }

  if (droppedPrefix !== null) {
    assert.strictEqual(droppedPrefix, `claude-${DROP_UID}`,
      `running as uid ${DROP_UID}, quaude computed ${droppedPrefix} — `
      + (droppedPrefix === 'claude-0'
        ? 'that is the ?? 0 default, i.e. process.getuid did not report the real uid'
        : 'which is neither the real uid nor the default'));
    return;
  }

  // The drop did not run. Say exactly what is now untested rather than
  // pretending a green row means the divergence closed.
  t.diagnostic('UID-0 RUNNER: could not re-run the fixture with privileges dropped to uid '
    + `${DROP_UID} (status=${dropped.status}, error=${dropped.error && dropped.error.code}, `
    + `stderr=${JSON.stringify((dropped.stderr || '').slice(-400))}). `
    + 'NOT TESTED HERE: whether quaude READ the real uid or silently fell back to the '
    + '`?? 0` default — at uid 0 those two produce the identical string "claude-0", so no '
    + 'assertion on the output can separate them. What IS still tested below: that '
    + 'process.getuid EXISTS (an absent getuid makes `process.getuid?.()` undefined and '
    + 'takes the ?? 0 branch, which IS observable), and that the prefix equals the one '
    + 'naude/real node computes.');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const { prefix, isFunction } = JSON.parse(r.stdout.trim());
  assert.strictEqual(isFunction, true,
    'process.getuid is absent under the shim — `process.getuid?.() ?? 0` therefore takes the '
    + 'default branch, and the prefix below only LOOKS right because this runner happens to be uid 0');
  assert.strictEqual(prefix, `claude-${realUid}`,
    `quaude computed ${prefix} but naude/real-node (real uid ${realUid}) computes claude-${realUid}`);
});

// REGRESSION (found by review): an earlier version of this fix used the
// WRONG primitive (a top-level `tjs.userInfo`, which never existed on any
// tjs version) as its primary path, so every real run fell through to the
// `id -u` subprocess fallback. With PATH stripped, that fallback failed too
// and the (then-unconditional) throw turned an absence into a CRASH — in an
// environment where both real Node and the correct native primitive
// (tjs.system.userInfo) succeed. This test is that exact repro: PATH
// stripped entirely, `process.getuid?.() ?? 0` (the bundle's own guarded
// call shape) must not throw. With the corrected primary path
// (tjs.system.userInfo — a native call, no subprocess involved) this
// actually SUCCEEDS with the real uid, not merely "degrades silently" —
// stronger than the minimum bar, and proof the fix no longer depends on
// PATH at all for the common case.
test('process.getuid() does not throw with PATH stripped (the primary path needs no subprocess)', (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.platform === 'win32') { t.skip('process.getuid is POSIX-only'); return; }
  const f = writeProg(`
    console.log(JSON.stringify({ uid: process.getuid?.() ?? 0 }));`);
  const r = runLoader(f, [], { env: { PATH: '/nonexistent-path-xyz' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const { uid } = JSON.parse(r.stdout.trim());
  assert.strictEqual(typeof uid, 'number');
  assert.strictEqual(uid, process.getuid(), 'the native tjs.system.userInfo path needs no PATH at all, so this must still be the REAL uid, not a degraded 0');
});

// NOTE: win32 gating (process.getuid absent, not present-but-undefined) is a
// plain `if (module.exports.platform !== 'win32')` in process.cjs, verified
// by code inspection — no win32 tjs engine is available in this environment
// to drive it end-to-end. The "every primitive AND the id(1) fallback are
// both unavailable" degrade-to-0 tail is likewise not independently driven
// here: tjs.system.userInfo is a native, non-configurable property on every
// real tjs engine (verified: attempting to delete/reassign it throws
// "could not delete property"/"no setter for property"), so that branch
// cannot be forced from JS without engine surgery — same as unixArch()'s own
// degrade-to-'x64' default has no dedicated "uname genuinely absent" test.
