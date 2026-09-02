'use strict';
// Positive-control proof that test/run.mjs's central `security`-shadow stub is
// actually reachable from a spawned child — not merely that PATH changed.
//
// WHY this file exists: the keychain EMULATION was deleted (BACKLOG.md,
// 2026-09-02) because upstream already falls back to ~/.claude/.credentials.json
// on its own. Deleting the emulation does NOT stop the bundle's own `security`
// calls from reaching the REAL binary — under a test-redirected HOME that pops a
// modal on the operator's screen ("Could not find a keychain to store
// <account>"). test/run.mjs now prepends a directory holding a stub `security`
// script to PATH before spawning the suite, so every child inherits the shadow.
//
// This project has been misled TWICE by an instrument reporting "zero security
// calls" when it simply was not being consulted (see child_process.cjs's git
// history, 2026-08-28: `_kcRealSec` bypassed PATH, so a PATH-wrapper reported
// zero calls for a client that was merely being intercepted elsewhere). A bare
// "no dialog appeared" assertion is exactly that kind of unfalsifiable evidence
// — it is equally true whether the stub ran OR `security` was never invoked at
// all. So this file does not just assert an absence; it resolves WHICH file a
// spawned child's PATH search would actually execute (`command -v security`)
// and separately proves an UNRELATED command still resolves to something
// OUTSIDE the stub dir — the positive control that the shadow is doing its one
// job (hide `security`) and nothing more (not silently eating the rest of PATH,
// the exact way an earlier attempt's EMPTY decoy dir shadowed nothing at all).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STUB_DIR = process.env.CLODE_TEST_SECURITY_STUB_DIR;

test('central security stub: test/run.mjs wired CLODE_TEST_SECURITY_STUB_DIR into PATH', (t) => {
  if (!STUB_DIR) {
    t.skip('CLODE_TEST_SECURITY_STUB_DIR not set — this file must run through test/run.mjs, ' +
      'not a standalone `node --test` of just this file');
    return;
  }
  const entries = String(process.env.PATH || '').split(path.delimiter);
  assert.ok(entries.includes(STUB_DIR),
    `PATH does not include the stub dir at all — a spawned child cannot reach it. PATH=${process.env.PATH}`);
});

// `security` only exists as a concept on darwin; there is nothing to shadow (or
// to accidentally invoke for real) anywhere else, so the resolution/behavior
// checks below only make sense there.
function skipUnlessDarwinStub(t) {
  if (!STUB_DIR) { t.skip('CLODE_TEST_SECURITY_STUB_DIR not set — run through test/run.mjs'); return true; }
  if (process.platform !== 'darwin') { t.skip('security(1) is darwin-only; the stub is a no-op elsewhere'); return true; }
  return false;
}

function resolvedPath(cmd) {
  // `command -v` (POSIX sh builtin) resolves through the CURRENT PATH exactly
  // the way a bare spawn('security', ...) would — this is what tells "the stub
  // answered" apart from "the real binary happened to say the same thing" (see
  // the file header): identical stderr text from the real tool would pass a
  // behavior-only check, but only the stub script lives under STUB_DIR.
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

test('central security stub: POSITIVE CONTROL — `security` resolves INTO the stub dir', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  const resolved = resolvedPath('security');
  assert.strictEqual(resolved, path.join(STUB_DIR, 'security'),
    `expected PATH search for 'security' to resolve to the stub, got: ${resolved}`);
});

test('central security stub: POSITIVE CONTROL — an unrelated command resolves OUTSIDE the stub dir', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  // /bin/sh itself is never shadowed (the stub dir holds only a `security`
  // file) — this is the control proving the shadow did not eat the rest of
  // PATH, the failure mode an earlier EMPTY decoy dir would NOT have caught.
  const resolved = resolvedPath('sh');
  assert.ok(resolved, 'expected `sh` to resolve at all');
  assert.notStrictEqual(path.dirname(resolved), STUB_DIR,
    `'sh' resolved INSIDE the stub dir (${resolved}) — the shadow is eating unrelated commands`);
});

