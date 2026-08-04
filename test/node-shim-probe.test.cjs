'use strict';
// CLODE_SHIM_PROBE: behavior-neutral observability for missing-property
// access on BROAD (non-sealed) shim builtins (fs, crypto, http, net, ...).
// wallProxy already covers a module with no .cjs at all; sealSurface already
// covers the tiny curated SEALED set (module, vm) with a branded throw.
// Neither sees a missing-property GET on a broad module, because Node's
// "missing prop = undefined" idiom is DELIBERATELY preserved there — the
// bundle's own feature detection depends on it. This probe makes those
// accesses visible on stderr WITHOUT changing what the GET/`in` returns:
// handing back a stub (or merely defining a property) would flip
// `typeof mod.X` / `"X" in mod` branches, precisely the Bun.SQL regression
// this repo already hit (see libexec/node-shim/internal/probe.cjs header).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-probe-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

// fs.fchownSync is genuinely absent from libexec/node-shim/modules/fs.cjs —
// verified by running the loader (not assumed): probe OFF, `String(fs.fchownSync)`
// prints "undefined" and `'fchownSync' in fs` is false.
const MISSING_PROP_PROG = `
  const fs = require('fs');
  console.log('VAL=' + String(fs.fchownSync));
`;

test('probe ON: gap GET is logged to stderr and still returns undefined', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(MISSING_PROP_PROG);
  const r = runLoader(f, [], { env: { CLODE_SHIM_PROBE: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[probe\] fs\.fchownSync/, 'the access must be observable');
  assert.match(r.stdout, /VAL=undefined/,
    'and MUST still be undefined — returning a stub flips feature-detection branches');
});

test('probe ON: "in" on a gap still evaluates false (and logs the (in) marker)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('fs');
    console.log('IN=' + ('fchownSync' in fs));
  `);
  const r = runLoader(f, [], { env: { CLODE_SHIM_PROBE: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[probe\] fs\.fchownSync \(in\)/);
  assert.match(r.stdout, /IN=false/);
});

test('probe ON: an existing property is returned normally and NOT logged', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('fs');
    console.log('T=' + typeof fs.readFileSync);
  `);
  const r = runLoader(f, [], { env: { CLODE_SHIM_PROBE: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /T=function/);
  assert.doesNotMatch(r.stderr, /\[probe\] fs\.readFileSync/);
});

test('probe OFF (default): silent, and value semantics are unchanged', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(MISSING_PROP_PROG);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /\[probe\]/);
  assert.match(r.stdout, /VAL=undefined/);
});

test('probe ON: a SEALED module (vm) still throws its branded wall, undisturbed', (t) => {
  if (skipUnlessTjs(t)) return;
  // vm is sealed; vm.SourceTextModule is unimplemented -> branded throw, same
  // as test/node-shim-walls.test.cjs's un-probed assertion of this fact. The
  // probe must not soften/replace/precede that behavior with a stub return.
  const f = writeProg('const vm=require("node:vm"); vm.SourceTextModule;');
  const r = runLoader(f, [], { env: { CLODE_SHIM_PROBE: '1' } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /node-shim: vm\.SourceTextModule not implemented/);
});
