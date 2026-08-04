'use strict';
// Task 5 (phase 2 API gaps), Class C process.* gaps other than getuid (which
// has its own file, test/node-shim-getuid.test.cjs, for the tmpdir-divergence
// acceptance test). process.getuid/getBuiltinModule/reallyExit/chdir/ppid/
// constrainedMemory were all ARMED by the Task 4 probe (reached by at least
// one corpus) — see test/shim-surface/reachability.json and
// .superpowers/sdd/2026-08-03-phase2-api-gaps/task-4-report.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-procgaps-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('process.ppid is a live number matching a real parent process', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    console.log(JSON.stringify({
      ppid1: process.ppid,
      ppid2: process.ppid,   // must be a LIVE read (getter), not a frozen snapshot
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(typeof out.ppid1, 'number');
  assert.ok(out.ppid1 > 0, `ppid must be a positive pid, got ${out.ppid1}`);
  // Two reads within the same still-alive parent must agree.
  assert.strictEqual(out.ppid1, out.ppid2);
});

test('process.chdir() really moves the process (process.cwd() reflects it) and round-trips', (t) => {
  if (skipUnlessTjs(t)) return;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-chdir-target-'));
  // Resolve symlinks (macOS /tmp -> /private/tmp) so the string compare below
  // matches what a real chdir()+cwd() round-trip reports.
  const realTarget = fs.realpathSync(target);
  const f = writeProg(`
    const before = process.cwd();
    process.chdir(${JSON.stringify(target)});
    const after = process.cwd();
    console.log(JSON.stringify({ before, after }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.after, realTarget, 'process.cwd() must reflect the chdir, not silently no-op');
  assert.notStrictEqual(out.before, out.after);
});

test('process.chdir() throws a real ENOENT-shaped error on a bad path (loud, not a silent no-op)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    try {
      process.chdir('/this-path-should-not-exist-xyz-shim-test');
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, code: e.code, message: String(e.message) }));
    }`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.threw, true);
  assert.strictEqual(out.code, 'ENOENT');
});

test('process.chdir() rejects a non-string argument (TypeError, matching Node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    try {
      process.chdir(42);
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, name: e.constructor.name }));
    }`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { threw: true, name: 'TypeError' });
});

test('process.getBuiltinModule returns the real builtin for a known id (bare and node:-prefixed)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const viaBare = process.getBuiltinModule('path');
    const viaPrefixed = process.getBuiltinModule('node:path');
    console.log(JSON.stringify({
      bareHasJoin: typeof viaBare?.join === 'function',
      prefixedHasJoin: typeof viaPrefixed?.join === 'function',
      sameAsRequire: viaBare === require('node:path'),
      joined: viaBare.join('a', 'b'),
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    bareHasJoin: true, prefixedHasJoin: true, sameAsRequire: true, joined: 'a/b',
  });
});

test('process.getBuiltinModule returns undefined for an unknown id (no throw)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const v = process.getBuiltinModule('definitely-not-a-real-builtin-xyz');
    console.log(JSON.stringify({ isUndefined: v === undefined }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isUndefined: true });
});

test('process.reallyExit(code) terminates the process synchronously with that exit code', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    process.stdout.write('before\\n');
    process.reallyExit(7);
    process.stdout.write('after\\n');   // must NEVER run`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 7);
  assert.strictEqual(r.stdout, 'before\n');
});

test('process.constrainedMemory is a function returning undefined (honest "no known constraint", never a fabricated number)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    console.log(JSON.stringify({
      isFunction: typeof process.constrainedMemory === 'function',
      value: process.constrainedMemory() === undefined ? 'undefined' : process.constrainedMemory(),
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isFunction: true, value: 'undefined' });
});

test('constrainedMemory unblocks the bundle diagnostics pattern (no optional chaining, wrapped in try/catch)', (t) => {
  if (skipUnlessTjs(t)) return;
  // Mirrors the extracted bundle's lEg()-shaped call site: a bare (non-optional)
  // process.constrainedMemory() call inside an object literal, inside a
  // try/catch that previously swallowed the WHOLE return value (not just this
  // one field) whenever the property was missing.
  const f = writeProg(`
    function lEgShaped() {
      try {
        return { uptime: process.uptime(), constrainedMemory: process.constrainedMemory() };
      } catch {
        return undefined;
      }
    }
    const r = lEgShaped();
    console.log(JSON.stringify({ gotResult: r !== undefined, hasUptime: typeof r?.uptime === 'number' }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { gotResult: true, hasUptime: true });
});