test('central security stub: a spawned `security find-generic-password` never reaches the real binary', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  const r = spawnSync('security', ['find-generic-password', '-a', 'nobody-xyz', '-w', '-s', 'no-such-service-xyz'],
    { encoding: 'utf8' });
  assert.strictEqual(r.status, 44, `stub should answer "not found" (44); got status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /could not be found in the keychain/,
    `stub stderr did not look like a keychain miss: ${JSON.stringify(r.stderr)}`);
});

test('central security stub: a spawned `security -i` write never reaches the real binary', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  const r = spawnSync('security', ['-i'], {
    encoding: 'utf8',
    input: 'add-generic-password -U -a "someone" -s "Claude Code-credentials" -w "not-a-real-token"\n',
  });
  assert.strictEqual(r.status, 0, `stub should quietly accept a write; got status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

// upstream's ARGV-based write fallback (used when the -i stdin payload exceeds
// its size cap, per the traced 2.1.251 source) and the doctor keychain-probe's
// own cleanup call `add-generic-password`/`delete-generic-password` directly,
// not through `-i`. Both must also stay off the real binary.
test('central security stub: a spawned argv-form `add-generic-password`/`delete-generic-password` never reaches the real binary', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  const add = spawnSync('security', ['add-generic-password', '-U', '-a', 'nobody-xyz', '-s', 'no-such-service-xyz', '-X', '00'],
    { encoding: 'utf8' });
  assert.strictEqual(add.status, 0, `stub should quietly accept argv add; got status=${add.status} stderr=${add.stderr}`);
  const del = spawnSync('security', ['delete-generic-password', '-a', 'nobody-xyz', '-s', 'no-such-service-xyz'],
    { encoding: 'utf8' });
  assert.strictEqual(del.status, 0, `stub should quietly accept delete; got status=${del.status} stderr=${del.stderr}`);
});

// The EXACT shape the real bundle uses (traced from a freshly-extracted, darwin-
// carved 2.1.251 graph — NOT the stale/mixed-platform ~/.cache/clode/2.1.251
// entry, whose find-generic-password count of 2 vs. the correct 7 is the same
// mixed-carve signature BACKLOG.md documents for other versions): the command
// is built as a STRING and piped to `security -i` on stdin, hex-encoding the
// JSON payload with -X so the secret never touches argv. `-i` alone is `$1`, so
// a stub that switches on `$1` (not the whole command line) covers it — but only
// if it actually reads stdin, which this exercises with the real command shape.
test('central security stub: the exact upstream `-i` write shape (hex -X payload on stdin) is intercepted', (t) => {
  if (skipUnlessDarwinStub(t)) return;
  const account = process.env.USER || 'nobody';
  const service = 'Claude Code-credentials';
  const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"NOT-A-REAL-TOKEN"}}', 'utf8').toString('hex');
  const command = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  const r = spawnSync('security', ['-i'], {
    encoding: 'utf8',
    input: command,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.strictEqual(r.status, 0, `real upstream write shape should be quietly accepted; ` +
    `got status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

// The `test/e2e.cjs` sandbox() helper is deliberately "NOTHING from process.env
// leaks in" — it builds its OWN env from scratch rather than spreading
// `...process.env`, so it does NOT automatically inherit the PATH prepend above.
// It threads the stub dir through by NAME instead (CLODE_TEST_SECURITY_STUB_DIR).
// This is the positive control for THAT wiring specifically, independent of the
// generic `...process.env` inheritance every other test file gets — a real gap
// here is exactly the shape of bug this project has shipped twice before (an
// instrument, or in this case a SEPARATE env-construction path, quietly not
// consulting the shadow at all).
test('central security stub: the e2e sandbox() helper ALSO shadows security (not just ...process.env inheritance)', (t) => {
  if (!STUB_DIR) { t.skip('CLODE_TEST_SECURITY_STUB_DIR not set — run through test/run.mjs'); return; }
  const { sandbox } = require('./e2e.cjs');
  const sbx = sandbox(t);
  const entries = String(sbx.env.PATH || '').split(path.delimiter);
  assert.ok(entries.includes(STUB_DIR),
    `sandbox() env.PATH does not include the stub dir — a sandboxed spawn of the real ` +
    `bundle would reach /usr/bin/security for real. sandbox PATH=${sbx.env.PATH}`);
  if (process.platform !== 'darwin') { t.skip('security(1) is darwin-only; the stub is a no-op elsewhere'); return; }
  const r = spawnSync('/bin/sh', ['-c', 'command -v security'], { encoding: 'utf8', env: sbx.env });
  assert.strictEqual(r.stdout.trim(), path.join(STUB_DIR, 'security'),
    `a child spawned with sandbox().env resolves 'security' to: ${r.stdout.trim()}`);
});
