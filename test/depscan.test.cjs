'use strict';
// depscan — the cross-capable dependency reader (tools/depscan/depscan.c).
// These tests BUILD it, because a verifier that is never built on this host
// proves nothing about this host. The build is the first assertion.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { depscanExe, runDepscan } = require('./depscan-build.cjs');

const repo = path.join(__dirname, '..');

test('depscan builds host-native and reports usage on no arguments', () => {
  const r = runDepscan([]);
  assert.strictEqual(r.status, 2, `expected usage exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /usage: depscan/);
});

test('depscan exits 4, not 0, on a file it cannot read', () => {
  const r = runDepscan([path.join(os.tmpdir(), 'depscan-no-such-file-9e3a')]);
  assert.strictEqual(r.status, 4, `expected 4 for an unreadable file, got ${r.status}`);
});

test('depscan exits 3, not 0, on a file that is not a binary at all', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'depscan-txt-')), 'notabinary');
  fs.writeFileSync(f, 'this is plain text, not ELF, Mach-O or PE\n');
  const r = runDepscan([f]);
  assert.strictEqual(r.status, 3, `expected 3 for an unrecognized container, got ${r.status}`);
  assert.doesNotMatch(r.stdout, /deps=/,
    'an unparseable file must NOT print a deps= line — "found none" and "could not read it" are different answers');
});

test('build-depscan never passes a cross toolchain file', () => {
  // HOST-NATIVE IS THE WHOLE POINT: depscan inspects a binary built for
  // another machine, so it must run on THIS one. Handing it the target's
  // cross-file would build a verifier the build cannot execute.
  const src = fs.readFileSync(path.join(repo, 'scripts/build-depscan.mjs'), 'utf8');
  assert.doesNotMatch(src, /CMAKE_TOOLCHAIN_FILE/,
    'buildDepscan must not pass CMAKE_TOOLCHAIN_FILE — the verifier is a HOST tool');
  assert.doesNotMatch(src, /crossFile/,
    'buildDepscan must not consult the target cross-file at all');
});
